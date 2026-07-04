# Thin MCP Layer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** MCP layer becomes a thin mapping (schema → App call → MCP response).
All business logic moves to api/ and domain modules.

**Architecture:** Unified `App` interface in api/ replaces scattered
dependencies. `createApp()` factory replaces `createAppContext()` in bootstrap.
MCP handlers become 3-line functions: resolve params → `app.method()` →
`formatMcpResponse()`. Strategy + Factory Method pattern in explore/ for search
dispatch.

**Tech Stack:** TypeScript, Zod (MCP schemas only), Qdrant REST, ONNX/Jina
embeddings

---

## Current State Analysis

### What's wrong now

1. **MCP layer has business logic:**
   - `search.ts`: creates BM25SparseVectorGenerator, scrollOrderedBy,
     filterResultsByGlob, RankModule, excludeDocumentation filter, preset
     resolution
   - `formatters/search-pipeline.ts`: resolveCollectionName validation,
     getSearchFetchLimit, applyPostProcessing (glob + rerank),
     formatSearchResults (metaOnly + overlay mask + essential fields)
   - `document.ts`: BM25 generation, hybrid detection, point construction
   - `collection.ts`: direct qdrant calls

2. **MCP imports from wrong layers:**
   - `search.ts` → adapters/ (filters, scroll, sparse), explore/ (RankModule,
     Reranker)
   - `search-pipeline.ts` → adapters/ (filters), contracts/ (reranker types),
     explore/ (Reranker), ingest/ (collection), trajectory/ (payload-signals)
   - `resources/index.ts` → adapters/ (QdrantManager)

3. **bootstrap/factory.ts creates domain objects:**
   - Should be api/'s job (composition root)

4. **ToolDependencies has 8 fields** — should be just `App`

### Target state

- MCP imports ONLY from api/ (App interface + formatMcpResponse utility)
- bootstrap creates App via `api/createApp(config)`
- All business logic in api/ facades + domain modules
- ToolDependencies = `{ app: App }`

---

### Task 1: Create App interface and typed response types in api/

**Files:**

- Create: `src/core/api/app.ts`
- Test: `tests/core/api/app.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/api/app.test.ts
import { describe, expect, it } from "vitest";

import type { App } from "../../../src/core/api/app.js";

describe("App interface", () => {
  it("should be importable as a type", () => {
    // Type-level test: App interface exists and is structurally correct
    const app = {} as App;
    expect(app).toBeDefined();
  });

  it("should have all required methods", () => {
    const app = {} as App;
    // Verify method signatures exist at type level
    expect(typeof app.semanticSearch).toBe("undefined"); // not implemented yet
    expect(typeof app.hybridSearch).toBe("undefined");
    expect(typeof app.rankChunks).toBe("undefined");
    expect(typeof app.searchCode).toBe("undefined");
    expect(typeof app.indexCodebase).toBe("undefined");
    expect(typeof app.reindexChanges).toBe("undefined");
    expect(typeof app.getIndexStatus).toBe("undefined");
    expect(typeof app.clearIndex).toBe("undefined");
    expect(typeof app.createCollection).toBe("undefined");
    expect(typeof app.listCollections).toBe("undefined");
    expect(typeof app.getCollectionInfo).toBe("undefined");
    expect(typeof app.deleteCollection).toBe("undefined");
    expect(typeof app.addDocuments).toBe("undefined");
    expect(typeof app.deleteDocuments).toBe("undefined");
    expect(typeof app.getSchemaDescriptors).toBe("undefined");
    expect(typeof app.checkSchemaDrift).toBe("undefined");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/app.test.ts` Expected: FAIL — module not
found

**Step 3: Create App interface with all method signatures and request/response
types**

```typescript
// src/core/api/app.ts
/**
 * App — unified public API for tea-rags.
 *
 * MCP layer and any external consumer imports ONLY this interface.
 * All methods accept typed request objects, return typed response objects.
 * No MCP protocol types, no Zod, no string formatting.
 */

import type {
  ChangeStats,
  IndexOptions,
  IndexStats,
  IndexStatus,
  ProgressCallback,
} from "../types.js";

// ── Search ──────────────────────────────────────────────────────────────────

export interface CollectionRef {
  collection?: string;
  path?: string;
}

export interface SemanticSearchRequest extends CollectionRef {
  query: string;
  limit?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  metaOnly?: boolean;
}

export interface HybridSearchRequest extends CollectionRef {
  query: string;
  limit?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  rerank?: string | { custom: Record<string, number> };
  metaOnly?: boolean;
}

export interface RankChunksRequest extends CollectionRef {
  rerank: string | { custom: Record<string, number> };
  level: "chunk" | "file";
  limit?: number;
  offset?: number;
  filter?: Record<string, unknown>;
  pathPattern?: string;
  metaOnly?: boolean;
}

export interface SearchCodeRequest {
  path: string;
  query: string;
  limit?: number;
  fileTypes?: string[];
  pathPattern?: string;
  documentationOnly?: boolean;
  author?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  minAgeDays?: number;
  maxAgeDays?: number;
  minCommitCount?: number;
  taskId?: string;
  rerank?: string | { custom: Record<string, number> };
}

export interface SearchResult {
  id?: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: Record<string, unknown>;
}

export interface SearchCodeResult {
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  fileExtension: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  results: SearchResult[];
  driftWarning?: string | null;
}

export interface SearchCodeResponse {
  results: SearchCodeResult[];
  driftWarning?: string | null;
}

// ── Collections ─────────────────────────────────────────────────────────────

export interface CreateCollectionRequest {
  name: string;
  distance?: "Cosine" | "Euclid" | "Dot";
  enableHybrid?: boolean;
}

export interface CollectionInfo {
  name: string;
  vectorSize?: number;
  pointsCount?: number;
  distance?: string;
  hybridEnabled?: boolean;
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface AddDocumentsRequest {
  collection: string;
  documents: Array<{
    id: string | number;
    text: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface DeleteDocumentsRequest {
  collection: string;
  ids: Array<string | number>;
}

// ── Schema descriptors (for MCP schema generation) ──────────────────────────

export interface SignalDescriptor {
  name: string;
  description: string;
}

export interface PresetDescriptors {
  presetNames: Record<string, string[]>; // tool → preset names
  signalDescriptors: SignalDescriptor[];
}

// ── App interface ───────────────────────────────────────────────────────────

export interface App {
  // Search
  semanticSearch(request: SemanticSearchRequest): Promise<SearchResponse>;
  hybridSearch(request: HybridSearchRequest): Promise<SearchResponse>;
  rankChunks(request: RankChunksRequest): Promise<SearchResponse>;
  searchCode(request: SearchCodeRequest): Promise<SearchCodeResponse>;

  // Indexing
  indexCodebase(
    path: string,
    options?: IndexOptions,
    progress?: ProgressCallback,
  ): Promise<IndexStats>;
  reindexChanges(
    path: string,
    progress?: ProgressCallback,
  ): Promise<ChangeStats>;
  getIndexStatus(path: string): Promise<IndexStatus>;
  clearIndex(path: string): Promise<void>;

  // Collections
  createCollection(request: CreateCollectionRequest): Promise<CollectionInfo>;
  listCollections(): Promise<string[]>;
  getCollectionInfo(name: string): Promise<CollectionInfo>;
  deleteCollection(name: string): Promise<void>;

  // Documents
  addDocuments(request: AddDocumentsRequest): Promise<{ count: number }>;
  deleteDocuments(request: DeleteDocumentsRequest): Promise<{ count: number }>;

  // Schema descriptors (for MCP Zod schema generation)
  getSchemaDescriptors(): PresetDescriptors;

  // Drift monitoring
  checkSchemaDrift(
    pathOrCollection: string,
    isPath: boolean,
  ): Promise<string | null>;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/app.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/api/app.ts tests/core/api/app.test.ts
git commit -m "feat(api): add App interface with typed request/response types"
```

