import type { AstNode } from "../../../../contracts/types/ast.js";
import { resolveLocalBindingType, type LocalBinding } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { FULL_RUBY_CATALOGUE, type RubyDslCatalogue } from "../dsl/index.js";
import { forEachClassScope, readScopeResolution, walk } from "./ast-utils.js";
import { constInstanceType, isOrAssignment } from "./type-sources/ast-inference.js";
import { collectYardParamTypes, YARD_CONST } from "./type-sources/yard.js";

export { collectYardParamTypes, collectYardReturnTypes, YARD_CONST } from "./type-sources/yard.js";
export { RUBY_BLOCK_ITERATOR_METHODS } from "./type-sources/ast-inference.js";

/**
 * Env-gate for the Ruby local variable type inference path. When `false`,
 * walker emits `localBindings: undefined` and the resolver falls back to
 * legacy import + short-name resolution. Default `true`.
 */
export function localTypeTrackingEnabled(): boolean {
  const raw = process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

/**
 * Per-class `@ivar -> typeName` map for the universal `classFieldTypes` channel
 * (Ruby is the 5th implementation after TS/Java/Python/Rust). Walks each class /
 * module and records `@ivar = Const.new` (or instance-returning finder, via
 * {@link constInstanceType}) assignments found ANYWHERE in that class's own
 * method bodies — `initialize`, lazy memoization, setup helpers — but NOT in
 * nested classes, which get their own fq map. The class key is the fully
 * qualified scope-stack name (`Outer::Inner`), matching `collectRubyClassAncestors`
 * and the resolver's `ctx.callerScope.join("::")`. The `@`-prefixed field key
 * matches the call-site receiver text verbatim (`@client`). Mirrors
 * `collectPythonClassFieldTypes`: within-class conflict is last-write-wins; a
 * non-constructor RHS records nothing (the uppercase-constant gate lives in
 * `constInstanceType`).
 */
export function collectRubyIvarFieldTypes(
  root: AstNode,
  associationTypes: Record<string, Record<string, string>> = {},
  code = "",
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): Record<string, Record<string, string>> {
  const yardParamsByLine = code ? collectYardParamTypes(code) : new Map<number, Record<string, string>>();
  const out: Record<string, Record<string, string>> = {};
  forEachClassScope(root, (node, fq) => {
    // Collect typed `@ivar = …` across THIS class's own bodies. Stop at any
    // nested class/module — those are attributed to their own fq by the
    // forEachClassScope recursion. Method bodies get a method-scoped type env
    // (YARD params + local `Const.new`/copy) so a param/local-copy or an
    // association-chain RHS types the ivar, not just `@x = Const.new`.
    const fields: Record<string, string> = {};
    const collectInClass = (n: AstNode): void => {
      if (n.type === "class" || n.type === "module") return;
      if (n.type === "method" || n.type === "singleton_method") {
        const env = methodTypeEnv(n, yardParamsByLine, catalogue);
        collectIvarAssignmentsInMethod(n, env, fields, associationTypes, catalogue);
        return; // collectIvarAssignmentsInMethod walks the body
      }
      // Class-body-level ivar assignment (rare) — no method env.
      recordIvarAssignment(n, {}, fields, associationTypes, catalogue);
      for (const child of n.children) collectInClass(child);
    };
    const body = node.childForFieldName("body");
    for (const child of (body ?? node).children) collectInClass(child);
    if (Object.keys(fields).length > 0) out[fq] = { ...(out[fq] ?? {}), ...fields };
  });
  return out;
}

/**
 * Build a method-scoped `localName → typeName` env: YARD `@param` types at the
 * def line, then a pass binding `local = Const.new`/finder (constInstanceType)
 * and copy-propagation `local = otherTypedLocal`. Last-write-wins. Stops at a
 * nested class / module / method (those have their own scope).
 */
function methodTypeEnv(
  method: AstNode,
  yardParamsByLine: Map<number, Record<string, string>>,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): Record<string, string> {
  const env: Record<string, string> = { ...(yardParamsByLine.get(method.startPosition.row + 1) ?? {}) };
  const scan = (n: AstNode): void => {
    if (n.type === "class" || n.type === "module" || n.type === "method" || n.type === "singleton_method") return;
    if (n.type === "assignment") {
      const lhs = n.childForFieldName("left");
      const rhs = n.childForFieldName("right");
      if (lhs?.type === "identifier" && rhs) {
        const direct = constInstanceType(rhs, catalogue);
        if (direct) {
          env[lhs.text] = direct;
        } else if (rhs.type === "identifier") {
          const copied = env[rhs.text];
          if (copied) env[lhs.text] = copied;
        }
      }
    }
    for (const child of n.children) scan(child);
  };
  const body = method.childForFieldName("body");
  for (const child of (body ?? method).children) scan(child);
  return env;
}

/** Walk a method body recording every `@ivar = <rhs>` against the method's type env. */
function collectIvarAssignmentsInMethod(
  method: AstNode,
  env: Record<string, string>,
  fields: Record<string, string>,
  associationTypes: Record<string, Record<string, string>>,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): void {
  const walkBody = (n: AstNode): void => {
    if (n.type === "class" || n.type === "module") return;
    recordIvarAssignment(n, env, fields, associationTypes, catalogue);
    for (const child of n.children) walkBody(child);
  };
  const body = method.childForFieldName("body");
  for (const child of (body ?? method).children) walkBody(child);
}

/**
 * Record `@ivar = <rhs>` into `fields` using (in precedence order):
 *  1. constInstanceType(rhs) — `@x = Const.new`/finder (preserves prior behaviour).
 *  2. env[rhs] — typed-param / typed-local copy (`@x = account`).
 *  3. chain-RHS threading — `@x = head.assoc[.assoc][.new]` (association walk).
 * Last-write-wins. Mutates `fields`.
 */
function recordIvarAssignment(
  n: AstNode,
  env: Record<string, string>,
  fields: Record<string, string>,
  associationTypes: Record<string, Record<string, string>>,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): void {
  if (n.type !== "assignment" && !isOrAssignment(n)) return;
  const lhs = n.childForFieldName("left");
  const rhs = n.childForFieldName("right");
  if (lhs?.type !== "instance_variable" || !rhs) return;
  const direct = constInstanceType(rhs, catalogue);
  if (direct) {
    fields[lhs.text] = direct;
    return;
  }
  if (rhs.type === "identifier") {
    const copied = env[rhs.text];
    if (copied) {
      fields[lhs.text] = copied;
      return;
    }
  }
  const chained = threadChainRhsType(rhs.text, env, fields, associationTypes, catalogue);
  if (chained) fields[lhs.text] = chained;
}

/**
 * Thread a dotted-chain assignment RHS (`@account.statuses.new`, `acct.posts.first`)
 * to its element-model type. The head's type comes from `fields` (a prior `@ivar`)
 * or `env` (a typed param/local). Each association hop walks `associationTypes`;
 * an instance-returning tail link (`new`/`build`/`create!`/`first`/`find`…) on an
 * association keeps the element model. Returns `undefined` at the first unknown
 * hop (no fabrication) or for a non-chain / untyped-head RHS.
 */
function threadChainRhsType(
  text: string,
  env: Record<string, string>,
  fields: Record<string, string>,
  associationTypes: Record<string, Record<string, string>>,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): string | undefined {
  if (!text.includes(".")) return undefined;
  const segments = text.split(".");
  const head = segments[0];
  if (head === undefined) return undefined;
  let current: string | undefined = head.startsWith("@") ? fields[head] : env[head];
  if (!current) return undefined;
  const seen = new Set<string>([current]); // cycle guard (self-referential has_many)
  for (let i = 1; i < segments.length; i++) {
    const link = stripArgsLocal(segments[i]);
    if (catalogue.instanceReturning.has(link)) continue; // `.new`/`.first` on a relation → keep element model
    const next: string | undefined = associationTypes[current]?.[link];
    if (!next) return undefined; // unknown hop STOPS (honest fan-out)
    if (seen.has(next)) return next;
    seen.add(next);
    current = next;
  }
  return current;
}

/** Strip a trailing call argument list from a chain segment (`new(post)` → `new`). */
function stripArgsLocal(segment: string): string {
  const paren = segment.indexOf("(");
  return paren === -1 ? segment : segment.slice(0, paren);
}

/**
 * Infer `methodName → returnTypeName` from each method's BODY when no YARD
 * `@return` is present (cai0 a71lj body-inference). The return value of a Ruby
 * method is its LAST evaluated expression (implicit return) or an explicit
 * `return EXPR`; when that expression is a constructor / instance-returning
 * factory (`Widget.new`, `User.find(id)` — typed by {@link constInstanceType}),
 * the method's return type is that constant. Conservative: a conditional /
 * identifier / literal last expression records NOTHING (no guessing across
 * branches), mirroring the single-concrete-return discipline of
 * `collectYardReturnTypes`. Keyed by the bare method name (`def self.make` →
 * `make`), matching how the resolver reads `localCallBindings` short names.
 * YARD annotations win over body inference at the merge site (the walker).
 */
export function collectRubyBodyReturnTypes(
  root: AstNode,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    if (node.type !== "method" && node.type !== "singleton_method") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const type = bodyReturnInstanceType(node, catalogue);
    if (type) out[nameNode.text] = type;
  });
  return out;
}

