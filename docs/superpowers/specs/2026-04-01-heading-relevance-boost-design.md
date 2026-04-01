# Heading Relevance Boost for Markdown Search

## Problem

Markdown documentation chunks are ranked solely by semantic similarity to the
query. Heading text — which is the most concise summary of a section's topic —
is not used as a separate ranking signal. A chunk whose h1 ancestor is titled
"Authentication" should rank higher for query "authentication" than a chunk
whose only heading match is at h3 level. Breadcrumbs already prepend ancestor
headings to chunk content (improving embedding), but this is uncontrolled — we
cannot separately weight "query matched h1 ancestor" vs "query matched h3
section heading".

## Solution

Store the heading breadcrumb path (`headingPath`) as a structured payload field
per chunk. Add a derived signal `headingRelevance` that computes token overlap
between the search query and each heading in the path, weighted by depth (h1 >
h2 > h3). The signal activates automatically via a preset when searching
documentation.

## Prerequisites

`SECTION_HEADING_DEPTH = 3` and `MarkdownChunker.buildBreadcrumb()` already
implemented. Chunks are split by h1/h2/h3 with ancestor breadcrumbs prepended to
content.

## Design Decisions

| Decision               | Choice                                                             | Alternatives considered                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heading storage        | `headingPath` — breadcrumb path array per chunk                    | `innerHeadings` (all headings inside chunk) — unnecessary since chunks are already split by h3; `headingDepth` scalar — loses ancestor text for matching |
| Query-heading matching | Token overlap (normalized)                                         | BM25 (no per-heading sparse vectors), cosine similarity (expensive)                                                                                      |
| Depth weighting        | Linear: `(MAX_DEPTH - depth + 1) / MAX_DEPTH`                      | Exponential — less predictable, harder to tune                                                                                                           |
| Signal placement       | Static trajectory (structural signal)                              | Git trajectory — headings are not git-derived                                                                                                            |
| Activation             | Auto-preset when `documentation: "only"` or `language: "markdown"` | Always-on — would affect code search                                                                                                                     |
| Overlay visibility     | Internal — not in overlay mask, not in raw payload output          | Visible — unnecessary, implementation detail                                                                                                             |
| Data backfill          | Schema migration v10                                               | Force reindex — unnecessary, data derivable from existing payload fields                                                                                 |

## Architecture

### 1. Payload Field: `headingPath`

The breadcrumb hierarchy for a chunk — from the root ancestor heading down to
the chunk's own section heading. Mirrors what `buildBreadcrumb()` already
computes but stored as structured data.

```typescript
interface HeadingPathEntry {
  depth: number; // 1-3 (matches SECTION_HEADING_DEPTH)
  text: string; // heading text without markdown syntax
}
```

**Payload example (h3 chunk with h1 and h2 ancestors):**

```json
{
  "headingPath": [
    { "depth": 1, "text": "API Reference" },
    { "depth": 2, "text": "Endpoints" },
    { "depth": 3, "text": "Rate Limits" }
  ]
}
```

**Payload example (h1 chunk, no ancestors):**

```json
{
  "headingPath": [{ "depth": 1, "text": "Getting Started" }]
}
```

**Who writes:**

- `MarkdownChunker.chunk()` — at chunking time, for each section chunk: builds
  `headingPath` from `buildBreadcrumb()` ancestors + current heading. Data is
  already computed — just needs to be structured and written to metadata.
- For code block chunks: derives from `parentName`/`parentType` + ancestors.
- Schema migration v10 — backfills existing chunks from `name`, `parentName`,
  `parentType` payload fields.

**Not indexed in Qdrant** — no payload index needed, read-only at rerank time.

### 2. ExtractContext: `query` Field

```typescript
interface ExtractContext {
  bounds?: Record<string, number>;
  dampeningThreshold?: number;
  collectionStats?: CollectionSignalStats;
  signalLevel?: SignalLevel;
  query?: string; // NEW — search query text for query-dependent signals
}
```

**Source:** `contracts/types/trajectory.ts`

**Who passes:** `Reranker.rerank()` receives query as new optional parameter,
passes to `extractAllDerived()`, which includes it in `ExtractContext`.

**Impact on existing signals:** zero — field is optional, all current signals
ignore it.

