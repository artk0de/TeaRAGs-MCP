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

**A facade method does two things: validate input and delegate.** Everything
else — resolving the collection, guarding against a missing collection or wrong
model, ensuring cached stats are loaded, embedding the query, merging filters,
executing a strategy, attaching a drift warning, shaping the response — lives in
the corresponding Ops / Query class.

**The facade class has zero private async pipeline methods.** If you find
yourself writing `private async doX(...)` on a facade, stop: that helper is
pipeline work, and pipeline work lives in Ops. A facade that hosts
`executeExplore`, `embedAndDispatch`, `buildFilter`, `resolveAndGuard`,
`ensureStats`, `checkDrift`, or any context-building helpers has failed the rule
— regardless of how short each public method looks.

The only private members allowed on the facade are:

1. Injected dependencies (`qdrant`, `ops`, `query`, `modelGuard`, etc.)
2. Synchronous input validators (and even these move out once they exceed ~5
   lines — see "Validation extraction").

### The pipeline lives in Ops

Ops classes run this pipeline, not the facade:

```
1. resolve     — paths/collection names, embed query if needed
2. guard       — collection exists, model matches
3. ensureStats — cold-start bridge for reranker (explore only)
4. dispatch    — hand off to exactly one strategy / query
5. finalize    — attach drift warning, strip internal fields, shape response
```

If an Ops method does anything beyond these five steps, the extra work belongs
in a strategy / query — not further up.

### Responsibility table

| Responsibility                             | Facade | Ops | Strategy | Query |
| ------------------------------------------ | :----: | :-: | :------: | :---: |
| Input validation (shape, mutex)            |   ✅   |     |          |       |
| Path / collection resolution               |        | ✅  |          |       |
| Model guard, collection-exists             |        | ✅  |          |       |
| Ensuring cached stats are loaded           |        | ✅  |          |       |
| Embedding the query                        |        | ✅  |          |       |
| Merging typed + raw filters (via registry) |        | ✅  |          |       |
| Context assembly for strategy / query      |        | ✅  |          |       |
| Drift warning attachment                   |        | ✅  |          |       |
| Stripping internal payload fields          |        | ✅  |          |       |
| **Building Qdrant filter shapes**          |        |     |    ✅    |  ✅   |
| **Parallel scrolls, dedup, merge**         |        |     |    ✅    |  ✅   |
| **Reranking / scoring**                    |        |     |    ✅    |       |
| **Vector / BM25 / scroll search**          |        |     |    ✅    |       |
| **Per-language aggregation**               |        |     |          |  ✅   |
| **Index/reindex branching**                |        | ✅  |          |       |
| **Marker read/backfill**                   |        | ✅  |          |       |
| **Collection/document CRUD**               |        | ✅  |          |       |

Note: "Merging typed + raw filters" is Ops work — it calls
`registry.buildMergedFilter()` and hands the merged filter to the strategy via
`ExploreContext.filter`. Strategies only build filters when they need
operation-specific shapes (e.g. `SymbolSearchStrategy` building its symbolId +
parentSymbolId pair).

## Decision: where does a new method go?

**Every new facade method delegates to Ops.** That's not negotiable — Ops owns
the pipeline (resolve → guard → ensureStats → dispatch → finalize). The facade
just validates input and forwards the request.

What actually needs placement is the **inner work** the Ops method performs.
Answer three questions, in order — the first "yes" wins:

1. **Does it search, rank, or scroll chunks?** → new strategy in
   `domains/explore/strategies/` extending `BaseExploreStrategy`. Register in
   `createExploreStrategy()` (for shared strategies) or instantiate per-request
   (like `SimilarSearchStrategy` / `SymbolSearchStrategy`).
2. **Does it aggregate / summarize data from Qdrant without vector search?** →
   new query class in `domains/explore/queries/`. Injected into Ops as a
   constructor dep (Ops in turn is injected into the facade).
3. **Does it mutate collections or documents, or orchestrate indexing
   branches?** → new ops class in `api/internal/ops/` alongside `CollectionOps`
   / `DocumentOps` / `IndexingOps` / `ExploreOps`, or a new method on an
   existing ops class if the responsibility matches.

If none match, the Ops method is pure pipeline: `executeExplore` or equivalent
forwards to an existing strategy / query / ops with different context. Still
goes in Ops, not the facade.

