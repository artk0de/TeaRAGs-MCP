---
paths:
  - "src/core/api/internal/facades/**/*.ts"
  - "src/core/api/public/app.ts"
  - "src/core/domains/explore/strategies/**/*.ts"
  - "src/core/domains/explore/queries/**/*.ts"
  - "src/core/api/internal/ops/**/*.ts"
---

# Facade Discipline (MANDATORY)

`ExploreFacade`/`IngestFacade` = **thin orchestrators**, not business-logic
containers. Facade method growing past dispatching collapses layering:
strategies stop being source of truth, tests mock facade internals not domain
classes, next feature pasted same place by same instinct.

This rule prevents drift. Triggers on: edit facade, add `App` method, touch
strategies/ops/queries.

## What a facade does — and only that

**Facade method does two things: validate input + delegate.** Everything else —
resolve collection, guard missing-collection/wrong-model, ensure cached stats
loaded, embed query, merge filters, execute strategy, attach drift warning,
shape response — lives in corresponding Ops/Query class.

**Facade has zero private async pipeline methods.** Writing
`private async doX(...)` on facade → stop: that's pipeline work, lives in Ops.
Facade hosting `executeExplore`, `embedAndDispatch`, `buildFilter`,
`resolveAndGuard`, `ensureStats`, `checkDrift`, or any context-builders = failed
rule — regardless how short each public method looks.

Only private members allowed on facade:

