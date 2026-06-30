# rvw34 — Chain-HEAD typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Type the chain HEAD (ivar from data-flow + `Const.new` chains) so the already-complete Rails association type-source fires on un-annotated Rails.

**Architecture:** Produce-side only. Three precise type-sources feed the existing `classFieldTypes` / chain-threading channels; the resolver/consume side is untouched. Zero name-classification, zero fabrication.

**Tech Stack:** TypeScript, tree-sitter-ruby, vitest. Spec: `docs/superpowers/specs/2026-06-30-rvw34-chain-head-typing-design.md`.

## Global Constraints

- **Precision-first, zero fabrication.** A source emits a type only from real data-flow (assignment RHS, YARD, `Const.new`). Never from a name heuristic.
- **Additive only on hub files.** `type-propagation.ts` (transitiveImpact 15, consumed by dynamic-dispatch + chain-type + union-dispatch) and `walker.ts` (fanIn 5) must keep existing `byReceiverKind` behavior — only ADD resolutions, never change existing ones.
- **Business-logic tests immutable.** Existing `collectRubyIvarFieldTypes(root)` calls stay green — new signature params are optional/defaulted. Add tests, never rewrite.
- **No `throw new Error`** — typed errors only (not expected to throw here; pure functions returning `undefined` on miss).
- **`dsl/` stays tree-sitter-free** — typing logic lives in `walker/` / `resolver/`, consumes DSL data.
- Reindex / live-validation on `bench-mastodon` is **user-gated** (never auto).

---

### Task 1: Const.new-chain head seed (gap b)

**Files:**
- Modify: `src/core/domains/language/ruby/resolver/type-propagation.ts` (`resolveChain`, ~185-207; add import + `CONST_HEAD` regex + `stripArgs`)
- Test: `tests/core/domains/language/ruby/resolver/type-propagation.test.ts`

**Interfaces:**
- Consumes: `RUBY_INSTANCE_RETURNING: Set<string>` from `../dsl/index.js`; existing `returnTypeOf`, `typeOfReceiver`, `chainMaxHops`.
- Produces: `typeOfReceiver("Const.new")` / `typeOfReceiver("Const.new.member"…)` → `{form:"instance", name:"Const"}` threaded; no new exports.

- [ ] **Step 1: Write the failing test**

In `type-propagation.test.ts`, add a describe block:

```ts
describe("resolveChain — Const.new-chain head seed (rvw34 gap b)", () => {
  const ctx = (over: Partial<CallContext> = {}): CallContext =>
    ({ localBindings: {}, callerScope: [], classAncestors: {}, structuredReturnTypes: {}, associationTypes: {}, ...over }) as CallContext;

  it("seeds Const.new as an instance of Const", () => {
    expect(typeOfReceiver("PostStatusService.new", 1, ctx())).toEqual({ form: "instance", name: "PostStatusService" });
  });

  it("seeds Const.new(args) (strips trailing arg list)", () => {
    expect(typeOfReceiver("PostStatusService.new(post)", 1, ctx())).toEqual({ form: "instance", name: "PostStatusService" });
  });

  it("threads a member after the new-seed via structuredReturnTypes", () => {
    const c = ctx({ structuredReturnTypes: { "PostStatusService#call": { form: "instance", name: "Status" } } });
    expect(typeOfReceiver("PostStatusService.new.call", 1, c)).toEqual({ form: "instance", name: "Status" });
  });

  it("does NOT type a bare-const head with a non-instance-returning first link", () => {
    expect(typeOfReceiver("Config.value", 1, ctx())).toBeUndefined();
  });

  it("scoped const head (A::B.new) seeds instance of A::B", () => {
    expect(typeOfReceiver("Mod::Svc.new", 1, ctx())).toEqual({ form: "instance", name: "Mod::Svc" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/type-propagation.test.ts -t "Const.new-chain"`
Expected: FAIL — `PostStatusService.new` head is a constant, `typeOfReceiver` returns `undefined` (chain seed undefined).

- [ ] **Step 3: Add import + helpers at top of `type-propagation.ts`**

After the existing imports:

```ts
import { RUBY_INSTANCE_RETURNING } from "../dsl/index.js";
```

Near the other module constants (after `IVAR_RECEIVER`):

