# trace_path Lean-by-Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (recommended) or dinopowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per-Task code
> generation uses dinopowers:test-driven-development (NOT the raw superpowers
> version).

**Goal:** Make `trace_path` emit a lean path enumeration by default; attach the
danger overlay (per-step `dangerOverlay`, `dangerRanking`, `aggregateDanger`)
ONLY when the caller passes a `rerank` preset.

**Architecture:** `TracePathOps.tracePath` currently force-defaults `preset` to
`"bugHunt"` and unconditionally runs an annotate-only rerank, attaching a
verbose danger overlay to every step even when none was requested. We remove the
hidden default: `preset = req.rerank` with no fallback. When undefined, the
hydrate→rerank→danger-assembly is skipped — steps carry only
`{symbolId, relativePath, startLine, endLine}`, paths stay in enumeration order,
and `dangerRanking`/`aggregateDanger` are omitted. The danger path is unchanged
when `rerank` IS passed. `bugHunt` moves from an implicit default into the
skills that explicitly need danger-ranking.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, tea-rags
codegraph navigation (`trace_path` / `get_callers` / `get_callees` MCP tools).

## Global Constraints

- Worktree: `worktree-prqsj-trace-path-lean`. **4 active worktrees → NO
  auto-build, NO `npm link`, NO reindex** — all user-gated.
- `find_symbol` is OUT of scope — its rerank-overlay is an intentional
  diagnostic feature.
- Typed errors only (`.claude/rules/typed-errors.md`); no `throw new Error` in
  domain code (no new throws needed here).
- Facade discipline: `TracePathOps` is the orchestrator for `trace_path`; logic
  stays there, not in the facade.
- `feedback_business_logic_tests_immutable`: existing danger-ranking assertions
  are PRESERVED verbatim. Only the trigger (implicit default → explicit
  `rerank: "bugHunt"`) is adapted in the call args. New lean-path tests are
  ADDED.
- Commit convention: `improve(api): ...` (enhancement to existing `trace_path`;
  api scope → patch bump). The default-behaviour flip is user-facing but
  additive (lean is the new default, danger still available) — assess whether a
  `BREAKING CHANGE:` footer is warranted per `.claude/rules/commit-rules.md`
  (default response shape of `trace_path` changes for no-rerank callers).

---

### Task 1: trace_path lean default + DTO optional-widening

**Files:**

- Modify: `src/core/api/internal/ops/trace-path-ops.ts:28-150`
- Modify: `src/core/api/public/dto/graph.ts:103-133`
- Test: `tests/core/api/internal/ops/trace-path-ops.test.ts`

**Interfaces:**

- Consumes: `TracePathRequest`
  (`{from, to, rerank?, maxDepth?, maxPaths?, ...}`),
  `Reranker.rerank(input, preset, "trace_path", {reorder})`,
  `QdrantManager.scrollBySymbolIds`.
- Produces: `PathTraceResult { paths: TracedPath[]; truncated: boolean }` where
  `TracedPath = { steps: PathStep[]; dangerRanking?: number[]; aggregateDanger?: number }`
  and
  `PathStep = { symbolId, relativePath, startLine, endLine, dangerOverlay? }`.
  When `req.rerank` is absent: `dangerRanking`/`aggregateDanger` are omitted and
  no `dangerOverlay` is set.

- [ ] **Step 1: Adapt existing danger-ranking tests to pass `rerank` explicitly
      (preserve assertions verbatim)**

In `tests/core/api/internal/ops/trace-path-ops.test.ts`, the four danger tests
currently rely on the removed implicit `bugHunt` default. Add
`rerank: "bugHunt"` to each `tracePath` call; leave every assertion unchanged.
The empty-path test (no danger asserted) stays as-is.

