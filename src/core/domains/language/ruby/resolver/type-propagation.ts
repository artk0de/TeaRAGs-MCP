/**
 * Ruby receiver type-propagation engine — multi-hop chain threading (Increment 1, Task 1.4).
 *
 * Exposes {@link typeOfReceiver}: given a raw receiver string + call line + the
 * per-file {@link CallContext}, resolves the static {@link RubyTypeRef} for
 * single-hop receivers (local variable bindings and `@ivar` field types) and
 * multi-hop dotted chains (`a.b.c.d`) via the propagation engine.
 *
 * **Scope of this module:**
 * - Local variable → `LocalBinding` via `resolveLocalBinding` → `RubyTypeRef`.
 * - `@ivar` → {@link ivarTypeName}: `ctx.ivarTypes` (declared types, merged
 *   run-global by the codegraph provider — empty until a Sorbet/RBS source
 *   emits `kind:"ivar"` facts) then `ctx.classFieldTypes` (the live channel:
 *   walker AST inference over `@x = Const.new`).
 * - Dotted chain receiver (`a.b.c`) → multi-hop threading via {@link returnTypeOf}
 *   seeded from the head segment and walked left-to-right. Capped at
 *   `CODEGRAPH_RB_CHAIN_MAX_HOPS` (default 4).
 * - Constants / `self` / `super` → `undefined`. Index-access on a TYPED
 *   container yields the element type (Task 1.6); untyped index → `undefined`.
 *
 * **Wired.** Consumed by the ruby dynamic-dispatch, chain-type, and
 * union-dispatch strategies; the codegraph provider merges
 * `ctx.structuredReturnTypes` / `ctx.ivarTypes` run-global from the per-file
 * extractions (bd 9bliu) — whatever the type sources put there.
 */