1. Injected dependencies (`qdrant`, `ops`, `query`, `modelGuard`, etc.)
2. Synchronous input validators (move out once >~5 lines — see "Validation
   extraction").

### The pipeline lives in Ops

Ops classes run this pipeline, not facade:

```
1. resolve     — paths/collection names, embed query if needed
2. guard       — collection exists, model matches
3. ensureStats — cold-start bridge for reranker (explore only)
4. dispatch    — hand off to exactly one strategy / query
5. finalize    — attach drift warning, strip internal fields, shape response
```

Ops method doing anything beyond these five steps → extra work belongs in
strategy/query, not further up.

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

Note: "Merging typed + raw filters" = Ops work — calls
`registry.buildMergedFilter()`, hands merged filter to strategy via
`ExploreContext.filter`. Strategies build filters only for operation-specific
shapes (e.g. `SymbolSearchStrategy` symbolId + parentSymbolId pair).

## Decision: where does a new method go?

**Every new facade method delegates to Ops.** Non-negotiable — Ops owns pipeline
(resolve → guard → ensureStats → dispatch → finalize). Facade validates input +
forwards.

What needs placement = **inner work** the Ops method performs. Answer three
questions in order — first "yes" wins:

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

None match → Ops method is pure pipeline: `executeExplore` or equivalent
forwards to existing strategy/query/ops with different context. Still Ops, not
facade.

## Size budget

Three checks, priority order:

1. **Facade has zero private async pipeline methods.** Structural check — no
   `private async executeExplore`, no `private async embedAndDispatch`, no
   `private async resolveAndGuard`, no `private async ensureStats`. Belong in
   Ops. Any on facade class → facade absorbed pipeline work, extraction
   incomplete, regardless how short each public method.
2. **Facade public method body: ≤ 20 lines.** Validate+delegate dispatchers
   typically 1–5 lines. Method exceeding 20 → facade doing work inline, extract.
3. **Facade file total: informational, not hard gate.** 7 methods × 2 lines
   delegation + imports + validators lands under 200 lines naturally. Well over
   200 lines but every public method 1–3 lines → look for synchronous helpers to
   move to Ops (ctx builders, filter merges disguised as validators).

Check 1 = the one rule existed to prevent. Check 2 catches inline bloat. Check 3
= smoke alarm.

Checks exist because `ExploreFacade` grew to 635 lines when three methods
(`findSymbol`, `findSimilar`, `getIndexMetrics`) each added ~90 lines inline
business logic, then — after first-pass refactor — dropped to 478 lines of
"thin" public methods backed by ~10 private async helpers doing exact same
pipeline work. Both shapes fail: first on Check 2, second on Check 1.

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

Every public method ≤ 10 lines, every method-body budget satisfied, yet file
grew — pipeline got renamed `public async method()` → `private async method()`.
Cosmetic, not structural.

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

Facade holds only Ops reference + (synchronous) input validators. Every public
method 1–3 lines. Pipeline — `executeExplore`, `embedAndDispatch`,
`buildFilter`, `resolveAndGuard`, `ensureStats`, `checkDrift`, ctx builders —
all in `ExploreOps`.

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

`ExploreContext.filter` holds ONE filter. Strategies needing two+ filters
(parallel scrolls, disjoint passes) take typed **Input object via constructor**
— same as `SimilarSearchStrategy`. Do not wedge extra filters into
`ExploreContext`; do not build filters in facade + thread as ad-hoc context
fields.

Strategy consumes `ctx.collectionName` / `ctx.limit` / `ctx.offset` /
`ctx.metaOnly` / `ctx.rerank` from `ExploreContext`, everything else from own
`input`. Filter construction (incl. `registry.buildMergedFilter()` for
`pathPattern` merging) happens inside strategy.

### Adding a new strategy type — checklist

Adding new concrete strategy class:

1. **Implement `BaseExploreStrategy`** — override `executeExplore` and, if
   needed, `applyDefaults` / `postProcess`.
2. **Extend the `type` union** in `strategies/types.ts`:
   ```typescript
   readonly type: "vector" | "hybrid" | "scroll-rank" | "similar" | "symbol";
   ```
   Do NOT cast (`as unknown as`) to sidestep the union — silent widening hides
   new type from factory's exhaustiveness check.
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

Inject into facade via `ExploreFacadeDeps`; do not reach into `domains/explore/`
internals from facade body.

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

Match shape of existing `CollectionOps` / `DocumentOps`.

## Validation extraction

Input validation (shape, mutual exclusion, strategy-specific rules) = facade
work — but only up to ~5 lines. Past that, extract into named
`validate<Name>Request` function **exported from bottom of same facade file**,
below class, alongside other per-endpoint helpers.

Don't put validators in `api/errors.ts` — holds error _classes_, not validation
logic. Don't spin up `validators/` subdirectory until 5+ validators to group.

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

Throw typed errors per `typed-errors.md`. Export validator so its unit test
imports it directly rather than reaching through facade. Facade method calls it
as first line.

## Adding a new explore or ingest API

Before writing method in facade, run checklist:

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

Legacy tests sometimes swap facade deps after construction, e.g.:

```typescript
const facade = new ExploreFacade({ ... });
(facade as any).qdrant = { collectionExists: vi.fn().mockResolvedValue(true) };
```

Works as long as facade methods read `this.qdrant` / `this.indexing` every call.
After extraction, strategy/query/ops class **captures deps at construction
time** and post-hoc swap has no effect. Test silently exercises wrong code path.

**Prefer constructor-time DI.** Pass mocked dependency via `ExploreFacadeDeps` /
`IngestFacadeDeps` at `new Facade({...})`. Test insisting on post-construction
swap (e.g. replacing concrete `IndexPipeline` for fire-and-forget assertions) →
redirect swap to extracted class: `(facade as any).indexingOps.indexing = ...` —
leave comment pointing at this rule so future readers see why.

Extraction breaking existing tests this way → fix test by moving mock to
constructor time rather than weakening encapsulation of extracted class.

## When in doubt

Ask: "If I delete this code from the facade, which file picks it up?" Answer
"nothing, it only exists here" → code doesn't belong in facade. Find/create its
real home before adding.

## Verification

```bash
npx tsc --noEmit && npx vitest run tests/core/api/ tests/core/domains/explore/
```

File sizes: see Size budget section above. PR may grow facade past budget only
if every public method fits ≤ 20 lines — otherwise review must link
strategy/query/ops class absorbing new work.
