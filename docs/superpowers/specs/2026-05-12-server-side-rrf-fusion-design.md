# Server-side RRF fusion for hybrid search

**Status:** approved **Date:** 2026-05-12 **Beads:** tea-rags-mcp-gk1d (closes
tea-rags-mcp-xqfh on merge)

## Problem

`QdrantManager.hybridSearch` (`src/core/adapters/qdrant/client.ts:950-1046`)
performs hybrid retrieval client-side:

1. Two parallel `this.client.search()` calls — dense (`using: "dense"`) and
   sparse (`using: "text"`).
2. Min-max normalization per source (`minMaxNorm` at `client.ts:1352`).
3. Linear blend with a hardcoded `semanticWeight = 0.7` default:
   `score = 0.7 * dense + 0.3 * sparse`.
4. Union merge by id and sort by fused score.

This is fragile:

- Min-max normalization is sensitive to outliers in the score distribution. A
  single anomalous score collapses the dynamic range of the rest.
- The default weight `0.7` is unreachable from any caller —
  `HybridSearchStrategy` calls `hybridSearch` without the 6th argument, so the
  value is dead config.
- Two requests per query instead of one. The double round-trip wastes latency.
- Score blending is not what modern hybrid systems use. RRF (Reciprocal Rank
  Fusion) is rank-based, distribution-insensitive, and the supported approach in
  Qdrant since 1.10.

Qdrant 1.17 (already pinned in `.qdrant-required-version`) supports **weighted
RRF** with per-prefetch weights, exposing a typed `weights[]` field in the SDK
starting at `@qdrant/js-client-rest@1.17.0`. The current installed SDK is
`1.16.2`, which exposes `rrf.k` but not `rrf.weights`.

## Goal

Replace the client-side blend with a single Qdrant Query-API call using
`prefetch` + RRF fusion. Keep the public method shape compatible with the only
production caller (`HybridSearchStrategy`), but allow future callers to opt into
weighted RRF via an optional argument.

## Non-goals

- `queryGroups` does not support RRF fusion. The `level=file` path in
  `HybridSearchStrategy.executeExplore`
  (`src/core/domains/explore/strategies/hybrid.ts:33-39`) continues to fetch
  `limit * 3` chunks and group client-side via
  `BaseExploreStrategy.groupByFile`. The comment on line 37 stays accurate; only
  the wording is tightened.
- No new MCP tool, no DTO changes, no new public API surface beyond the optional
  `semanticWeight` argument that was already in the signature (it just becomes
  meaningful instead of dead).
- No integration test against the embedded Qdrant daemon. Unit tests against a
  mocked `this.client.query()` cover the request shape; the existing
  `tests/integration/integration.test.ts` already exercises hybrid search
  end-to-end and will catch any regression in the live wire format.
- No changes to sparse-vector generation, BM25 tokenization, or any consumer of
  `SearchResult[]`. The result shape is unchanged.

## Design

### SDK upgrade

Bump `@qdrant/js-client-rest` from `1.16.2` to `1.17.0` in `package.json`. This
aligns the typed surface with the server version already pinned in
`.qdrant-required-version`. The 1.16 → 1.17 jump is a minor bump on
`@qdrant/js-client-rest` (semver patch range covers it); the only call sites in
`client.ts` use stable methods (`search`, `query`, `queryGroups`, `upsert`,
`scroll`, `delete`, `setPayload`, `batchUpdate`, `updateCollection`,
`createCollection`, `getCollection`, `getCollections`, `count`, `retrieve`,
`deletePayload`, `createPayloadIndex`), none of which change shape in 1.17.

### Public signature

```ts
async hybridSearch(
  collectionName: string,
  denseVector: number[],
  sparseVector: SparseVector,
  fetchLimit: number,
  filter?: Record<string, unknown>,
  semanticWeight?: number, // optional; absent = vanilla RRF
): Promise<SearchResult[]>
```

Semantics of `semanticWeight`:

| Input              | Behavior                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `undefined`        | Plain RRF — `query: { fusion: "rrf" }`. Both prefetches contribute with equal weight, Qdrant default `k`.                                   |
| Number in `[0, 1]` | Weighted RRF — `query: { rrf: { weights: [semanticWeight, 1 - semanticWeight] } }`. Order matches `prefetch[]`: dense first, sparse second. |
| Anything else      | Throw `InvalidQueryError("semanticWeight must be a number in [0, 1]")`.                                                                     |

The "anything else" branch catches `NaN`, `Infinity`, negatives, and values
strictly above 1. Validation lives in `hybridSearch` itself — this is an
adapter-level guard, not a facade-level one, because the only call site at the
facade layer does not expose `semanticWeight` to MCP clients today; if a future
caller introduces it, the validation is already on the path.

### Implementation

Single Qdrant Query-API call. Pseudocode:

```ts
async hybridSearch(collectionName, denseVector, sparseVector, fetchLimit, filter, semanticWeight) {
  if (semanticWeight !== undefined) {
    if (!Number.isFinite(semanticWeight) || semanticWeight < 0 || semanticWeight > 1) {
      throw new InvalidQueryError("semanticWeight must be a number in [0, 1]");
    }
  }

  const qdrantFilter = normalizeFilter(filter); // unchanged from current impl

  const fusionQuery =
    semanticWeight === undefined
      ? { fusion: "rrf" as const }
      : { rrf: { weights: [semanticWeight, 1 - semanticWeight] } };

  try {
    const response = await this.call(async () =>
      this.client.query(collectionName, {
        prefetch: [
          { query: denseVector,  using: "dense", limit: fetchLimit, filter: qdrantFilter ?? undefined },
          { query: sparseVector, using: "text",  limit: fetchLimit, filter: qdrantFilter ?? undefined },
        ],
        query: fusionQuery,
        limit: fetchLimit,
        filter: qdrantFilter ?? undefined,
        with_payload: true,
      } as Parameters<QdrantClient["query"]>[1]),
    );

    return (response.points ?? []).map((p) => ({
      id: p.id,
      score: p.score ?? 0,
      payload: (p.payload as Record<string, unknown> | null | undefined) ?? undefined,
    }));
  } catch (error: unknown) {
    if (error instanceof QdrantUnavailableError) throw error;
    const errorData = error as { data?: { status?: { error?: string } }; message?: string };
    const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
    throw new QdrantOperationError(
      "hybridSearch",
      `collection "${collectionName}": ${errorMessage}`,
      error instanceof Error ? error : undefined,
    );
  }
}
```