---

### Task 2: Move search business logic from MCP to explore/ strategies

**Files:**

- Create: `src/core/explore/strategies/types.ts`
- Create: `src/core/explore/strategies/vector.ts`
- Create: `src/core/explore/strategies/hybrid.ts`
- Create: `src/core/explore/strategies/scroll-rank.ts`
- Create: `src/core/explore/strategies/factory.ts`
- Create: `src/core/explore/post-process.ts`
- Test: `tests/core/explore/strategies/factory.test.ts`
- Test: `tests/core/explore/post-process.test.ts`

**Step 1: Write the failing test for strategy factory**

```typescript
// tests/core/explore/strategies/factory.test.ts
import { describe, expect, it } from "vitest";

import { createSearchStrategy } from "../../../../src/core/explore/strategies/factory.js";

describe("createSearchStrategy", () => {
  it("should return VectorSearchStrategy for semantic search with query", () => {
    const strategy = createSearchStrategy("semantic");
    expect(strategy.type).toBe("vector");
  });

  it("should return HybridSearchStrategy for hybrid search", () => {
    const strategy = createSearchStrategy("hybrid");
    expect(strategy.type).toBe("hybrid");
  });

  it("should return ScrollRankStrategy for rank_chunks", () => {
    const strategy = createSearchStrategy("scroll-rank");
    expect(strategy.type).toBe("scroll-rank");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/explore/strategies/factory.test.ts` Expected:
FAIL — module not found

**Step 3: Create strategy types**

```typescript
// src/core/explore/strategies/types.ts
export interface SearchStrategy {
  readonly type: "vector" | "hybrid" | "scroll-rank";
  execute(ctx: SearchContext): Promise<RawResult[]>;
}

export interface SearchContext {
  collectionName: string;
  query?: string;
  embedding?: number[];
  sparseVector?: { indices: number[]; values: number[] };
  limit: number;
  filter?: Record<string, unknown>;
  weights?: Record<string, number>;
  level?: "chunk" | "file";
  presetName?: string;
}

export interface RawResult {
  id?: string | number;
  score: number;
  payload?: Record<string, unknown>;
}
```

**Step 4: Create VectorSearchStrategy**

Extracts from `search.ts` semantic_search handler:

- embed query → qdrant.search → return results

```typescript
// src/core/explore/strategies/vector.ts
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { RawResult, SearchContext, SearchStrategy } from "./types.js";

export class VectorSearchStrategy implements SearchStrategy {
  readonly type = "vector" as const;

  constructor(private readonly qdrant: QdrantManager) {}

  async execute(ctx: SearchContext): Promise<RawResult[]> {
    if (!ctx.embedding)
      throw new Error("VectorSearchStrategy requires embedding");
    return this.qdrant.search(
      ctx.collectionName,
      ctx.embedding,
      ctx.limit,
      ctx.filter,
    );
  }
}
```

**Step 5: Create HybridSearchStrategy**

Extracts from `search.ts` hybrid_search handler:

- embed + BM25 → qdrant.hybridSearch, including hybridEnabled validation

```typescript
// src/core/explore/strategies/hybrid.ts
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { BM25SparseVectorGenerator } from "../../adapters/qdrant/sparse.js";
import type { RawResult, SearchContext, SearchStrategy } from "./types.js";

export class HybridSearchStrategy implements SearchStrategy {
  readonly type = "hybrid" as const;

  constructor(private readonly qdrant: QdrantManager) {}

  async execute(ctx: SearchContext): Promise<RawResult[]> {
    if (!ctx.embedding)
      throw new Error("HybridSearchStrategy requires embedding");

    // Validate hybrid support
    const info = await this.qdrant.getCollectionInfo(ctx.collectionName);
    if (!info.hybridEnabled) {
      throw new HybridNotEnabledError(ctx.collectionName);
    }

    const sparseGenerator = new BM25SparseVectorGenerator();
    const sparseVector = sparseGenerator.generate(ctx.query ?? "");
    return this.qdrant.hybridSearch(
      ctx.collectionName,
      ctx.embedding,
      sparseVector,
      ctx.limit,
      ctx.filter,
    );
  }
}

export class HybridNotEnabledError extends Error {
  constructor(collectionName: string) {
    super(
      `Collection "${collectionName}" does not have hybrid search enabled.`,
    );
    this.name = "HybridNotEnabledError";
  }
}
```

