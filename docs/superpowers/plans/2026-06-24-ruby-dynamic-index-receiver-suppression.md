# Ruby dynamic-edge precision — Increment A (index-access receiver suppression) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. When executing, prefer the dinopowers
> wrappers (dinopowers:executing-plans / dinopowers:test-driven-development /
> dinopowers:verification-before-completion).

**Goal:** Stop the Ruby dynamic-dispatch resolver from fanning out index-access
receivers (`recv[k].member`) and classify those calls as external, removing
~10%-precision Hash/Array-element noise from the codegraph.

**Architecture:** One text-shape predicate (`receiverIsIndexAccess`) in
`strategies/shared.ts`, consumed by two existing sites: the dynamic-dispatch
resolver (suppress the fan-out) and the Ruby external vocabulary (reclassify the
call as `callsExternalSkipped`, so it leaves the `inProjectEdgeRecall`
denominator instead of becoming a miss). No `CallRef` contract change; no walker
change.

**Tech Stack:** TypeScript, vitest, tree-sitter-ruby (unchanged), DuckDB
codegraph.

## Global Constraints

- NO change to `CallRef` or any `contracts/types/language.ts` interface
  (high-blast hub — keep the predicate a plain function in
  `strategies/shared.ts`).
- Regression invariant: constant / typed-local / `@ivar` / `self` / `super` /
  AR-relation receivers resolve EXACTLY as before; **bare-identifier (`obj.m`)
  AND chain (`a.b.m`) receivers STILL fan out** (those are Increment B).
- Silo-owned files (`strategies/shared.ts`, `ruby-external-vocabulary.ts` —
  artk0de 100%): additive change only, full golden coverage; flag for owner
  review.
- Each Task is RED → GREEN. Predicate (Task 1) lands before its two consumers.
- Test runner: `npx vitest run <file>`. Pre-commit hook runs tsc + full suite +
  coverage.

---

### Task 1: `receiverIsIndexAccess` predicate

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/strategies/shared.ts`
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts`

**Interfaces:**

- Produces: `export function receiverIsIndexAccess(receiver: string): boolean` —
  true when the receiver expression's outermost operation is an element
  reference (`recv[...]`), i.e. the trimmed text ends in `]` and contains a `[`.
  Consumed by Task 2 (dynamic dispatch) and Task 3 (external vocabulary).

- [ ] **Step 1: Write the failing test** — append to `strategies.test.ts`:

```ts
import { receiverIsIndexAccess } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";

describe("receiverIsIndexAccess (mktkk increment A)", () => {
  it("is true when the receiver's outermost op is an element reference", () => {
    expect(receiverIsIndexAccess("options['subject']")).toBe(true);
    expect(receiverIsIndexAccess("payload[key]")).toBe(true);
    expect(receiverIsIndexAccess("arr[i]")).toBe(true);
    expect(receiverIsIndexAccess("context.registers[:agent]")).toBe(true); // outermost is [:agent]
    expect(receiverIsIndexAccess("[1, 2, 3]")).toBe(true); // array literal receiver
  });

  it("is false for chain / bare / constant receivers (deferred to increment B)", () => {
    expect(receiverIsIndexAccess("event.user")).toBe(false); // chain
    expect(receiverIsIndexAccess("a[0].b")).toBe(false); // outermost op is .b, not index
    expect(receiverIsIndexAccess("obj")).toBe(false); // bare identifier
    expect(receiverIsIndexAccess("User")).toBe(false); // constant
    expect(receiverIsIndexAccess("@client")).toBe(false); // ivar
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts -t "receiverIsIndexAccess"`
Expected: FAIL — `receiverIsIndexAccess is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation** — add to `strategies/shared.ts`
      (near the other text-shape predicates `isRubyPath` / `CONE_MAX_DEFAULT`):

```ts
/**
 * True when a call receiver's OUTERMOST operation is an element reference
 * (`recv[k]`, `arr[i]`, `[1,2,3]`) — the trimmed text ends in `]` and contains a
 * `[`. An index on an untyped container yields an element whose type is
 * statically untrackable (Hash/Array element → core/external), so the dynamic
 * resolver must NOT fan out to same-named in-project methods. A chain off an
 * index (`a[0].b`) ends in `b`, not `]`, so it is correctly excluded (outermost
 * op is the chain — deferred to increment B). Text-shape, mirroring
 * `receiverLooksLikeArRelationChain` (bd tea-rags-mcp-mktkk increment A).
 */
