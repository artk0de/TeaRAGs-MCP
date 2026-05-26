# trace_path — Execution Path Tracing with Danger Overlay

**Status:** Design approved 2026-05-25 **Beads:** `tea-rags-mcp-uxsr` (Codegraph
Slice 6 — this spec covers the `trace_path` portion; cluster detection deferred)
**Domain:** `src/core/domains/trajectory/codegraph/symbols/`

## Problem

The agent debugging a bug has two disjoint tools today:

- **call graph** (`get_callers`/`get_callees`) — tells _who can call whom_, but
  flat, no priority, and one level at a time.
- **ranked suspects** (`bugHunt` rerank) — tells _what is historically buggy_,
  but loses the causal chain between suspects.

Neither answers: "show me the execution path from A to B, **and** which steps on
that path are the most suspicious." The agent reads the whole chain linearly or
guesses. `trace_path` closes this — it returns the path in execution order plus
a danger overlay, so the agent jumps straight to the riskiest step.

This is the tea-rags-unique combination: **structural** (the path) +
**temporal** (git bugFix/churn overlay) + the existing **ranking-overlay**
mechanism, applied to a _sequence_ rather than a flat list.

## Not a separate trajectory

`trace_path` is **not** a new `EnrichmentProvider`. It writes nothing at index
time. It **reads** the call graph that the symbols trajectory already built
(`cg_symbols` + method edges). Without resolved symbols there are no edges to
walk — it is strictly a read-side capability of the symbols trajectory. Hence it
lives **under** `symbols/`, not as a peer module.

## Scope (first slice)

| Dimension      | Decision                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Direction      | **A→B directed** — both endpoints given. `forward`/`backward` are a follow-up `direction` param over the same traversal engine.     |
| Multiple paths | **All simple-paths** (no cycles) up to `maxDepth` / `maxPaths` cap. Path list sorted by aggregate danger (most dangerous first).    |
| Danger source  | **`rerank` parameter** with existing presets (`dangerous` / `bugHunt` / `hotspots` / `blastRadius`). No new preset.                 |
| Reranker mode  | **annotate-only** — overlay computed and attached, reorder step skipped via `reorder: false`. Path order is never changed.          |
| Location       | New module `codegraph/symbols/path-tracing/`. Traversal in TS. `GraphDbClient` gains ONE adjacency method. `provider.ts` untouched. |
| Cluster detect | **Deferred** — out of scope for this slice (was bundled in `uxsr`; split out).                                                      |

## Architecture

```
codegraph/symbols/path-tracing/
  path-tracer.ts     — bounded DFS enumeration (pure fn over adjacency map)
  types.ts           — TracedPath, PathStep, PathTraceResult
  index.ts           — barrel
```

### Data flow

```
trace_path(from, to, rerank?, maxDepth?, maxPaths?)
  → GraphDbClient.getCalleeEdges(symbolIds)   — adjacency from cg_symbols (DuckDB)
  → PathTracer.enumerate(adjacency, from, to) — bounded DFS, cycle detection,
                                                maxPaths cap → simple paths A→B
  → Reranker.rerank(chunks, preset, { reorder: false })  — danger overlay per
                                                step, ORDER PRESERVED
  → assemble PathTraceResult, sort paths by aggregateDanger
```

The traversal is a **pure function over an adjacency map** — testable with a
mock adjacency, no DuckDB needed. The DB's only new responsibility is returning
edges for a set of nodes.

### Output shape — two projections of one path

```ts
interface PathTraceResult {
  paths: TracedPath[]; // sorted by aggregateDanger, most dangerous first
  truncated: boolean; // true if maxPaths/maxDepth cap was hit
}

interface TracedPath {
  steps: PathStep[]; // ORDERED — execution order, never reordered
  dangerRanking: number[]; // indices into steps, sorted by danger (where to look first)
  aggregateDanger: number; // path-level score, used to sort the path list
}

interface PathStep {
  symbolId: string; // Class#method (instance) / Class.method (static)
  relativePath: string;
  startLine: number;
  endLine: number;
  dangerOverlay: RankingOverlay; // bugFixRate / churn labels from the rerank preset
}
```

The path itself is the **structural truth** (execution order = information).
`dangerRanking` is the **analytical lens** — a separate index list, not a
re-sorting of `steps`. Two views, one path, no conflict.

## Reranker change (the one core addition)

The reranker currently always reorders. `trace_path` needs overlay **without**
reorder. Add an optional `reorder: boolean` (default `true`) to the rerank call
path; when `false`, the overlay extraction runs as today but the final sort step
is skipped. Single code path, no duplication of overlay-extraction logic
(complies with the project's "shared logic in base, do not duplicate" rule).

## GraphDbClient change (minimize blast radius)

`GraphDbClient` is a hub (`fanIn 8`, chunk `fanIn 35`) with a **concerning**
bugFixRate of 44 — it is the most fragile point the feature touches. Therefore
it gains exactly ONE method: an adjacency query
(`getCalleeEdges(symbolIds: string[]): Promise<Map<string, string[]>>` or
equivalent). No recursive-path SQL inside this interface — path assembly lives
in `path-tracer.ts` in TS. This keeps the change to the fragile hub minimal and
testable.

## MCP tool

`trace_path` registered in `src/mcp/tools/codegraph.ts` alongside `get_callers`
/ `get_callees` / `find_cycles`, gated by `app.hasProvider("codegraph.symbols")`
(silent no-op when codegraph isn't wired).

Inputs: `from` (symbolId), `to` (symbolId), optional `rerank` (preset name),
`maxDepth` (default TBD at impl — bench-driven), `maxPaths` (default ~10).
Output: `PathTraceResult`.

## Testing

- **PathTracer.enumerate** — pure unit tests over mock adjacency maps: linear
  path, branching (multiple paths), cycle (must not loop), maxDepth cap,
  maxPaths cap, no-path-exists (empty result), A==B edge case.
- **Reranker annotate-only** — overlay attached, order identical to input
  (regression: `reorder: false` never permutes).
- **MCP integration** — `trace_path` gated off when provider absent; on a small
  fixture graph, A→B returns expected ordered steps with overlay populated.

## Risk signals honored (from tea-rags enrichment 2026-05-25)

- `provider.ts` is a god class (instability 0.9375, ~1430 lines) → new logic
  goes to `path-tracing/`, provider untouched.
- `GraphDbClient` bugFixRate 44 (concerning), hub → exactly one adjacency
  method, no complex recursive SQL added to the fragile interface.
- Entire codegraph is deep-silo (single author) → isolated, pure-function
  path-tracer with a clean interface is self-documenting (bus-factor
  mitigation).

## Follow-ups (explicitly out of scope)

- `direction: forward | backward` — same engine, single-endpoint modes.
- Path-specific derived signals (`onDangerousPaths`, `brokerScore`) — feed
  existing presets automatically once added; would replace the cut betweenness
  centrality's broker-detection use case.
- Cluster detection (the other half of `uxsr`).
- Recursive-CTE traversal in DuckDB if TS-side enumeration proves too slow at
  scale (bench first against tea-rags' own ~3k method nodes).