```ts
/** A bare constant chain head: `Foo`, `Mod::Svc`. Capitalized, optional `::` scope. */
const CONST_HEAD = /^[A-Z]\w*(?:::[A-Z]\w*)*$/;

/** Strip a trailing call argument list from a chain segment (`new(post)` → `new`). */
function stripArgs(segment: string): string {
  const paren = segment.indexOf("(");
  return paren === -1 ? segment : segment.slice(0, paren);
}
```

- [ ] **Step 4: Rewrite the seed + walk in `resolveChain`**

Replace the seed-and-walk body (from `// Seed: resolve head…` through the `for (const link of links)` loop) with:

```ts
  let current: RubyTypeRef | undefined;
  let startLink = 0;
  // Const.new-chain (rvw34 gap b): a bare-constant head whose first link is
  // instance-returning (`new`/`find`/`create!`…) IS an instance of that constant
  // — `PostStatusService.new` is definitionally a PostStatusService. Zero
  // fabrication. A bare-const head with a non-instance-returning first link
  // (`Config.value`) is NOT typed.
  const firstLink = links[0];
  if (firstLink !== undefined && CONST_HEAD.test(head) && RUBY_INSTANCE_RETURNING.has(stripArgs(firstLink))) {
    current = { form: "instance", name: head };
    startLink = 1;
  } else {
    current = typeOfReceiver(head, atLine, ctx);
  }
  if (current === undefined) return undefined;

  // Walk remaining links left-to-right, threading type through each hop.
  for (let i = startLink; i < links.length; i++) {
    current = returnTypeOf(current, stripArgs(links[i]!), ctx);
    if (current === undefined) return undefined; // STOP-at-unknown-hop
  }

  return current;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/type-propagation.test.ts`
Expected: PASS (new block + all existing type-propagation tests green).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/resolver/type-propagation.ts tests/core/domains/language/ruby/resolver/type-propagation.test.ts
git commit -m "feat(language): seed Const.new-chain head as instance in resolveChain (rvw34 gap b)"
```

---

### Task 2: ivar typing from typed-param/local copy (gap a, C2)

**Files:**
- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts` (`collectRubyIvarFieldTypes` — add optional `associationTypes`, `code` params + method-scoped type env)
- Modify: `src/core/domains/language/ruby/walker/walker.ts:201` (pass `associationTypes`, `input.code`)
- Test: `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (in the existing `collectRubyIvarFieldTypes` describe at ~2391)

**Interfaces:**
- Consumes: existing `constInstanceType` (already imported), `collectYardParamTypes` (re-exported from this file), the `associationTypes` local in `extractFromRubyFile`, `input.code`.
- Produces: `collectRubyIvarFieldTypes(root, associationTypes?, code?)` — same return shape `Record<class, Record<@ivar, type>>`; `@x = typedParam` and `@x = typedLocal` now produce entries. Backward compatible (both new params optional/defaulted).

- [ ] **Step 1: Write the failing test**

In `ruby-walker.test.ts`, inside the `collectRubyIvarFieldTypes` describe (~2391), add:

```ts
it("types @ivar from a YARD-typed param copy (@account = account)", () => {
  const code = [
    "class PostStatusService",
    "  # @param [Account] account",
    "  def call(account)",
    "    @account = account",
    "  end",
    "end",
  ].join("\n");
  const root = parseRuby(code);
  expect(collectRubyIvarFieldTypes(root, {}, code)).toEqual({ PostStatusService: { "@account": "Account" } });
});

it("types @ivar from a local typed by Const.new earlier in the method", () => {
  const code = [
    "class Svc",
    "  def run",
    "    user = User.find(1)",
    "    @user = user",
    "  end",
    "end",
  ].join("\n");
  const root = parseRuby(code);
  expect(collectRubyIvarFieldTypes(root, {}, code)).toEqual({ Svc: { "@user": "User" } });
});

it("does NOT type @ivar from an untyped param (no YARD, no Const.new)", () => {
  const code = ["class Svc", "  def run(thing)", "    @thing = thing", "  end", "end"].join("\n");
  const root = parseRuby(code);
  expect(collectRubyIvarFieldTypes(root, {}, code)).toEqual({});
});
```

(Use the file's existing Ruby-parse helper — match the name used by the sibling tests in this describe, e.g. `parseRuby` / `rubyRoot`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "collectRubyIvarFieldTypes"`
Expected: FAIL — `@account = account` yields `{}` today (`constInstanceType("account")` is null).