```ts
// test "returns the A->B->C path in execution order with danger overlays"
const res = await ops.tracePath({
  collection: "c",
  from: "A",
  to: "C",
  rerank: "bugHunt",
});
// (assertions unchanged: steps order A,B,C; every step has dangerOverlay)

// test "ranks the riskiest step first via dangerRanking ..."
const res = await ops.tracePath({
  collection: "c",
  from: "A",
  to: "C",
  rerank: "bugHunt",
});
// (assertions unchanged: dangerRanking[0] -> B; aggregateDanger ~0.9)

// test "passes reorder:false to the reranker (annotate-only)"
await ops.tracePath({ collection: "c", from: "A", to: "C", rerank: "bugHunt" });
// (assertion unchanged: rerank called with "bugHunt", "trace_path", {reorder:false})

// test "sorts the path list by aggregateDanger ..."
const res = await ops.tracePath({
  collection: "c",
  from: "A",
  to: "D",
  rerank: "bugHunt",
});
// (assertions unchanged)

// test "returns empty paths when no route exists" — UNCHANGED (no rerank, no danger asserted)
```

- [ ] **Step 2: Write the new failing lean-path tests**

Append to `describe("TracePathOps.tracePath", ...)`:

```ts
it("WITHOUT rerank returns lean steps with no danger overlay and no danger fields", async () => {
  const reranker = { rerank: vi.fn() };
  const ops = makeOps({ reranker: reranker as never });
  const res = await ops.tracePath({ collection: "c", from: "A", to: "C" });

  expect(res.paths).toHaveLength(1);
  const path = res.paths[0];
  expect(path.steps.map((s) => s.symbolId)).toEqual(["A", "B", "C"]);
  expect(path.steps.every((s) => s.dangerOverlay === undefined)).toBe(true);
  expect(path.dangerRanking).toBeUndefined();
  expect(path.aggregateDanger).toBeUndefined();
});

it("WITHOUT rerank does NOT invoke the reranker", async () => {
  const reranker = { rerank: vi.fn() };
  const ops = makeOps({ reranker: reranker as never });
  await ops.tracePath({ collection: "c", from: "A", to: "C" });
  expect(reranker.rerank).not.toHaveBeenCalled();
});

it("WITHOUT rerank keeps paths in enumeration order (no danger sort)", async () => {
  // Diamond A->B->D and A->C->D; without rerank both aggregateDanger absent,
  // so order is enumeration order, not danger-sorted.
  const graphDb = {
    getCalleeEdges: vi.fn(async (ids: string[]) => {
      const g: Record<string, string[]> = {
        A: ["B", "C"],
        B: ["D"],
        C: ["D"],
        D: [],
      };
      return new Map(ids.filter((i) => g[i]).map((i) => [i, g[i]]));
    }),
    close: vi.fn(async () => undefined),
  };
  const pool = {
    acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })),
  };
  const qdrant = {
    scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
      ids.map((id) => ({
        id,
        payload: {
          symbolId: id,
          relativePath: `${id}.ts`,
          startLine: 1,
          endLine: 9,
        },
      })),
    ),
  };
  const reranker = { rerank: vi.fn() };
  const ops = new TracePathOps({
    pool: pool as never,
    qdrant: qdrant as never,
    reranker: reranker as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n,
  });

  const res = await ops.tracePath({ collection: "c", from: "A", to: "D" });
  expect(res.paths).toHaveLength(2);
  expect(reranker.rerank).not.toHaveBeenCalled();
  expect(res.paths.every((p) => p.aggregateDanger === undefined)).toBe(true);
  // enumeration order: A->B->D enumerated before A->C->D
  expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["A", "B", "D"]);
  expect(res.paths[1].steps.map((s) => s.symbolId)).toEqual(["A", "C", "D"]);
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run:
`cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/prqsj-trace-path-lean && npx vitest run tests/core/api/internal/ops/trace-path-ops.test.ts`
Expected: the 3 new lean-path tests FAIL (current code force-defaults to
`bugHunt`, so `dangerOverlay` IS present, `dangerRanking`/`aggregateDanger` ARE
set, and `reranker.rerank` IS called). The adapted danger tests PASS (explicit
`bugHunt` matches current behaviour).

- [ ] **Step 4: Make `TracedPath` danger fields optional in the DTO**

In `src/core/api/public/dto/graph.ts`, update the `TracePathRequest.rerank` doc
(lines 103-109) and `TracedPath` (lines 126-133):

```ts
  /**
   * Optional rerank preset that scores per-step "danger" for the overlay.
   * When omitted, trace_path returns a LEAN path enumeration — steps carry
   * only {symbolId, relativePath, startLine, endLine}, paths stay in
   * enumeration order, and dangerRanking/aggregateDanger are absent. Pass a
   * per-step danger preset (bugHunt / dangerous / hotspots / blastRadius) to
   * attach the overlay and danger-sort the path list; group presets (e.g.
   * refactoring) are not meaningful here — danger is scored per step.
   */
  rerank?: string;
