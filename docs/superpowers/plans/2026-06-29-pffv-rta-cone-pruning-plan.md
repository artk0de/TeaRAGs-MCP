# pffv — RTA Pruning of CHA Cones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. When a step's cycle would invoke
> superpowers:test-driven-development, invoke
> **dinopowers:test-driven-development** instead.

**Goal:** Prune the already-merged CHA cone fan-out (`ConeDispatchResolver`) to
only the subtypes that are the nearest method definer for some program-wide
_instantiated_ type — Rapid Type Analysis (RTA), a precision add-on over the
2jet cone engine.

**Architecture:** A program-wide instantiation set (`Klass.new` + factory/finder
calls via `RUBY_INSTANCE_RETURNING`) is collected per-file by the Ruby walker
into `FileExtraction.instantiatedTypes`, merged run-global by the codegraph
provider exactly like `functionReturnTypes` (`runInstantiatedTypes`), and
injected into `CallContext.instantiatedTypes`.
`ConeDispatchResolver#resolveDispatch` reads it and, before the coneMax
threshold, drops every cone member that is not `nearestDefiner(U, m)` for some
instantiated `U <: T`. A soundness floor keeps the unpruned cone when there is
zero instantiation evidence, and the whole prune is gated on the set being
present so non-Ruby languages and pre-pffv indices are byte-identical.

**Tech Stack:** TypeScript, tree-sitter (ruby grammar), DuckDB codegraph,
vitest.

## Global Constraints

- **PRECISION work, NOT a relocation refactor.** `byReceiverKind` /
  `resolveSuccessRate` MAY move; `edgeKinds.cone` is EXPECTED to DROP (false
  fan-out pruned) and some cones collapse to a single edge. The win is validated
  LIVE on huginn + mastodon, not by byte-identity.
- **Additive gate (mandatory).** Every behaviour change is gated on
  `ctx.instantiatedTypes` being present and non-empty. Absent / empty ⇒
  identical pre-pffv path. `cone-dispatch.ts` has transitiveImpact 22 — a
  non-additive change ripples to 22 files.
- **Soundness floor (mandatory).** Pruning may only NARROW a non-empty cone,
  never zero it out. Empty prune ⇒ keep the original cone.
- **TDD mandatory** (net-new behaviour): failing test FIRST (red) → minimal impl
  (green) → commit. Use dinopowers:test-driven-development.
- **Name-key form** = the fq form `HierarchyView` uses (`sourceFqName` /
  `ancestorFqName`). `constInstanceType` already returns Zeitwerk-resolved fq
  consts; a key that does not match a hierarchy node simply finds no
  instantiated `U` and the floor keeps the cone — safe degradation, never a
  crash.
- **Each task = own commit**, conventional commits
  (`feat(contracts|trajectory|...)`), body lines ≤100 chars.
- **Regression net** between tasks:
  `npx vitest run tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`
  (~1065 tests).
- **Builds on pg5ya** (committed on this branch `worktree-inheritance-dispatch`,
  not merged): `RUBY_INSTANCE_RETURNING` is grammar-owned (`dsl/catalogue.ts`,
  re-exported via `dsl/index.js`) and `constInstanceType` already reads it.

---

## File Structure

| File                                                                          | Change                  | Responsibility                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/contracts/types/codegraph.ts`                                       | Modify (2 fields)       | `FileExtraction.instantiatedTypes?: string[]` (NDJSON-spill array) + `CallContext.instantiatedTypes?: ReadonlySet<string>` (run-global injected set).               |
| `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`         | Modify (+1 exported fn) | `collectRubyInstantiatedTypes(root): string[]` — reuses `constInstanceType` at every call node. Lives beside `constInstanceType` (same module owns the classifier). |
| `src/core/domains/language/ruby/walker/walker.ts`                             | Modify (wire)           | Call `collectRubyInstantiatedTypes` in `extractFromRubyFile`, attach to `out.instantiatedTypes`. Does NOT touch `collectRubyCalls`.                                 |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts`                   | Modify (thread)         | `runInstantiatedTypes: Set<string>` field; merge in pass-1 loop; reset at all 3 reset sites; inject into the per-call `CallContext`.                                |
| `src/core/domains/language/cone-dispatch.ts`                                  | Modify (prune)          | `nearestDefiner` helper + RTA prune in `resolveDispatch`, gated + floored.                                                                                          |
| `tests/core/domains/language/ruby/walker/ast-inference-instantiation.test.ts` | Create                  | Unit tests for `collectRubyInstantiatedTypes`.                                                                                                                      |
| `tests/core/domains/language/cone-dispatch.test.ts`                           | Create                  | Unit tests for the prune (fake `ConeTypeLocator` + `MapHierarchyView`).                                                                                             |
| `tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts`       | Modify                  | Add a run-global instantiation-threading + end-to-end prune case.                                                                                                   |

