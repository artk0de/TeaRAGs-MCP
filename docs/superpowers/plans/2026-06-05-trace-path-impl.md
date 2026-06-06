# trace_path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `trace_path` codegraph MCP tool that returns all simple call
paths A→B in execution order, each step carrying a git/churn "danger" overlay,
so a debugging agent jumps straight to the riskiest step on the path.

**Architecture:** A pure bounded-DFS path enumerator lives in
`domains/trajectory/codegraph/symbols/path-tracing/` (zero deps, fully
unit-testable over a mock adjacency map). Cross-domain orchestration — fetch
adjacency from the codegraph DuckDB, run the enumerator, hydrate each step from
Qdrant, attach a danger overlay via the existing Reranker in a new
**annotate-only** mode (`reorder: false`), assemble + sort paths — lives in a
new `TracePathOps` in `api/internal/ops/` (the only layer permitted to bridge
the codegraph trajectory and the explore domain). `GraphFacade` is left
untouched; `App.tracePath` delegates straight to `TracePathOps` like
`createCollection` delegates to `CollectionOps`.

**Tech Stack:** TypeScript, DuckDB (codegraph edges), Qdrant (chunk payloads),
Vitest, Zod (MCP schema), the existing Reranker + preset machinery.

**Spec:** `docs/superpowers/specs/2026-05-25-trace-path-design.md` (Design
approved 2026-05-25). **Beads:** epic `tea-rags-mcp-l26`, task
`tea-rags-mcp-jz1m` (depends on `uxsr`). Defaults locked this session:
`maxDepth=8`, `maxPaths=10`.

---

## Design decisions that refine the spec

The spec is high-level; these are the concrete bindings the implementation locks
in. They do **not** change scope — they resolve under-specified assembly details
against the project's layering rules.

1. **Orchestration home = `api/internal/ops/TracePathOps`, not `GraphFacade`.**
   `facade-discipline.md` forbids pipeline work (scroll chunks, rerank,
   multi-source assembly) in a facade. `domain-boundaries.md` +
   `domains-language.md` rule #1 make `api/internal/` the only layer allowed to
   bridge two domains (codegraph trajectory adjacency + explore rerank). So the
   assembly is an ops class; `App.tracePath` → `TracePathOps` directly.
   `GraphFacade` is not modified.

2. **`getCalleeEdges(symbolIds[])` is a frontier-expansion primitive, not a
   full-graph load.** The spec's "pure fn over an adjacency map" is preserved:
   `TracePathOps` builds a _partial_ adjacency map by expanding the call
   frontier from A level-by-level (≤ `maxDepth`) via batched `getCalleeEdges`
   calls, then hands that map to the pure `PathTracer.enumerate`. The full
   method graph is never materialized. This honors the `GraphDbClient` fragility
   (one new method, indexed `IN (...)` read).

3. **Type placement.** The _pure tracer_ owns only its own types in
   `path-tracing/types.ts` (`EnumeratedPath`, `EnumerateOptions`) — zero
   rerank/overlay coupling. The _consumer-facing_ shapes that carry the
   `RankingOverlay` (`PathStep`, `TracedPath`, `PathTraceResult`,
   `TracePathRequest`) are DTOs in `api/public/dto/graph.ts`, per
   `domain-boundaries.md` (response types live in `dto/`). This is the
   layering-correct reading of the spec's `types.ts` line.