```

```ts
export interface TracedPath {
  /** ORDERED — execution order, never reordered. */
  steps: PathStep[];
  /**
   * Indices into `steps`, sorted by per-step danger desc (where to look
   * first). Present ONLY when a `rerank` preset was supplied; absent for a
   * lean (no-rerank) trace.
   */
  dangerRanking?: number[];
  /**
   * Path-level score = max per-step danger; sorts the path list. Present
   * ONLY when a `rerank` preset was supplied; absent for a lean trace.
   */
  aggregateDanger?: number;
}
```

- [ ] **Step 5: Make the rerank conditional in `TracePathOps`**

In `src/core/api/internal/ops/trace-path-ops.ts`: delete the `DEFAULT_PRESET`
const (line 30), drop the fallback (line 48), gate the danger compute, and make
`assemble` danger-optional. Extract the rerank+collect into a `computeDanger`
helper.

Delete line 30 (`const DEFAULT_PRESET = "bugHunt";`). Change line 48:

```ts
const preset = req.rerank; // no default — danger overlay is opt-in (tea-rags-mcp-prqsj)
```

Replace the rerank+assemble tail (current lines 83-96) with:

```ts
    // 4. Annotate-only rerank — ONLY when a rerank preset was requested.
    //    Without it, trace_path is lean path enumeration (no danger overlay,
    //    no danger sort). bugHunt is no longer an implicit default.
    const dangerById = preset ? await this.computeDanger(chunks, preset) : undefined;

    // 5. Assemble TracedPath per enumerated path. With danger, sort by
    //    aggregateDanger desc; without, keep enumeration order.
    const traced: TracedPath[] = paths.map((p) => this.assemble(p, byId, dangerById));
    if (dangerById) traced.sort((a, b) => (b.aggregateDanger ?? 0) - (a.aggregateDanger ?? 0));
    return { paths: traced, truncated };
  }

  /** Annotate-only rerank over hydrated chunks → per-symbol danger score + overlay. */
  private async computeDanger(
    chunks: { id: string | number; payload: Record<string, unknown> }[],
    preset: string,
  ): Promise<Map<string, { score: number; overlay?: RankingOverlay }>> {
    const rerankInput = chunks.map((c) => ({ id: c.id, score: 0, payload: c.payload }));
    const annotated = await this.deps.reranker.rerank(rerankInput, preset, "trace_path", { reorder: false });
    const dangerById = new Map<string, { score: number; overlay?: RankingOverlay }>();
    for (const r of annotated) {
      const sid = r.payload?.symbolId as string | undefined;
      if (!sid) continue;
      dangerById.set(sid, { score: r.score, overlay: r.rankingOverlay });
    }
    return dangerById;
  }
```

Replace `assemble` (current lines 130-150) with a danger-optional version:

```ts
  private assemble(
    path: SymbolId[],
    byId: Map<string, { id: string | number; payload: Record<string, unknown> }>,
    dangerById?: Map<string, { score: number; overlay?: RankingOverlay }>,
  ): TracedPath {
    const steps: PathStep[] = path.map((symbolId) => {
      const payload = byId.get(symbolId)?.payload ?? {};
      const step: PathStep = {
        symbolId,
        relativePath: (payload.relativePath as string) ?? "",
        startLine: (payload.startLine as number) ?? 0,
        endLine: (payload.endLine as number) ?? 0,
      };
      const overlay = dangerById?.get(symbolId)?.overlay;
      if (overlay) step.dangerOverlay = overlay;
      return step;
    });
    if (!dangerById) return { steps }; // lean — no dangerRanking / aggregateDanger
    const dangers = path.map((id) => dangerById.get(id)?.score ?? 0);
    const dangerRanking = steps.map((_, i) => i).sort((a, b) => dangers[b] - dangers[a]);
    const aggregateDanger = dangers.length > 0 ? Math.max(...dangers) : 0;
    return { steps, dangerRanking, aggregateDanger };
  }
