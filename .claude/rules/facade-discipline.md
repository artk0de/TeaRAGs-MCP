---
paths:
  - "src/core/api/internal/facades/**/*.ts"
  - "src/core/api/public/app.ts"
  - "src/core/domains/explore/strategies/**/*.ts"
  - "src/core/domains/explore/queries/**/*.ts"
  - "src/core/api/internal/ops/**/*.ts"
---

# Facade Discipline (MANDATORY)

`ExploreFacade` and `IngestFacade` are **thin orchestrators**, not containers
for business logic. Every time a facade method grows past dispatching, the
layered architecture collapses: strategies stop being the source of truth, tests
have to mock facade internals instead of domain classes, and the next feature
gets pasted in the same place by the same instinct.

This rule prevents that drift. It triggers whenever you edit a facade, add a
method to `App`, or touch strategies/ops/queries.

## What a facade does — and only that

A facade method is at most five steps, in this order:

```
1. resolve    — paths/collection names, embed query if needed
2. guard      — collection exists, model matches, input valid
3. ensureStats — cold-start bridge for reranker (explore only)
4. dispatch   — hand off to exactly one strategy / ops / query class
5. finalize   — attach drift warning, strip internal fields, shape response
```

If a method does anything beyond these five steps, the extra work belongs
somewhere else. No exceptions.

| Responsibility                     | Facade | Strategy | Ops | Query |
| ---------------------------------- | :----: | :------: | :-: | :---: |
| Path / collection resolution       |   ✅   |          |     |       |
| Model guard, collection-exists     |   ✅   |          |     |       |
| Input validation (shape, mutex)    |   ✅   |          |     |       |
| Drift warning attachment           |   ✅   |          |     |       |
| Stripping internal payload fields  |   ✅   |          |     |       |
| **Building Qdrant filters**        |        |   ✅¹    | ✅  |  ✅   |
| **Parallel scrolls, dedup, merge** |        |    ✅    | ✅  |  ✅   |
| **Reranking / scoring**            |        |    ✅    |     |       |
| **Vector / BM25 / scroll search**  |        |    ✅    |     |       |
| **Per-language aggregation**       |        |          |     |  ✅   |
| **Index/reindex branching**        |        |          | ✅  |       |
| **Marker read/backfill**           |        |          | ✅  |       |
| **Collection/document CRUD**       |        |          | ✅  |       |

¹ Filter building via `registry.buildMergedFilter()` — facade calls it, the
strategy consumes the result. The facade does not inline-build filters.

## Decision: where does a new method go?

Answer three questions in this order. The first "yes" wins.

1. **Does it search, rank, or scroll chunks?** → new strategy in
   `domains/explore/strategies/` extending `BaseExploreStrategy`. Register in
   `createExploreStrategy()`.
2. **Does it aggregate / summarize data from Qdrant without vector search?** →
   new query class in `domains/explore/queries/`. Injected into the facade via
   `ExploreFacadeDeps`.
3. **Does it mutate collections or documents, or orchestrate indexing
   branches?** → new ops class in `api/internal/ops/` alongside `CollectionOps`
   / `DocumentOps`. Injected into the facade via its deps.

If none match, the method is pure dispatch (e.g. `clearIndex` is a one-liner
that forwards to `status.clearIndex`) — it may stay in the facade as-is.

## Size budget

- **Facade method body: ≤ 20 lines.** If you're past that, the method is doing
  work — extract it.
- **Facade file total: ≤ ~250 lines.** Past that, inspect the fattest methods
  first.
- **Private helpers in the facade** are allowed only for cross-cutting concerns
  (e.g. `ensureStats`, `checkDrift`, `resolveAndGuard`). A helper that's called
  by one public method is a smell — move it with its caller.

These are not arbitrary numbers: `ExploreFacade` grew to 635 lines because three
methods (`findSymbol`, `findSimilar`, `getIndexMetrics`) each added ~90 lines of
business logic inline. A strict budget makes the next such method impossible to
land without extraction.

## Anti-patterns

### ❌ Inline filter building in the facade

```typescript
// BAD — facade builds Qdrant filter shapes itself
async findSymbol(request: FindSymbolRequest) {
  const must = [{ key: "symbolId", match: { text: request.symbol } }];
  if (request.language) {
    must.push({ key: "language", match: { value: request.language } });
  }
  const filter = { must };
  const chunks = await this.qdrant.scrollFiltered(collectionName, filter, 200);
  // ...100 more lines
}
```

### ✅ Dispatch to a strategy

```typescript
async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
  validateFindSymbolRequest(request);
  const { collectionName, path } = await this.resolveAndGuard(
    request.collection,
    request.path,
  );
  return this.executeExplore(
    this.symbolStrategy,
    buildSymbolContext(request, collectionName, this.registry),
    path,
  );
}
```

### ❌ Aggregation logic in the facade