**Step 6: Create ScrollRankStrategy**

Extracts from `search.ts` rank_chunks handler:

- preset resolution, scrollOrderedBy, RankModule scatter-gather

```typescript
// src/core/explore/strategies/scroll-rank.ts
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { scrollOrderedBy } from "../../adapters/qdrant/scroll.js";
import { RankModule } from "../rank-module.js";
import type { Reranker } from "../reranker.js";
import type { RawResult, SearchContext, SearchStrategy } from "./types.js";

export class ScrollRankStrategy implements SearchStrategy {
  readonly type = "scroll-rank" as const;
  private readonly rankModule: RankModule;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly reranker: Reranker,
  ) {
    this.rankModule = new RankModule(reranker, reranker.getDescriptors());
  }

  async execute(ctx: SearchContext): Promise<RawResult[]> {
    if (!ctx.weights) throw new Error("ScrollRankStrategy requires weights");
    if (!ctx.level) throw new Error("ScrollRankStrategy requires level");

    const scrollFn = async (
      col: string,
      orderBy: { key: string; direction: "asc" | "desc" },
      lim: number,
      f?: Record<string, unknown>,
    ) => scrollOrderedBy(this.qdrant, col, orderBy, lim, f);

    const ensureIndexFn = async (col: string, fieldName: string) => {
      const isInteger = /count|days|lines/i.test(fieldName);
      await this.qdrant.ensurePayloadIndex(
        col,
        fieldName,
        isInteger ? "integer" : "float",
      );
    };

    const effectiveFilter = excludeDocumentation(ctx.filter);

    const results = await this.rankModule.rankChunks(ctx.collectionName, {
      weights: ctx.weights,
      level: ctx.level,
      limit: ctx.limit,
      scrollFn,
      ensureIndexFn,
      filter: effectiveFilter,
      presetName: ctx.presetName,
    });

    return results as RawResult[];
  }
}

function excludeDocumentation(
  filter?: Record<string, unknown>,
): Record<string, unknown> {
  const docExclusion = { key: "isDocumentation", match: { value: true } };
  if (!filter) return { must_not: [docExclusion] };
  const existing = filter.must_not;
  const mustNot = Array.isArray(existing)
    ? [...(existing as Record<string, unknown>[]), docExclusion]
    : [docExclusion];
  return { ...filter, must_not: mustNot };
}
```

**Step 7: Create factory**

```typescript
// src/core/explore/strategies/factory.ts
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { Reranker } from "../reranker.js";
import { HybridSearchStrategy } from "./hybrid.js";
import { ScrollRankStrategy } from "./scroll-rank.js";
import type { SearchStrategy } from "./types.js";
import { VectorSearchStrategy } from "./vector.js";

export type StrategyType = "semantic" | "hybrid" | "scroll-rank";

export function createSearchStrategy(
  type: StrategyType,
  qdrant?: QdrantManager,
  reranker?: Reranker,
): SearchStrategy {
  switch (type) {
    case "semantic":
      if (!qdrant) throw new Error("VectorSearchStrategy requires qdrant");
      return new VectorSearchStrategy(qdrant);
    case "hybrid":
      if (!qdrant) throw new Error("HybridSearchStrategy requires qdrant");
      return new HybridSearchStrategy(qdrant);
    case "scroll-rank":
      if (!qdrant || !reranker)
        throw new Error("ScrollRankStrategy requires qdrant and reranker");
      return new ScrollRankStrategy(qdrant, reranker);
  }
}
```

**Step 8: Create post-process module**

Extracts from `search-pipeline.ts`: getSearchFetchLimit, applyPostProcessing,
formatSearchResults logic.