### 3. Reranker.rerank() Signature Change

```typescript
// Before
rerank<T>(results: T[], mode: RerankMode, presetSet: string, overrideSignalLevel?: SignalLevel)

// After
rerank<T>(results: T[], mode: RerankMode, presetSet: string, options?: RerankOptions)
```

```typescript
interface RerankOptions {
  signalLevel?: SignalLevel;
  query?: string;
}
```

Consolidates `overrideSignalLevel` and `query` into a single options object.
This is a breaking change to the internal API (Reranker is not public), but all
callers are within `ExploreFacade` and `App`.

**Wiring in `extractAllDerived()`:**

```typescript
private extractAllDerived(
  payload: Record<string, unknown>,
  sourceBounds: Map<string, number>,
  signalLevel?: SignalLevel,
  query?: string,       // NEW
): Record<string, number> {
  // ...existing code...
  signals[d.name] = d.extract(payload, {
    bounds,
    dampeningThreshold,
    collectionStats: this.collectionStats,
    signalLevel,
    query,              // NEW — passed through to all signals
  });
}
```

### 4. HeadingRelevanceSignal

**Location:**
`src/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.ts`

```typescript
export class HeadingRelevanceSignal implements DerivedSignalDescriptor {
  readonly name = "headingRelevance";
  readonly description =
    "Heading-query token overlap weighted by heading depth";
  readonly sources: string[] = []; // structural signal, no raw signal deps

  private static readonly MAX_DEPTH = 3; // matches SECTION_HEADING_DEPTH
  private static readonly STOP_WORDS = new Set([
    "the",
    "a",
    "an",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "and",
    "or",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "with",
    "from",
    "by",
    "as",
    "it",
    "this",
    "that",
  ]);

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const path = rawSignals.headingPath as HeadingPathEntry[] | undefined;
    if (!path?.length || !ctx?.query) return 0;

    const queryTokens = this.tokenize(ctx.query);
    if (queryTokens.length === 0) return 0;

    let maxScore = 0;
    for (const entry of path) {
      const headingTokens = this.tokenize(entry.text);
      const overlap = this.tokenOverlap(queryTokens, headingTokens);
      const depthWeight =
        (HeadingRelevanceSignal.MAX_DEPTH - entry.depth + 1) /
        HeadingRelevanceSignal.MAX_DEPTH;
      maxScore = Math.max(maxScore, overlap * depthWeight);
    }
    return maxScore;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s\-_/]+/)
      .filter((t) => t.length > 1 && !HeadingRelevanceSignal.STOP_WORDS.has(t));
  }

  private tokenOverlap(queryTokens: string[], headingTokens: string[]): number {
    const headingSet = new Set(headingTokens);
    const matches = queryTokens.filter((t) => headingSet.has(t)).length;
    return matches / queryTokens.length;
  }
}
```

**Depth weight table (MAX_DEPTH = 3):**

| Heading | Weight |
| ------- | ------ |
| h1      | 1.0    |
| h2      | 0.67   |
| h3      | 0.33   |

**Score formula:**
`max(tokenOverlap(query, entry.text) * depthWeight(entry.depth))` across all
entries in headingPath.

**Range:** 0..1

**Example:** query "authentication", chunk h3 "Rate Limits" with breadcrumb
`# Authentication > ## Security`:

- overlap("authentication", "Authentication") = 1.0 × weight(h1=1.0) = **1.0**
- overlap("authentication", "Security") = 0.0 × weight(h2=0.67) = 0.0
- overlap("authentication", "Rate Limits") = 0.0 × weight(h3=0.33) = 0.0
- **score = 1.0** — chunk boosted because h1 ancestor matched

### 5. Schema Migration v10: headingPath Backfill

**Location:**
`src/core/infra/migration/schema_migrations/schema-v10-heading-path-backfill.ts`

**Algorithm:**

1. Scroll all points where `isDocumentation = true`
2. For each point, reconstruct `headingPath` from existing payload fields:
   - Section chunks: `name` contains the chunk's own heading text. `parentName`
     and `parentType` may contain parent heading info. Build path from available
     parent chain.
   - Code block chunks: `parentName`/`parentType` contains the nearest section
     heading. Build single-entry path.
   - Chunks without heading info (preamble, fallback): empty array `[]`.