---

## Task 1: Contracts — instantiatedTypes fields

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (`FileExtraction` ends line
  380; `CallContext` ends line 846)

**Interfaces:**

- Produces: `FileExtraction.instantiatedTypes?: string[]`,
  `CallContext.instantiatedTypes?: ReadonlySet<string>` — consumed by Tasks 2,
  3, 4.

- [ ] **Step 1: Add the `FileExtraction` field**

In `src/core/contracts/types/codegraph.ts`, after the `structuredReturnTypes?`
field (line 379), before the closing `}` of `FileExtraction` (line 380), add:

```ts
  /**
   * Optional program-wide instantiation set for RTA cone pruning (bd
   * tea-rags-mcp-pffv): the fully-qualified constants this file instantiates
   * via `Klass.new` or a factory/finder in `RUBY_INSTANCE_RETURNING`
   * (`User.find`, `Account.create!`, `Const.where(...).first`). The provider
   * merges these run-global (pass-1 barrier, mirroring `functionReturnTypes`)
   * so `ConeDispatchResolver` can prune a CHA cone to the subtypes that are the
   * nearest definer of `m` for some INSTANTIATED type — cutting false fan-out.
   *
   * Plain array (NOT Set) so the value round-trips through the NDJSON spill.
   * Undefined for languages whose walkers don't collect instantiation sites.
   */
  instantiatedTypes?: string[];
```

- [ ] **Step 2: Add the `CallContext` field**

In the same file, after the `structuredReturnTypes?` field of `CallContext`
(line 845), before the closing `}` of `CallContext` (line 846), add:

