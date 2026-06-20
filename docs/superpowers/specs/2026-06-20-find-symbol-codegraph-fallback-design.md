# find_symbol Codegraph-Aware Fallback (cg_symbols.chunk_id) — Design

**Bead:** tea-rags-mcp-0rskm (P2 bug) · follow-up tea-rags-mcp-q383b (P3)
**Date:** 2026-06-20 **Status:** Approved — ready for implementation plan

## Problem

`find_symbol` resolves symbols **only** from a Qdrant chunk scroll
(`domains/explore/strategies/symbol.ts` → `domains/explore/symbol-resolve.ts`
`resolveSymbols`). The scroll filters by the payload field `symbolId`.

The chunkers can collapse a declaration so that an inner method has **no own
Qdrant chunk** — the canonical case is the Ruby chunker collapsing a small class
into a single class chunk (`alwaysExtractChildren` emits per-method chunks for
most classes, but the collapsed case exists). When a method has no chunk,
`find_symbol("Foo#bar")` returns nothing.

Yet the codegraph **did** persist that the symbol exists: `collectSymbols`
(`domains/trajectory/codegraph/symbols/provider.ts`) walks the AST per
declaration independently of the Qdrant chunker and writes a `cg_symbols` row
for `Foo#bar`. So codegraph knows the symbol exists and which file it lives in;
`find_symbol` cannot see it.

## Key facts established during design

1. **`cg_symbols` has no line ranges.** Schema (migration
   `002-cg-symbols-table.ts`) is
   `rel_path, symbol_id, fq_name, short_name, scope_json`. Line ranges live only
   in Qdrant chunk payloads. So a fallback cannot read a method slice from
   `cg_symbols` alone.

2. **Qdrant chunk point id is deterministic but content-dependent.**
   `chunker/utils/chunk-id.ts` `generateChunkId` =
   `sha256(filePath:startLine:endLine:symbolId:content)` → `chunk_<hash16>`,
   then `adapters/qdrant/client.ts` `normalizeId` → UUID. Because the id depends
   on the chunk's content and exact boundaries (which differ from AST symbol
   boundaries due to comment-capture, header extraction, `#partN` splitting, and
   collapse), **codegraph cannot recompute a chunk id on its own.** The id can
   only be learned from the chunker's output.

3. **The codegraph deferred chunk pass already holds the chunk ids + ranges.**
   `CodegraphEnrichmentProvider.buildChunkSignals(root, chunkMap, options)` runs
   once post-finalize (via `CompletionRunner` → `chunkPhase.runDeferredChunk`)
   and receives `chunkMap: Map<string, ChunkLookupEntry[]>` where
   `ChunkLookupEntry = { chunkId, startLine, endLine }`. The provider already
   matches methods↔chunks here to attach chunk-level signals (fanIn, pageRank).
   So the symbol↔chunk containment join can live **inside the codegraph
   provider**, reusing existing data — **no `QdrantManager` threading needed**,
   codegraph stays DuckDB-only.

4. **The explore→codegraph DIP bridge already exists.** `get_callers` /
   `get_callees` flow
   `App → AppDeps.graphFacade? → GraphFacade.withReadHandle → graphDb.getCallers(symbolId)`.
   `graphFacade` is optional in `AppDeps` (`api/public/app.ts:135`), constructed
   in `bootstrap/factory.ts:461`, wired in `createApp` without any static import
   of codegraph/adapters internals. When codegraph is disabled `graphFacade` is
   undefined and the call is a no-op. The fallback mirrors this exactly.

## Approach (D-store)

Store a reference to the **covering Qdrant chunk** on each `cg_symbols` row.
`find_symbol`'s fallback becomes a two-hop lookup:
`symbol_id → chunk_id → qdrant.getPoint(chunk_id) → content`. Content stays
single-sourced in Qdrant; no line-range columns, no file-slice reads.

This is the substrate q383b needs: with `chunk_id` populated, `cg_symbols` is a
self-sufficient `symbol → location` map, so q383b can later flip the primary
source to `cg_symbols` (Qdrant demoted to a content layer) by promoting the same
reader method.

### Why not the alternatives

- **D-derive (scope-walk at query time, no column):** fallback reads
  `cg_symbols.scope_json` of `Foo#bar`, derives ancestor `Foo`, scrolls Qdrant
  by payload `symbolId=Foo`. Cheaper (no migration), but not a literal chunk
  reference and lays no q383b substrate. Rejected in favor of the forward
  compatible store-time link.
- **Line-range columns + query-time containment:** add `start_line/end_line` to
  `cg_symbols`, resolve the covering chunk at query time. Migration either way;
  query does more work; chunk id is the cleaner reference. Rejected.

## Components

### 1. Schema migration

New `infra/migration/database/migrations/00X-cg-symbols-chunk-id.ts`:

- `ALTER TABLE cg_symbols ADD COLUMN chunk_id VARCHAR` — **nullable**. Null when
  a symbol has no covering chunk (excluded files), or on a stale index written
  before this migration / before backfill.
- `CREATE INDEX idx_cg_symbols_symbol ON cg_symbols(symbol_id)` — supports the
  new lookup-by-symbol_id read path (today only `listAllSymbols` full-scan
  exists).

### 2. SymbolDefinition + write path

- `contracts/types/codegraph.ts` `SymbolDefinition` gains `chunkId?: string`.
- `adapters/duckdb/client.ts` `upsertSymbols` writes the `chunk_id` column.

The stored value is the `chunk_<hash16>` form from `ChunkLookupEntry.chunkId`
(the read path normalizes to the Qdrant point UUID via the existing
`getPoint`/`normalizeId` machinery — keep one canonical stored form, the
`chunk_` string).

### 3. Containment join (write side)