- [ ] **Step 3: Widen the signature + add a method-scoped type env**

In `local-bindings.ts`, change the signature and walk. Replace the header + `collectIvars` with a method-aware collector:

```ts
import { collectYardParamTypes } from "./type-sources/yard.js";

// ... existing imports unchanged ...

export function collectRubyIvarFieldTypes(
  root: AstNode,
  associationTypes: Record<string, Record<string, string>> = {},
  code = "",
): Record<string, Record<string, string>> {
  const yardParamsByLine = code ? collectYardParamTypes(code) : new Map<number, Record<string, string>>();
  const out: Record<string, Record<string, string>> = {};

  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
      const body = node.childForFieldName("body");

      const fields: Record<string, string> = {};
      const collectInClass = (n: AstNode): void => {
        if (n.type === "class" || n.type === "module") return;
        if (n.type === "method" || n.type === "singleton_method") {
          const env = methodTypeEnv(n, yardParamsByLine);
          collectIvarAssignmentsInMethod(n, env, fields);
          return; // collectIvarAssignmentsInMethod walks the body
        }
        // Class-body-level ivar assignment (rare) — no method env.
        recordIvarAssignment(n, {}, fields);
        for (const child of n.children) collectInClass(child);
      };
      for (const child of (body ?? node).children) collectInClass(child);
      if (Object.keys(fields).length > 0) out[fq] = { ...(out[fq] ?? {}), ...fields };

      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return out;
}
```

Add the helpers below `collectRubyIvarFieldTypes`:

```ts
/**
 * Build a method-scoped `localName → typeName` env: YARD `@param` types at the
 * def line, then a source-order pass binding `local = Const.new`/finder
 * (constInstanceType) and copy-propagation `local = otherTypedLocal`.
 * Last-write-wins (later reassignment shadows earlier).
 */
function methodTypeEnv(method: AstNode, yardParamsByLine: Map<number, Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = { ...(yardParamsByLine.get(method.startPosition.row + 1) ?? {}) };
  const body = method.childForFieldName("body");
  const scan = (n: AstNode): void => {
    if (n.type === "class" || n.type === "module" || n.type === "method" || n.type === "singleton_method") return;
    if (n.type === "assignment") {
      const lhs = n.childForFieldName("left");
      const rhs = n.childForFieldName("right");
      if (lhs?.type === "identifier" && rhs) {
        const direct = constInstanceType(rhs);
        if (direct) env[lhs.text] = direct;
        else if (rhs.type === "identifier" && env[rhs.text]) env[lhs.text] = env[rhs.text]!;
      }
    }
    for (const child of n.children) scan(child);
  };
  for (const child of (body ?? method).children) scan(child);
  return env;
}

/**
 * Record `@ivar = <rhs>` into `fields` using (in precedence order):
 *  1. constInstanceType(rhs) — `@x = Const.new`/finder (preserves prior behavior).
 *  2. env[rhs] — typed-param / typed-local copy (`@x = account`).
 * Last-write-wins. Returns nothing; mutates `fields`.
 */
function recordIvarAssignment(n: AstNode, env: Record<string, string>, fields: Record<string, string>): void {
  if (n.type !== "assignment") return;
  const lhs = n.childForFieldName("left");
  const rhs = n.childForFieldName("right");
  if (lhs?.type !== "instance_variable" || !rhs) return;
  const direct = constInstanceType(rhs);
  if (direct) { fields[lhs.text] = direct; return; }
  if (rhs.type === "identifier" && env[rhs.text]) fields[lhs.text] = env[rhs.text]!;
}

/** Walk a method body recording every `@ivar = <rhs>` against the method's type env. */
function collectIvarAssignmentsInMethod(method: AstNode, env: Record<string, string>, fields: Record<string, string>): void {
  const walkBody = (n: AstNode): void => {
    if (n.type === "class" || n.type === "module") return;
    recordIvarAssignment(n, env, fields);
    for (const child of n.children) walkBody(child);
  };
  const body = method.childForFieldName("body");
  for (const child of (body ?? method).children) walkBody(child);
}
```