3. `set_payload` with `headingPath`

**Limitation:** migration can only reconstruct partial paths from existing
payload fields (`name`, `parentName`, `parentType`). Full breadcrumb hierarchy
(grandparent headings) is not stored in current payload — only the immediate
parent. After next reindex, `MarkdownChunker` will write complete paths.

**Registration:** add to `SchemaMigrator` constructor after v9.

### 6. DocumentationRelevance Preset

**Location:**
`src/core/domains/explore/rerank/presets/documentation-relevance.ts`

```typescript
export class DocumentationRelevancePreset implements RerankPreset {
  readonly name = "documentationRelevance";
  readonly description = "Boost documentation by heading relevance and depth";
  readonly tools = ["semantic_search", "hybrid_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.5,
    headingRelevance: 0.3,
    documentation: 0.2,
  };
  readonly overlayMask: OverlayMask = {
    derived: ["similarity", "documentation"],
    // headingRelevance intentionally excluded — internal signal
  };
}
```

**Auto-activation logic in ExploreFacade** (not in Reranker — Reranker
orchestrates, facade decides):

```typescript
// In facade, before calling reranker.rerank():
if (!explicitRerank && (documentation === "only" || language === "markdown")) {
  rerank = "documentationRelevance";
}
```

This applies to `semantic_search` and `hybrid_search` tools. If user provides
explicit `rerank` parameter, it takes precedence.

### 7. DTO Filtering: stripInternalFields()

**Location:** `src/core/api/public/dto/sanitize.ts`

```typescript
const INTERNAL_PAYLOAD_FIELDS = ["headingPath"] as const;

export function stripInternalFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...payload };
  for (const field of INTERNAL_PAYLOAD_FIELDS) {
    delete result[field];
  }
  return result;
}
```

**Called from:** all DTO response mappers that transform Qdrant results into MCP
responses (semantic_search, hybrid_search, find_symbol, find_similar,
rank_chunks).

## Edge Cases

| Case                                        | Behavior                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Non-markdown chunk (no `headingPath`)       | Signal returns 0, no effect                                                 |
| Query is all stop-words                     | `queryTokens` empty after filtering → signal returns 0                      |
| h1 chunk (no ancestors)                     | `headingPath: [{depth: 1, text: "..."}]` — single entry, weight 1.0         |
| Code block chunk with parentType h2         | `headingPath: [{depth: 2, text: parentName}]`                               |
| Preamble chunk (before first heading)       | `headingPath: []` → signal returns 0                                        |
| Oversized section split by fallback chunker | Sub-chunks inherit section heading; `headingPath` from parent heading chain |
| User provides explicit rerank preset        | Auto-activation skipped, user preset used as-is                             |
| `headingRelevance` used in custom weights   | Works — signal computes normally, just not shown in overlay                 |
| Whole-document fallback chunk               | `headingPath: []` → signal returns 0                                        |
| Migration before reindex                    | Partial paths (only immediate parent). Full paths after reindex             |

## Files Changed

| File                                                                    | Change                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `contracts/types/trajectory.ts`                                         | Add `query?: string` to `ExtractContext`             |
| `domains/explore/reranker.ts`                                           | `RerankOptions`, pass query to `extractAllDerived()` |
| `domains/explore/reranker.ts`                                           | Update all internal callers of `extractAllDerived()` |
| `domains/trajectory/static/rerank/derived-signals/heading-relevance.ts` | **NEW** — `HeadingRelevanceSignal`                   |
| `domains/trajectory/static/rerank/derived-signals/index.ts`             | Register new signal                                  |
| `domains/explore/rerank/presets/documentation-relevance.ts`             | **NEW** — `DocumentationRelevancePreset`             |
| `domains/explore/rerank/presets/index.ts`                               | Register new preset                                  |
| `domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts`             | Write `headingPath` to metadata                      |
| `infra/migration/schema_migrations/schema-v10-heading-path-backfill.ts` | **NEW** — migration                                  |
| `infra/migration/schema-migrator.ts`                                    | Register v10 migration                               |
| `api/public/dto/sanitize.ts`                                            | **NEW** — `stripInternalFields()`                    |
| `api/public/dto/index.ts`                                               | Export sanitize                                      |
| `api/public/app.ts`                                                     | Apply `stripInternalFields()` in response mappers    |
| Facade files calling `reranker.rerank()`                                | Update to `RerankOptions` + pass query               |
| `mcp/tools/` handlers passing rerank                                    | Pass query to facade                                 |