import { resolveLocalBinding, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { ACTIVE_RECORD_QUERY_INTERFACE } from "../dsl/rails.js";
import { catalogueForGemfile } from "../gemfile.js";

/**
 * Array/Enumerable methods that return a SINGLE ELEMENT from a typed container.
 * When `recv` is `{form:"container", element:E}` and the member is in this set,
 * `returnTypeOf` unwraps the container and returns `E` so multi-hop chains like
 * `posts.first.title` thread correctly: posts→container(Post), .first→Post,
 * .title→Post#title.
 *
 * Non-element methods (`size`, `count`, `map`, `length`) are intentionally
 * absent — those operate on the container itself (Array/Enumerable = external)
 * and their return types are not trackable without a full Enumerable type model.
 */
export const CONTAINER_ELEMENT_RETURNING_METHODS = new Set([
  "first",
  "last",
  "[]",
  "fetch",
  "sample",
  "find",
  "detect",
  "min",
  "max",
  "dig",
]);

/**
 * Block-iteration methods whose FIRST block parameter is bound to the container's
 * element type at walk-time. When `recv` has a known container element type E,
 * `posts.each { |p| … }` binds `p` to `E`. This constant is the single source
 * of truth for the block-param inference set (bd Increment B / B-block) used by
 * both `rubyAstInferenceTypeSource` (via the `latestBinding` seed) and
 * `collectLocalBindingsForChunk` (via `RUBY_BLOCK_ITERATOR_METHODS`).
 *
 * Exported here so the engine and the walker share one definition; the walker's
 * `RUBY_BLOCK_ITERATOR_METHODS` re-exports this.
 */
export const CONTAINER_BLOCK_ITERATION_METHODS = new Set([
  "each",
  "map",
  "collect",
  "select",
  "filter",
  "filter_map",
  "reject",
  "find",
  "detect",
  "find_all",
  "flat_map",
  "each_with_index",
  "each_with_object",
  "group_by",
  "sort_by",
  "min_by",
  "max_by",
  "partition",
]);

/** `@ivar` — a single leading `@` followed by word characters only. */
const IVAR_RECEIVER = /^@\w+$/;

/** A bare constant chain head: `Foo`, `Mod::Svc`. Capitalized, optional `::` scope. */
const CONST_HEAD = /^[A-Z]\w*(?:::[A-Z]\w*)*$/;

/** Strip a trailing call argument list from a chain segment (`new(post)` → `new`). */
function stripArgs(segment: string): string {
  const paren = segment.indexOf("(");
  return paren === -1 ? segment : segment.slice(0, paren);
}

/**
 * Default maximum chain hops when `CODEGRAPH_RB_CHAIN_MAX_HOPS` is unset.
 * Mirrors the `CONE_MAX_DEFAULT` / `DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT` pattern
 * in `strategies/shared.ts` — the const documents the default while the env
 * is read per-call so tests can override it without module reload.
 */
export const CHAIN_MAX_HOPS_DEFAULT = 4;

/**
 * Read the effective chain hop cap from env, falling back to `CHAIN_MAX_HOPS_DEFAULT`.
 * Called per `resolveChain` invocation so env-variable test overrides take effect
 * without needing a module reload.
 */
function chainMaxHops(): number {
  const raw = process.env.CODEGRAPH_RB_CHAIN_MAX_HOPS;
  if (raw === undefined) return CHAIN_MAX_HOPS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHAIN_MAX_HOPS_DEFAULT;
}

/**
 * Resolve the static {@link RubyTypeRef} for a receiver — single-hop or
 * multi-hop dotted chain.
 *
 * @param receiver - Raw receiver text from the call site (e.g. `"user"`, `"@client"`, `"a.b.c"`).
 * @param atLine   - 1-based source line of the call; used for position-aware
 *                   local-binding lookup (`LocalBinding.line <= atLine`).
 * @param ctx      - Per-call {@link CallContext} carrying `localBindings`,
 *                   `ivarTypes`, `classFieldTypes`, `associationTypes`,
 *                   `structuredReturnTypes`, `functionReturnTypes`,
 *                   `classAncestors`, and `callerScope`.
 * @returns A {@link RubyTypeRef} when the receiver's static type is known;
 *          `undefined` for unknowable receivers (constants, self, super,
 *          untyped index-access, unbound variables, or chains with an unknown hop).
 */
export function typeOfReceiver(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  // ── Dotted chain: multi-hop threading (Task 1.4) ─────────────────────────
  if (receiver.includes(".")) {
    return resolveChain(receiver, atLine, ctx);
  }

  // ── Index-access on a typed container: `arr[i]` → element type (Task 1.6) ─
  // When the outermost operation is `[...]` and the base var has a container
  // binding, return the element type so call sites like `arr[0].title` can
  // resolve to the element class rather than being suppressed as untrackable.
  // UNTYPED containers (no binding or non-container typeRef) return `undefined`
  // — suppression is preserved as before.
  const trimmed = receiver.trimEnd();
  if (trimmed.endsWith("]") && trimmed.includes("[")) {
    const bracketIdx = trimmed.indexOf("[");
    const baseVar = bracketIdx > 0 ? trimmed.slice(0, bracketIdx) : "";
    if (baseVar && /^[a-z_]\w*$/.test(baseVar)) {
      const baseBinding = resolveLocalBinding(ctx.localBindings, baseVar, atLine);
      if (baseBinding?.typeRef?.form === "container") {
        return baseBinding.typeRef.element;
      }
    }
    // Untyped index-access → undefined (suppression unchanged).
    return undefined;
  }

  // ── @ivar ───────────────────────────────────────────────────────────────
  if (IVAR_RECEIVER.test(receiver)) {
    return resolveIvarType(receiver, ctx);
  }

  // ── Local variable binding ───────────────────────────────────────────────
  // Only plain lowercase identifiers can be local variables in Ruby. A
  // capitalized identifier is a constant; `self`/`super` are keywords. We rely
  // on `resolveLocalBinding` returning `undefined` for constants/keywords (no
  // binding recorded), so no pre-filter on casing is strictly required — but
  // dotted receivers and ivars are already guarded above, and index-access
  // (`arr[0]`) is handled above. The explicit chain guard above is the only
  // structural guard needed.
  const binding = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  if (!binding) return undefined;

  // Prefer the richer typeRef (union / container) when present (INFRA-A);
  // fall back to reconstructing from type + valueKind for plain bindings.
  return (
    binding.typeRef ?? {
      form: binding.valueKind === "class" ? "class" : "instance",
      name: binding.type,
    }
  );
}

/**
 * Thread a dotted chain receiver through the propagation engine.
 *
 * Algorithm:
 * 1. Split `receiver` into `[head, link1, link2, ...]`.
 * 2. Seed: resolve `head` via the single-hop path (recurse into `typeOfReceiver`
 *    without the dot guard).
 * 3. For each link left-to-right: `t = returnTypeOf(t, link, ctx)`.
 *    - First `undefined` hop → STOP, return `undefined` (precision invariant:
 *      never fabricate past an unknown hop).
 * 4. Cap at `CHAIN_MAX_HOPS` hops — a chain longer than the cap returns `undefined`.
 */
function resolveChain(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  const segments = receiver.split(".");
  // segments[0] is the head; segments[1..] are the member links.
  const head = segments[0];
  if (!head) return undefined;

  const links = segments.slice(1);

  // Hop cap: links.length is the number of hops (each `.link` = one hop).
  if (links.length > chainMaxHops()) return undefined;

  let current: RubyTypeRef | undefined;
  let startLink = 0;
  // Bare-constant head. Two ways the first link can be typed, declared facts FIRST:
  //
  //  1. DECLARED (bd tea-rags-mcp-6zpds) — the project itself states what the
  //     member returns on that constant (`scope :without_deleted` →
  //     `container(Owner)`, a YARD `@return`, an inherited fact). Custom scopes
  //     live only here; the generic vocabulary cannot know them.
  //  2. VOCABULARY (rvw34 gap b) — a framework/Ruby instance-returning verb
  //     (`new`/`find`/`create!`…) makes the chain an instance of the constant:
  //     `PostStatusService.new` is definitionally a PostStatusService.
  //
  // Both are zero-fabrication. A bare-const head that is neither declared nor
  // vocabulary (`Config.value`) is still NOT typed.
  const firstLink = links[0];
  const headMember = firstLink === undefined ? null : stripArgs(firstLink);
  const declaredHead =
    headMember !== null && CONST_HEAD.test(head) ? declaredReturnType(head, headMember, ctx) : undefined;
  if (declaredHead !== undefined) {
    current = declaredHead;
    startLink = 1;
  } else if (
    headMember !== null &&
    CONST_HEAD.test(head) &&
    catalogueForGemfile(ctx.gemfileContent).instanceReturning.has(headMember)
  ) {
    current = { form: "instance", name: head };
    startLink = 1;
  } else {
    // Seed: resolve head via single-hop (no dot in head → no recursion risk).
    current = typeOfReceiver(head, atLine, ctx);
  }
  if (current === undefined) return undefined;

  // Walk remaining links left-to-right, threading type through each hop.
  for (let i = startLink; i < links.length; i++) {
    current = returnTypeOf(current, stripArgs(links[i]), ctx);
    if (current === undefined) return undefined; // STOP-at-unknown-hop
  }

  return current;
}

/**
 * Whether `className`'s transitive ancestry (walking `ctx.classAncestors`,
 * cycle-guarded by `seen`) reaches any class in `targets`. A local membership
 * predicate rather than the strategies' `collectAncestorChain`: importing that
 * would pull `strategies/shared.ts` → `walker.ts` → `type-sources/ast-inference`
 * → back here, a module cycle that breaks this file's top-level `CONTAINER_*`
 * const init. `className` itself counts (a call on `ApplicationRecord` directly).
 */
function ancestryReaches(
  className: string,
  targets: ReadonlySet<string>,
  ctx: CallContext,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(className)) return false;
  seen.add(className);
  if (targets.has(className)) return true;
  for (const ancestor of ctx.classAncestors?.[className] ?? []) {
    if (ancestryReaches(ancestor, targets, ctx, seen)) return true;
  }
  return false;
}