```typescript
// src/core/explore/post-process.ts
import {
  calculateFetchLimit,
  filterResultsByGlob,
} from "../adapters/qdrant/filters/index.js";
import type { RankingOverlay } from "../contracts/types/reranker.js";
import type { Reranker, RerankMode } from "./reranker.js";
import type { RawResult } from "./strategies/types.js";

export interface PostProcessOptions {
  pathPattern?: string;
  rerank?: unknown;
  limit: number;
  reranker: Reranker;
  tool?: string;
}

export function computeFetchLimit(
  requestedLimit: number | undefined,
  pathPattern?: string,
  rerank?: unknown,
): { requestedLimit: number; fetchLimit: number } {
  const limit = requestedLimit || 5;
  const needsOverfetch =
    Boolean(pathPattern) || Boolean(rerank && rerank !== "relevance");
  return {
    requestedLimit: limit,
    fetchLimit: calculateFetchLimit(limit, needsOverfetch),
  };
}

export function postProcess(
  results: RawResult[],
  options: PostProcessOptions,
): RawResult[] {
  let filtered = options.pathPattern
    ? filterResultsByGlob(results, options.pathPattern)
    : results;
  if (options.rerank && options.rerank !== "relevance") {
    filtered = options.reranker.rerank(
      filtered,
      options.rerank as RerankMode<string>,
      options.tool ?? "semantic_search",
    );
  }
  return filtered.slice(0, options.limit);
}

// ── metaOnly filtering ──────────────────────────────────────────────────────

export interface MetaOnlyOptions {
  essentialFields: string[];
  basePayloadKeys: string[];
}

export function filterMetaOnly(
  results: RawResult[],
  options: MetaOnlyOptions,
): Record<string, unknown>[] {
  return results.map((r) => {
    const meta: Record<string, unknown> = { score: r.score };

    // Copy base payload signals
    for (const key of options.basePayloadKeys) {
      if (r.payload?.[key] !== undefined) {
        meta[key] = r.payload[key];
      }
    }

    // Overlay from reranking
    const overlay = (r as RawResult & { rankingOverlay?: RankingOverlay })
      .rankingOverlay;
    const fullGit = r.payload?.git as
      | Record<string, Record<string, unknown>>
      | undefined;

    if (overlay && hasOverlayData(overlay)) {
      const gitFromOverlay = buildGitFromOverlay(overlay);
      if (Object.keys(gitFromOverlay).length > 0) meta.git = gitFromOverlay;
      if (overlay.derived && Object.keys(overlay.derived).length > 0)
        meta.derived = overlay.derived;
      meta.preset = overlay.preset;
    } else if (fullGit) {
      const filtered = filterGitByEssential(fullGit, options.essentialFields);
      if (Object.keys(filtered).length > 0) meta.git = filtered;
      if (overlay?.preset) meta.preset = overlay.preset;
    }

    return meta;
  });
}

function hasOverlayData(overlay: RankingOverlay): boolean {
  return Boolean(
    (overlay.file && Object.keys(overlay.file).length > 0) ||
    (overlay.chunk && Object.keys(overlay.chunk).length > 0) ||
    (overlay.derived && Object.keys(overlay.derived).length > 0),
  );
}

function buildGitFromOverlay(overlay: RankingOverlay): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  if (overlay.file && Object.keys(overlay.file).length > 0)
    git.file = overlay.file;
  if (overlay.chunk && Object.keys(overlay.chunk).length > 0)
    git.chunk = overlay.chunk;
  return git;
}

function filterGitByEssential(
  fullGit: Record<string, Record<string, unknown>>,
  essentialKeys: string[],
): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  for (const level of ["file", "chunk"] as const) {
    const levelData = fullGit[level];
    if (!levelData) continue;
    const filtered: Record<string, unknown> = {};
    for (const key of essentialKeys) {
      const parts = key.split(".");
      if (parts.length === 3 && parts[0] === "git" && parts[1] === level) {
        const field = parts[2];
        if (levelData[field] !== undefined) filtered[field] = levelData[field];
      }
    }
    if (Object.keys(filtered).length > 0) git[level] = filtered;
  }
  return git;
}
```

**Step 9: Run tests**

Run: `npx vitest run tests/core/explore/` Expected: PASS

**Step 10: Commit**

```bash
git add src/core/explore/strategies/ src/core/explore/post-process.ts tests/core/explore/
git commit -m "feat(explore): add search strategies + post-process module

Extract business logic from MCP search.ts and search-pipeline.ts into
explore/ domain: VectorSearchStrategy, HybridSearchStrategy,
ScrollRankStrategy + factory method, post-process with metaOnly."
```

---

### Task 3: Move collection + document business logic into api/

**Files:**

- Create: `src/core/api/collection-ops.ts`
- Create: `src/core/api/document-ops.ts`
- Test: `tests/core/api/collection-ops.test.ts`
- Test: `tests/core/api/document-ops.test.ts`

**Step 1: Write the failing test for collection ops**

```typescript
// tests/core/api/collection-ops.test.ts
import { describe, expect, it, vi } from "vitest";

import { CollectionOps } from "../../../src/core/api/collection-ops.js";

describe("CollectionOps", () => {
  const mockQdrant = {
    createCollection: vi.fn(),
    listCollections: vi.fn().mockResolvedValue(["col1", "col2"]),
    getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
    deleteCollection: vi.fn(),
  };
  const mockEmbeddings = { getDimensions: vi.fn().mockReturnValue(384) };

  it("should create collection with embedding dimensions", async () => {
    const ops = new CollectionOps(mockQdrant as any, mockEmbeddings as any);
    await ops.create({ name: "test", enableHybrid: true });
    expect(mockQdrant.createCollection).toHaveBeenCalledWith(
      "test",
      384,
      undefined,
      true,
    );
  });

  it("should list collections", async () => {
    const ops = new CollectionOps(mockQdrant as any, mockEmbeddings as any);
    const result = await ops.list();
    expect(result).toEqual(["col1", "col2"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/collection-ops.test.ts` Expected: FAIL

**Step 3: Create CollectionOps**

```typescript
// src/core/api/collection-ops.ts
import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import type { CollectionInfo, CreateCollectionRequest } from "./app.js";

export class CollectionOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async create(request: CreateCollectionRequest): Promise<CollectionInfo> {
    const vectorSize = this.embeddings.getDimensions();
    await this.qdrant.createCollection(
      request.name,
      vectorSize,
      request.distance,
      request.enableHybrid || false,
    );
    return {
      name: request.name,
      vectorSize,
      distance: request.distance || "Cosine",
      hybridEnabled: request.enableHybrid || false,
    };
  }

  async list(): Promise<string[]> {
    return this.qdrant.listCollections();
  }

  async getInfo(name: string): Promise<CollectionInfo> {
    const info = await this.qdrant.getCollectionInfo(name);
    return info as CollectionInfo;
  }

  async delete(name: string): Promise<void> {
    await this.qdrant.deleteCollection(name);
  }
}
```

**Step 4: Write failing test for document ops**