Inside the codegraph provider's deferred chunk pass (reusing the `chunkMap`
already passed to `buildChunkSignals`):

- Per file, for each symbol the provider extracted (symbol
  `[startLine, endLine]` from the AST re-parse the pass already performs),
  select the **tightest covering chunk**: the `ChunkLookupEntry` whose
  `[startLine, endLine]` contains the symbol's start line, choosing the smallest
  range when several contain it.
  - Normal method with its own chunk → that chunk (fast path: a chunk whose
    range matches the symbol exactly / shares its `symbolId`).
  - Collapsed `Foo#bar` (no own chunk) → the class chunk `Foo` that contains it.
  - `#partN`-split chunk → the part whose range contains the symbol's start
    line.
  - No covering chunk (excluded file) → `chunkId` stays null.
- Persist the resolved `chunk_id` back onto the symbol rows. Implementation may
  extend the existing `upsertSymbols` write or add a dedicated
  `updateSymbolChunkIds(relPath, Map<symbolId, chunkId>)` — the plan picks the
  least-churn option; both write the same column.

Symbol line ranges at join time come from the codegraph extraction the provider
already performs for the file (the `collectSymbols` output:
`{ symbolId, startLine, endLine, scope }`). Whether that output is carried into
the deferred pass or re-derived from a fresh parse is a plan-phase detail — the
plan confirms the cheapest source. Either way, **no `start_line`/`end_line`
columns are added to `cg_symbols`**.

### 4. Read API (DIP, mirrors get_callers)

- `adapters/duckdb/client.ts` (and the `GraphDbClient` contract): new
  `findSymbolChunk(symbolId): Promise<{ relPath: string; chunkId: string } | null>`
  — indexed lookup by `symbol_id`, returns the row's `rel_path` + `chunk_id`
  (null when no row or `chunk_id` is null).
- `api/internal/facades/graph-facade.ts`: new
  `resolveSymbolChunk(addressing, symbolId)` via `withReadHandle`, mirroring
  `getCallers`. Returns null when no codegraph handle resolves.

### 5. find_symbol fallback (query side)

In `domains/explore/strategies/symbol.ts` `SymbolSearchStrategy.executeExplore`:

- After the primary + parent scroll yields no chunk matching the exact queried
  `symbolId`, and only then, consult an injected codegraph reader:
  `resolveSymbolChunk(symbolId)`.
- On a hit, `qdrant.getPoint(chunkId)` fetches the covering chunk; wrap it as a
  `find_symbol` result tagged with provenance (covering chunk via codegraph
  fallback — see §6).
- Reader undefined (codegraph disabled) **or** `chunkId` null (stale index) →
  fallback skipped; behavior is exactly today's empty result. Graceful, no
  throw.

Injection: the reader (the `GraphFacade`/a narrow reader interface) reaches
`SymbolSearchStrategy` through the same optional-DI path as `graphFacade`
(constructed in `bootstrap/factory.ts`, wired via the explore ops/facade
context). When absent, the strategy runs unchanged.

### 6. Provenance in the response

`FindSymbolResponse` gains an **additive** flag on a result indicating it is the
**covering chunk resolved via codegraph fallback** (the queried symbol is
collapsed into it), not an exact symbol chunk. This keeps the contract
backward-compatible and lets an agent consumer distinguish a class-granular
answer from a precise method chunk.

## Error handling & edge cases

- **Codegraph disabled** → no reader injected → fallback is a no-op (current
  behavior preserved).
- **Stale index** (`chunk_id` null because the symbol predates the migration or
  backfill) → fallback skipped; force-reindex repopulates.
- **Symbol genuinely absent** → `findSymbolChunk` returns null → no fallback, no
  false positive. (Distinguishes "collapsed, exists" from "typo / not a
  symbol".)
- **Chunk deleted but cg_symbols stale** → `getPoint` misses → treat as no
  result; do not throw. Incremental reindex keeps the two stores converged via
  the normal per-file rewrite.
- **symbolId form** — the join matches by **line-range containment**, robust to
  `#`/`.` form mismatches; the exact-symbol fast path matches by `symbolId`
  equality first. Keeps `.claude/rules/symbolid-convention.md` intact.

## Testing strategy

- **Migration** — column + index exist after migrate; idempotent on re-run.
- **Containment join (unit)** — collapsed method → class chunk id; normal method
  → own chunk id; `#partN` → correct part; excluded/uncovered symbol → null;
  tightest-range selection when nested chunks both contain a symbol.
- **`GraphDbClient.findSymbolChunk`** — returns `{relPath, chunkId}` for a
  populated row; null for missing row and for null `chunk_id`.
- **`GraphFacade.resolveSymbolChunk`** — read-handle resolution; null when no
  codegraph handle.
- **`SymbolSearchStrategy` fallback** — no Qdrant chunk + reader returns chunkId
  → `getPoint` result returned with provenance; reader undefined → no fallback;
  chunkId null → no fallback; primary chunk present → reader never consulted.
- **Live (MCP)** — force-reindex tea-rags (schema drift) + reindex huginn
  (`code_d2c81d68`, Ruby); `find_symbol` on a known collapsed Ruby method
  returns the covering class chunk with the provenance flag, and on a
  non-collapsed method still returns its own chunk unchanged.

## Reindex impact

New column populated at index time → **BREAKING for the index, not the API**.
tea-rags self-test index needs `force_reindex` (schema drift guard). huginn
reindexed for Ruby validation. No user-facing config/flag change.

## Out of scope (q383b / P3)

Flipping the **primary** symbol source to `cg_symbols` when codegraph is enabled
(Qdrant demoted to content layer). This design only adds the fallback + the
`chunk_id` substrate; q383b promotes `resolveSymbolChunk` to primary. The seam
(the reader method) is deliberately shaped so q383b changes call order, not the
data model.