4. **`aggregateDanger` = the maximum per-step danger score on the path** (the
   single riskiest step defines the path's risk — matches the "jump to the
   riskiest step" goal); `dangerRanking` = step indices sorted by per-step
   danger descending; the path list is sorted by `aggregateDanger` descending.
   The per-step danger score is the Reranker's score for that step's chunk under
   the chosen preset.

---

## File structure

| File                                                                        | Create / Modify | Responsibility                                                             |
| --------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------- |
| `src/core/domains/trajectory/codegraph/symbols/path-tracing/types.ts`       | Create          | `EnumeratedPath`, `EnumerateOptions` — pure tracer vocabulary              |
| `src/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.ts` | Create          | `enumeratePaths(adjacency, from, to, opts)` — pure bounded DFS, cycle-safe |
| `src/core/domains/trajectory/codegraph/symbols/path-tracing/index.ts`       | Create          | barrel                                                                     |
| `src/core/domains/trajectory/codegraph/symbols/index.ts`                    | Modify          | re-export `path-tracing` (barrel-files rule)                               |
| `src/core/contracts/types/reranker.ts`                                      | Modify          | add `reorder?: boolean` to `RerankOptions`                                 |
| `src/core/domains/explore/reranker.ts`                                      | Modify          | gate the single sort behind `reorder !== false`                            |
| `src/core/contracts/types/codegraph.ts`                                     | Modify          | add `getCalleeEdges` to `GraphDbClient`                                    |
| `src/core/adapters/duckdb/client.ts`                                        | Modify          | `DuckDbGraphClient.getCalleeEdges` (SQL)                                   |
| `src/core/adapters/duckdb/daemon/protocol.ts`                               | Modify          | `getCalleeEdges` op + param shape                                          |
| `src/core/adapters/duckdb/daemon/server.ts`                                 | Modify          | dispatch case (serialize Map as entries)                                   |
| `src/core/adapters/duckdb/daemon/client.ts`                                 | Modify          | `DaemonGraphDbClient.getCalleeEdges` proxy                                 |
| `src/core/adapters/qdrant/client.ts`                                        | Modify          | `QdrantManager.scrollBySymbolIds` batch hydration                          |
| `src/core/api/public/dto/graph.ts`                                          | Modify          | `TracePathRequest`, `PathStep`, `TracedPath`, `PathTraceResult`            |
| `src/core/api/internal/ops/trace-path-ops.ts`                               | Create          | cross-domain orchestration                                                 |
| `src/core/api/public/app.ts`                                                | Modify          | `App.tracePath` + `AppDeps.tracePathOps` + `createApp` wiring              |
| `src/bootstrap/factory.ts`                                                  | Modify          | construct `TracePathOps`, thread into App deps                             |
| `src/mcp/tools/codegraph.ts`                                                | Modify          | register `trace_path` (gated)                                              |

Tests mirror source under `tests/`.

---

### Task 1: Pure path enumerator (`PathTracer`)

Highest-value, zero-dependency, fully isolated unit — built first. Pure function
over a `Map<string, string[]>` adjacency; no DuckDB, no Qdrant, no rerank.

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/path-tracing/types.ts`
- Create:
  `src/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.ts`
- Create: `src/core/domains/trajectory/codegraph/symbols/path-tracing/index.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.test.ts
import { describe, expect, it } from "vitest";

import { enumeratePaths } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.js";

const adj = (entries: Record<string, string[]>): Map<string, string[]> =>
  new Map(Object.entries(entries));

describe("enumeratePaths", () => {
  it("returns the single linear path A->B->C", () => {
    const r = enumeratePaths(adj({ A: ["B"], B: ["C"], C: [] }), "A", "C", {
      maxDepth: 8,
      maxPaths: 10,
    });
    expect(r.paths).toEqual([["A", "B", "C"]]);
    expect(r.truncated).toBe(false);
  });

  it("returns all simple paths when the graph branches", () => {
    const r = enumeratePaths(
      adj({ A: ["B", "D"], B: ["C"], D: ["C"], C: [] }),
      "A",
      "C",
      { maxDepth: 8, maxPaths: 10 },
    );
    expect(r.paths).toContainEqual(["A", "B", "C"]);
    expect(r.paths).toContainEqual(["A", "D", "C"]);
    expect(r.paths).toHaveLength(2);
  });

  it("never loops on a cycle and still finds the exit path", () => {
    const r = enumeratePaths(
      adj({ A: ["B"], B: ["A", "C"], C: [] }),
      "A",
      "C",
      { maxDepth: 8, maxPaths: 10 },
    );
    expect(r.paths).toEqual([["A", "B", "C"]]);
  });

  it("drops paths longer than maxDepth (depth = edge count)", () => {
    const r = enumeratePaths(
      adj({ A: ["B"], B: ["C"], C: ["D"], D: [] }),
      "A",
      "D",
      { maxDepth: 2, maxPaths: 10 },
    );
    expect(r.paths).toEqual([]); // A->B->C->D is 3 edges > maxDepth 2
  });

  it("caps the result at maxPaths and flags truncation", () => {
    const r = enumeratePaths(
      adj({ A: ["B", "C", "D"], B: ["E"], C: ["E"], D: ["E"], E: [] }),
      "A",
      "E",
      {
        maxDepth: 8,
        maxPaths: 2,
      },
    );
    expect(r.paths).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("returns empty when no path exists", () => {
    const r = enumeratePaths(adj({ A: ["B"], B: [], C: [] }), "A", "C", {
      maxDepth: 8,
      maxPaths: 10,
    });
    expect(r.paths).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("returns the trivial one-node path when from === to", () => {
    const r = enumeratePaths(adj({ A: ["B"] }), "A", "A", {
      maxDepth: 8,
      maxPaths: 10,
    });
    expect(r.paths).toEqual([["A"]]);
  });

  it("returns empty when the start node is absent from the adjacency", () => {
    const r = enumeratePaths(adj({ B: ["C"] }), "A", "C", {
      maxDepth: 8,
      maxPaths: 10,
    });
    expect(r.paths).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.test.ts`
Expected: FAIL — "Failed to resolve import .../path-tracer.js".

- [ ] **Step 3: Write the types**

```typescript
// src/core/domains/trajectory/codegraph/symbols/path-tracing/types.ts
import type { SymbolId } from "../../../../../contracts/types/codegraph.js";

/** One enumerated call path, in execution order (caller -> callee). */
export type EnumeratedPath = SymbolId[];

export interface EnumerateOptions {
  /** Max edges on a path (depth = number of hops, not number of nodes). */
  maxDepth: number;
  /** Hard cap on returned paths; enumeration stops once reached. */
  maxPaths: number;
}

export interface EnumerateResult {
  /** Simple paths A->B (no repeated node), each in execution order. */
  paths: EnumeratedPath[];
  /** True if the `maxPaths` cap stopped enumeration before exhaustion. */
  truncated: boolean;
}
```

- [ ] **Step 4: Write the minimal implementation**

```typescript
// src/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.ts
import type { SymbolId } from "../../../../../contracts/types/codegraph.js";
import type { EnumerateOptions, EnumerateResult } from "./types.js";

/**
 * Enumerate every simple call path `from`->`to` over a pre-built adjacency
 * map, bounded by `maxDepth` (edge count) and `maxPaths`. Pure: no I/O, no
 * mutation of the input. Cycle-safe — the on-stack `visited` set guarantees
 * no node repeats within a path, so a cyclic graph cannot loop forever.
 */
export function enumeratePaths(
  adjacency: ReadonlyMap<SymbolId, SymbolId[]>,
  from: SymbolId,
  to: SymbolId,
  opts: EnumerateOptions,
): EnumerateResult {
  const paths: SymbolId[][] = [];
  let truncated = false;

  if (from === to) return { paths: [[from]], truncated: false };

  const stack: SymbolId[] = [from];
  const visited = new Set<SymbolId>([from]);

  const dfs = (node: SymbolId): void => {
    if (paths.length >= opts.maxPaths) {
      truncated = true;
      return;
    }
    if (stack.length - 1 >= opts.maxDepth) return; // depth = edges already taken
    for (const next of adjacency.get(node) ?? []) {
      if (paths.length >= opts.maxPaths) {
        truncated = true;
        return;
      }
      if (visited.has(next)) continue; // simple-path guard (also breaks cycles)
      stack.push(next);
      if (next === to) {
        paths.push([...stack]);
      } else {
        visited.add(next);
        dfs(next);
        visited.delete(next);
      }
      stack.pop();
    }
  };

  dfs(from);
  return { paths, truncated };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/path-tracing/path-tracer.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Write the barrel + register in the symbols barrel**

```typescript
// src/core/domains/trajectory/codegraph/symbols/path-tracing/index.ts
export { enumeratePaths } from "./path-tracer.js";
export type {
  EnumeratedPath,
  EnumerateOptions,
  EnumerateResult,
} from "./types.js";
```

Then add to `src/core/domains/trajectory/codegraph/symbols/index.ts` (append
next to the existing exports):

```typescript
export * from "./path-tracing/index.js";
```

- [ ] **Step 7: Verify + commit**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/trajectory/codegraph/symbols/path-tracing/`
Expected: tsc clean, tests PASS.

```bash
git add src/core/domains/trajectory/codegraph/symbols/path-tracing tests/core/domains/trajectory/codegraph/symbols/path-tracing src/core/domains/trajectory/codegraph/symbols/index.ts
git commit -m "feat(trajectory): pure bounded-DFS path enumerator for trace_path"
```

---

### Task 2: Reranker annotate-only mode (`reorder: false`)

Isolate the single highest-churn file's change behind one flag, gating the lone
sort. Mandatory regression test: `reorder: false` never permutes input order,
overlay still attached.

**Files:**

- Modify: `src/core/contracts/types/reranker.ts:37` (`RerankOptions`)
- Modify: `src/core/domains/explore/reranker.ts:147` (the sort)
- Test: `tests/core/domains/explore/reranker.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing regression test**

```typescript
// append to tests/core/domains/explore/reranker.test.ts
describe("rerank annotate-only mode (reorder: false)", () => {
  it("attaches overlays but preserves input order", async () => {
    // Reuse the test file's existing reranker construction helper / fixtures.
    // `results` MUST be ordered so that score-desc sorting WOULD reorder them
    // (i.e. a low-danger item first, high-danger second).
    const results = makeResults([
      {
        id: "A",
        score: 0.1,
        payload: { relativePath: "a.ts", git: { file: { bugFixRate: 0 } } },
      },
      {
        id: "B",
        score: 0.1,
        payload: { relativePath: "b.ts", git: { file: { bugFixRate: 90 } } },
      },
    ]);

    const annotated = await reranker.rerank(
      results,
      "bugHunt",
      "semantic_search",
      { reorder: false },
    );

    expect(annotated.map((r) => r.id)).toEqual(["A", "B"]); // order identical to input
    expect(annotated[0].rankingOverlay).toBeDefined(); // overlay still computed
    expect(annotated[1].rankingOverlay).toBeDefined();
  });

  it("still reorders by default (reorder omitted)", async () => {
    const results = makeResults([
      {
        id: "A",
        score: 0.1,
        payload: { relativePath: "a.ts", git: { file: { bugFixRate: 0 } } },
      },
      {
        id: "B",
        score: 0.1,
        payload: { relativePath: "b.ts", git: { file: { bugFixRate: 90 } } },
      },
    ]);
    const sorted = await reranker.rerank(results, "bugHunt", "semantic_search");
    expect(sorted.map((r) => r.id)).toEqual(["B", "A"]); // danger-desc
  });
});
```

> NOTE: match `makeResults` / `reranker` to the helpers already present in
> `reranker.test.ts`. If the file builds the reranker inline per-test, mirror
> that exact setup — do not invent a new harness (test-patterns.md: don't
> rewrite existing tests; add new ones in the local style).

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/explore/reranker.test.ts -t "annotate-only"`
Expected: FAIL — `reorder` is not a known option / order is reordered.

- [ ] **Step 3: Add the flag to the contract**

In `src/core/contracts/types/reranker.ts`, extend `RerankOptions`:

```typescript
export interface RerankOptions {
  signalLevel?: SignalLevel;
  query?: string;
  /**
   * When false, overlays are still computed and attached but the final
   * score-descending sort is skipped — the returned array preserves input
   * order. Default true (sort as before). Used by trace_path to annotate a
   * path with danger overlays without disturbing execution order.
   */
  reorder?: boolean;
}
```

- [ ] **Step 4: Gate the sort**

In `src/core/domains/explore/reranker.ts` around line 147, the current body is:

```typescript
const sorted = scored.sort((a, b) => b.score - a.score);
return resolved.groupBy ? groupByTop(sorted, resolved.groupBy) : sorted;
```

Replace with (read `options?.reorder` — it is already in scope where `options`
is the 4th param):

```typescript
const ordered =
  options?.reorder === false
    ? scored
    : scored.sort((a, b) => b.score - a.score);
return resolved.groupBy ? groupByTop(ordered, resolved.groupBy) : ordered;
```

> The overlay is attached upstream in `scoreResults()` (reranker.ts:223),
> unaffected by this gate — so `reorder: false` keeps overlays and only skips
> the sort. `groupByTop` is intentionally still applied (it dedups, does not
> reorder semantically); trace_path does not pass `groupBy`, so it is a no-op
> there.

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/explore/reranker.test.ts -t "annotate-only"`
then the full file. Expected: both new tests PASS; no existing reranker test
regresses.

- [ ] **Step 6: Verify + commit**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/explore/reranker.test.ts`
Expected: clean.

```bash
git add src/core/contracts/types/reranker.ts src/core/domains/explore/reranker.ts tests/core/domains/explore/reranker.test.ts
git commit -m "feat(rerank): add annotate-only mode (reorder:false) preserving input order

Why: trace_path needs danger overlays attached to a path WITHOUT reordering
the steps — execution order is the information. Single gate on the lone sort;
overlay extraction path is unchanged (no duplication). Trade-off: one extra
branch in the hot rerank path, negligible vs the sort it guards."
```

---

### Task 3: `getCalleeEdges` adjacency primitive (contract + DuckDB)

One new read on the fragile `GraphDbClient` hub. Type ripples to ~47 importers —
caught entirely by `tsc`. SQL is an indexed `IN (...)` over the existing
method-edge table.

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (`GraphDbClient`, after
  `getCallees` at line 569)
- Modify: `src/core/adapters/duckdb/client.ts` (after `getCallees`, line 675)
- Test: `tests/core/adapters/duckdb/client.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/core/adapters/duckdb/client.test.ts, inside the existing
// describe that constructs a real DuckDbGraphClient over a temp DB (reuse the
// file's existing setup: migrate + upsertFile with method edges).
describe("getCalleeEdges (batch adjacency for trace_path)", () => {
  it("returns callee target symbolIds keyed by source, for many sources at once", async () => {
    // Seed via the file's existing upsertFile helper:
    //   A -> B, A -> C, B -> D   (method edges, non-null targets)
    await seedMethodEdges(client, [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "B", target: "D" },
    ]);

    const adj = await client.getCalleeEdges(["A", "B", "X"]);

    expect(new Set(adj.get("A"))).toEqual(new Set(["B", "C"]));
    expect(adj.get("B")).toEqual(["D"]);
    expect(adj.get("X")).toBeUndefined(); // unknown source -> no entry
  });

  it("excludes file-only edges (null target symbol)", async () => {
    await seedMethodEdges(client, [{ source: "A", target: null }]);
    const adj = await client.getCalleeEdges(["A"]);
    expect(adj.get("A")).toBeUndefined();
  });

  it("returns an empty map for an empty input list", async () => {
    const adj = await client.getCalleeEdges([]);
    expect(adj.size).toBe(0);
  });
});
```

> `seedMethodEdges` — if the test file lacks such a helper, insert edges with
> the existing `client.upsertFile(node, { fileEdges: [], methodEdges: [...] })`
> API (see `GraphEdges` in codegraph.ts:698). Build `methodEdges` entries
> `{ sourceSymbolId, targetSymbolId, targetRelPath, callExpression }`.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/adapters/duckdb/client.test.ts -t "getCalleeEdges"`
Expected: FAIL — `client.getCalleeEdges is not a function`.

- [ ] **Step 3: Add to the contract**

In `src/core/contracts/types/codegraph.ts`, immediately after `getCallees` (line
569):

```typescript
/**
 * Batch adjacency: for each input source symbolId, the list of callee
 * target symbolIds (file-only edges with a null target are excluded).
 * Used by trace_path to expand the call frontier level-by-level without
 * materialising the whole method graph. Sources with no callees are
 * simply absent from the returned map.
 */
getCalleeEdges: (symbolIds: SymbolId[]) => Promise<Map<SymbolId, SymbolId[]>>;
```

- [ ] **Step 4: Implement in `DuckDbGraphClient`**

In `src/core/adapters/duckdb/client.ts`, after `getCallees` (line 675):

```typescript
  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    const out = new Map<SymbolId, SymbolId[]>();
    if (symbolIds.length === 0) return out;
    const placeholders = symbolIds.map(() => "?").join(", ");
    const rows = await this.queryAll<{ source: SymbolId; target: SymbolId }>(
      `SELECT source_symbol_id AS source, target_symbol_id AS target
       FROM cg_symbols_edges_method
       WHERE source_symbol_id IN (${placeholders}) AND target_symbol_id IS NOT NULL
       ORDER BY source_symbol_id, target_symbol_id`,
      symbolIds,
    );
    for (const { source, target } of rows) {
      const list = out.get(source);
      if (list) list.push(target);
      else out.set(source, [target]);
    }
    return out;
  }
```

> `queryAll<T>(sql, params)` is the existing private helper (used by every read
> above). The `target_symbol_id` index
> (`idx_cg_symbols_edges_method_target_symbol`) does not assist this
> source-keyed scan, but the table is the same one `getCallees` reads per single
> source; batching N sources in one statement is the win.

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/adapters/duckdb/client.test.ts -t "getCalleeEdges"`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify the type ripple + commit**

Run: `npx tsc --noEmit` Expected: clean — confirms every `GraphDbClient`
implementer (in-process + daemon + any test doubles) now satisfies the new
method. If `tsc` flags the daemon client, that is Task 4 — proceed there before
committing this task, OR add a temporary `getCalleeEdges` throwing stub to the
daemon client and remove it in Task 4. Prefer doing Task 4 next and committing
them together if tsc is red.

```bash
git add src/core/contracts/types/codegraph.ts src/core/adapters/duckdb/client.ts tests/core/adapters/duckdb/client.test.ts
git commit -m "feat(trajectory): GraphDbClient.getCalleeEdges batch adjacency for trace_path

Why: trace_path expands the call frontier level-by-level; one batched IN(...)
read replaces N single-source getCallees calls. Added to the fragile GraphDbClient
hub as exactly ONE method (spec constraint) — no recursive path SQL in the adapter."
```

---

### Task 4: Daemon proxy for `getCalleeEdges`

Reads route full-proxy through the daemon (DuckDB RW lock is process-exclusive).
Add the op to the protocol union, the dispatch case, and the client proxy. Map
is JSON-serialised as entries (same pattern as `listAdjacency`).

**Files:**

- Modify: `src/core/adapters/duckdb/daemon/protocol.ts` (`DaemonOp` line 45,
  params line 57)
- Modify: `src/core/adapters/duckdb/daemon/server.ts` (dispatch, after
  `getCallees` line 112)
- Modify: `src/core/adapters/duckdb/daemon/client.ts` (proxy, after `getCallees`
  line 244)
- Test: `tests/core/adapters/duckdb/daemon/server.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/core/adapters/duckdb/daemon/server.test.ts, reusing the
// existing CodegraphDaemonServer + pool fixture in that file.
it("dispatches getCalleeEdges and serialises the Map as entries", async () => {
  // Seed method edges A->B, A->C via the file's existing pool/graphDb setup.
  await seedMethodEdges(pool, collection, [
    { source: "A", target: "B" },
    { source: "A", target: "C" },
  ]);

  const res = await server.handle({
    id: 1,
    op: "getCalleeEdges",
    params: { collection, symbolIds: ["A"] },
  });

  expect(res.ok).toBe(true);
  // Map serialises as [key, value][] entries over the wire.
  expect(res.ok && res.result).toEqual([["A", ["B", "C"]]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/adapters/duckdb/daemon/server.test.ts -t "getCalleeEdges"`
Expected: FAIL — `unknown daemon op: getCalleeEdges`.

- [ ] **Step 3: Extend the protocol**

In `src/core/adapters/duckdb/daemon/protocol.ts`, add to the reads section of
`DaemonOp` (after `"getCallees"`, line 37):

```typescript
  | "getCalleeEdges"
```

And add a param variant to `DaemonRequest.params` union (after the
`getCallers | getCallees ...` line 57):

```typescript
    | { collection: string; symbolIds: SymbolId[] } // getCalleeEdges
```

- [ ] **Step 4: Add the dispatch case**

In `src/core/adapters/duckdb/daemon/server.ts`, after the `getCallees` case
(line 112):

```typescript
      case "getCalleeEdges": {
        const { graphDb } = await this.pool.acquire(collection);
        // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
        const adj = await graphDb.getCalleeEdges(p.symbolIds as SymbolId[]);
        return [...adj.entries()];
      }
```

- [ ] **Step 5: Add the client proxy**

In `src/core/adapters/duckdb/daemon/client.ts`, after `getCallees` (line 244):

```typescript
  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    const entries = (await this.call("getCalleeEdges", { symbolIds })) as [SymbolId, SymbolId[]][];
    return new Map(entries);
  }
```

- [ ] **Step 6: Run test + full tsc**

Run:
`npx vitest run tests/core/adapters/duckdb/daemon/server.test.ts -t "getCalleeEdges" && npx tsc --noEmit`
Expected: PASS, tsc clean (daemon client now satisfies `GraphDbClient`).

- [ ] **Step 7: Commit**

```bash
git add src/core/adapters/duckdb/daemon tests/core/adapters/duckdb/daemon/server.test.ts
git commit -m "feat(adapters): proxy getCalleeEdges through codegraph daemon

Why: reads route through the daemon's sole RW connection (DuckDB RW lock is
process-exclusive). Map rides the wire as entries, rebuilt client-side — same
pattern as listAdjacency. Trade-off: one IPC round-trip per frontier level,
bounded by maxDepth."
```

---

### Task 5: `QdrantManager.scrollBySymbolIds` (step hydration)

Batch-fetch chunk payloads (relativePath, startLine, endLine, git/codegraph
signals) for the symbolIds on the discovered paths — one Qdrant scroll with a
`should` (OR) filter. Adapter CRUD only; no rerank, no business logic.

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts` (new method near
  `scrollFiltered`, ~line 1248)
- Test: `tests/core/adapters/qdrant/client.test.ts` (append) — or the existing
  qdrant client test file

- [ ] **Step 1: Write the failing test**

```typescript
// append to the qdrant client test file (reuse its in-memory/mock harness).
describe("scrollBySymbolIds", () => {
  it("returns chunks whose symbolId is in the set, in one call", async () => {
    // Seed points with payload.symbolId = "A", "B", "C".
    const chunks = await qdrant.scrollBySymbolIds(collection, ["A", "C"]);
    const ids = chunks.map((c) => c.payload.symbolId).sort();
    expect(ids).toEqual(["A", "C"]);
  });

  it("returns [] for an empty id list without querying", async () => {
    const chunks = await qdrant.scrollBySymbolIds(collection, []);
    expect(chunks).toEqual([]);
  });
});
```

> Match the existing qdrant test harness (MockQdrant or a live embedded instance
> — follow whatever `client.test.ts` already uses). If the suite needs a running
> Qdrant and is integration-gated, place this under the same gate the
> neighbouring scroll tests use.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/adapters/qdrant/client.test.ts -t "scrollBySymbolIds"`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement**

In `src/core/adapters/qdrant/client.ts`, add next to `scrollFiltered`:

```typescript
  /**
   * Fetch chunk payloads for an exact set of symbolIds in one scroll, using a
   * `should` (OR) filter of exact-match conditions. Used by trace_path to
   * hydrate each path step with its relativePath / line range / git+codegraph
   * signals. Empty input short-circuits to [] (no query). Result order is not
   * guaranteed — callers index by `payload.symbolId`.
   */
  async scrollBySymbolIds(
    collectionName: string,
    symbolIds: string[],
    limit = 1024,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    if (symbolIds.length === 0) return [];
    const filter = {
      should: symbolIds.map((id) => ({ key: "symbolId", match: { value: id } })),
    };
    return this.scrollFiltered(collectionName, filter, limit);
  }
```

> Uses `match: { value }` (exact) — NOT `match: { text }`. symbolId is stored as
> an exact keyword; `text` would do token matching and over-fetch. Delegates to
> the existing `scrollFiltered` so framing/paging is reused.

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/adapters/qdrant/client.test.ts -t "scrollBySymbolIds"`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit`

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client.test.ts
git commit -m "feat(qdrant): scrollBySymbolIds batch payload hydration for trace_path"
```

---

### Task 6: trace_path DTOs

Consumer-facing response shapes carrying the danger overlay. Type-only;
tsc-checked.

**Files:**

- Modify: `src/core/api/public/dto/graph.ts` (append)
- Test: covered transitively by Task 7/8 (no standalone test for pure
  interfaces).

- [ ] **Step 1: Add the DTOs**

Append to `src/core/api/public/dto/graph.ts` (and add the `RankingOverlay`
import to the existing import block at the top of the file):

```typescript
// ── Slice 6 — trace_path ──

export interface TracePathRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /** Start symbol of the path (caller end). */
  from: SymbolId;
  /** End symbol of the path (callee end). */
  to: SymbolId;
  /** Rerank preset that defines "danger" for the overlay. Default: bugHunt. */
  rerank?: string;
  /** Max hops on a path (edge count). Default 8. */
  maxDepth?: number;
  /** Max paths returned, sorted by aggregateDanger desc. Default 10. */
  maxPaths?: number;
}

export interface PathStep {
  /** Class#method (instance) / Class.method (static) / functionName. */
  symbolId: SymbolId;
  relativePath: RelPath;
  startLine: number;
  endLine: number;
  /** bugFixRate / churn / ownership labels from the chosen rerank preset. */
  dangerOverlay?: RankingOverlay;
}

export interface TracedPath {
  /** ORDERED — execution order, never reordered. */
  steps: PathStep[];
  /** Indices into `steps`, sorted by per-step danger desc (where to look first). */
  dangerRanking: number[];
  /** Path-level score = max per-step danger; used to sort the path list. */
  aggregateDanger: number;
}

export interface PathTraceResult {
  /** Sorted by aggregateDanger, most dangerous first. */
  paths: TracedPath[];
  /** True if maxPaths/maxDepth capped enumeration. */
  truncated: boolean;
}
```

Top-of-file import change:

```typescript
import type {
  CycleScope,
  RelPath,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";
```

> `SymbolId` and `RelPath` are already imported (line 12). Add the
> `RankingOverlay` import line.

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit`

```bash
git add src/core/api/public/dto/graph.ts
git commit -m "feat(api): trace_path DTOs (TracePathRequest, PathStep, TracedPath, PathTraceResult)"
```

---

### Task 7: `TracePathOps` — cross-domain orchestration

The heart of the feature. Bridges codegraph adjacency + explore rerank. Lives in
`api/internal/ops/` (the only cross-domain bridge layer). Fully unit-testable
with mock deps.

**Files:**

- Create: `src/core/api/internal/ops/trace-path-ops.ts`
- Test: `tests/core/api/internal/ops/trace-path-ops.test.ts`

**Dependencies (constructor):** `pool: GraphDbClientPool`,
`qdrant: QdrantManager`, `reranker: Reranker`,
`collectionRegistry: CollectionRegistry`,
`payloadSignals: PayloadSignalDescriptor[]`,
`resolveActiveCollection?: (name) => Promise<string>`.

- [ ] **Step 1: Write the failing test (mock all deps)**

```typescript
// tests/core/api/internal/ops/trace-path-ops.test.ts
import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../../src/core/api/internal/ops/trace-path-ops.js";

function makeOps(overrides: Partial<Record<string, unknown>> = {}) {
  const graphDb = {
    getCalleeEdges: vi.fn(async (ids: string[]) => {
      const g: Record<string, string[]> = { A: ["B"], B: ["C"], C: [] };
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
          git: { file: { bugFixRate: id === "B" ? 90 : 0 } },
        },
      })),
    ),
  };
  const reranker = {
    rerank: vi.fn(async (results: { payload?: { symbolId?: string } }[]) =>
      results.map((r) => ({
        ...r,
        score: r.payload?.symbolId === "B" ? 0.9 : 0.1,
        rankingOverlay: { preset: "bugHunt" },
      })),
    ),
  };
  const collectionRegistry = {};
  return new TracePathOps({
    pool: pool as never,
    qdrant: qdrant as never,
    reranker: reranker as never,
    collectionRegistry: collectionRegistry as never,
    payloadSignals: [],
    resolveActiveCollection: async (n: string) => n,
    ...overrides,
  });
}

describe("TracePathOps.tracePath", () => {
  it("returns the A->B->C path in execution order with danger overlays", async () => {
    const ops = makeOps();
    const res = await ops.tracePath({ collection: "c", from: "A", to: "C" });
    expect(res.paths).toHaveLength(1);
    expect(res.paths[0].steps.map((s) => s.symbolId)).toEqual(["A", "B", "C"]); // order preserved
    expect(res.paths[0].steps.every((s) => s.dangerOverlay)).toBe(true);
  });

  it("ranks the riskiest step first via dangerRanking and sets aggregateDanger to its max", async () => {
    const ops = makeOps();
    const res = await ops.tracePath({ collection: "c", from: "A", to: "C" });
    const path = res.paths[0];
    expect(path.steps[path.dangerRanking[0]].symbolId).toBe("B"); // B is the 0.9 step
    expect(path.aggregateDanger).toBeCloseTo(0.9);
  });

  it("returns empty paths when no route exists, without throwing", async () => {
    const ops = makeOps();
    const res = await ops.tracePath({ collection: "c", from: "A", to: "Z" });
    expect(res.paths).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("passes reorder:false to the reranker (annotate-only)", async () => {
    const reranker = {
      rerank: vi.fn(async (r: unknown[]) =>
        r.map((x) => ({
          ...(x as object),
          score: 0,
          rankingOverlay: { preset: "bugHunt" },
        })),
      ),
    };
    const ops = makeOps({ reranker: reranker as never });
    await ops.tracePath({ collection: "c", from: "A", to: "C" });
    expect(reranker.rerank).toHaveBeenCalledWith(
      expect.anything(),
      "bugHunt",
      "semantic_search",
      expect.objectContaining({ reorder: false }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/internal/ops/trace-path-ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TracePathOps`**

```typescript
// src/core/api/internal/ops/trace-path-ops.ts
import type {
  CollectionGraphHandle,
  GraphDbClientPool,
} from "../../../adapters/duckdb/pool.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { SymbolId } from "../../../contracts/types/codegraph.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/provider.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { enumeratePaths } from "../../../domains/trajectory/codegraph/symbols/index.js";
import { resolveCollection } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/index.js";
import type {
  PathStep,
  PathTraceResult,
  TracedPath,
  TracePathRequest,
} from "../../public/dto/graph.js";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_PATHS = 10;
const DEFAULT_PRESET = "bugHunt";

export interface TracePathOpsDeps {
  pool: GraphDbClientPool;
  qdrant: QdrantManager;
  reranker: Reranker;
  collectionRegistry: CollectionRegistry;
  payloadSignals: PayloadSignalDescriptor[];
  resolveActiveCollection?: (collectionName: string) => Promise<string>;
}

const EMPTY: PathTraceResult = { paths: [], truncated: false };

export class TracePathOps {
  constructor(private readonly deps: TracePathOpsDeps) {}

  async tracePath(req: TracePathRequest): Promise<PathTraceResult> {
    const maxDepth = req.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxPaths = req.maxPaths ?? DEFAULT_MAX_PATHS;
    const preset = req.rerank ?? DEFAULT_PRESET;

    const { collectionName } = resolveCollection(
      this.deps.collectionRegistry,
      req,
    );
    const active = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => collectionName)
      : collectionName;

    // 1. Build a bounded adjacency map by expanding the call frontier from `from`.
    let handle: CollectionGraphHandle | undefined;
    let adjacency: Map<SymbolId, SymbolId[]>;
    try {
      handle = await this.deps.pool.acquireReader(active);
    } catch {
      return EMPTY; // pool unavailable -> graceful empty
    }
    try {
      adjacency = await this.buildBoundedAdjacency(handle, req.from, maxDepth);
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }

    // 2. Enumerate simple paths over the partial map (pure).
    const { paths, truncated } = enumeratePaths(adjacency, req.from, req.to, {
      maxDepth,
      maxPaths,
    });
    if (paths.length === 0) return { paths: [], truncated };

    // 3. Hydrate every step symbol from Qdrant (one scroll for the whole union).
    const unique = [...new Set(paths.flat())];
    const chunks = await this.deps.qdrant.scrollBySymbolIds(active, unique);
    const byId = new Map(chunks.map((c) => [c.payload.symbolId as string, c]));

    // 4. Annotate-only rerank over the hydrated chunks -> danger score + overlay.
    const rerankInput = chunks.map((c) => ({
      id: c.id,
      score: 0,
      payload: c.payload,
    }));
    const annotated = await this.deps.reranker.rerank(
      rerankInput,
      preset,
      "semantic_search",
      { reorder: false },
    );
    const dangerById = new Map<
      string,
      { score: number; overlay?: RankingOverlay }
    >();
    for (const r of annotated) {
      dangerById.set((r.payload?.symbolId as string) ?? "", {
        score: r.score,
        overlay: r.rankingOverlay,
      });
    }

    // 5. Assemble TracedPath per enumerated path; sort the list by aggregateDanger desc.
    const traced: TracedPath[] = paths.map((p) =>
      this.assemble(p, byId, dangerById),
    );
    traced.sort((a, b) => b.aggregateDanger - a.aggregateDanger);
    return { paths: traced, truncated };
  }

  private async buildBoundedAdjacency(
    handle: CollectionGraphHandle,
    from: SymbolId,
    maxDepth: number,
  ): Promise<Map<SymbolId, SymbolId[]>> {
    const adjacency = new Map<SymbolId, SymbolId[]>();
    const visited = new Set<SymbolId>([from]);
    let frontier: SymbolId[] = [from];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const edges = await handle.graphDb.getCalleeEdges(frontier);
      const next: SymbolId[] = [];
      for (const src of frontier) {
        const targets = edges.get(src) ?? [];
        adjacency.set(src, targets);
        for (const t of targets) {
          if (!visited.has(t)) {
            visited.add(t);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    return adjacency;
  }

  private assemble(
    path: SymbolId[],
    byId: Map<
      string,
      { id: string | number; payload: Record<string, unknown> }
    >,
    dangerById: Map<string, { score: number; overlay?: RankingOverlay }>,
  ): TracedPath {
    const steps: PathStep[] = path.map((symbolId) => {
      const payload = byId.get(symbolId)?.payload ?? {};
      const danger = dangerById.get(symbolId);
      return {
        symbolId,
        relativePath: (payload.relativePath as string) ?? "",
        startLine: (payload.startLine as number) ?? 0,
        endLine: (payload.endLine as number) ?? 0,
        dangerOverlay: danger?.overlay,
      };
    });
    const dangers = path.map((id) => dangerById.get(id)?.score ?? 0);
    const dangerRanking = steps
      .map((_, i) => i)
      .sort((a, b) => dangers[b] - dangers[a]);
    const aggregateDanger = dangers.length > 0 ? Math.max(...dangers) : 0;
    return { steps, dangerRanking, aggregateDanger };
  }
}
```

> `enumeratePaths` is imported through the `symbols/index.js` barrel (Task 1
> Step 6 re-exports path-tracing there) — keeps the cross-module import on the
> trajectory barrel per barrel-files.md. Confirm `PayloadSignalDescriptor` lives
> in `contracts/types/provider.js` (it does, per project-structure.md); adjust
> the import if tsc disagrees.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/internal/ops/trace-path-ops.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit && npx vitest run tests/core/api/internal/ops/`

```bash
git add src/core/api/internal/ops/trace-path-ops.ts tests/core/api/internal/ops/trace-path-ops.test.ts
git commit -m "feat(api): TracePathOps — bounded frontier BFS + path enumeration + danger overlay

Why: bridges codegraph adjacency and explore rerank in the one layer allowed to
cross domains. Frontier expansion bounds graph reads to maxDepth from the source;
pure enumerator finds simple paths; annotate-only rerank attaches danger without
reordering steps. aggregateDanger = max step danger (riskiest step defines the path)."
```

---

### Task 8: Wire `App.tracePath` + bootstrap construction

`App.tracePath` delegates straight to `TracePathOps` (like
`createCollection`→`CollectionOps`), with graceful empty-result fallback when
codegraph is disabled. `GraphFacade` stays untouched.

**Files:**

- Modify: `src/core/api/public/app.ts` (App interface line 108, `AppDeps`,
  `createApp`)
- Modify: `src/bootstrap/factory.ts` (construct `TracePathOps` near line 460,
  thread into deps near line 611)
- Test: `tests/core/api/public/app.test.ts` (or the existing createApp test) —
  dispatch + fallback

- [ ] **Step 1: Write the failing test**

```typescript
// append to the createApp test file
describe("App.tracePath", () => {
  it("delegates to tracePathOps when wired", async () => {
    const tracePathOps = {
      tracePath: vi.fn(async () => ({ paths: [], truncated: false })),
    };
    const app = createApp({ ...baseDeps, tracePathOps } as never);
    await app.tracePath({ collection: "c", from: "A", to: "B" });
    expect(tracePathOps.tracePath).toHaveBeenCalledWith({
      collection: "c",
      from: "A",
      to: "B",
    });
  });

  it("returns empty result when codegraph (tracePathOps) is absent", async () => {
    const app = createApp({ ...baseDeps, tracePathOps: undefined } as never);
    const res = await app.tracePath({ collection: "c", from: "A", to: "B" });
    expect(res).toEqual({ paths: [], truncated: false });
  });
});
```

> `baseDeps` — reuse whatever minimal `AppDeps` fixture the file already builds
> for `createApp`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <createApp test file> -t "App.tracePath"` Expected: FAIL —
`app.tracePath is not a function`.

- [ ] **Step 3: Extend the App interface + AppDeps**

In `src/core/api/public/app.ts`, add to the Codegraph section of `App` (after
`findCycles`, line 108):

```typescript
tracePath: (request: TracePathRequest) => Promise<PathTraceResult>;
```

Add the import of `TracePathOps` type + the new DTO types at the top of the file
(alongside the existing graph DTO imports), and add to `AppDeps` (after
`graphFacade?`, line 131):

```typescript
  /** Optional — present when codegraph is wired (built in bootstrap alongside graphFacade). */
  tracePathOps?: TracePathOps;
```

> `TracePathOps` is in `api/internal/ops/` — `app.ts` (api/public) importing an
> internal ops type mirrors how `projectRegistryOps: ProjectRegistryOps` is
> already typed in `AppDeps`. Import `TracePathRequest, PathTraceResult` from
> `./dto/graph.js` (or the dto barrel) and `TracePathOps` from
> `../internal/ops/trace-path-ops.js`.

- [ ] **Step 4: Wire in `createApp`**

In `src/core/api/public/app.ts`, in the Codegraph block of the returned object
(after `findCycles`, line 266):

```typescript
    tracePath: async (req) => (deps.tracePathOps ? deps.tracePathOps.tracePath(req) : { paths: [], truncated: false }),
```

- [ ] **Step 5: Construct `TracePathOps` in bootstrap**

In `src/bootstrap/factory.ts`, where `graphFacade` is built (line 460):

```typescript
const graphFacade = new GraphFacade({
  pool,
  collectionRegistry,
  resolveActiveCollection,
});
const tracePathOps = new TracePathOps({
  pool,
  qdrant, // the QdrantManager already constructed in this scope
  reranker, // the Reranker already constructed in this scope
  collectionRegistry,
  payloadSignals, // the PayloadSignalDescriptor[] used to build the reranker
  resolveActiveCollection,
});
```

Return it from the codegraph context (line 493):

```typescript
return { deps, graphFacade, pool, tracePathOps, indexRunDaemonGuard };
```

And thread it into the App deps (line 611, next to
`graphFacade: codegraphContext?.graphFacade`):

```typescript
    tracePathOps: codegraphContext?.tracePathOps,
```

> Import `TracePathOps` at the top of factory.ts. Confirm `qdrant`, `reranker`,
> and `payloadSignals` are in scope at line 460 — they are constructed earlier
> in the factory for the App `deps`. If `payloadSignals` is not a standalone
> local, source it from the same value passed to the `Reranker` constructor /
> `deps.reranker.getPayloadSignals()`.

- [ ] **Step 6: Run test + full tsc**

Run:
`npx vitest run <createApp test file> -t "App.tracePath" && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/api/public/app.ts src/bootstrap/factory.ts tests/core/api/public/
git commit -m "feat(api): wire App.tracePath -> TracePathOps with codegraph-disabled fallback

Why: tracePath delegates straight to ops (like createCollection->CollectionOps),
keeping GraphFacade untouched. Fallback returns empty paths when codegraph is off,
matching getCallers/getCallees/findCycles graceful-degradation behaviour."
```

---

### Task 9: MCP tool `trace_path`

Register alongside the other codegraph tools, gated by
`hasProvider("codegraph.symbols")`.

**Files:**

- Modify: `src/mcp/tools/codegraph.ts` (input shape + registration)
- Test: `tests/mcp/tools/codegraph-gating.test.ts` (append gating assertion)

- [ ] **Step 1: Write the failing gating test**

```typescript
// append to tests/mcp/tools/codegraph-gating.test.ts
it("registers trace_path when codegraph.symbols is present", () => {
  const names =
    registeredToolNames(/* app with hasProvider("codegraph.symbols") === true */);
  expect(names).toContain("trace_path");
});

it("does NOT register trace_path when codegraph.symbols is absent", () => {
  const names = registeredToolNames(/* app with hasProvider === false */);
  expect(names).not.toContain("trace_path");
});
```

> Mirror the exact harness the existing `get_callers`/`find_cycles` gating tests
> in this file use (`registeredToolNames` is illustrative — use the file's real
> helper).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/codegraph-gating.test.ts -t "trace_path"`
Expected: FAIL — `trace_path` not registered.

- [ ] **Step 3: Add the input shape**

In `src/mcp/tools/codegraph.ts`, after `FindCyclesInputShape` (line 79):

```typescript
const TracePathInputShape = {
  ...collectionPathFields(),
  from: z.string().describe("Start symbol id (caller end, e.g. main)"),
  to: z.string().describe("End symbol id (callee end, e.g. Foo.bar)"),
  rerank: z
    .string()
    .optional()
    .describe(
      "Rerank preset defining 'danger' for the step overlay (default bugHunt)",
    ),
  maxDepth: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Max hops on a path (default 8)"),
  maxPaths: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Max paths returned, danger-sorted (default 10)"),
};
```

- [ ] **Step 4: Register the tool**

In `registerCodegraphTools`, after the `find_cycles` registration (line 136),
inside the function body (still under the `hasProvider` gate at line 88):

```typescript
registerToolSafe(
  server,
  "trace_path",
  {
    title: "Trace Path",
    description:
      "Trace all simple call paths from one symbol to another, in execution order, " +
      "each step annotated with a git/churn danger overlay. Paths are sorted most-dangerous " +
      "first so you jump straight to the riskiest step. Backed by the codegraph DuckDB.",
    inputSchema: TracePathInputShape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({
    project,
    collection,
    path,
    from,
    to,
    rerank,
    maxDepth,
    maxPaths,
  }) => {
    const response = await app.tracePath({
      project,
      collection,
      path,
      from,
      to,
      rerank,
      maxDepth,
      maxPaths,
    });
    return formatMcpText(JSON.stringify(response, null, 2));
  },
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mcp/tools/codegraph-gating.test.ts` Expected: PASS.

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit && npx vitest run tests/mcp/tools/`

```bash
git add src/mcp/tools/codegraph.ts tests/mcp/tools/codegraph-gating.test.ts
git commit -m "feat(mcp): register trace_path tool (gated by codegraph.symbols)"
```

---

### Task 10: Full verification, live MCP smoke test, beads sync

- [ ] **Step 1: Full suite + type-check + lint + build**

Run:

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

Expected: all green. If coverage threshold fails, delegate to the
`coverage-expander` agent (do NOT lower thresholds —
`feedback_never_lower_thresholds`).

- [ ] **Step 2: Re-link + reindex for live MCP test**

Per `.claude/CLAUDE.md` "MCP Integration Testing" + "Re-index when testing new
functionality": `getCalleeEdges` reads an existing payload table (no schema
change), so a force-reindex is not required for adjacency. But the worktree
build must be linked and MCP reconnected:

```bash
npm run build && npm link
```

Then request MCP reconnect (AskUserQuestion per
`.claude/rules/.local/mcp-testing.md`), and:

- [ ] **Step 3: Live smoke test against tea-rags' own index**

Pick a known method edge from the tea-rags graph (e.g. `from` = a facade method,
`to` = a `DuckDbGraphClient` method) and call:

```
mcp__tea-rags__trace_path project=tea-rags from="<A>" to="<B>" rerank="bugHunt"
```

Expected: at least one path in execution order, each step with `dangerOverlay`
populated, paths sorted by `aggregateDanger`. Verify `truncated` toggles when
`maxPaths=1` on a branching pair. Confirm the tool is **absent** on a project
indexed without codegraph.

- [ ] **Step 4: Update beads**

```bash
bd dolt pull
bd update tea-rags-mcp-jz1m --status=in_progress   # at execution start
# ... on completion:
bd close tea-rags-mcp-jz1m --reason="trace_path implemented per 2026-06-05 plan: pure enumerator, getCalleeEdges adjacency, annotate-only rerank, TracePathOps, MCP tool"
bd label add tea-rags-mcp-jz1m architecture   # reranker reorder:false is an arch change; api+metrics already set
```

- [ ] **Step 5: Do NOT push.** Per `feedback_never_push` + `session-completion`,
      stop after commits unless the user explicitly asks to push/merge.

---

## Self-Review

**Spec coverage:**

- A→B directed → Task 1 (`from`/`to`), Task 9 (`from`/`to` inputs). ✅
- All simple paths, sorted by aggregate danger → Task 1 (enumeration), Task 7
  (sort by `aggregateDanger`). ✅
- Danger via existing `rerank` preset, no new preset → Task 7
  (`req.rerank ?? "bugHunt"`), Task 9 (`rerank` input). ✅
- Reranker annotate-only (`reorder: false`) → Task 2. ✅
- New module `path-tracing/` with pure DFS, `GraphDbClient` gains ONE method,
  `provider.ts` untouched → Tasks 1, 3 (one method), provider.ts never edited.
  ✅
- MCP tool gated by `hasProvider("codegraph.symbols")` → Task 9. ✅
- Output shape `PathTraceResult`/`TracedPath`/`PathStep` (steps ordered,
  `dangerRanking` separate index list, `aggregateDanger`) → Task 6 DTOs, Task 7
  assembly. ✅
- maxDepth (8) / maxPaths (10) defaults → Task 7 constants, Task 9 schema. ✅
- Testing: enumerate unit tests (linear/branching/cycle/caps/no-path/A==B) →
  Task 1; reranker reorder regression → Task 2; MCP gating + live → Tasks 9, 10.
  ✅
- Cluster detection deferred → not in plan. ✅

**Placeholder scan:** No TBD/TODO. The "match the existing harness" notes (Tasks
2, 5, 9) point at concrete existing test files, not deferred work — the test
bodies are fully specified; only the local fixture helper name must match what's
already there.

**Type consistency:** `enumeratePaths` (Task 1) ← imported in Task 7.
`getCalleeEdges` signature identical in contract (Task 3), DuckDB impl (Task 3),
daemon proxy (Task 4), consumed in Task 7. `RerankOptions.reorder` (Task 2) ←
passed in Task 7. `TracePathRequest`/`PathTraceResult`/`TracedPath`/`PathStep`
(Task 6) ← used in Tasks 7, 8, 9. `TracePathOps`/`TracePathOpsDeps` (Task 7) ←
wired in Task 8. `scrollBySymbolIds` (Task 5) ← called in Task 7. All
consistent.

**Risk signals honored:** reranker (churn 21, age 1d) → single isolated gate +
mandatory order-preservation regression (Task 2). `GraphDbClient` hub
(bugFix 44) → exactly one new method, indexed read, no recursive SQL (Task 3).
daemon dispatch (bugFix 50 critical) → one case mirroring the existing
`listAdjacency`/`getCallees` pattern verbatim (Task 4). `provider.ts` god class
→ never touched. `GraphFacade` → never touched. New logic isolated in a pure
module + one ops class.
