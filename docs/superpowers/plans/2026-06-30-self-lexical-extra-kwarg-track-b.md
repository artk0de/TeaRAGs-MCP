# Self/Lexical Residual + Extra-Unknown-Kwarg (Track B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or dinopowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) measure the residual in the already-near-exact self/implicit-self lexical+ancestor resolution and tighten ONLY what data justifies; (B) add the extra-unknown-kwarg direction to `KwargNarrower`.

**Architecture:** Part A extends the existing per-receiver-kind resolve tally (`runStats.byReceiverKind` / `classifyReceiverKind` / `recordRunStats` in `codegraph/symbols/provider.ts`) with `selfMember`/`bareCall` residual sub-buckets, measures on a Ruby bench, then applies a data-chosen lever to `ruby-self-member.ts`/`ruby-bare-call.ts`/`shared.ts`. Part B extends Spec #1's `KwargSignature` with `optional` names and adds a second `KwargNarrower` clause (every passed key must be declared).

**Tech Stack:** TypeScript (ESM), tree-sitter-ruby, DuckDB (`cg_run_stats`), vitest.

## Global Constraints

- **Conservatism invariant:** tighten ONLY where A0 PROVES a residual; never trade recall for unmeasured precision. A valid Part-A outcome is "measured, no fix warranted".
- **Part A is INDEPENDENT of Spec #1** (files: `ruby-self-member.ts`, `ruby-bare-call.ts`, `shared.ts`, `provider.ts` run-stats) → runs fully parallel to track A.
- **Part B EXTENDS Spec #1** (`KwargSignature`, `KwargNarrower`, walker kwarg capture) → its edits REBASE onto track A before merge. Do Part B's contract/walker/narrower changes only after track A's Task 2 has landed (or on a track-A-based branch).
- **No `eslint-disable`, no lowered coverage thresholds.** Walker test rule: preserve existing examples; counts `>=` base.
- Reindex / live measurement is USER-GATED (4 active worktrees → never auto-build/reindex).

---

### Task A0: Instrument self/implicit-self residual

Extend the existing resolve tally — do NOT build a new harness. `classifyReceiverKind` (provider.ts ~1939) already labels each call's receiver kind; `runStats.byReceiverKind` aggregates attempted/resolved per kind; `recordRunStats` persists to `cg_run_stats`. Add residual sub-buckets for the `selfMember` and `bareCall` kinds.

**Files:**
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (run-stats tally — `byReceiverKind`, the resolve loop ~1939, `recordRunStats` ~1610)
- Modify (read for the cause labels): `src/core/domains/language/ruby/resolver/strategies/ruby-bare-call.ts`, `ruby-self-member.ts`
- Test: `tests/core/domains/trajectory/codegraph/symbols/*run-stats*` (mirror the existing run-stats test)

**Interfaces:**
- Produces: per-kind residual counters `{ resolvedExact, droppedNoLexicalMatch, ambiguousFellThrough, singleGlobalNoVerify }` surfaced in the `[codegraph] resolve by receiver-kind` debug log (and, if cheap, `cg_run_stats`).

- [ ] **Step 1: Add the residual counters to the run-stats shape**

Extend the per-kind tally struct (where `createEmptyRunStats` builds `byReceiverKind`) with the four residual sub-counters above for the `bareCall` and `selfMember` kinds. Keep them debug-only if `cg_run_stats` schema change is undesirable — the goal is a measured table, not a durable signal.

- [ ] **Step 2: Tag the residual cause at the resolve site**