```typescript
// tests/core/api/document-ops.test.ts
import { describe, expect, it, vi } from "vitest";

import { DocumentOps } from "../../../src/core/api/document-ops.js";

describe("DocumentOps", () => {
  const mockQdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    addPoints: vi.fn(),
    deletePoints: vi.fn(),
  };
  const mockEmbeddings = {
    embedBatch: vi.fn().mockResolvedValue([{ embedding: [0.1, 0.2] }]),
  };

  it("should add documents with embeddings", async () => {
    const ops = new DocumentOps(mockQdrant as any, mockEmbeddings as any);
    const result = await ops.add({
      collection: "test",
      documents: [{ id: "1", text: "hello" }],
    });
    expect(result.count).toBe(1);
    expect(mockQdrant.addPoints).toHaveBeenCalled();
  });

  it("should throw if collection does not exist", async () => {
    const noCollQdrant = {
      ...mockQdrant,
      collectionExists: vi.fn().mockResolvedValue(false),
    };
    const ops = new DocumentOps(noCollQdrant as any, mockEmbeddings as any);
    await expect(
      ops.add({ collection: "nope", documents: [] }),
    ).rejects.toThrow();
  });
});
```

**Step 5: Create DocumentOps**

```typescript
// src/core/api/document-ops.ts
import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { BM25SparseVectorGenerator } from "../adapters/qdrant/sparse.js";
import type { AddDocumentsRequest, DeleteDocumentsRequest } from "./app.js";

export class DocumentOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async add(request: AddDocumentsRequest): Promise<{ count: number }> {
    const exists = await this.qdrant.collectionExists(request.collection);
    if (!exists) {
      throw new Error(`Collection "${request.collection}" does not exist.`);
    }

    const collectionInfo = await this.qdrant.getCollectionInfo(
      request.collection,
    );
    const texts = request.documents.map((doc) => doc.text);
    const embeddingResults = await this.embeddings.embedBatch(texts);

    if (collectionInfo.hybridEnabled) {
      const sparseGenerator = new BM25SparseVectorGenerator();
      const points = request.documents.map((doc, index) => ({
        id: doc.id,
        vector: embeddingResults[index].embedding,
        sparseVector: sparseGenerator.generate(doc.text),
        payload: { text: doc.text, ...doc.metadata },
      }));
      await this.qdrant.addPointsWithSparse(request.collection, points);
    } else {
      const points = request.documents.map((doc, index) => ({
        id: doc.id,
        vector: embeddingResults[index].embedding,
        payload: { text: doc.text, ...doc.metadata },
      }));
      await this.qdrant.addPoints(request.collection, points);
    }

    return { count: request.documents.length };
  }

  async delete(request: DeleteDocumentsRequest): Promise<{ count: number }> {
    await this.qdrant.deletePoints(request.collection, request.ids);
    return { count: request.ids.length };
  }
}
```

**Step 6: Run tests**

Run:
`npx vitest run tests/core/api/collection-ops.test.ts tests/core/api/document-ops.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/core/api/collection-ops.ts src/core/api/document-ops.ts tests/core/api/
git commit -m "feat(api): add CollectionOps and DocumentOps

Move collection CRUD and document add/delete business logic from MCP
handlers into api/ layer. Includes BM25 hybrid support in DocumentOps."
```

---

### Task 4: Move search pipeline logic into api/ — expand SearchFacade with semantic/hybrid/rank

**Files:**

- Modify: `src/core/api/explore-facade.ts`
- Test: `tests/core/api/explore-facade.test.ts`

This is the biggest task. The current `SearchFacade` only has `searchCode()`. We
need to add:

- `semanticSearch()` — uses VectorSearchStrategy + postProcess + metaOnly
- `hybridSearch()` — uses HybridSearchStrategy + postProcess + metaOnly
- `rankChunks()` — uses ScrollRankStrategy + pathPattern + offset + metaOnly

All logic currently in `mcp/tools/search.ts` and `formatters/search-pipeline.ts`
moves here.

**Step 1: Write the failing test**

```typescript
// tests/core/api/explore-facade.test.ts
import { describe, expect, it, vi } from "vitest";

// Test that SearchFacade has the new methods
describe("SearchFacade expanded API", () => {
  it("should have semanticSearch method", async () => {
    // Will import and verify the new API shape
    const { SearchFacade } =
      await import("../../../src/core/api/explore-facade.js");
    expect(SearchFacade.prototype.semanticSearch).toBeDefined();
  });

  it("should have hybridSearch method", async () => {
    const { SearchFacade } =
      await import("../../../src/core/api/explore-facade.js");
    expect(SearchFacade.prototype.hybridSearch).toBeDefined();
  });

  it("should have rankChunks method", async () => {
    const { SearchFacade } =
      await import("../../../src/core/api/explore-facade.js");
    expect(SearchFacade.prototype.rankChunks).toBeDefined();
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run tests/core/api/explore-facade.test.ts` Expected: FAIL

**Step 3: Expand SearchFacade**

Add `semanticSearch()`, `hybridSearch()`, `rankChunks()` methods that:

1. Resolve collection (path → collectionName)
2. Validate collection exists
3. Load stats if cold start
4. Compute fetch limit
5. Execute strategy
6. Post-process (glob, rerank, limit)
7. Apply metaOnly filtering if requested
8. Check drift warning
9. Return typed `SearchResponse`

Key imports from new modules:

- `explore/strategies/factory.ts` → `createSearchStrategy()`
- `explore/post-process.ts` → `computeFetchLimit()`, `postProcess()`,
  `filterMetaOnly()`
- `explore/strategies/hybrid.ts` → `HybridNotEnabledError`

Constructor gets additional params:

- `essentialTrajectoryFields: string[]`
- `basePayloadKeys: string[]`

The facade also needs to resolve presets for rank_chunks (currently in MCP
search.ts lines 159-174).

**Step 4: Run tests**

Run: `npx vitest run tests/core/api/` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/api/explore-facade.ts tests/core/api/explore-facade.test.ts
git commit -m "feat(api): expand SearchFacade with semantic/hybrid/rank methods

Move all search pipeline logic from MCP layer into SearchFacade:
collection resolution, validation, strategy execution, post-processing,
metaOnly filtering, drift warning."
```

---

### Task 5: Implement createApp() factory

**Files:**

- Create: `src/core/api/create-app.ts`
- Test: `tests/core/api/create-app.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/api/create-app.test.ts
import { describe, expect, it } from "vitest";