/** `find_by_<attr>` / `find_by_<attr>!` — a dynamic finder (requires an attr suffix). */
function isDynamicFinder(member: string): boolean {
  const prefix = ACTIVE_RECORD_QUERY_INTERFACE.dynamicFinderPrefix;
  return member.startsWith(prefix) && member.length > prefix.length;
}

/**
 * ActiveRecord query-interface fallback (G1b): on an AR-model receiver, the
 * Rails-defined query methods resolve WITHOUT per-model facts. Instance-returning
 * finders/factories (`find`, `create!`, `find_by_<attr>`) yield the model;
 * relation-returning query methods (`where`, `order`, …) yield a relation
 * (`container(model)`). Returns `undefined` when the receiver is not an AR model
 * or the member is not query vocabulary — the caller then falls through to
 * `undefined` (no fabrication).
 */
function activeRecordQueryReturn(className: string, member: string, ctx: CallContext): RubyTypeRef | undefined {
  if (!ancestryReaches(className, ACTIVE_RECORD_QUERY_INTERFACE.modelBaseClasses, ctx)) return undefined;
  const catalogue = catalogueForGemfile(ctx.gemfileContent);
  if (catalogue.instanceReturning.has(member) || isDynamicFinder(member)) {
    return { form: "instance", name: className };
  }
  if (catalogue.relationReturning.has(member)) {
    return { form: "container", element: { form: "instance", name: className } };
  }
  return undefined;
}