/**
 * The constant a method's BODY last expression evaluates to as an INSTANCE, or
 * `null` for every shape the inference deliberately stays silent on (branching,
 * opaque call tails, literals, bare identifiers). Explicit `return EXPR` is
 * unwrapped; `rescue` / `ensure` / `else` tails are skipped, so the tail seen is
 * the method's normal-path value.
 *
 * Shared by the FLAT {@link collectRubyBodyReturnTypes} and the OWNER-KEYED
 * {@link collectRubyScopedBodyReturnTypes} so the two channels cannot disagree
 * about which shapes carry a return type — the scoped map is the same inference
 * under a key that names the declaring class.
 */
function bodyReturnInstanceType(method: AstNode, catalogue: RubyDslCatalogue): string | null {
  const tail = bodyTailExpression(method);
  return tail === null ? null : constInstanceType(tail, catalogue);
}

/**
 * The method body's last value-producing expression: `rescue` / `ensure` / `else`
 * tails skipped so the tail seen is the NORMAL-path value, and an explicit
 * `return EXPR` unwrapped to `EXPR`. `null` when the body produces no value.
 */
function bodyTailExpression(method: AstNode): AstNode | null {
  const body = method.childForFieldName("body");
  if (!body) return null;
  const stmts = body.namedChildren.filter((n) => n.type !== "rescue" && n.type !== "ensure" && n.type !== "else");
  let last = stmts[stmts.length - 1];
  if (!last) return null;
  if (last.type === "return") {
    const arg = last.namedChildren[0];
    if (!arg) return null;
    last = arg.type === "argument_list" ? arg.namedChildren[0] : arg;
    if (!last) return null;
  }
  return last;
}