```typescript
// BAD — getIndexMetrics assembles per-language/per-signal metrics inline
async getIndexMetrics(path: string) {
  // 95 lines of Map iteration, descriptor matching, label mapping
}
```

### ✅ Delegate to a query class

```typescript
async getIndexMetrics(path: string): Promise<IndexMetrics> {
  const { collectionName } = await this.resolveAndGuard(undefined, path);
  return this.indexMetricsQuery.run(collectionName);
}
```

### ❌ Indexing branching in the facade

```typescript
// BAD — indexCodebase forks on collection state, backfills markers,
// runs recovery, refreshes stats, all inline
async indexCodebase(path, options, cb) {
  if (!options?.forceReindex) {
    const exists = await this.qdrant.collectionExists(...);
    if (exists) {
      // 40 lines: modelInfo, recovery, reindex, invalidate
    }
  }
  // 15 lines: full index
}
```

### ✅ Hand off to ops

```typescript
async indexCodebase(path, options, cb) {
  return this.indexingOps.run(path, options, cb);
}
```

## Extraction templates

### Strategy (for search / scroll / rank work)

```typescript
// domains/explore/strategies/symbol.ts
export class SymbolSearchStrategy extends BaseExploreStrategy {
  async executeSearch(ctx: ExploreContext): Promise<RawResult[]> {
    const [symbolChunks, memberChunks] = await Promise.all([
      this.qdrant.scrollFiltered(ctx.collectionName, ctx.filter!, 200),
      this.qdrant.scrollFiltered(ctx.collectionName, ctx.parentFilter!, 200),
    ]);
    const seen = new Set(symbolChunks.map((c) => c.id));
    return [...symbolChunks, ...memberChunks.filter((c) => !seen.has(c.id))];
  }
}
```

Then register in `strategies/index.ts`:

```typescript
export function createExploreStrategy(
  kind: "vector" | "hybrid" | "scroll-rank" | "symbol",
  ...,
): BaseExploreStrategy { /* ... */ }
```

### Query (for aggregation without vector search)

```typescript
// domains/explore/queries/index-metrics.ts
export class IndexMetricsQuery {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly statsCache: StatsCache,
    private readonly payloadSignals: PayloadSignalDescriptor[],
  ) {}
  async run(collectionName: string): Promise<IndexMetrics> {
    /* ... */
  }
}
```

Inject into the facade via `ExploreFacadeDeps`; do not reach into
`domains/explore/` internals from the facade body.

### Ops (for CRUD / orchestration branching)

```typescript
// api/internal/ops/indexing-ops.ts
export class IndexingOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly indexing: IndexPipeline,
    private readonly reindex: ReindexPipeline,
    private readonly enrichment: EnrichmentCoordinator,
    /* ... */
  ) {}
  async run(path, options, cb): Promise<IndexStats> {
    /* branching here */
  }
}
```

Match the shape of existing `CollectionOps` / `DocumentOps`.

## Validation extraction

Input validation (shape, mutual exclusion, strategy-specific rules) counts as
facade work — but only up to ~5 lines. Past that, extract into a named
validator:

```typescript
// api/errors.ts or a dedicated validator file
export function validateFindSimilarRequest(req: FindSimilarRequest): void {
  const hasPositive = /* ... */;
  const hasNegative = /* ... */;
  if (req.strategy && req.strategy !== "best_score" && !hasPositive) {
    throw new InvalidQueryError(
      `Strategy '${req.strategy}' requires at least one positive input`,
    );
  }
  if (!hasPositive && !hasNegative) {
    throw new InvalidQueryError(
      "At least one positive or negative input is required",
    );
  }
}
```

Throw typed errors (see `typed-errors.md`). The facade calls the validator as
its first line and moves on.

## Adding a new explore or ingest API

Before writing the method in the facade, run this checklist:

1. **Classify** the method using the decision tree above (strategy / query / ops
   / pure dispatch).
2. **Create the class file** in the correct location (this is where the work
   goes).
3. **Wire via deps.** Add the field to `ExploreFacadeDeps` / `IngestFacadeDeps`,
   pass from `createComposition()` in `api/internal/composition.ts`.
4. **Facade method last.** Only once the class exists do you write the facade
   method — and it should be a dispatcher that fits the size budget.
5. **Update `App` interface** in `api/public/app.ts` and wire in `createApp()` —
   follow `add-mcp-endpoint` skill.
6. **Tests live with the implementation**, not the facade. The facade test
   verifies dispatch + drift wiring; the strategy/query/ops test verifies the
   logic.

## When in doubt

Ask: "If I delete this code from the facade, which file picks it up?" If the
answer is "nothing, it only exists here" — the code doesn't belong in the
facade. Find or create its real home before adding it.

## Verification

```bash
npx tsc --noEmit && npx vitest run tests/core/api/ tests/core/domains/explore/
```

Both facade files should stay under ~250 lines. If a PR grows either past that,
the review must link a strategy/query/ops class absorbing the new work —
otherwise the PR is rejected.