## Size budget

Three checks in priority order:

1. **Facade has zero private async pipeline methods.** This is the structural
   check — no `private async executeExplore`, no
   `private async embedAndDispatch`, no `private async resolveAndGuard`, no
   `private async ensureStats`. Those belong in Ops. If any exist on the facade
   class, the facade has absorbed pipeline work and the extraction is
   incomplete, regardless of how short each public method looks.
2. **Facade public method body: ≤ 20 lines.** Dispatchers that only validate +
   delegate are typically 1–5 lines. If a method exceeds 20, the facade is doing
   work inline — extract it.
3. **Facade file total: informational, not a hard gate.** A facade with 7
   methods × 2 lines of delegation + imports + validators will land under 200
   lines naturally. If the file is well over 200 lines but every public method
   is 1–3 lines, look for synchronous helpers that could move to Ops (ctx
   builders, filter merges disguised as validators).

Check 1 is the one the rule existed to prevent in the first place. Check 2
catches inline bloat. Check 3 is a smoke alarm.

These checks exist because `ExploreFacade` grew to 635 lines when three methods
(`findSymbol`, `findSimilar`, `getIndexMetrics`) each added ~90 lines of
business logic inline, and then — after a first-pass refactor — dropped to 478
lines of "thin" public methods backed by ~10 private async helpers doing the
exact same pipeline work. Both shapes fail the rule: the first on Check 2, the
second on Check 1.

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

### ❌ Private pipeline helpers in the facade (cosmetic thinning)

```typescript
// BAD — public method looks thin, but the pipeline lives next to it
// as private helpers. The facade is still a container for pipeline code.
class ExploreFacade {
  async semanticSearch(req) {
    return this.embedAndDispatch(req, this.vectorStrategy);
  }
  async hybridSearch(req) {
    return this.embedAndDispatch(req, this.hybridStrategy);
  }
  private async embedAndDispatch(req, strategy) {
    /* 12 lines: guard → embed → level → filter → execute */
  }
  private async executeExplore(strategy, ctx, path) {
    /* 15 lines: ensureStats → strategy.execute → map → checkDrift */
  }
  private buildFilter(req, level) {
    /* merges via registry */
  }
  // + ctx builders, resolveAndGuard, ensureStats, checkDrift, ...
}
```

Every public method is ≤ 10 lines, every method-body budget is satisfied, and
yet the file has grown — because the pipeline got renamed from
`public async method()` to `private async method()`. That's cosmetic, not
structural.

### ✅ Facade is pure delegation; pipeline lives in Ops

```typescript
class ExploreFacade {
  constructor(deps: ExploreFacadeDeps) {
    this.exploreOps = new ExploreOps(deps);
  }
  async semanticSearch(req) {
    return this.exploreOps.semanticSearch(req);
  }
  async hybridSearch(req) {
    return this.exploreOps.hybridSearch(req);
  }
  async rankChunks(req) {
    return this.exploreOps.rankChunks(req);
  }
  async searchCode(req) {
    return this.exploreOps.searchCode(req);
  }
  async findSimilar(req) {
    validateFindSimilarRequest(req);
    return this.exploreOps.findSimilar(
      req,
      this.exploreOps.buildSimilarStrategy(req),
    );
  }
  async findSymbol(req) {
    validateFindSymbolRequest(req);
    return this.exploreOps.findSymbol(req);
  }
  async getIndexMetrics(path) {
    return this.exploreOps.getIndexMetrics(path);
  }
}
```

The facade holds only the Ops reference and (synchronous) input validators.
Every public method is 1–3 lines. The pipeline — `executeExplore`,
`embedAndDispatch`, `buildFilter`, `resolveAndGuard`, `ensureStats`,
`checkDrift`, ctx builders — all lives in `ExploreOps`.

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
export interface SymbolSearchInput {
  symbol: string;
  language?: string;
  pathPattern?: string;
}

export class SymbolSearchStrategy extends BaseExploreStrategy {
  readonly type = "symbol" as const;

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly registry: TrajectoryRegistry,
    private readonly input: SymbolSearchInput,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  protected async executeExplore(
    ctx: ExploreContext,
  ): Promise<ExploreResult[]> {
    const primary = this.buildFilter("symbolId");
    const parent = this.buildFilter("parentSymbolId");
    const [symbolChunks, memberChunks] = await Promise.all([
      this.qdrant.scrollFiltered(ctx.collectionName, primary, 200),
      this.qdrant.scrollFiltered(ctx.collectionName, parent, 200),
    ]);
    const seen = new Set(symbolChunks.map((c) => c.id));
    return [...symbolChunks, ...memberChunks.filter((c) => !seen.has(c.id))];
  }