`bareCall` (`ruby-bare-call.ts`) and `selfMember` (`ruby-self-member.ts`) already branch on the four outcomes; surface which branch fired (return a small outcome tag, or have the provider's resolve loop classify the result) and increment the matching sub-counter. Do NOT change resolution behaviour — measurement only.

- [ ] **Step 3: Write a unit test for the tally**

Assert that a synthetic run with known self/bareCall outcomes produces the expected sub-counter totals (mirror the existing run-stats test setup).

- [ ] **Step 4: Run the test + tsc**

Run: `npx vitest run tests/core/domains/trajectory/codegraph/symbols && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(debug): instrument self/bareCall resolve residual sub-buckets (measure-only)"
```

- [ ] **Step 6: Measure on a Ruby bench (USER-GATED)**

Request the user to build+link this worktree, reconnect MCP, and reindex a Ruby bench (mastodon/huginn/octokit). Capture the `[codegraph] resolve by receiver-kind` output. **Deliverable: the residual table** — counts per cause for selfMember/bareCall, dominant cause identified. This decides Task A1.

---

### Task A1: Targeted tightening (specced FROM A0 data)

**Do not implement blindly.** Pick the lever matching A0's dominant residual cause. Each lever is a small, TDD'd change with the conservatism invariant held.

**Decision table:**

| A0 dominant cause | Lever | File |
|---|---|---|
| `singleGlobalNoVerify` is a precision leak (lone global match in an unrelated class) | demote/drop the lone match when it is NOT MRO-reachable AND not a top-level/Kernel helper | `ruby-bare-call.ts` |
| same-level cross-form ambiguity (`ambiguousFellThrough`) | apply 55xil instance>class preference INSIDE each `atLevel` of the MRO walk | `ruby-bare-call.ts` |
| inherited/prepended-method misses (`droppedNoLexicalMatch` with a known ancestor) | extend the MRO/prepend walk depth | `shared.ts` (`collectAncestorChain`/`resolveInstanceMethodInClassChain`) |
| residual negligible | **CLOSE Part A: "measured, no fix warranted"** — honest outcome, no code | — |

- [ ] **Step 1: Write the failing test for the chosen lever**

A red unit test in the relevant strategy test file encoding the exact residual case A0 surfaced (e.g. a bareCall whose lone global match is in an unrelated class → expect CONTINUE/drop, not a wrong edge).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the minimal lever** (recall-guarded — never drop a legit top-level/Kernel helper).

- [ ] **Step 4: Run the lever test + the FULL ruby resolver suite + tsc** (no existing business-logic test regresses).

Run: `npx vitest run tests/core/domains/language/ruby/resolver && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit + re-measure (USER-GATED)** — confirm the targeted residual shrank with ZERO recall regression on the bench.

```bash
git add -A
git commit -m "improve(language): tighten <cause> self/implicit-self residual (data-driven, recall-guarded)"
```

---

### Task B1: Extra-unknown-kwarg narrowing (REBASES onto track A)

Adds the second incompatibility direction to `KwargNarrower`. **Land after track A Task 2** (it shares `KwargSignature`/`KwargNarrower`/walker kwarg capture).

**Files:**
- Modify: `src/core/contracts/types/codegraph.ts` (`KwargSignature` — add `optional`)
- Modify: `src/core/domains/language/ruby/walker/walker.ts` (capture optional kwarg names)
- Modify: `src/core/domains/language/kernel/dispatch-narrowing.ts` (`KwargNarrower` second clause)
- Test: `tests/core/domains/language/kernel/dispatch-narrowing.test.ts`, `ruby-walker.test.ts`

**Interfaces:**
- Consumes (from track A Task 1/2): `KwargSignature { required, hasSplat }`, `SymbolDefinition.kwargs?`, `CallRef.kwargKeys?/.hasKwargSplat?`, the walker kwarg-capture site.
- Produces: `KwargSignature.optional: string[]`; `KwargNarrower` enforcing both directions.

- [ ] **Step 1: Add `optional` to `KwargSignature`**

```ts
export interface KwargSignature {
  required: string[];
  optional: string[]; // declared kwargs WITH a default (bd d9o7o extra-kwarg)
  hasSplat: boolean;
}
```

(Update track A's walker required-only capture to also populate `optional`; `kwargs_json` already serialises the whole object — no migration change.)

- [ ] **Step 2: Write the failing KwargNarrower extra-key test**

```ts
const def2 = (id: string, required: string[], optional: string[], hasSplat = false): SymbolDefinition =>
  ({ symbolId: id, fqName: id, shortName: id, relPath: "a.rb", scope: [], kwargs: { required, optional, hasSplat } });

it("drops a candidate when the call passes a kwarg key the def does not declare", () => {
  const cs = [def2("A", [], ["limit"]), def2("B", [], ["offset"])];
  // call x.m(limit: 5) → B has no `limit:` and no **opts → drop B
  expect(new KwargNarrower().narrow(callWith(["limit"]), cs, ctx).map((c) => c.symbolId)).toEqual(["A"]);
});
it("keeps a def with **opts even on an undeclared key", () => {
  const cs = [def2("A", [], [], true)];
  expect(new KwargNarrower().narrow(callWith(["whatever"]), cs, ctx)).toHaveLength(1);
});
it("keeps when the call has a ** double-splat", () => {
  const cs = [def2("A", [], ["limit"])];
  expect(new KwargNarrower().narrow(callWith(["x"], true), cs, ctx)).toHaveLength(1);
});
```

- [ ] **Step 3: Run to verify it fails.**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "undeclared"`
Expected: FAIL.

- [ ] **Step 4: Extend `KwargNarrower` with the second clause**

```ts
narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
  if (call.kwargKeys === undefined || call.hasKwargSplat) return candidates;
  const have = new Set(call.kwargKeys);
  return candidates.filter((c) => {
    if (!c.kwargs) return true;
    // (1) omitted-required (Spec #1)
    if (!c.kwargs.required.every((k) => have.has(k))) return false;
    // (2) extra-unknown (this task): every passed key must be declared, unless **opts
    if (c.kwargs.hasSplat) return true;
    const declared = new Set([...c.kwargs.required, ...c.kwargs.optional]);
    return call.kwargKeys!.every((k) => declared.has(k));
  });
}
```

- [ ] **Step 5: Run the extra-key tests + the Spec #1 KwargNarrower tests (both directions green) + tsc.**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "Kwarg" && npx tsc --noEmit`
Expected: PASS (omitted-required AND extra-unknown).

- [ ] **Step 6: Walker — capture optional kwarg names**

Extend the def-side kwarg capture (track A Task 2 site) so a `keyword_parameter` WITH a value child pushes its name to `optional` (it currently only pushes no-default ones to `required`). Add a walker test: `def m(a:, b: 1, **o)` → `kwargs: { required: ["a"], optional: ["b"], hasSplat: true }`.

- [ ] **Step 7: Run walker tests + full kernel suite + tsc** (preserve example counts).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(trajectory): extra-unknown-kwarg narrowing direction (every passed key declared)"
```

- [ ] **Step 9: Live-validation gate (USER-GATED)** — residual fan-out further ↓ vs the track-A baseline, ZERO false-narrow.

---

## Self-Review

- **Spec coverage:** A0 → §Part A Task A0 (instrument); A1 → §Part A Task A1 (data-gated fix, with the honest no-op outcome); B1 → §Part B (KwargSignature.optional + KwargNarrower second clause + walker optional capture). All spec sections mapped.
- **Placeholders:** A1 is deliberately data-gated — it documents a decision table + concrete levers rather than a single pre-chosen fix (this is correct given the measured-residual decision, not a placeholder). A0 anchors to the real `runStats.byReceiverKind`/`classifyReceiverKind`/`recordRunStats` sites. B1 is fully concrete.
- **Type consistency:** `KwargSignature` gains `optional: string[]` consistently; `KwargNarrower.narrow` signature matches track A's; the second clause composes with Spec #1's first clause.
- **Rebase dependency:** B1 explicitly sequenced after track A Task 2; Part A carries no track-A dependency.