```

- [ ] **Step 6: Run the full test file to verify all pass**

Run:
`cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/prqsj-trace-path-lean && npx vitest run tests/core/api/internal/ops/trace-path-ops.test.ts`
Expected: PASS — 3 new lean-path tests green, 5 adapted/unchanged danger tests
green.

- [ ] **Step 7: Type-check**

Run:
`cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/prqsj-trace-path-lean && npx tsc --noEmit`
Expected: 0 errors. (The optional `dangerRanking`/`aggregateDanger` must not
break any consumer — if a consumer reads them non-optionally, that surfaces here
and is fixed in the same task.)

- [ ] **Step 8: Commit**

```bash
git add src/core/api/internal/ops/trace-path-ops.ts src/core/api/public/dto/graph.ts tests/core/api/internal/ops/trace-path-ops.test.ts
git commit -m "improve(api): trace_path lean by default, danger overlay opt-in via rerank"
```

---

### Task 2: get_callers / get_callees overlay-absence guard test

**Files:**

- Test: `tests/core/api/internal/facades/graph-facade.test.ts` (create if
  absent, else append)
- Reference (no change):
  `src/core/api/internal/facades/graph-facade.ts:108-126`,
  `src/core/api/public/dto/graph.ts:26-55`

**Interfaces:**

- Consumes:
  `GraphFacade.getCallers(req) → GetCallersResponse { callers: CallerResult[] }`,
  `GraphFacade.getCallees(req) → GetCalleesResponse { callees: CalleeResult[] }`.
  `CallerResult = {sourceSymbolId, sourceRelPath, callExpression}`,
  `CalleeResult = {targetSymbolId, targetRelPath, callExpression}` — neither
  carries an overlay field.
- Produces: a locked invariant — these responses NEVER contain a `dangerOverlay`
  / `rankingOverlay`.

- [ ] **Step 1: Write the guard test**

Assert each result entry exposes only its declared keys — no overlay leaks in.
Mirror the existing `graph-facade.test.ts` setup if the file exists; otherwise
build a minimal `GraphDbClientPool` mock returning one edge each.

```ts
import { describe, expect, it, vi } from "vitest";

import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";

function makeFacade() {
  const graphDb = {
    getCallers: vi.fn(async () => [
      {
        sourceSymbolId: "Caller#m",
        sourceRelPath: "caller.ts",
        callExpression: "target()",
      },
    ]),
    getCallees: vi.fn(async () => [
      {
        targetSymbolId: "Callee#m",
        targetRelPath: "callee.ts",
        callExpression: "callee()",
      },
    ]),
    close: vi.fn(async () => undefined),
  };
  const pool = {
    acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })),
  };
  return new GraphFacade({
    pool: pool as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n,
  });
}