## Testing Strategy

| Component                | Test type   | What to verify                                                                |
| ------------------------ | ----------- | ----------------------------------------------------------------------------- |
| `HeadingRelevanceSignal` | Unit        | Token overlap, depth weighting, stop-words, empty inputs, max-score selection |
| `stripInternalFields()`  | Unit        | Removes `headingPath`, preserves other fields                                 |
| Schema migration v10     | Integration | Backfill populates `headingPath` from name/parentName/parentType              |
| `MarkdownChunker`        | Unit        | New chunks include `headingPath` with full ancestor chain                     |
| Auto-preset activation   | Unit        | Facade applies `documentationRelevance` when `documentation: "only"`          |
| `Reranker.rerank()`      | Unit        | Query propagates to `ExtractContext`, signal receives it                      |
| End-to-end               | Integration | Markdown search with heading match ranks higher than without                  |

## Risks and Mitigations

### Risk 1: Reranker.rerank() signature change (Medium)

`Reranker` is a hot zone (churnVolatility 3.66, changeDensity 7). Adding `query`
parameter touches `rerank()` and `extractAllDerived()` — the two most critical
methods.

**Mitigation:** Consolidate `overrideSignalLevel` and `query` into a single
`RerankOptions` object. This is additive (optional parameter), backward
compatible at call sites (just wrap existing arg). All callers are internal
(`ExploreFacade`, `App`), so no public API break.

### Risk 2: Migration partial paths (Medium)

Migration can only reconstruct partial `headingPath` from existing payload
(`name`, `parentName`, `parentType`). Full ancestor chains (grandparent
headings) are not available in current payload.

**Mitigation:** Accept partial paths from migration — they provide immediate
value (own heading + parent). Full paths written by `MarkdownChunker` on next
reindex. Signal works correctly with partial data (fewer entries = fewer overlap
candidates, but still functional).

### Risk 3: Auto-preset placement (Low)

Auto-activation logic ("if documentation/markdown → apply preset") is business
logic. Placing it in Reranker would violate its orchestrator role.

**Mitigation:** Place in `ExploreFacade` at the point where rerank mode is
resolved, before calling `reranker.rerank()`. Reranker stays pure.

### Risk 4: Token overlap division by zero (Low)

Query consisting entirely of stop-words produces empty `queryTokens` array →
`matches / queryTokens.length` = `0/0 = NaN`.

**Mitigation:** Guard in `extract()`: `if (queryTokens.length === 0) return 0`.
Already specified in the signal pseudocode above.

### Risk 5: Qdrant struct array in set_payload (Low)

`headingPath` is an array of objects. Qdrant supports nested payloads, but
`set_payload` behavior with struct arrays should be verified.

**Mitigation:** Integration test in migration spec that round-trips
`set_payload` → `scroll` and verifies array structure is preserved. Qdrant
documentation confirms nested object arrays are supported in payload.

### 8. Search-Cascade Update

Update search-cascade instructions to leverage heading relevance automatically
when searching documentation.

**Location:** `.claude/rules/search-cascade.md` (or equivalent hook/rule file)

**Change:** In the Rerank Decision section, add a rule:

```
Documentation search?
├─ language: "markdown" OR documentation: "only"
│     → auto-applies "documentationRelevance" preset (heading-weighted ranking)
│     → no explicit rerank needed from agent
└─ Otherwise → existing rerank decision tree
```

**Agent behavior:** When agents use `semantic_search` or `hybrid_search` with
`documentation: "only"` or `language: "markdown"`, the facade auto-applies
`documentationRelevance` preset. Agents don't need to specify rerank explicitly
for documentation searches — heading boost is automatic.

**Explicit override:** Agent can still pass `rerank: "techDebt"` (or any other
preset) to override the auto-applied documentation preset.

## Non-Goals

- Changing markdown chunking granularity (already h3, stays h3)
- Embedding heading text separately (named vectors)
- Making `headingPath` visible in API responses or overlay
- Supporting non-latin tokenization (token overlap is sufficient for keyword
  matching regardless of script)