- [ ] **Step 4: Wire the new args in `walker.ts:201`**

Replace line 201:

```ts
    const ivarFieldTypes = collectRubyIvarFieldTypes(input.tree.rootNode, associationTypes, input.code);
```

(`associationTypes` is already computed in `extractFromRubyFile`; `input.code` is the file source. `associationTypes` is unused in Task 2 but threaded now so Task 3 needs no further walker edit.)

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts tests/core/domains/language/ruby/walker/local-bindings.test.ts`
Expected: PASS — new C2 tests green; all existing `collectRubyIvarFieldTypes(root)` tests still green (defaulted params).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/walker/local-bindings.ts src/core/domains/language/ruby/walker/walker.ts tests/core/domains/language/ruby/walker/ruby-walker.test.ts
git commit -m "feat(language): type @ivar from typed-param/local copy in collectRubyIvarFieldTypes (rvw34 gap a C2)"
```

---

### Task 3: ivar typing from chain-RHS association threading (gap a, C3)

**Files:**
- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts` (extend `recordIvarAssignment` with chain-RHS threading; add `threadChainRhsType`)
- Test: `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (same `collectRubyIvarFieldTypes` describe)

**Interfaces:**
- Consumes: `associationTypes` (now threaded into the collector from Task 2), the method/ivar `env`+`fields` type maps, `RUBY_INSTANCE_RETURNING` from `../dsl/index.js`.
- Produces: `@x = head.assoc[.assoc][.new|.first]` → element-model entry (e.g. `@status = @account.statuses.new` → `Status`). No new exports.

- [ ] **Step 1: Write the failing test**

Add to the `collectRubyIvarFieldTypes` describe:

```ts
it("types @ivar from a chain RHS through associations + instance-returning tail", () => {
  const code = [
    "class PostStatusService",
    "  # @param [Account] account",
    "  def call(account)",
    "    @account = account",
    "    @status = @account.statuses.new",
    "  end",
    "end",
  ].join("\n");
  const assoc = { Account: { statuses: "Status" } };
  const root = parseRuby(code);
  expect(collectRubyIvarFieldTypes(root, assoc, code)).toEqual({
    PostStatusService: { "@account": "Account", "@status": "Status" },
  });
});

it("stops chain-RHS at an unknown association hop (no fabrication)", () => {
  const code = [
    "class Svc",
    "  # @param [Account] account",
    "  def run(account)",
    "    @x = account.unknown_assoc.new",
    "  end",
    "end",
  ].join("\n");
  const root = parseRuby(code);
  expect(collectRubyIvarFieldTypes(root, { Account: {} }, code)).toEqual({});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "chain RHS"`
Expected: FAIL — `@status` absent (chain RHS not threaded yet).

- [ ] **Step 3: Add chain-RHS threading**

In `local-bindings.ts`, add the import:

```ts
import { RUBY_INSTANCE_RETURNING } from "../dsl/index.js";
```

Extend `recordIvarAssignment` to accept `associationTypes` + `fields` for head lookup, and fall through to chain threading. Replace `recordIvarAssignment` with:

```ts
function recordIvarAssignment(
  n: AstNode,
  env: Record<string, string>,
  fields: Record<string, string>,
  associationTypes: Record<string, Record<string, string>>,
): void {
  if (n.type !== "assignment") return;
  const lhs = n.childForFieldName("left");
  const rhs = n.childForFieldName("right");
  if (lhs?.type !== "instance_variable" || !rhs) return;
  const direct = constInstanceType(rhs);
  if (direct) { fields[lhs.text] = direct; return; }
  if (rhs.type === "identifier" && env[rhs.text]) { fields[lhs.text] = env[rhs.text]!; return; }
  const chained = threadChainRhsType(rhs.text, env, fields, associationTypes);
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
): string | undefined {
  if (!text.includes(".")) return undefined;
  const segments = text.split(".");
  const head = segments[0];
  if (head === undefined) return undefined;
  let current: string | undefined = head.startsWith("@") ? fields[head] : env[head];
  if (!current) return undefined;
  const seen = new Set<string>([current]); // cycle guard (self-referential has_many)
  for (let i = 1; i < segments.length; i++) {
    const link = stripArgsLocal(segments[i]!);
    if (RUBY_INSTANCE_RETURNING.has(link)) continue; // `.new`/`.first` on a relation → keep element model
    const next = associationTypes[current]?.[link];
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
```