describe("GraphFacade overlay-absence invariant", () => {
  it("getCallers never attaches an overlay field", async () => {
    const facade = makeFacade();
    const res = await facade.getCallers({
      collection: "c",
      symbolId: "target",
    });
    for (const caller of res.callers) {
      expect(Object.keys(caller).sort()).toEqual([
        "callExpression",
        "sourceRelPath",
        "sourceSymbolId",
      ]);
      expect((caller as Record<string, unknown>).dangerOverlay).toBeUndefined();
      expect(
        (caller as Record<string, unknown>).rankingOverlay,
      ).toBeUndefined();
    }
  });

  it("getCallees never attaches an overlay field", async () => {
    const facade = makeFacade();
    const res = await facade.getCallees({
      collection: "c",
      symbolId: "source",
    });
    for (const callee of res.callees) {
      expect(Object.keys(callee).sort()).toEqual([
        "callExpression",
        "targetRelPath",
        "targetSymbolId",
      ]);
      expect((callee as Record<string, unknown>).dangerOverlay).toBeUndefined();
      expect(
        (callee as Record<string, unknown>).rankingOverlay,
      ).toBeUndefined();
    }
  });
});
```

> NOTE for the implementer: confirm the real `GraphFacade` constructor
> dependency names against `src/core/api/internal/facades/graph-facade.ts` and
> the edge→result mapping shape (`CallerEdge`/`CalleeEdge` →
> `CallerResult`/`CalleeResult`) before finalizing the mock. If a
> `graph-facade.test.ts` already exists, append the `describe` block and reuse
> its existing factory instead of the one above. Adapt the mock to whatever the
> facade actually calls (`graphDb.getCallers` returns `CallerEdge[]`); keep the
> assertion (no overlay keys) verbatim.

- [ ] **Step 2: Run the guard test**

Run:
`cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/prqsj-trace-path-lean && npx vitest run tests/core/api/internal/facades/graph-facade.test.ts`
Expected: PASS immediately (no code change — the invariant already holds; this
test locks it).

- [ ] **Step 3: Commit**

```bash
git add tests/core/api/internal/facades/graph-facade.test.ts
git commit -m "test(api): lock get_callers/get_callees overlay-absence invariant"
```

---

### Task 3: skills & docs sweep — bugHunt is no longer a trace_path default

**Files:**

- Modify: `src/mcp/tools/codegraph.ts:104` (rerank `.describe` — "default
  bugHunt") and `:185-186` (trace_path tool description — "each step annotated
  with a git/churn danger overlay. Paths are sorted most-dangerous first")
- Modify: `src/core/api/internal/ops/trace-path-ops.ts:1-16` (header JSDoc —
  steps 4-5 describe an unconditional danger overlay; qualify as opt-in)
- Modify: `.claude-plugin/tea-rags/skills/bug-hunt/SKILL.md:117`
- Modify: `.claude-plugin/tea-rags/rules/search-cascade.md:165`
- Audit (modify only if a danger-needing call omits rerank):
  `.claude-plugin/dinopowers/skills/systematic-debugging/SKILL.md` (~line 116),
  `.claude-plugin/dinopowers/skills/receiving-code-review/SKILL.md` (~line 140)

**Interfaces:** none (documentation + tool-description strings). The behaviour
contract these docs describe is set by Task 1. NOTE:
`src/mcp/tools/codegraph.ts` is the user-facing MCP tool description the LLM
reads to decide whether to pass `rerank` — it currently lies ("default bugHunt",
"sorted most-dangerous first"), found stale during live validation. Because it
is under `src/`, its commit re-runs the pre-commit suite (now green with
`build/` present). Commit scope: `docs(mcp)`.

- [ ] **Step 0a: Fix the MCP tool description in `src/mcp/tools/codegraph.ts`**

Line 104 — the `rerank` param `.describe(...)`:

```ts
      .describe("Rerank preset that scores per-step danger for the overlay (optional — omit for a lean path enumeration, no danger ranking)"),
```

Lines 185-186 — the trace_path tool description string. Replace the "annotated
with a git/churn danger overlay. Paths are sorted most-dangerous first..."
clause:

```ts
        "Lean path enumeration by default. Pass a `rerank` danger preset to annotate each step " +
        "with a git/churn overlay and sort paths most-dangerous first. Backed by the codegraph DuckDB.",
```

- [ ] **Step 0b: Fix the header JSDoc in
      `src/core/api/internal/ops/trace-path-ops.ts`**

Lines 11-15 describe the annotate-rerank (step 4) and danger assembly (step 5)
as unconditional. Qualify them as opt-in (only when `rerank` is passed). Keep
the numbered-step structure; reword steps 4-5 to state the rerank/danger path
runs only when a preset is supplied, otherwise steps are lean and paths stay in
enumeration order.

- [ ] **Step 1: Fix the "bugHunt (default)" claim in bug-hunt SKILL**

In `.claude-plugin/tea-rags/skills/bug-hunt/SKILL.md:117`, the line currently
lists danger presets with `bugHunt` marked `(default)`. Remove the `(default)`
marker and state that `rerank` must be passed explicitly:

```
Curated danger presets for `trace_path` (pass explicitly — there is no default;
without `rerank` the trace is lean, no danger ranking): `bugHunt`, `dangerous`,
`hotspots`, `blastRadius`. Use `bugHunt` for general fault-tracing.
```

- [ ] **Step 2: Fix the always-on danger-ranking implication in search-cascade**

In `.claude-plugin/tea-rags/rules/search-cascade.md:165`, the `trace_path`
description implies per-step danger ranking is always present. Qualify it as
opt-in:

```
3. **`trace_path`** — ALL paths A→B. Lean by default (path enumeration only);
   pass `rerank="bugHunt"` (or `dangerous`/`hotspots`/`blastRadius`) to attach
   per-step danger ranking. Escalate here ...