export function receiverIsIndexAccess(receiver: string): boolean {
  const t = receiver.trimEnd();
  return t.endsWith("]") && t.includes("[");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts -t "receiverIsIndexAccess"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/strategies/shared.ts tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts
git commit -m "feat(trajectory): receiverIsIndexAccess predicate for ruby dynamic-edge suppression (mktkk)"
```

---

### Task 2: Suppress index-access fan-out in the dynamic dispatch resolver

**Files:**

- Modify:
  `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts`

**Interfaces:**

- Consumes: `receiverIsIndexAccess` (Task 1).
- Produces: `RubyDynamicDispatchResolver.resolveDispatch` returns `[]` for an
  index-access receiver (no fan-out edges).

- [ ] **Step 1: Write the failing test** — append a
      `RubyDynamicDispatchResolver` describe (mirror the existing strategy
      tests' symbol-table setup in this file: build an
      `InMemoryGlobalSymbolTable` with two in-project defs of `fetch`, then call
      `resolveDispatch`):

```ts
it("suppresses fan-out for an index-access receiver (mktkk)", () => {
  // symbolTable has TWO in-project `fetch` defs → without suppression this would
  // fan out to 2 dynamic edges. Index receiver `opts[k]` must produce NONE.
  const resolver = new RubyDynamicDispatchResolver({ mode: "all" });
  const call = {
    callText: "opts[k].fetch",
    receiver: "opts[k]",
    member: "fetch",
    startLine: 1,
  };
  expect(resolver.resolveDispatch(call, ctxWithTwoFetchDefs)).toEqual([]);
});

it("still fans out a bare-identifier untyped receiver (increment B, NOT suppressed here)", () => {
  const resolver = new RubyDynamicDispatchResolver({ mode: "all" });
  const call = {
    callText: "obj.fetch",
    receiver: "obj",
    member: "fetch",
    startLine: 1,
  };
  expect(
    resolver.resolveDispatch(call, ctxWithTwoFetchDefs).length,
  ).toBeGreaterThan(0);
});
```

(Reuse / adapt the file's existing `ctx` + symbol-table builder; the
two-`fetch`-defs context mirrors the bareCall ambiguity fixtures already in the
suite.)

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts -t "index-access receiver"`
Expected: FAIL — the index receiver currently fans out (length 2, not `[]`).

- [ ] **Step 3: Write minimal implementation** — in `ruby-dynamic-dispatch.ts`,
      add the import and the guard among the existing receiver-exclusion guards
      in `resolveDispatch`:

```ts
import {
  DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT,
  isRubyPath,
  receiverIsIndexAccess,
  type ResolverConfig,
} from "./shared.js";
```

```ts
if (receiverLooksLikeArRelationChain(r)) return []; // AR::Relation chain
// Index-access receiver (`opts[k]`, `arr[i]`): the element type is untrackable
// (Hash/Array element → core/external). Fanning out to same-named in-project
// methods is ~10%-precision noise. Suppress; the external classifier (Task 3)
// reclassifies the call as external so recall is not falsely penalised
// (bd tea-rags-mcp-mktkk increment A).
if (receiverIsIndexAccess(r)) return [];
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts -t "receiver"`
Expected: PASS (index suppressed → `[]`; bare-identifier still fans out).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts
git commit -m "feat(trajectory): suppress index-access receiver fan-out in ruby dynamic dispatch (mktkk)"
```

---

### Task 3: Reclassify index-access receivers as external

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts`
- Test:
  `tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`

**Interfaces:**

- Consumes: `receiverIsIndexAccess` (Task 1).
- Produces: `RubyExternalVocabulary.isQualifiedReceiverExternal` returns `true`
  for an index-access receiver → `RubyCallResolver.targetsExternalImport` true →
  provider counts the call as `callsExternalSkipped` (excluded from the
  `inProjectEdgeRecall` denominator).

- [ ] **Step 1: Write the failing test** — append to the
      `RubyCallResolver.targetsExternalImport` describe:

```ts
it("classifies an index-access receiver call as external (mktkk)", () => {
  // `opts[k].fetch` — element type untrackable → external, NOT an in-project miss.
  const resolver = new RubyCallResolver();
  const call = {
    callText: "opts[k].fetch",
    receiver: "opts[k]",
    member: "fetch",
    startLine: 1,
  };
  expect(resolver.targetsExternalImport(call, baseCtx)).toBe(true);
});

it("does NOT classify a bare-identifier receiver as external on index grounds (increment B)", () => {
  const resolver = new RubyCallResolver();
  const call = {
    callText: "obj.fetch",
    receiver: "obj",
    member: "fetch",
    startLine: 1,
  };
  // `obj` is lowercase, non-index → not external by THIS rule (resolveConstant path → false here).
  expect(resolver.targetsExternalImport(call, baseCtx)).toBe(false);
});
```

(Reuse the file's existing `baseCtx` / context builder used by the other
`targetsExternalImport` cases.)

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts -t "index-access receiver"`
Expected: FAIL — `opts[k]` is lowercase, non-ivar, non-super → current
`isQualifiedReceiverExternal` returns `false`.

- [ ] **Step 3: Write minimal implementation** — in
      `ruby-external-vocabulary.ts`, import the predicate and add the index
      check at the TOP of `isQualifiedReceiverExternal` (before the
      constant/ivar/super branches):

```ts
import { receiverIsIndexAccess } from "./strategies/shared.js";
```

```ts
  isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean {
    // Index-access receiver (`opts[k]`): element type untrackable → external.
    // Paired with the dynamic-dispatch suppression (mktkk increment A) so the
    // suppressed call leaves the inProjectEdgeRecall denominator as
    // callsExternalSkipped instead of becoming a recall hole.
    if (receiverIsIndexAccess(receiver)) return true;
    if (receiver === SUPER_RECEIVER_SENTINEL) return superTargetsExternal(ctx);
    if (IVAR_RECEIVER.test(receiver)) return ivarTargetsExternal(receiver, ctx);
    return /^[A-Z]/.test(receiver) && resolveConstant(receiver, ctx) === null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`
Expected: PASS (index → external; bare-identifier unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts
git commit -m "feat(trajectory): classify index-access receiver calls as external (mktkk)"
```

---

### Task 4: Provider-level integration test + full verification + live validation

**Files:**

- Test:
  `tests/core/domains/trajectory/codegraph/symbols/inproject-edge-recall.test.ts`
  (or the resolve-regression-gate test) — add one end-to-end case.

**Interfaces:**

- Consumes: Tasks 1–3.

- [ ] **Step 1: Write the failing integration test** — a fixture where an
      in-project method `run` exists AND a call uses an index-access receiver
      `cfg[:k].run`; assert the run's stats classify it as external, not
      resolved, not a recall hole. Mirror the `inproject-edge-recall.test.ts`
      driver (tmp DuckDB + provider + asExtractionSink, or streamFileBatch +
      finalizeSignals + getRunStats):

```ts
it("an index-access receiver call is externalSkipped, not resolved nor a recall hole (mktkk)", async () => {
  // file defines Worker#run; main calls cfg[:k].run (index receiver) → external.
  // ... write fixture (a.rb defines `def run; end` in class Worker; main.rb: cfg[:k].run) ...
  await provider.streamFileBatch(root, paths);
  await provider.finalizeSignals(root);
  const rows = await client.getRunStats();
  const total = (sel) => rows.reduce((s, r) => s + sel(r), 0);
  // the cfg[:k].run call is counted external, not resolved, not no-in-project-def.
  expect(total((r) => r.externalSkipped)).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run it to verify RED, then implement is already done (Tasks
      1–3)** — if it passes immediately, tighten the fixture so it genuinely
      exercises the suppression path (the call must have an in-project `run`
      def, else it is zeroDef and the test proves nothing).

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit` (expect 0); `npx vitest run` (expect all green — adjust
any existing dynamic-dispatch / external-import test that asserted index
receivers fan out, since that behavior intentionally changed);
`npx prettier --check <changed files>`.

- [ ] **Step 4: Commit the integration test**

```bash
git add tests/core/domains/trajectory/codegraph/symbols/inproject-edge-recall.test.ts
git commit -m "test(trajectory): index-access receiver is externalSkipped end-to-end (mktkk)"
```

- [ ] **Step 5: Live-validate on huginn**

Build worktree (`npm run build`); ASK the user to `/mcp reconnect tea-rags` and
WAIT (the codegraph daemon must restart to pick up new code — kill the stale
`daemon/entry.js` if it lingers); force-reindex huginn
(`tea-rags index-codebase --project huginn --force --wait-enrichments --json`
via the worktree CLI); then assert via `get_index_status project=huginn` + a
direct RO edge query on the huginn codegraph DuckDB:

- ruby `exactRatio` UP; ruby dynamic edge count DOWN (≈ the suppressed
  index-receiver fan-out);
- ruby `callsExternalSkipped` UP ~371; `inProjectEdgeRecall` ≈ 0.864 (within the
  predicted −0.92pp);
- ruby EXACT edge count NOT reduced (suppression touches only `dynamic` edges);
- re-sample a few suppressed call-sites to confirm they were noise.

- [ ] **Step 6: Close beads + (worktree-only) commit; do NOT merge/push**

`bd close tea-rags-mcp-mktkk` once live validation confirms the deltas.

## Self-Review

- **Spec coverage:** predicate (Task 1) ✓; suppression consumer (Task 2) ✓;
  external-reclassify consumer (Task 3) ✓; metric/recall behavior (Task 4
  integration + live) ✓; regression guards (Tasks 2/3 boundary tests) ✓; live
  validation (Task 4) ✓. No spec section unmapped.
- **Placeholder scan:** Task 4's fixture body is sketched, not full — the
  executor writes the exact `.rb` fixture mirroring
  `inproject-edge-recall.test.ts`'s existing pattern; flagged explicitly, not a
  silent TODO.
- **Type consistency:** `receiverIsIndexAccess(receiver: string): boolean` used
  identically in Tasks 1/2/3. `isQualifiedReceiverExternal(receiver, ctx)`
  signature matches the real method read from source. No `CallRef` field added.