Notes:

- `filter` is duplicated at prefetch level **and** outer level. Prefetch-level
  filtering keeps each sub-query selective; the outer filter is redundant but
  harmless and matches the documented Qdrant pattern.
- The `as Parameters<QdrantClient["query"]>[1]` cast is the same pattern already
  used by `QdrantManager#query` (`client.ts:627`) — the SDK type for the second
  argument is a discriminated union that does not narrow cleanly when the
  request mixes `prefetch` + outer `query`.
- `this.call` is the existing retry/circuit-breaker wrapper; behavior unchanged.

### Code to delete

- `function minMaxNorm` at `client.ts:1352` — only caller was `hybridSearch`.
- The `Promise.all([dense search, sparse search])` block and the score-map merge
  in the old `hybridSearch` body (`client.ts:975-1035`).
- The local `sparseWeight = 1 - semanticWeight` constant.

### Caller-side updates

- `HybridSearchStrategy.executeExplore` (`hybrid.ts:29`) — no change to the call
  itself, but the comment on line 37 changes from
  `queryGroups doesn't support RRF fusion` to a tighter wording that names the
  workaround:
  `queryGroups has no fusion=rrf option; fetch fetchLimit*3 and group client-side`.
- `tests/core/domains/ingest/__helpers__/test-helpers.ts:174` —
  `MockQdrantManager.hybridSearch` gains an optional 6th `semanticWeight`
  parameter to match the signature. The mock body does not need to honor it for
  ingest-side helpers; it only needs to type-check.

### Errors

| Failure                                  | Error class                                      |
| ---------------------------------------- | ------------------------------------------------ |
| `semanticWeight` invalid                 | `InvalidQueryError` (adapter throws, not facade) |
| Qdrant unreachable                       | `QdrantUnavailableError` (propagated)            |
| Qdrant returns 4xx / 5xx for the request | `QdrantOperationError("hybridSearch", ...)`      |

The wrapping preserves the existing log shape (`"hybridSearch"` op tag) so any
log-based dashboards or grep'd traces keep working.

## Testing

Unit tests only. No new integration test.

| File                                                    | Update                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/core/adapters/qdrant/client.test.ts`             | Replace existing `hybridSearch` suite with: (a) golden request-payload test (mock `this.client.query` and assert exact `prefetch` + `query` shape, both vanilla and weighted), (b) result mapping, (c) filter forwarding to prefetch and outer, (d) `semanticWeight` validation (4 invalid inputs throw `InvalidQueryError`), (e) error wrapping for non-Unavailable failures, (f) `QdrantUnavailableError` propagation. |
| `tests/core/domains/explore/strategies/hybrid.test.ts`  | Update mock `hybridSearch` signature to include optional 6th arg. Assert that strategy still passes `fetchLimit * 3` for `level=file` and groups client-side. No new behavior assertions.                                                                                                                                                                                                                                |
| `tests/core/domains/ingest/__helpers__/test-helpers.ts` | Add optional 6th parameter to `MockQdrantManager.hybridSearch`.                                                                                                                                                                                                                                                                                                                                                          |

The existing `tests/integration/integration.test.ts` will pick up the bumped SDK
and the new fusion path automatically — that is the smoke layer.

## Risks

- **Bumped SDK behavior drift.** `1.16.2 → 1.17.0` is minor, but the embedded
  daemon download in `src/core/adapters/qdrant/embedded/` already targets server
  `1.17.0`. Any SDK type tightening that affects other call sites would surface
  as `tsc --noEmit` failures. Mitigation: full type-check pass is the first
  verification step.
- **High-churn zone.** `client.ts` chunk containing `hybridSearch` shows
  `bugFixRate 35 "concerning"` and `relativeChurn 2.72` per tea-rags signals.
  Mitigation: tests cover the request payload shape exactly (golden), so any
  future drift surfaces as a test diff rather than silent behavior change.
- **Score-distribution behavior change.** Rankings produced by RRF differ from
  the old min-max-blend rankings for the same query. The change is intentional —
  the old behavior was the bug — but users tuned for the old curve will see
  reranking shift. No mitigation needed; this is the point of the migration.
- **Weighted RRF default semantics.** Choosing `undefined → plain RRF` (Qdrant
  default `k=60`, no weights) instead of `undefined → weighted [0.5, 0.5]` keeps
  the default behavior aligned with Qdrant's documented out-of-box ranking. If
  we later discover that operations teams need `[0.5, 0.5]` as the baseline for
  some calibration, we can flip the default without changing the signature.

## Out-of-scope follow-ups

- Exposing RRF `k` as a parameter. Not requested, no current calibration use
  case. Add later if a caller needs it.
- Surfacing `semanticWeight` through the MCP `hybrid_search` tool. Requires a
  DTO field and SchemaBuilder update. Not part of `gk1d` — file a follow-up if a
  caller materializes.
- Migrating `level=file` to a server-side aggregation. Requires `queryGroups` to
  support fusion, which is a Qdrant upstream change.