```

(Preserve the surrounding bullet text; only the danger-ranking clause changes.)

- [ ] **Step 3: Audit the two dinopowers call-sites**

Open `.claude-plugin/dinopowers/skills/systematic-debugging/SKILL.md` and
`.claude-plugin/dinopowers/skills/receiving-code-review/SKILL.md`. For each
`mcp__tea-rags__trace_path(...)` invocation that the surrounding prose treats as
danger-ranked, confirm the call includes `rerank="bugHunt"` (or
`rerank="blastRadius"`). Where a danger-needing call omits `rerank`, add it. The
table rows already cite explicit `rerank` (`systematic-debugging:215` →
`bugHunt`, `receiving-code-review:265` → `blastRadius`); fix only the primary
fenced call examples if they lack it.

- [ ] **Step 4: Markdown lint the changed docs**

Run:
`cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/prqsj-trace-path-lean && npx markdownlint-cli2 .claude-plugin/tea-rags/skills/bug-hunt/SKILL.md .claude-plugin/tea-rags/rules/search-cascade.md 2>/dev/null || true`
Expected: no new violations (best-effort; the repo's markdownlint config
governs).

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/tea-rags/skills/bug-hunt/SKILL.md .claude-plugin/tea-rags/rules/search-cascade.md .claude-plugin/dinopowers/skills/systematic-debugging/SKILL.md .claude-plugin/dinopowers/skills/receiving-code-review/SKILL.md
git commit -m "docs(api): trace_path bugHunt is explicit, not a default"
```

---

## Validation (post-implementation, user-gated)

These steps require build + relink + reindex, all explicitly user-gated (4
active worktrees). They are NOT part of the code-change commit cycle above — run
only on explicit request.

- [ ] **Build + link the worktree** (`npm run build && npm link`) and reconnect
      MCP, per `.claude/CLAUDE.md` MCP testing workflow.
- [ ] **Live-check `trace_path` lean default:** call `mcp__tea-rags__trace_path`
      with `{from, to}` and no `rerank` against an indexed corpus; confirm steps
      carry no `dangerOverlay` and the response has no
      `dangerRanking`/`aggregateDanger`. Then call with `rerank="bugHunt"` and
      confirm the danger overlay + sort return.
- [ ] **Re-run nav-benchmark E2 on the trace_path path** (NOT the existing
      find_symbol×10 run) to measure the token delta. NOTE: E2's measured 92k
      came from `find_symbol×10`; this change makes graph-navigation cheap, so
      the −30k must be confirmed by re-running E2 with the agent driven through
      `trace_path`/`get_callers`, not by the prior run. This is a follow-up
      measurement, not a gate on the code change.

## Self-Review Notes

- **Spec coverage:** Task 1 = trace-path-ops + DTO (changes 1, 2 of the design).
  Task 2 = guard-test for callers/callees (change 3). Task 3 = skills/docs sweep
  (change 4). All four design changes mapped.
- **Type consistency:** `computeDanger` / `assemble` signatures introduced in
  Task 1 Step 5 match the optional `TracedPath` shape from Step 4.
  `PathStep.dangerOverlay` was already optional. `dangerById?` threads as
  `Map<string, {score, overlay?}> | undefined` consistently.
- **Business-logic immutability:** the four danger tests keep their assertions;
  only call args gain `rerank: "bugHunt"`. No danger-ranking assertion is
  rewritten.
- **Open verification:** Task 2 mock must be reconciled against the real
  `GraphFacade` constructor/deps (flagged inline); Task 3 Step 3 is an audit
  that may be a no-op if the call examples already pass `rerank`.