```ts
  /**
   * Run-global instantiation set merged from every file's
   * `FileExtraction.instantiatedTypes` (bd tea-rags-mcp-pffv). Built by the
   * provider at the pass-1→pass-2 barrier, mirroring `functionReturnTypes`.
   * `ConeDispatchResolver` reads it to prune the CHA cone via RTA: a cone
   * member survives only when it is `nearestDefiner(U, m)` for some
   * instantiated `U <: T`. Absent / empty ⇒ the cone engine keeps its full
   * pre-pffv fan-out (the gate). Key form matches `HierarchyView` fq names.
   */
  instantiatedTypes?: ReadonlySet<string>;
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit -p tsconfig.json` Expected: PASS (additive optional
fields, no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add src/core/contracts/types/codegraph.ts
git commit -m "feat(contracts): instantiatedTypes fields for RTA cone pruning (pffv Task 1)"
```

---

## Task 2: Ruby walker — collect instantiation sites

**Files:**

- Modify: `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`
  (add `collectRubyInstantiatedTypes`; `constInstanceType` is at line 46, `walk`
  already imported line 5)
- Modify: `src/core/domains/language/ruby/walker/walker.ts`
  (`extractFromRubyFile` line 81; `out` assembled line 136; `returnTypes` wired
  line 167-169)
- Test:
  `tests/core/domains/language/ruby/walker/ast-inference-instantiation.test.ts`

**Interfaces:**

- Consumes: `constInstanceType(node)` (existing, `ast-inference.ts:46`),
  `FileExtraction.instantiatedTypes` (Task 1).
- Produces: `collectRubyInstantiatedTypes(root: AstNode): string[]` — deduped fq
  consts; `extractFromRubyFile` attaches them to `out.instantiatedTypes`.

- [ ] **Step 1: Write the failing test**

Create
`tests/core/domains/language/ruby/walker/ast-inference-instantiation.test.ts`:

```ts
import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { collectRubyInstantiatedTypes } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";

function parse(code: string): Parser.Tree {
  const p = new Parser();
  p.setLanguage(Ruby as Parser.Language);
  return p.parse(code);
}

describe("collectRubyInstantiatedTypes", () => {
  it("collects constructors, factories, finders and relation tails; dedups", () => {
    const tree = parse(
      [
        "user = User.new",
        "post = Post.find(1)",
        "acct = Account.create!(name: 'x')",
        "first = Comment.where(approved: true).first",
        "dup = User.new", // duplicate — must dedup
        "n = compute(2)", // bare call — no const, ignored
      ].join("\n"),
    );
    const got = collectRubyInstantiatedTypes(tree.rootNode).sort();
    expect(got).toEqual(["Account", "Comment", "Post", "User"]);
  });

  it("returns [] when nothing is instantiated", () => {
    const tree = parse("x = compute(1)\ny = x + 2\n");
    expect(collectRubyInstantiatedTypes(tree.rootNode)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ast-inference-instantiation.test.ts`
Expected: FAIL — `collectRubyInstantiatedTypes` is not exported.

- [ ] **Step 3: Implement `collectRubyInstantiatedTypes`**

In `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`, after
`constInstanceType` (line 58), add:

```ts
/**
 * Collect the program's instantiation set for one Ruby file (bd
 * tea-rags-mcp-pffv): every fully-qualified constant instantiated via
 * `Klass.new` or a factory/finder in `RUBY_INSTANCE_RETURNING` — exactly the
 * sites {@link constInstanceType} already classifies. Deduped. The provider
 * unions these across files into the run-global RTA set used to prune CHA
 * cones. Pure AST walk; no symbol-table access (walker discipline).
 */
export function collectRubyInstantiatedTypes(root: AstNode): string[] {
  const seen = new Set<string>();
  walk(root, (node) => {
    if (node.type !== "call" && node.type !== "method_call") return;
    const fqConst = constInstanceType(node);
    if (fqConst) seen.add(fqConst);
  });
  return [...seen];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ast-inference-instantiation.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `extractFromRubyFile`**

In `src/core/domains/language/ruby/walker/walker.ts`, import the new collector —
extend the existing import of the type-source module (the file already imports
`constInstanceType`-adjacent helpers; add `collectRubyInstantiatedTypes` to that
import group from `./type-sources/ast-inference.js`).

Then, immediately after the `functionReturnTypes` wiring (line 169, the
`if (Object.keys(returnTypes).length > 0) out.functionReturnTypes = returnTypes;`
line), add:

```ts
// RTA instantiation set (bd tea-rags-mcp-pffv): fq consts this file
// instantiates (`Klass.new` / factory / finder). Gated on the same
// type-tracking env as the other inference channels — without local-type
// tracking the cone engine has no localBindings to fan out anyway. The
// provider unions these run-global to prune CHA cones to live subtypes.
const instantiatedTypes = trackTypes
  ? collectRubyInstantiatedTypes(input.tree.rootNode)
  : [];
if (instantiatedTypes.length > 0) out.instantiatedTypes = instantiatedTypes;
```

- [ ] **Step 6: Write a wiring test on `extractFromRubyFile`**

Append to the same test file (`ast-inference-instantiation.test.ts`) a case that
calls `extractFromRubyFile` on a small fixture and asserts
`out.instantiatedTypes` contains the expected consts. Mirror the harness used by
the existing ruby walker tests for `functionReturnTypes` (find it via
`find_symbol(relativePath: "tests/core/domains/language/ruby/walker/ruby-walker.test.ts")`
to copy the `extractFromRubyFile` input shape and the `localTypeTrackingEnabled`
env setup verbatim — DO NOT invent a new harness).

- [ ] **Step 7: Run the regression gate**

Run: `npx vitest run tests/core/domains/language/ruby` Expected: PASS (existing
ruby walker tests untouched-green + new instantiation tests pass).

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/ast-inference.ts \
        src/core/domains/language/ruby/walker/walker.ts \
        tests/core/domains/language/ruby/walker/ast-inference-instantiation.test.ts
git commit -m "feat(trajectory): collect ruby instantiation set into FileExtraction (pffv Task 2)"
```

---

## Task 3: Provider — thread the run-global instantiation set

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  - `runReturnTypes` field declared line 461 (add `runInstantiatedTypes` beside
    it)
  - pass-1 merge loop line 749-753 (merge after `functionReturnTypes`)
  - empty-run reset line 1072; `clearRunState` line 1590; `onRelease` line 1628
    (3 reset sites)
  - `returnTypesForResolver` computed line 1829-1830 (add
    `instantiatedForResolver` beside it)
  - per-call `ctx` object line 1874-1900 (inject; the `hierarchy:` key is
    line 1899)
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts`
  (extend)

**Interfaces:**

- Consumes: `FileExtraction.instantiatedTypes` (Task 2),
  `CallContext.instantiatedTypes` (Task 1).
- Produces: a populated `ctx.instantiatedTypes` on the per-call `CallContext` —
  consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Extend `tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts`
with a case proving the run-global merge reaches the resolver. Read the existing
cone end-to-end test first
(`find_symbol(relativePath: "tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts")`)
and reuse its two-file fixture harness. The new case: file A instantiates only a
subset of a cone's subtypes; assert that the persisted method edges fan out ONLY
to the instantiated subtypes (the end-to-end manifestation of pffv). Name it
`"RTA: cone prunes to the program-wide instantiation set"`.

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts`
Expected: FAIL — without threading + Task 4 the cone still fans out to every
overriding subtype.

(Task 3 alone makes the data available; the assertion goes green only after
Task 4. If subagent-driven, mark this test `.skip` with a
`// unskipped in Task 4` comment after Step 2 confirms it fails for the right
reason, then unskip in Task 4 Step 1. This keeps Task 3's commit green.)

- [ ] **Step 3: Declare the run-global field**

In `provider.ts`, after the `runReturnTypes` declaration (line 461), add:

```ts
  /**
   * Per-run aggregation of `FileExtraction.instantiatedTypes` (bd
   * tea-rags-mcp-pffv). The union of every instantiated fq const across pass-1
   * files, so `ConeDispatchResolver` can RTA-prune a CHA cone regardless of
   * which file does the `Klass.new`. Same lifecycle as `runReturnTypes` — reset
   * on finish / empty-run / release.
   */
  private runInstantiatedTypes = new Set<string>();
```

- [ ] **Step 4: Merge in the pass-1 loop**

In `provider.ts`, immediately after the `functionReturnTypes` merge block (lines
749-753), add:

```ts
// Union this file's instantiation set into the run-global RTA set so
// the cone resolver in pass-2 prunes by program-wide instantiation
// regardless of which file instantiates the type. bd tea-rags-mcp-pffv.
if (extraction.instantiatedTypes) {
  for (const t of extraction.instantiatedTypes)
    this.runInstantiatedTypes.add(t);
}
```

- [ ] **Step 5: Reset at all 3 sites**

Add `this.runInstantiatedTypes.clear();` to each reset site, mirroring
`runReturnTypes`:

- Empty-run reset (line 1072, where `this.runReturnTypes = {};`) — add
  `this.runInstantiatedTypes.clear();`
- `clearRunState` (line 1590, beside `this.runReturnTypes = {};`) — add
  `this.runInstantiatedTypes.clear();`
- `onRelease` (line 1628, beside `this.runReturnTypes = {};`) — add
  `this.runInstantiatedTypes.clear();`

- [ ] **Step 6: Compute the resolver-facing set + inject into the per-call ctx**

In `provider.ts`, beside `returnTypesForResolver` (lines 1829-1830), add:

```ts
// Run-global instantiation set if any file contributed, else this file's
// own (mirrors the returnTypes "run-global if present else extraction"
// pattern). bd tea-rags-mcp-pffv.
const instantiatedForResolver =
  this.runInstantiatedTypes.size > 0
    ? this.runInstantiatedTypes
    : new Set(extraction.instantiatedTypes ?? []);
```

Then in the per-call `ctx` object literal, immediately after the
`hierarchy: this.hierarchyView,` line (line 1899), add:

```ts
          // bd tea-rags-mcp-pffv — run-global instantiation set drives RTA
          // pruning of the CHA cone. Empty ⇒ cone keeps full fan-out (gate).
          instantiatedTypes: instantiatedForResolver,
```

(Do NOT add it to the `fileEdgeCtx` object — cone dispatch only runs on
method-level edges.)

- [ ] **Step 7: Run the regression gate**

Run: `npx vitest run tests/core/domains/trajectory/codegraph` Expected: PASS
(existing codegraph tests green; the new pffv case still `.skip` per Step 2).

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts \
        tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts
git commit -m "feat(trajectory): thread run-global instantiation set into CallContext (pffv Task 3)"
```

---

## Task 4: Cone-dispatch — the RTA prune

**Files:**

- Modify: `src/core/domains/language/cone-dispatch.ts` (`resolveDispatch` lines
  44-89; the override loop is lines 56-60; `resolveBaseDecl` line 98)
- Test: `tests/core/domains/language/cone-dispatch.test.ts` (create)
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts`
  (unskip the Task 3 case)

**Interfaces:**

- Consumes: `CallContext.instantiatedTypes` (Task 1/3),
  `ConeTypeLocator.findDirectMethod` (existing, `language.ts:105`),
  `HierarchyView.getAncestors(fqName, {ordered, transitive})` (existing, returns
  `InheritanceEdge[]` with `ancestorFqName`).

- [ ] **Step 1: Write the failing unit test**

Create `tests/core/domains/language/cone-dispatch.test.ts` with a fake
`ConeTypeLocator` and a real `MapHierarchyView`:

```ts
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  HierarchySnapshot,
  InheritanceEdgeRow,
  SymbolResolutionTarget,
} from "../../../../src/core/contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../src/core/contracts/types/language.js";
import { ConeDispatchResolver } from "../../../../src/core/domains/language/cone-dispatch.js";
import { MapHierarchyView } from "../../../../src/core/infra/graph/hierarchy-view.js";

// Hierarchy: A, B, C all extend Base; each subtype `t` overrides `m` iff
// overriders.has(t). Base also defines `m` (the inherited fallback).
function buildCtx(opts: {
  overriders: Set<string>;
  instantiated?: Set<string>;
}): { ctx: CallContext; locator: ConeTypeLocator } {
  const rows: InheritanceEdgeRow[] = ["A", "B", "C"].map((s, i) => ({
    sourceFqName: s,
    ancestorFqName: "Base",
    ancestorSymbolId: null,
    kind: "super",
    ordinal: i,
  }));
  const snapshot: HierarchySnapshot = {
    ancestorsBySource: { A: [rows[0]], B: [rows[1]], C: [rows[2]] },
    descendantsByAncestor: { Base: rows },
  };
  const locator: ConeTypeLocator = {
    resolveTypeFile: (t) => `${t.toLowerCase()}.rb`,
    findDirectMethod: (t, member): SymbolResolutionTarget | null =>
      member === "m" && (opts.overriders.has(t) || t === "Base")
        ? { targetRelPath: `${t.toLowerCase()}.rb`, targetSymbolId: `${t}#m` }
        : null,
  };
  const ctx = {
    callerFile: "caller.rb",
    callerScope: [],
    imports: [],
    symbolTable: {} as never,
    localBindings: { obj: [{ line: 1, type: "Base" }] },
    hierarchy: new MapHierarchyView(snapshot),
    instantiatedTypes: opts.instantiated,
  } as unknown as CallContext;
  return { ctx, locator };
}

const call: CallRef = { receiver: "obj", member: "m", startLine: 1 } as CallRef;

describe("ConeDispatchResolver — RTA prune (bd pffv)", () => {
  it("prunes the cone to instantiated subtypes only", () => {
    const { ctx, locator } = buildCtx({
      overriders: new Set(["A", "B", "C"]),
      instantiated: new Set(["A"]),
    });
    const edges = new ConeDispatchResolver(locator, 8).resolveDispatch(
      call,
      ctx,
    );
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["A#m"]);
  });

  it("soundness floor: zero instantiation evidence keeps the full cone", () => {
    const { ctx, locator } = buildCtx({
      overriders: new Set(["A", "B", "C"]),
      instantiated: new Set(["Unrelated"]),
    });
    const edges = new ConeDispatchResolver(locator, 8).resolveDispatch(
      call,
      ctx,
    );
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual([
      "A#m",
      "B#m",
      "C#m",
    ]);
  });

  it("gate: absent instantiatedTypes is byte-identical pre-pffv (full cone)", () => {
    const { ctx, locator } = buildCtx({ overriders: new Set(["A", "B", "C"]) });
    const edges = new ConeDispatchResolver(locator, 8).resolveDispatch(
      call,
      ctx,
    );
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual([
      "A#m",
      "B#m",
      "C#m",
    ]);
  });

  it("drops a sibling whose nearest definer is the uninstantiated base", () => {
    // Only A overrides m; B,C inherit Base#m. Instantiate A and B.
    // A is live (definer A); B's nearest definer is Base (not in cone) ⇒ B's
    // cone slot does not exist (B doesn't override). Cone = {A} pre-prune,
    // stays {A}.
    const { ctx, locator } = buildCtx({
      overriders: new Set(["A"]),
      instantiated: new Set(["A", "B"]),
    });
    const edges = new ConeDispatchResolver(locator, 8).resolveDispatch(
      call,
      ctx,
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/domains/language/cone-dispatch.test.ts`
Expected: FAIL — the prune case returns `["A#m","B#m","C#m"]` (no pruning yet).

- [ ] **Step 3: Implement the prune**

In `src/core/domains/language/cone-dispatch.ts`, replace the override loop + `n`
computation (lines 56-63):

```ts
// Keep only subtypes that DIRECTLY override `m` (a method-level pin) — an
// inheriting subtype that doesn't redefine `m` adds no new target.
const overrides: SymbolResolutionTarget[] = [];
for (const subtype of subtypes) {
  const target = this.locator.findDirectMethod(subtype, call.member, ctx);
  if (target) overrides.push(target);
}

const n = overrides.length;
if (n === 0) return [];
```

with a version that keys overrides by subtype and applies the RTA prune:

```ts
// Keep only subtypes that DIRECTLY override `m` (a method-level pin) — an
// inheriting subtype that doesn't redefine `m` adds no new target. Keyed by
// subtype so the RTA prune (below) can map an instantiated type's nearest
// definer back to its cone member.
const overrideBySubtype = new Map<string, SymbolResolutionTarget>();
for (const subtype of subtypes) {
  const target = this.locator.findDirectMethod(subtype, call.member, ctx);
  if (target) overrideBySubtype.set(subtype, target);
}
if (overrideBySubtype.size === 0) return [];

// RTA prune (bd tea-rags-mcp-pffv): keep a cone member only when it is the
// nearest definer of `m` for some INSTANTIATED type `U <: T`. Gated on the
// run-global instantiation set being present and non-empty — absent ⇒
// pre-pffv full cone (the cone engine is shared across languages; only
// Ruby populates the set initially). Soundness floor: an empty prune keeps
// the unpruned cone (zero-evidence metaprogramming case).
let live = overrideBySubtype;
if (ctx.instantiatedTypes && ctx.instantiatedTypes.size > 0) {
  const pruned = new Map<string, SymbolResolutionTarget>();
  for (const u of [baseType, ...subtypes]) {
    if (!ctx.instantiatedTypes.has(u)) continue;
    const definer = this.nearestDefiner(u, call.member, ctx);
    const target = definer ? overrideBySubtype.get(definer) : undefined;
    if (definer && target) pruned.set(definer, target);
  }
  if (pruned.size > 0) live = pruned;
}

const overrides = [...live.values()];
const n = overrides.length;
```

Then add the `nearestDefiner` helper next to `resolveBaseDecl` (after line 103):

```ts
  /**
   * The class that DEFINES `member` for an instance of `typeName`: `typeName`
   * itself if it declares `member`, else the first ancestor in MRO order that
   * does (bd tea-rags-mcp-pffv). This is the runtime dispatch target for an
   * instance of `typeName`; RTA keeps a cone member iff it is the nearest
   * definer for some instantiated type. Returns the fq class name, or null when
   * no class on the chain declares `member`.
   */
  private nearestDefiner(typeName: string, member: string, ctx: CallContext): string | null {
    if (this.locator.findDirectMethod(typeName, member, ctx)) return typeName;
    if (!ctx.hierarchy) return null;
    for (const edge of ctx.hierarchy.getAncestors(typeName, { ordered: true, transitive: true })) {
      if (this.locator.findDirectMethod(edge.ancestorFqName, member, ctx)) return edge.ancestorFqName;
    }
    return null;
  }
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run tests/core/domains/language/cone-dispatch.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Unskip the provider end-to-end case**

Remove the `.skip` added in Task 3 Step 2 from the
`"RTA: cone prunes to the program-wide instantiation set"` case.

- [ ] **Step 6: Run the full regression gate**

Run:
`npx vitest run tests/core/domains/language tests/core/domains/trajectory/codegraph`
Expected: PASS. The existing `provider-cone.test.ts` cone cases stay green (they
have no `instantiatedTypes` in their fixtures ⇒ gate keeps full cone —
byte-identical). If any pre-existing cone case goes red, its fixture now carries
an instantiation set that prunes it — investigate before touching the test; the
gate should make this impossible.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/cone-dispatch.ts \
        tests/core/domains/language/cone-dispatch.test.ts \
        tests/core/domains/trajectory/codegraph/symbols/provider-cone.test.ts
git commit -m "feat(trajectory): RTA prune CHA cone to instantiated nearest-definers (pffv Task 4)"
```

---

## Task 5: Live validation on huginn + mastodon

**Files:** none (validation gate).

This task is the precision proof. It is NOT byte-identity — `edgeKinds.cone` is
expected to DROP. Run it only after Tasks 1-4 are green and the worktree is
built + linked (build is `npm run build && npm link` as one unit; reindex is
USER-GATED — request it explicitly).

- [ ] **Step 1: Capture pre-pffv baselines** — before building the pffv
      worktree, record `get_index_status` `edgeKinds` (cone count) +
      `byReceiverKind` for huginn and bench-mastodon (the projects where the
      over-fan-out was found).

- [ ] **Step 2: Build + link the worktree** — `npm run build && npm link`
      (paired, per the worktree rule). Ask the user to `/mcp reconnect` and
      WAIT.

- [ ] **Step 3: Reindex (USER-GATED)** — request explicit confirmation, then
      `tea-rags index-codebase --project <huginn|mastodon> --force --json`.

- [ ] **Step 4: Measure** — `get_index_status` for both projects. ASSERT:
      `edgeKinds.cone` DROPPED vs baseline (false fan-out pruned);
      `edgeKinds.exact` may rise (cones collapsed to single edges);
      `resolveSuccessRate` did not regress materially. Record the deltas in the
      pffv bead notes.

- [ ] **Step 5: Commit authorization** — per the project rule, a successful
      user-triggered live validation auto-authorizes the commit of any
      validation-driven tweak on the worktree branch (no merge / push).

---

## Self-Review

**1. Spec coverage (5 locked decisions):**

- Decision 1 (nearest-definer liveness) → Task 4 `nearestDefiner` + prune loop;
  tested by the prune + sibling cases.
- Decision 2 (full instantiation vocabulary via `RUBY_INSTANCE_RETURNING`) →
  Task 2 reuses `constInstanceType` (which reads the grammar facet); tested by
  the constructor/factory/finder/relation-tail case.
- Decision 3 (soundness floor) → Task 4 `if (pruned.size > 0) live = pruned;`;
  tested by the floor case.
- Decision 4 (threading mirrors `functionReturnTypes`) → Tasks 1+3, every anchor
  line matched to the existing `functionReturnTypes` site.
- Decision 5 (prune before coneMax + gate) → Task 4 prune sits before
  `n <= this.coneMax`; gated on `ctx.instantiatedTypes` present + non-empty;
  tested by the gate case.

**2. Placeholder scan:** all code steps carry concrete code. The two
harness-reuse steps (Task 2 Step 6, Task 3 Step 1) name the exact file to copy
the fixture shape from via `find_symbol` rather than inlining a guessed harness
— this is deliberate (the existing two-file cone fixture is the oracle;
inventing a second one risks divergence), not a placeholder.

**3. Type consistency:** `instantiatedTypes` is `string[]` on `FileExtraction`
(NDJSON spill) and `ReadonlySet<string>` on `CallContext` (injected) — the
provider converts at the boundary (`new Set(...)`), exactly as the design's
NDJSON-vs-runtime split requires. `nearestDefiner` returns `string | null`;
`overrideBySubtype.get(definer)` is guarded by the `definer && target` check.
`getAncestors` opts `{ ordered: true, transitive: true }` match the
`HierarchyQuery` shape verified in `hierarchy-view.ts`.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-29-pffv-rta-cone-pruning-plan.md`.
Recommended execution: **subagent-driven** (same as pg5ya on this branch) —
Tasks 1→2→3→4 sequential (4 depends on 1+3; 3 depends on 1; 2 depends on 1),
Task 5 the live-validation gate. Task 1 is the type backbone and unblocks the
rest.