/**
 * How many times `name` is assigned (plain or operator) under `root`.
 *
 * A nested class / module is always a different scope and is never entered. A
 * nested `def` is entered only when counting an `@ivar`: ivars belong to the
 * INSTANCE, so every method of the class can write the same one, and that is
 * precisely what the memoization guard needs to see. Locals are method-scoped,
 * so for them a nested def is a different scope too.
 */
function countAssignmentsTo(root: AstNode, name: string, crossMethods: boolean): number {
  let seen = 0;
  const scan = (n: AstNode): void => {
    if (n.type === "class" || n.type === "module") return;
    if (!crossMethods && (n.type === "method" || n.type === "singleton_method")) return;
    if (n.type === "assignment" || n.type === "operator_assignment") {
      if (n.childForFieldName("left")?.text === name) seen += 1;
    }
    for (const child of n.children) scan(child);
  };
  for (const child of root.children) scan(child);
  return seen;
}

/**
 * The instance type of a MEMOIZED-READER tail — `@x ||= Const.new` / `x = Const.new`
 * (bd tea-rags-mcp-smvyk). `null` for every other tail.
 *
 * ── WHY THIS SHAPE AND NO OTHER ──
 * The taxdome census classified all 1 678 nullary-receiver misses whose callee
 * carries no return fact. Ranked by miss reach, the classes are: opaque qualified
 * call tails (118), memoized tails whose RHS is opaque (108), memoized tails
 * whose RHS is a `Const.m()` with no fact of its own (85), literals (56), and
 * then THIS — a memoized tail whose RHS types, 49 misses over 13 defs. Everything
 * above it is a genuine floor: an opaque RHS has no nominal type to name, and the
 * `Const.m()` cases bottom out in nilable conditionals (`HostHelper.current_firm`
 * returns a Firm or nil). The conditional-agree and passthrough-tail shapes the
 * design anticipated measured 1 and 0 sites respectively, so neither is built.
 *
 * ── WHY IT IS SOUND ──
 * The value of `x = e` IS `e`, unconditionally. The value of `x ||= e` is `e`
 * whenever `x` was falsy — so the fact holds exactly when nothing else could have
 * put a different value in `x`. That is checked, not assumed: an `@ivar` must be
 * assigned exactly once in the whole class body (no sibling method writes it), a
 * local exactly once in the method. `+=` and `&&=` are arithmetic and guard
 * idioms, not memoization, and are rejected outright.
 *
 * The check is file-scoped, like every walker inference: a class reopened in
 * another file could assign the same ivar. That is the same bound
 * `collectRubyIvarFieldTypes` and the service-entry source already accept.
 */