Update the two call sites to pass `associationTypes`:
- in `collectInClass`: `recordIvarAssignment(n, {}, fields, associationTypes);`
- in `collectIvarAssignmentsInMethod`: thread `associationTypes` through (add it as a param and pass from `collectInClass`'s `methodTypeEnv` branch: `collectIvarAssignmentsInMethod(n, env, fields, associationTypes)`), then `recordIvarAssignment(n, env, fields, associationTypes)` inside `walkBody`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts tests/core/domains/language/ruby/walker/local-bindings.test.ts`
Expected: PASS — C3 tests green, C2 + existing green.

- [ ] **Step 5: Full type-check + ruby suite + lint**

Run: `npx tsc --noEmit && npx vitest run tests/core/domains/language/ruby && npx eslint src/core/domains/language/ruby/walker/local-bindings.ts src/core/domains/language/ruby/resolver/type-propagation.ts`
Expected: tsc 0 errors, all ruby tests pass, eslint clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/walker/local-bindings.ts tests/core/domains/language/ruby/walker/ruby-walker.test.ts
git commit -m "feat(language): type @ivar from chain-RHS association threading (rvw34 gap a C3)"
```

---

### Task 4: Capability sync + live-validation (user-gated)

**Files:**
- Possibly modify: `src/core/domains/language/ruby/capability.ts` (only if the codegraph tier text changes — likely no tier move, additive precision)
- Regenerate (if capability changed): `npm run gen:lang-compat`

- [ ] **Step 1: Re-review ruby `capability.ts`**

Read `src/core/domains/language/ruby/capability.ts`. The change is additive receiver-typing precision; it does NOT move the `codegraph` tier. If `tech` text enumerates type-inference sources, append ivar-copy / chain-RHS / Const.new-chain; otherwise leave untouched. Do NOT bake measured `resolveSuccessRate` numbers in.

- [ ] **Step 2: Regen lang-compat only if descriptor changed**

Run (only if Step 1 edited the descriptor): `npm run gen:lang-compat`
Then: `npx vitest run tests/core/domains/language/capability/drift-guard.test.ts`
Expected: drift-guard green.

- [ ] **Step 3: Build + link (single-worktree gate — ASK if >1 worktree active)**

Check `git worktree list`. If exactly one worktree under `.claude/worktrees/`, run `npm run build && npm link`. If >1, STOP and ask the user before building.

- [ ] **Step 4: Live-validation on bench-mastodon (USER-GATED)**

STOP. Ask the user to trigger reindex ("замер"). Do NOT reindex automatically. On user go:
`tea-rags index-codebase --project bench-mastodon --wait-enrichments --force --json`
Then measure: `mcp__tea-rags__get_index_status project=bench-mastodon` (codegraphResolve `byReceiverKind`) — expect `account`/`account_id` dynamic fan-out to drop and `resolveSuccessRate` to rise, with **no precision regression** elsewhere. Confirm `PostStatusService#call` now has callers / its ivar receivers resolve.

- [ ] **Step 5: Commit capability artifacts (only if regenerated)**

```bash
git add src/core/domains/language/ruby/capability.ts .claude-plugin/tea-rags/rules/language-compatibility.md README.md
git commit -m "docs(language): sync ruby capability for chain-HEAD typing (rvw34)"
```

---

## Self-Review

- **Spec coverage:** gap b → Task 1; gap a C2 (typed-copy) → Task 2; gap a C3 (chain-RHS) → Task 3; capability sync + live-validation → Task 4. schema.rb / name-classification explicitly out of scope (spec). ✓
- **Type consistency:** `collectRubyIvarFieldTypes(root, associationTypes?, code?)` signature stable across Tasks 2-3; `recordIvarAssignment` gains `associationTypes` param in Task 3 (single definition, updated call sites). `stripArgs` (type-propagation) vs `stripArgsLocal` (local-bindings) — distinct files, no clash. ✓
- **Hub safety:** all changes additive; existing tests are the byReceiverKind oracle. ✓
- **Placeholder scan:** all steps carry real code/commands. ✓