  private buildFilter(
    key: "symbolId" | "parentSymbolId",
  ): Record<string, unknown> {
    /* ... */
  }
}
```

### Multi-filter strategies — pass input via constructor

`ExploreContext.filter` holds ONE filter. Strategies that need two or more
filters (parallel scrolls, disjoint passes) take a typed **Input object via
their constructor** — same pattern as `SimilarSearchStrategy`. Do not try to
wedge extra filters into `ExploreContext`; do not build filters in the facade
and thread them as ad-hoc context fields.

The strategy consumes `ctx.collectionName` / `ctx.limit` / `ctx.offset` /
`ctx.metaOnly` / `ctx.rerank` from `ExploreContext` and everything else from its
own `input`. Filter construction (including `registry.buildMergedFilter()` calls
for `pathPattern` merging) happens inside the strategy.

### Adding a new strategy type — checklist

When you add a new concrete strategy class:

1. **Implement `BaseExploreStrategy`** — override `executeExplore` and, if
   needed, `applyDefaults` / `postProcess`.
2. **Extend the `type` union** in `strategies/types.ts`:
   ```typescript
   readonly type: "vector" | "hybrid" | "scroll-rank" | "similar" | "symbol";
   ```
   Do NOT cast (`as unknown as`) to sidestep the union — that's a silent
   widening that hides the new type from the factory's exhaustiveness check.
3. **Register the strategy**: either extend `createExploreStrategy()` if the
   strategy is shared across calls (like `vector`/`hybrid`/`scroll-rank`), or
   keep it per-request and instantiate it in the facade dispatcher (like
   `similar`/`symbol`).
4. **Export from `strategies/index.ts`** — add both the class and its `Input`
   type to the barrel.

```typescript
// strategies/index.ts — barrel
export { SymbolSearchStrategy } from "./symbol.js";
export type { SymbolSearchInput } from "./symbol.js";
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
`validate<Name>Request` function **exported from the bottom of the same facade
file**, below the class and alongside other per-endpoint helpers.

Don't put validators in `api/errors.ts` — that file holds error _classes_, not
validation logic. Don't spin up a `validators/` subdirectory until there are 5+
validators to group.

```typescript
// src/core/api/internal/facades/explore-facade.ts (bottom of file)
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

Throw typed errors per `typed-errors.md`. Export the validator so its unit test
imports it directly rather than reaching through the facade. The facade method
calls it as its first line.

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

## Tests that mutate facade internals after construction

Legacy tests sometimes swap facade dependencies after construction, e.g.:

```typescript
const facade = new ExploreFacade({ ... });
(facade as any).qdrant = { collectionExists: vi.fn().mockResolvedValue(true) };
```

This works as long as facade methods read `this.qdrant` / `this.indexing` on
every call. After extraction, the strategy / query / ops class **captures those
deps at construction time** and the post-hoc swap has no effect. The test
silently exercises the wrong code path.

**Prefer constructor-time DI.** Pass the mocked dependency via
`ExploreFacadeDeps` / `IngestFacadeDeps` at `new Facade({...})`. If a test
insists on post-construction swap (e.g. because it's replacing the concrete
`IndexPipeline` for fire-and-forget assertions), redirect the swap to the
extracted class: `(facade as any).indexingOps.indexing = ...` — and leave a
comment pointing at this rule so future readers see why.

When extraction breaks existing tests this way, fix the test by moving the mock
to constructor time rather than weakening the encapsulation of the extracted
class.

## When in doubt

Ask: "If I delete this code from the facade, which file picks it up?" If the
answer is "nothing, it only exists here" — the code doesn't belong in the
facade. Find or create its real home before adding it.

## Verification

```bash
npx tsc --noEmit && npx vitest run tests/core/api/ tests/core/domains/explore/
```

File sizes: see the Size budget section above. A PR may grow a facade past
budget only if every public method fits ≤ 20 lines — otherwise the review must
link a strategy / query / ops class absorbing the new work.