function memoizedTailInstanceType(
  tail: AstNode,
  method: AstNode,
  classBody: AstNode,
  catalogue: RubyDslCatalogue,
): string | null {
  const plain = tail.type === "assignment";
  if (!plain && !isOrAssignment(tail)) return null;
  const lhs = tail.childForFieldName("left");
  const rhs = tail.childForFieldName("right");
  if (!lhs || !rhs) return null;
  if (lhs.type !== "identifier" && lhs.type !== "instance_variable") return null;
  const type = constInstanceType(rhs, catalogue);
  if (type === null) return null;
  if (plain) return type;
  const ivar = lhs.type === "instance_variable";
  return countAssignmentsTo(ivar ? classBody : method, lhs.text, ivar) === 1 ? type : null;
}

/**
 * The OWNER-QUALIFIED twin of {@link collectRubyBodyReturnTypes} (bd
 * tea-rags-mcp-rwv3o): the same body-last-expression inference keyed
 * `"<fqClass>#<method>"` — the engine's `structuredReturnTypes` convention —
 * instead of by the bare method name.
 *
 * ── WHY A SECOND KEY FOR THE SAME INFERENCE ──
 * The flat map carries no owning class, so one `def data; ReportRow.new; end`
 * speaks for every `data` in the corpus — on taxdome `data` has 244 definitions.
 * `returnTypeOf` therefore refuses the flat fact whenever the receiver's class is
 * known and the member is multiply defined (bd tea-rags-mcp-h4hxh), which leaves
 * a KNOWN receiver with no answer at all. The same fact under the declaring
 * class's coordinate has no such ambiguity: it describes exactly one method, so
 * the engine's precise path (`structuredReturnTypes["Klass#member"]`) can apply
 * it without a corpus-uniqueness gate, and a bare self-call can find it through
 * the CALLER's own class and ancestors.
 *
 * Singleton defs (`def self.build`) are keyed with `#` like every other
 * body-inferred fact — the engine reads that coordinate for class receivers too
 * (see `RubyTypeFactStore.structuredReturnTypesMap`), and only an explicit
 * `@!method self.x` directive claims the `.` form. A method declared outside any
 * class has no owner and is skipped; the flat map still carries it.
 *
 * Merged by the walker only where the type-fact store has nothing at that
 * coordinate, so declared sources (YARD, associations, the service-entry
 * body source) keep their precedence.
 */
export function collectRubyScopedBodyReturnTypes(
  root: AstNode,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): Record<string, RubyTypeRef> {
  const out: Record<string, RubyTypeRef> = {};
  forEachClassScope(root, (classNode, fq) => {
    const classBody = classNode.childForFieldName("body") ?? classNode;
    const scan = (n: AstNode): void => {
      // Nested class/module bodies belong to their own fq — forEachClassScope
      // visits them separately.
      if (n.type === "class" || n.type === "module") return;
      if (n.type === "method" || n.type === "singleton_method") {
        const nameNode = n.childForFieldName("name");
        if (nameNode === null) return;
        const tail = bodyTailExpression(n);
        const type =
          tail === null
            ? null
            : (constInstanceType(tail, catalogue) ?? memoizedTailInstanceType(tail, n, classBody, catalogue));
        if (type !== null) out[`${fq}#${nameNode.text}`] = { form: "instance", name: type };
        return;
      }
      for (const child of n.children) scan(child);
    };
    for (const child of classBody.children) scan(child);
  });
  return out;
}

/**
 * Collect `varName → calledMethod` for assignments whose RHS is a method call
 * WITHOUT a directly-knowable type (`x = client.fetch`, `x = build_thing()`).
 * Pairs with the run-global `functionReturnTypes` channel so the resolver binds
 * `x.member` to `<fetch's return type>#member` (the universal return-type channel;
 * Go fills it via `collectGoLocalBindingsForChunk`, bd 6g9c). Constructor /
 * factory RHS (`Foo.new`, `Model.find`) is EXCLUDED — `constInstanceType` already
 * types those directly into `localBindings`, so recording them here too would be
 * a redundant weaker binding. The method name is the OUTERMOST call's method
 * (`x = a.b.c` → `c`), matching how `collectYardReturnTypes` keys return types.
 * Simple `Record` (last-write-wins), mirroring Go's `localCallBindings`.
 *
 * ── SCOPE-QUALIFIED FORM (bd tea-rags-mcp-j9xpf) ──
 * When the outermost receiver is a CONSTANT the value keeps it —
 * `result = Billing::X::Create.call(…)` records `"Billing::X::Create.call"`, not
 * `"call"`. The constant IS the receiver's type, so the resolver can consult the
 * SCOPED return-type channels (`structuredReturnTypes["Type#member"]`, the
 * ancestor MRO) instead of the flat, project-wide map keyed by the bare name —
 * and `call` is the most collided method name in a Rails codebase. The two forms
 * are unambiguous: a Ruby method name never contains `.`. Anything else — a
 * lowercase/ivar receiver, a chained tail, a leading-`::` constant — keeps the
 * bare form, so the flat path is byte-identical for every binding that had no
 * statically-known receiver type to begin with.
 */
