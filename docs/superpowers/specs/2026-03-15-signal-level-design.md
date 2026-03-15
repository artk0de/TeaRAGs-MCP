# Signal Level & Consistent `level` Parameter — Design Spec

## Goal

Add `signalLevel` to rerank presets and a consistent `level` parameter across
all structured search tools. File-level presets get alpha=0 scoring (pure file
signals) and Qdrant Grouping API (one best chunk per file). Chunk-level presets
retain current alpha-blending behavior.

## Problem

1. **Alpha-blending always runs** — even for file-oriented presets (`techDebt`,
   `ownership`) where chunk signals are noise.
2. **`level` parameter exists only on `rank_chunks`** — `semantic_search`,
   `hybrid_search`, and `find_similar` have no way to express file vs chunk
   intent.
3. **No grouping** — file-level queries return multiple chunks from the same
   file, forcing agents to deduplicate client-side.

## Design Decisions

### D1: `signalLevel` on `RerankPreset`

Each preset declares its natural granularity:

```typescript
// contracts/types/reranker.ts
export type SignalLevel = "file" | "chunk";

export interface RerankPreset {
  // ... existing fields
  readonly signalLevel?: SignalLevel; // default: "chunk"
}
```

| signalLevel         | Alpha behavior                      | Presets                                                                                      |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `"file"`            | alpha = 0, pure file signals        | `techDebt`, `securityAudit`, `ownership`, `onboarding`, `stable`, `recent`, `impactAnalysis` |
| `"chunk"` (default) | alpha = computed (current blending) | `hotspots`, `codeReview`, `refactoring`, `relevance`, `decomposition`                        |

### D2: `level` parameter on all structured search tools

Add optional `level?: "file" | "chunk"` to:

- `SemanticSearchRequest`
- `HybridSearchRequest`
- `FindSimilarRequest`
- `RankChunksRequest` (already has it, make it optional with preset-derived
  default)

**Resolution order:**

1. Explicit `level` from user → wins always
2. `signalLevel` from resolved preset → used as default
3. No preset (custom weights) → `"chunk"` (current behavior)

### D3: `level` affects three layers

| Layer        | `level: "file"`                                                  | `level: "chunk"` (default)                     |
| ------------ | ---------------------------------------------------------------- | ---------------------------------------------- |
| **Scoring**  | alpha = 0 in `ExtractContext`                                    | alpha = computed (current)                     |
| **Grouping** | `queryGroups()` with `group_by: "relativePath"`, `group_size: 1` | `query()` as-is                                |
| **Filters**  | File-level payload fields                                        | Chunk-level payload fields (existing behavior) |

### D4: Response changes for `level: "file"`

- Add `level: "file"` to response metadata so agent knows results are
  file-grouped.
- `metaOnly: true` + `level: "file"` → return file-level metadata only (no
  chunk-specific fields like `startLine`, `chunkType`).
- Regular (non-metaOnly) `level: "file"` → return best chunk content as file
  representative, with `level: "file"` marker.

### D5: `search_code` excluded

`search_code` returns human-readable text, not structured JSON. `level` is an
analytical feature — only structured tools get it.

### D6: Grouping API integration

Use Qdrant `queryGroups()` for `level: "file"`:

- `group_by: "relativePath"`
- `group_size: 1` (one best chunk per file)
- Server-side, no client dedup needed

For `rank_chunks` with `level: "file"`: use existing scatter+gather with
`group_by` on preset (already partially implemented via
`RefactoringPreset.groupBy`).

Closes `tea-rags-mcp-35e` (Grouping API) and aligns with decision
`tea-rags-mcp-b6h`.

## Implementation Surface

### Contracts

- `contracts/types/reranker.ts` — add `SignalLevel` type, `signalLevel?` to
  `RerankPreset`
- `contracts/types/trajectory.ts` — add `signalLevel?: SignalLevel` to
  `ExtractContext`

### Presets (add `signalLevel`)

File-level (`signalLevel: "file"`):

- `tech-debt.ts`, `security-audit.ts`, `ownership.ts`, `onboarding.ts`,
  `stable.ts`, `recent.ts`
- `impactAnalysis` — static preset, same pattern

Chunk (default, no change needed):

- `hotspots.ts`, `code-review.ts`, `refactoring.ts`
- `relevance.ts`, `decomposition.ts`

### DTOs

- `explore.ts` — add `level?: "file" | "chunk"` to `SemanticSearchRequest`,
  `HybridSearchRequest`, `FindSimilarRequest`
- `RankChunksRequest` — make `level` optional (default from preset)

### Reranker

- `reranker.ts` — pass `signalLevel` through `ExtractContext`, derived signals
  check it to force alpha=0 when `signalLevel: "file"`

### Derived signal helpers

- `helpers.ts` — `payloadAlpha()` and `blendNormalized()` accept optional
  `signalLevel` from context; return 0 when `"file"`

### Facades

- `explore-facade.ts` — resolve effective `level` (user override > preset
  default > "chunk"), pass to reranker and query layer

### Qdrant layer

- Add `queryGroups()` wrapper for Grouping API
- Strategies use `queryGroups()` when `level: "file"`

### MCP schemas

- `schemas.ts` — add `level` to semantic_search, hybrid_search, find_similar
  schemas

### Response

- Add `level: "file"` to `ExploreResponse` when file-level
- `metaOnly` + `level: "file"` → file-level metadata shape

## Out of Scope

- MMR integration (separate task `tea-rags-mcp-93d`)
- `search_code` level parameter
- Client-side chunk rollup / file aggregation
- Per-preset `defaultTimeRange` (future enhancement)

## Research Context

From `website/docs/agent-integration/mental-model.md`:

- Chunk signals optimal at 3-6 month window (`GIT_CHUNK_MAX_AGE_MONTHS`)
- File signals optimal at 6-12 month window (`GIT_LOG_MAX_AGE_MONTHS`)
- Tornhill: 2-3 month windows for hotspot detection
- File-level signals reveal structural tech debt; chunk-level signals reveal
  function instability