describe("createApp", () => {
  it("should be importable", async () => {
    const mod = await import("../../../src/core/api/create-app.js");
    expect(mod.createApp).toBeDefined();
    expect(typeof mod.createApp).toBe("function");
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run tests/core/api/create-app.test.ts` Expected: FAIL

**Step 3: Create createApp factory**

This replaces `createAppContext()` logic from `bootstrap/factory.ts` lines
46-116. The factory creates all domain objects and returns an `App`
implementation.

```typescript
// src/core/api/create-app.ts
import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../contracts/types/trajectory.js";
import type { Reranker } from "../explore/reranker.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";
import type {
  ChangeStats,
  IndexOptions,
  IndexStats,
  IndexStatus,
  ProgressCallback,
} from "../types.js";
import type {
  AddDocumentsRequest,
  App,
  CollectionInfo,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  HybridSearchRequest,
  PresetDescriptors,
  RankChunksRequest,
  SearchCodeRequest,
  SearchCodeResponse,
  SearchResponse,
  SemanticSearchRequest,
} from "./app.js";
import { CollectionOps } from "./collection-ops.js";
import { DocumentOps } from "./document-ops.js";
import { SearchFacade } from "./explore-facade.js";
import { IngestFacade } from "./ingest-facade.js";
import type { SchemaDriftMonitor } from "./schema-drift-monitor.js";
import type { StatsCache } from "./stats-cache.js";

export interface AppDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  ingest: IngestFacade;
  search: SearchFacade;
  reranker: Reranker;
  registry: TrajectoryRegistry;
  essentialTrajectoryFields: string[];
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  schemaDriftMonitor: SchemaDriftMonitor;
}

export function createApp(deps: AppDeps): App {
  const collectionOps = new CollectionOps(deps.qdrant, deps.embeddings);
  const documentOps = new DocumentOps(deps.qdrant, deps.embeddings);

  return {
    // Search — delegate to expanded SearchFacade
    semanticSearch: (req: SemanticSearchRequest) =>
      deps.search.semanticSearch(req),
    hybridSearch: (req: HybridSearchRequest) => deps.search.hybridSearch(req),
    rankChunks: (req: RankChunksRequest) => deps.search.rankChunks(req),
    searchCode: (req: SearchCodeRequest) => deps.search.searchCodeTyped(req),

    // Indexing — delegate to IngestFacade
    indexCodebase: (
      path: string,
      options?: IndexOptions,
      progress?: ProgressCallback,
    ) => deps.ingest.indexCodebase(path, options, progress),
    reindexChanges: (path: string, progress?: ProgressCallback) =>
      deps.ingest.reindexChanges(path, progress),
    getIndexStatus: (path: string) => deps.ingest.getIndexStatus(path),
    clearIndex: (path: string) => deps.ingest.clearIndex(path),

    // Collections
    createCollection: (req: CreateCollectionRequest) =>
      collectionOps.create(req),
    listCollections: () => collectionOps.list(),
    getCollectionInfo: (name: string) => collectionOps.getInfo(name),
    deleteCollection: (name: string) => collectionOps.delete(name),

    // Documents
    addDocuments: (req: AddDocumentsRequest) => documentOps.add(req),
    deleteDocuments: (req: DeleteDocumentsRequest) => documentOps.delete(req),

    // Schema descriptors
    getSchemaDescriptors: (): PresetDescriptors => {
      const info = deps.reranker.getDescriptorInfo();
      const tools = [
        "semantic_search",
        "hybrid_search",
        "search_code",
        "rank_chunks",
      ];
      const presetNames: Record<string, string[]> = {};
      for (const tool of tools) {
        presetNames[tool] = deps.reranker.getPresetNames(tool);
      }
      return {
        presetNames,
        signalDescriptors: info.map((d) => ({
          name: d.name,
          description: d.description,
        })),
      };
    },

    // Drift
    checkSchemaDrift: async (ref: string, isPath: boolean) => {
      if (isPath) return deps.schemaDriftMonitor.checkAndConsume(ref);
      return deps.schemaDriftMonitor.checkByCollectionName(ref);
    },
  };
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/core/api/create-app.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/api/create-app.ts tests/core/api/create-app.test.ts
git commit -m "feat(api): add createApp() factory returning unified App

Single entry point for external consumers. Composes CollectionOps,
DocumentOps, SearchFacade, IngestFacade into App interface."
```

---

### Task 6: Rewire bootstrap/factory.ts to use createApp()

**Files:**

- Modify: `src/bootstrap/factory.ts`
- Modify: `src/mcp/tools/index.ts`

**Step 1: Modify factory.ts**

Replace `createAppContext()` to call `createApp()` from api/ and return `App`
instead of `AppContext`.

```typescript
// The new AppContext becomes thin:
export interface AppContext {
  app: App;
  schemaBuilder: SchemaBuilder;
  embeddedRelease?: () => void;
}
```

`createAppContext()` still:

- Resolves Qdrant URL
- Creates QdrantManager, EmbeddingProvider
- Creates composition (registry, reranker, etc.)
- Creates IngestFacade, SearchFacade
- But then calls `createApp(deps)` and returns
  `{ app, schemaBuilder, embeddedRelease }`

**Step 2: Update ToolDependencies in mcp/tools/index.ts**

```typescript
export interface ToolDependencies {
  app: App;
  schemaBuilder: SchemaBuilder;
}
```

**Step 3: Run build**

Run: `npx tsc --noEmit` Expected: Many type errors in MCP handlers (they still
reference old deps) — this is expected, they get fixed in Task 7.

**Step 4: Commit** (intermediate — will break MCP handlers temporarily)

```bash
git add src/bootstrap/factory.ts src/mcp/tools/index.ts
git commit -m "refactor(bootstrap): use createApp() and slim ToolDependencies

AppContext now contains App + SchemaBuilder. ToolDependencies reduced
from 8 fields to 2. MCP handlers will be updated in next task."
```

---

### Task 7: Rewrite MCP handlers as thin wrappers

**Files:**

- Modify: `src/mcp/tools/search.ts` → rename to `src/mcp/tools/explore.ts`
- Modify: `src/mcp/tools/collection.ts`
- Modify: `src/mcp/tools/document.ts`
- Modify: `src/mcp/tools/code.ts`
- Modify: `src/mcp/tools/index.ts`
- Create: `src/mcp/format.ts`
- Delete: `src/mcp/tools/formatters/search-pipeline.ts` (logic moved to api/ +
  explore/)
- Modify: `src/mcp/resources/index.ts`

This is the core transformation. Each MCP handler becomes:

```typescript
async (params) => {
  const result = await app.method(params);
  return formatMcpResponse(result);
};
```

**Step 1: Create shared MCP formatter**

```typescript
// src/mcp/format.ts
export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function formatMcpResponse(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function formatMcpText(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

export function formatMcpError(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function appendDriftWarning(
  result: McpToolResult,
  warning: string | null,
): McpToolResult {
  if (!warning || result.content.length === 0) return result;
  const last = result.content[result.content.length - 1];
  last.text += `\n\n${warning}`;
  return result;
}
```

**Step 2: Rewrite explore.ts (renamed from search.ts)**

```typescript
// src/mcp/tools/explore.ts
server.registerTool("semantic_search", { inputSchema: ... }, async (params) => {
  try {
    const response = await app.semanticSearch(params);
    const result = formatMcpResponse(response.results);
    return appendDriftWarning(result, response.driftWarning ?? null);
  } catch (error) {
    return formatMcpError(error instanceof Error ? error.message : String(error));
  }
});
```

Same pattern for `hybrid_search` and `rank_chunks`.

**Step 3: Rewrite collection.ts**

```typescript
server.registerTool(
  "create_collection",
  { inputSchema },
  async ({ name, distance, enableHybrid }) => {
    const info = await app.createCollection({ name, distance, enableHybrid });
    return formatMcpText(
      `Collection "${info.name}" created with ${info.vectorSize} dimensions.`,
    );
  },
);
```

**Step 4: Rewrite document.ts**

```typescript
server.registerTool(
  "add_documents",
  { inputSchema },
  async ({ collection, documents }) => {
    try {
      const result = await app.addDocuments({ collection, documents });
      return formatMcpText(
        `Added ${result.count} document(s) to "${collection}".`,
      );
    } catch (error) {
      return formatMcpError(
        error instanceof Error ? error.message : String(error),
      );
    }
  },
);
```

**Step 5: Rewrite code.ts**

`search_code`, `index_codebase`, `reindex_changes`, `get_index_status`,
`clear_index` — all delegate to `app.*`.

For `search_code`, the current formatting logic (human-readable results) stays
in MCP since it's presentation:

```typescript
const response = await app.searchCode(params);
if (response.results.length === 0)
  return formatMcpText(`No results for "${params.query}"`);
const text = formatCodeSearchResults(response.results); // local formatter
return appendDriftWarning(formatMcpText(text), response.driftWarning ?? null);
```

**Step 6: Update mcp/tools/index.ts**

All register functions now take `(server, app, schemaBuilder)` instead of
separate deps.

**Step 7: Update resources/index.ts**

Resources still need qdrant directly for collection listing. Two options:

- A) App gets `listCollections()` + `getCollectionInfo()` — already done in Task
  3
- B) Resources call `app.listCollections()` and `app.getCollectionInfo()`

Go with B:

```typescript
export function registerAllResources(server: McpServer, app: App): void {
  server.registerResource("collections", "qdrant://collections", { ... }, async (uri) => {
    const collections = await app.listCollections();
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(collections, null, 2) }] };
  });
  // ... same for collection-info
}
```

**Step 8: Delete search-pipeline.ts**

All logic moved to `explore/post-process.ts` and `api/explore-facade.ts`.

**Step 9: Run build + tests**

Run: `npx tsc --noEmit && npx vitest run` Expected: PASS

**Step 10: Commit**

```bash
git add src/mcp/ src/bootstrap/factory.ts
git rm src/mcp/tools/formatters/search-pipeline.ts
git commit -m "refactor(mcp): thin MCP handlers, all logic in api/

MCP handlers reduced to schema → app.method() → formatMcpResponse().
Renamed search.ts → explore.ts. Deleted search-pipeline.ts (moved to
explore/post-process.ts). Resources use App interface.
ToolDependencies: { app, schemaBuilder }."
```

---

### Task 8: Move Zod schema generation — api/ returns descriptors, MCP builds Zod

**Files:**

- Modify: `src/core/api/schema-builder.ts` → remove Zod, return plain
  descriptors
- Modify: `src/mcp/tools/schemas.ts` → build Zod from descriptors
- Test: `tests/core/api/schema-builder.test.ts`

**Step 1: Refactor SchemaBuilder to return plain descriptors**

Current `SchemaBuilder` imports Zod and returns `z.ZodObject`. This violates the
principle: api/ should not know about MCP protocol (Zod is MCP schema
technology).

New SchemaBuilder:

```typescript
// src/core/api/schema-builder.ts
export interface SignalDescriptorInfo {
  name: string;
  description: string;
}

export class SchemaBuilder {
  constructor(private readonly reranker: Reranker) {}

  /** Get all derived signal descriptors (name + description) */
  getSignalDescriptors(): SignalDescriptorInfo[] {
    return this.reranker.getDescriptorInfo();
  }

  /** Get preset names for a specific tool */
  getPresetNames(tool: string): string[] {
    return this.reranker.getPresetNames(tool);
  }
}
```

**Step 2: Move Zod schema building to MCP schemas.ts**

`createSearchSchemas()` now takes `SchemaBuilder` and builds Zod from plain
descriptors:

```typescript
export function createSearchSchemas(schemaBuilder: SchemaBuilder) {
  const signalDescriptors = schemaBuilder.getSignalDescriptors();
  const weightsShape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
  for (const d of signalDescriptors) {
    weightsShape[d.name] = z.number().optional().describe(d.description);
  }
  const weightsSchema = z.object(weightsShape);

  function buildRerankSchema(tool: string) {
    const names = schemaBuilder.getPresetNames(tool);
    const presetSchema = z.enum(names as [string, ...string[]]);
    return z.union([presetSchema, z.object({ custom: weightsSchema })]);
  }

  // ... build all schemas using buildRerankSchema()
}
```

**Step 3: Run tests**

Run: `npx tsc --noEmit && npx vitest run` Expected: PASS

**Step 4: Commit**

```bash
git add src/core/api/schema-builder.ts src/mcp/tools/schemas.ts tests/
git commit -m "refactor(api): SchemaBuilder returns plain descriptors, not Zod

api/ no longer depends on Zod. SchemaBuilder exports signal names +
descriptions. MCP schemas.ts builds Zod schemas from descriptors."
```

---

### Task 9: Final cleanup and import audit

**Files:**

- All MCP files — verify imports only from api/ + types
- Remove dead code
- Update barrel exports

**Step 1: Run import audit**

```bash
# Check that no MCP file imports from explore/, ingest/, trajectory/, contracts/, adapters/
grep -r "from.*core/explore" src/mcp/
grep -r "from.*core/ingest" src/mcp/
grep -r "from.*core/trajectory" src/mcp/
grep -r "from.*core/contracts" src/mcp/
grep -r "from.*core/adapters" src/mcp/
```

Expected: No results (zero violations).

**Step 2: Check MCP imports are only from api/**

```bash
grep -r "from.*core/" src/mcp/ | grep -v "core/api/"
```

Expected: No results. MCP may import from `core/types.ts` for shared type
definitions — that's acceptable as long as they're pure types.

**Step 3: Remove dead code**

- `formatters/search-pipeline.ts` — deleted in Task 7
- Old `SearchToolDependencies`, `CollectionToolDependencies`,
  `DocumentToolDependencies`, `CodeToolDependencies` interfaces — replaced by
  `{ app: App; schemaBuilder: SchemaBuilder }`
- `appendDriftWarning` in search.ts — moved to `mcp/format.ts`
- `excludeDocumentation` in search.ts — moved to
  explore/strategies/scroll-rank.ts

**Step 4: Verify everything builds and tests pass**

Run: `npx tsc --noEmit && npx vitest run` Expected: All green

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor(mcp): final cleanup — MCP imports only from api/

Remove dead code, verify import boundaries, update barrel exports.
MCP layer is now a thin schema → App → format mapping."
```

---

### Task 10: Update CLAUDE.md and documentation

**Files:**

- Modify: `.claude/CLAUDE.md` — update project structure section
- Modify: `docs/plans/2026-03-11-thin-mcp-layer-design.md` — mark as implemented

**Step 1: Update CLAUDE.md project structure**

Add to api/ section:

```
api/
  app.ts                               # App interface + request/response types
  create-app.ts                        # createApp() factory — builds App from deps
  collection-ops.ts                    # CollectionOps: CRUD via qdrant
  document-ops.ts                      # DocumentOps: add/delete with embeddings
  explore-facade.ts                    # SearchFacade: semantic/hybrid/rank/searchCode
  ingest-facade.ts                     # IngestFacade (unchanged)
  schema-builder.ts                    # SchemaBuilder: plain descriptors (no Zod)
```

Add to explore/ section:

```
explore/
  strategies/
    types.ts                           # SearchStrategy, SearchContext, RawResult
    vector.ts                          # VectorSearchStrategy
    hybrid.ts                          # HybridSearchStrategy
    scroll-rank.ts                     # ScrollRankStrategy + excludeDocumentation
    factory.ts                         # createSearchStrategy()
  post-process.ts                      # computeFetchLimit, postProcess, filterMetaOnly
```

Update MCP section to reflect thin handlers:

```
mcp/
  format.ts                            # formatMcpResponse, formatMcpText, formatMcpError
  tools/
    explore.ts                         # semantic_search, hybrid_search, rank_chunks (thin)
    collection.ts                      # create, list, info, delete (thin)
    document.ts                        # add, delete (thin)
    code.ts                            # index_codebase, search_code, reindex_changes, etc. (thin)
    schemas.ts                         # Zod schemas, reads descriptors from SchemaBuilder
    index.ts                           # ToolDependencies = { app, schemaBuilder }
  resources/
    index.ts                           # uses App for collection resources
```

**Step 2: Commit**

```bash
git add .claude/CLAUDE.md docs/plans/
git commit -m "docs(api): update CLAUDE.md for thin MCP layer architecture"
```

---

## Task Dependency Graph

```
Task 1 (App interface)
  ↓
Task 2 (explore strategies + post-process)
  ↓
Task 3 (collection + document ops) ← independent of Task 2, but logically after Task 1
  ↓
Task 4 (expand SearchFacade) ← depends on Task 2
  ↓
Task 5 (createApp factory) ← depends on Tasks 3 + 4
  ↓
Task 6 (rewire bootstrap) ← depends on Task 5
  ↓
Task 7 (thin MCP handlers) ← depends on Task 6
  ↓
Task 8 (SchemaBuilder Zod split) ← can run in parallel with Task 7
  ↓
Task 9 (cleanup + audit) ← depends on Tasks 7 + 8
  ↓
Task 10 (docs) ← depends on Task 9
```

**Parallelizable pairs:** Tasks 2+3 (independent domains), Tasks 7+8 (different
concerns).

**Critical path:** 1 → 2 → 4 → 5 → 6 → 7 → 9 → 10