/**
 * The DECLARED return type at a `<className>.<member>` coordinate: the precise
 * structured fact, then the same fact inherited through the ancestor MRO. Facts
 * only — no vocabulary, no flat by-name fallback, no association accessors (those
 * are instance-only and stay in {@link returnTypeOf}).
 *
 * Extracted so the chain-root seed can ask "is this member DECLARED on the root
 * constant?" through the very channels {@link returnTypeOf} consults, instead of
 * growing a second lookup that could drift (bd tea-rags-mcp-6zpds).
 */
function declaredReturnType(className: string, member: string, ctx: CallContext): RubyTypeRef | undefined {
  return declaredReturnTypeOn(className, member, ctx, true) ?? inheritedReturnType(className, member, ctx, true);
}

/**
 * The structured fact declared AT `<className>.<member>` / `<className>#<member>`.
 *
 * Facts are keyed with `#` by default — including `def self.x` `@return`s, which
 * the engine deliberately answers for class receivers too. A fact that declares
 * itself class-level (an `@!method self.x` directive) is keyed with `.`, so a
 * CLASS receiver tries that coordinate first and falls back to the shared `#`
 * one (bd tea-rags-mcp-8ypeu). Instance receivers never see the `.` key.
 */
function declaredReturnTypeOn(
  className: string,
  member: string,
  ctx: CallContext,
  classReceiver = false,
): RubyTypeRef | undefined {
  if (classReceiver) {
    const classForm = ctx.structuredReturnTypes?.[`${className}.${member}`];
    if (classForm !== undefined) return classForm;
  }
  return ctx.structuredReturnTypes?.[`${className}#${member}`];
}