export function collectRubyLocalCallBindingsForChunk(
  root: AstNode,
  startLine: number,
  endLine: number,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    const line = node.startPosition.row + 1;
    if (line < startLine || line > endLine) return;
    if (node.type !== "assignment") return;
    const lhs = node.childForFieldName("left");
    const rhs = node.childForFieldName("right");
    if (lhs?.type !== "identifier" || !rhs) return;
    if (rhs.type !== "call" && rhs.type !== "method_call") return;
    if (constInstanceType(rhs, catalogue) !== null) return; // directly typed → localBindings owns it
    const method = rhs.childForFieldName("method");
    if (!method) return;
    const receiver = rhs.childForFieldName("receiver");
    const receiverText =
      receiver === null ? "" : receiver.type === "scope_resolution" ? readScopeResolution(receiver) : receiver.text;
    // last-write-wins
    out[lhs.text] = YARD_CONST.test(receiverText) ? `${receiverText}.${method.text}` : method.text;
  });
  return out;
}

/** A dotted member chain whose root is a bare local — `event.user.agents`.
 *  Rejects constants, `::` scopes, `()` calls, `[]` index access, and `self`. */
const COMPOUND_CHAIN_RE = /^[a-z_][A-Za-z0-9_]*(?:\.[a-z_][A-Za-z0-9_]*)+$/;

/**
 * Walk every distinct dotted-chain call receiver in the chunk range and bind
 * each prefix to its association model type. For `event.user.agents` with
 * `event : Event`, `Event belongs_to :user` (→User), `User has_many :agents`
 * (→Agent): binds `event.user → User`, then `event.user.agents → Agent`. The
 * binding line is the receiver's own line so the position-aware lookup attaches
 * it correctly. Honours `class_name:` implicitly — the association map already
 * carries the rewritten model (`event.author → User`). Exported for use by the
 * walker's store-path rewire (Task 0.5) as a post-store association-chain pass.
 */
export function bindCompoundReceiverChains(
  root: AstNode,
  startLine: number,
  endLine: number,
  associationTypes: Record<string, Record<string, string>>,
  out: Record<string, LocalBinding[]>,
  push: (name: string, type: string, line: number) => void,
): void {
  // Distinct chain receiver texts (longest first so a deeper chain's prefixes
  // are all reachable) paired with the call line they appear on.
  const chains = new Map<string, number>();
  walk(root, (node) => {
    if (node.type !== "call" && node.type !== "method_call") return;
    const receiver = node.childForFieldName("receiver");
    if (!receiver) return;
    const line = receiver.startPosition.row + 1;
    if (line < startLine || line > endLine) return;
    const { text } = receiver;
    if (!COMPOUND_CHAIN_RE.test(text)) return;
    if (!chains.has(text)) chains.set(text, line);
  });

  for (const [chain, line] of chains) {
    const segments = chain.split(".");
    const root0 = segments[0];
    if (!root0) continue;
    // Root segment type from an already-established binding at this line.
    const rootType = resolveLocalBindingType(out, root0, line);
    if (!rootType) continue; // untyped root → no walk (honest fan-out)
    let currentType: string = rootType;
    let prefix = root0;
    const seenTypes = new Set<string>([currentType]); // cycle-guard
    // Cap at the chain's own segment count (a self-referential has_many can't loop).
    for (let i = 1; i < segments.length; i++) {
      const accessor = segments[i];
      if (!accessor) break;
      const nextType: string | undefined = associationTypes[currentType]?.[accessor];
      if (!nextType) break; // unknown hop STOPS the walk
      prefix = `${prefix}.${accessor}`;
      // Bind the prefix only when not already typed (e.g. a single-var binding).
      if (resolveLocalBindingType(out, prefix, line) === undefined) push(prefix, nextType, line);
      if (seenTypes.has(nextType)) break; // self-referential chain → stop
      seenTypes.add(nextType);
      currentType = nextType;
    }
  }
}