/** The structured fact `<member>` inherits from the first ancestor declaring it. */
function inheritedReturnType(
  className: string,
  member: string,
  ctx: CallContext,
  classReceiver = false,
): RubyTypeRef | undefined {
  for (const ancestor of ctx.classAncestors?.[className] ?? []) {
    const inherited = declaredReturnTypeOn(ancestor, member, ctx, classReceiver);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

/**
 * The ONE authority for "what type does calling `member` on a receiver of type
 * `recv` yield" (bd tea-rags-mcp-j9xpf — same single-authority discipline as
 * {@link ivarTypeName}). Every reader — the chain engine's hop walk and the
 * `returnTypeBinding` pass's scope-qualified lookup — MUST go through here, so
 * the channel precedence below is stated once and cannot drift between callers.
 *
 * Resolution order (first non-undefined wins):
 * 1. `ctx.structuredReturnTypes?.["${recv.name}#${member}"]` — precise structured ref.
 * 2. `ctx.associationTypes?.[recv.name]?.[member]` → `{form:"instance", name}` —
 *    Rails belongs_to / has_many / has_one DSL associations.
 * 3. Ancestor MRO: walk `ctx.classAncestors?.[recv.name]` for an inherited
 *    `structuredReturnTypes["${ancestor}#${member}"]`.
 * 4. `ctx.functionReturnTypes?.[member]` → `{form:"instance", name}` — flat
 *    fallback (YARD @return map, already populated today). Applied LAST so the
 *    more-precise paths win when available.
 * 5. ActiveRecord query interface (G1b) — consulted AFTER every declared fact
 *    (a declared type beats vocabulary), gated on the AR-model check.
 *
 * Container element-returning methods unwrap to the element type (Task 1.6);
 * union forms are not threaded here (deferred, Task 1.7) — returns `undefined`.
 */
export function returnTypeOf(recv: RubyTypeRef, member: string, ctx: CallContext): RubyTypeRef | undefined {
  // Container form: element-returning methods unwrap to the element type (Task 1.6).
  // Non-element methods (size, count, map, …) → undefined (Array/Enumerable = external).
  if (recv.form === "container") {
    return CONTAINER_ELEMENT_RETURNING_METHODS.has(member) ? recv.element : undefined;
  }

  // Only class/instance forms are threadable beyond the container branch; union deferred.
  if (recv.form !== "class" && recv.form !== "instance") return undefined;

  // 1. Precise structured return type for this class#member key.
  const direct = declaredReturnTypeOn(recv.name, member, ctx, recv.form === "class");
  if (direct !== undefined) return direct;

  // 2. Rails association DSL: associationTypes[className][accessorName] → modelName.
  //    INSTANCE receivers only — `belongs_to :firm` defines `#firm` on instances,
  //    never on the class object, so `SomeClass.firm` is a different method that
  //    must fall through to the scoped/flat return channels below (j9xpf: without
  //    this guard a class-form receiver silently borrows an instance accessor's
  //    type and shadows the correct one).
  if (recv.form === "instance") {
    const assocName = ctx.associationTypes?.[recv.name]?.[member];
    if (assocName !== undefined) return { form: "instance", name: assocName };
  }

  // 3. Ancestor MRO: walk classAncestors[recv.name] for an inherited return type.
  const inherited = inheritedReturnType(recv.name, member, ctx, recv.form === "class");
  if (inherited !== undefined) return inherited;

  // 4. Flat functionReturnTypes fallback — YARD @return map, populated today.
  const flatName = ctx.functionReturnTypes?.[member];
  if (flatName !== undefined) return { form: "instance", name: flatName };

  // 5. ActiveRecord query-interface vocabulary — AR-model receivers only,
  //    consulted last so every declared fact above wins over it (G1b).
  return activeRecordQueryReturn(recv.name, member, ctx);
}

/**
 * The ONE authority for "what type does `@ivar` hold inside the caller's class"
 * (bd tea-rags-mcp-wr7ku). Two channels carry ivar types and every reader must
 * consult both, in this order:
 *
 *  1. `ctx.ivarTypes` — type-SOURCE facts (`RubyTypeFact` of `kind:"ivar"`,
 *     merged run-global by the codegraph provider). Declared types win.
 *  2. `ctx.classFieldTypes` — the walker's AST inference over `@x = Const.new`
 *     assignments (`collectRubyIvarFieldTypes`), per-file. The channel that
 *     actually carries facts today: no INLINE type source emits `kind:"ivar"`
 *     yet, so (1) stays empty until a sidecar/Sorbet source lands.
 *
 * The enclosing-class key is `ctx.callerScope.join("::")` — the same key
 * `collectRubyClassAncestors` / `collectRubyIvarFieldTypes` produce. Unknown
 * ivar → `undefined`; callers own the resulting silence.
 */
export function ivarTypeName(ivar: string, ctx: CallContext): string | undefined {
  if (ctx.callerScope.length === 0) return undefined;
  const scopeKey = ctx.callerScope.join("::");
  return ctx.ivarTypes?.[scopeKey]?.[ivar] ?? ctx.classFieldTypes?.[scopeKey]?.[ivar];
}

/** {@link ivarTypeName} lifted to the engine's structured ref (always instance form). */
function resolveIvarType(ivar: string, ctx: CallContext): RubyTypeRef | undefined {
  const name = ivarTypeName(ivar, ctx);
  return name === undefined ? undefined : { form: "instance", name };
}

/**
 * The type a receiver BOUND TO A METHOD CALL carries — `result = Svc.call(…)`
 * leaves `result` with no `localBindings` entry (the walker cannot know another
 * file's return type), only a `localCallBindings` one naming what was called.
 * This is the ONE authority for that channel (bd tea-rags-mcp-j9xpf), read by
 * both the `returnTypeBinding` pass and the dynamic-dispatch component that
 * defers to it, so the two can never disagree about which receivers the exact
 * path owns.
 *
 * Two binding forms, mirroring what the walker records:
 *  - SCOPE-QUALIFIED (`"Billing::Create.call"`, recorded when the RHS receiver
 *    was a constant) — the receiver's type is known, so {@link returnTypeOf}
 *    answers over the CLASS object and every scoped channel applies (structured
 *    fact at the entry coordinate, ancestor MRO, then the flat map);
 *  - BARE (`"fetch"`) — no receiver type, so only the flat, project-wide
 *    `functionReturnTypes` map can answer. Unchanged from before.
 */
export function boundCallReturnType(receiver: string, ctx: CallContext): RubyTypeRef | undefined {
  const binding = ctx.localCallBindings?.[receiver];
  if (binding === undefined) return undefined;
  const separator = binding.lastIndexOf(".");
  if (separator <= 0) {
    const flat = ctx.functionReturnTypes?.[binding];
    return flat ? { form: "instance", name: flat } : undefined;
  }
  return returnTypeOf({ form: "class", name: binding.slice(0, separator) }, binding.slice(separator + 1), ctx);
}
