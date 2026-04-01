# Ollama Model Info Auto-Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect embedding model's context length and dimensions from
Ollama `/api/show` API, store in collection marker, use to cap chunk size and
set vector dimensions.

**Architecture:** `OllamaEmbeddings.resolveModelInfo()` queries Ollama once per
operation. Result stored in indexing marker for reuse. `IngestFacade` calls it
before pipeline start, computes effective `chunkSize` capped by model context,
passes override to pipeline.

**Tech Stack:** Ollama REST API (`/api/show`), Qdrant payload (indexing marker)

**Spec:** `docs/superpowers/specs/2026-04-01-ollama-model-info-design.md`

---

### Task 1: OllamaModelInfo type and resolveModelInfo() method

**Files:**

- Create: `src/core/adapters/embeddings/ollama/model-info.ts`
- Modify: `src/core/adapters/embeddings/ollama.ts:100-134` (constructor —
  dimensions fallback)
- Modify: `src/core/adapters/embeddings/base.ts:12-23` (EmbeddingProvider
  interface)
- Test: `tests/core/adapters/embeddings/ollama.test.ts`

- [ ] **Step 1: Write failing tests for resolveModelInfo()**

```typescript
// tests/core/adapters/embeddings/ollama.test.ts — new describe block

describe("resolveModelInfo", () => {
  const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

  it("should return model info from /api/show", async () => {
    const provider = new OllamaEmbeddings(
      "nomic-embed-text",
      undefined,
      undefined,
      "http://primary:11434",
      true,
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {
          "nomic-bert.context_length": 2048,
          "nomic-bert.embedding_length": 768,
        },
      }),
    });

    const info = await provider.resolveModelInfo();

    expect(info).toEqual({
      model: "nomic-embed-text",
      contextLength: 2048,
      dimensions: 768,
    });
    const url = mockFetch.mock.calls[
      mockFetch.mock.calls.length - 1
    ][0] as string;
    expect(url).toBe("http://primary:11434/api/show");
  });

  it("should return undefined when /api/show fails", async () => {
    const provider = new OllamaEmbeddings(
      "nomic-embed-text",
      undefined,
      undefined,
      "http://primary:11434",
      true,
    );

    mockFetch.mockRejectedValueOnce(new Error("connection refused"));

    const info = await provider.resolveModelInfo();
    expect(info).toBeUndefined();
  });

  it("should return undefined when model_info has no context_length", async () => {
    const provider = new OllamaEmbeddings(
      "nomic-embed-text",
      undefined,
      undefined,
      "http://primary:11434",
      true,
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model_info: {} }),
    });

    const info = await provider.resolveModelInfo();
    expect(info).toBeUndefined();
  });

  it("should cache result on second call", async () => {
    const provider = new OllamaEmbeddings(
      "nomic-embed-text",
      undefined,
      undefined,
      "http://primary:11434",
      true,
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {
          "jina-bert-v2.context_length": 8192,
          "jina-bert-v2.embedding_length": 768,
        },
      }),
    });

    const first = await provider.resolveModelInfo();
    const second = await provider.resolveModelInfo();

    expect(first).toEqual(second);
    // Only one /api/show call (not counting constructor health check)
    const showCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("/api/show"),
    );
    expect(showCalls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/adapters/embeddings/ollama.test.ts` Expected:
FAIL — `resolveModelInfo` is not a function

- [ ] **Step 3: Create model-info.ts with types and parser**

```typescript
// src/core/adapters/embeddings/ollama/model-info.ts

export interface OllamaModelInfo {
  model: string;
  contextLength: number;
  dimensions: number;
}

/**
 * Parse /api/show response into OllamaModelInfo.
 * Keys in model_info are prefixed with architecture name (e.g., "nomic-bert.context_length").
 * We scan all keys for the first match.
 */
export function parseModelInfo(
  model: string,
  modelInfo: Record<string, unknown>,
): OllamaModelInfo | undefined {
  let contextLength: number | undefined;
  let dimensions: number | undefined;

  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      contextLength = value;
    }
    if (key.endsWith(".embedding_length") && typeof value === "number") {
      dimensions = value;
    }
  }

  if (contextLength === undefined || dimensions === undefined) return undefined;

  return { model, contextLength, dimensions };
}
```

- [ ] **Step 4: Add resolveModelInfo() to OllamaEmbeddings**

In `src/core/adapters/embeddings/ollama.ts`:

Add import:

```typescript
import { parseModelInfo, type OllamaModelInfo } from "./ollama/model-info.js";
```

Add field after `private readonly primaryFailedAt = 0;`:

```typescript
private cachedModelInfo?: OllamaModelInfo;
```

Add method:

```typescript
async resolveModelInfo(): Promise<OllamaModelInfo | undefined> {
    if (this.cachedModelInfo) return this.cachedModelInfo;

    const url = this.resolveActiveUrl();
    try {
      const response = await fetchWithTimeout(
        `${url}/api/show`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: this.model }),
        },
        HEALTH_PROBE_TIMEOUT_MS * 5,
      );
      if (!response.ok) return undefined;

      const data = (await response.json()) as { model_info?: Record<string, unknown> };
      if (!data.model_info) return undefined;

      const info = parseModelInfo(this.model, data.model_info);
      if (info) this.cachedModelInfo = info;
      return info;
    } catch {
      return undefined;
    }
  }
```

- [ ] **Step 5: Add optional resolveModelInfo to EmbeddingProvider interface**

In `src/core/adapters/embeddings/base.ts`, add to interface:

```typescript
resolveModelInfo?: () => Promise<{ model: string; contextLength: number; dimensions: number } | undefined>;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/core/adapters/embeddings/ollama.test.ts` Expected:
PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/adapters/embeddings/ollama/model-info.ts \
  src/core/adapters/embeddings/ollama.ts \
  src/core/adapters/embeddings/base.ts \
  tests/core/adapters/embeddings/ollama.test.ts
git commit -m "feat(adapters): add OllamaEmbeddings.resolveModelInfo() via /api/show"
```

---

### Task 2: Store modelInfo in indexing marker

**Files:**

- Modify: `src/core/domains/ingest/pipeline/indexing-marker-codec.ts:9-48`
- Modify: `src/core/domains/ingest/pipeline/indexing-marker.ts:18-83`
- Test: `tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts`

- [ ] **Step 1: Write failing tests for marker codec**

```typescript
// tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts — add to existing

describe("modelInfo field", () => {
  it("should parse modelInfo from raw payload", () => {
    const raw = {
      indexingComplete: true,
      embeddingModel: "nomic-embed-text",
      modelInfo: {
        model: "nomic-embed-text",
        contextLength: 2048,
        dimensions: 768,
      },
    };

    const parsed = parseMarkerPayload(raw);
    expect(parsed.modelInfo).toEqual({
      model: "nomic-embed-text",
      contextLength: 2048,
      dimensions: 768,
    });
  });

  it("should return undefined modelInfo when absent", () => {
    const raw = { indexingComplete: true };
    const parsed = parseMarkerPayload(raw);
    expect(parsed.modelInfo).toBeUndefined();
  });

  it("should serialize modelInfo", () => {
    const marker: IndexingMarkerPayload = {
      indexingComplete: true,
      modelInfo: {
        model: "nomic-embed-text",
        contextLength: 2048,
        dimensions: 768,
      },
    };

    const serialized = serializeMarkerPayload(marker);
    expect(serialized.modelInfo).toEqual({
      model: "nomic-embed-text",
      contextLength: 2048,
      dimensions: 768,
    });
  });

  it("should omit modelInfo when undefined", () => {
    const marker: IndexingMarkerPayload = {
      indexingComplete: true,
    };

    const serialized = serializeMarkerPayload(marker);
    expect("modelInfo" in serialized).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts`
Expected: FAIL — modelInfo not in type / not parsed

- [ ] **Step 3: Add modelInfo to IndexingMarkerPayload and codec**

In `src/core/domains/ingest/pipeline/indexing-marker-codec.ts`:

Add to `IndexingMarkerPayload`:

```typescript
modelInfo?: {
  model: string;
  contextLength: number;
  dimensions: number;
};
```

Add to `parseMarkerPayload()`:

```typescript
modelInfo: parseModelInfoField(raw.modelInfo),
```

Add helper:

```typescript
function parseModelInfoField(
  value: unknown,
): { model: string; contextLength: number; dimensions: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.model !== "string" ||
    typeof obj.contextLength !== "number" ||
    typeof obj.dimensions !== "number"
  ) {
    return undefined;
  }
  return {
    model: obj.model,
    contextLength: obj.contextLength,
    dimensions: obj.dimensions,
  };
}
```

Add to `serializeMarkerPayload()`:

```typescript
if (marker.modelInfo !== undefined) result.modelInfo = marker.modelInfo;
```

- [ ] **Step 4: Update storeIndexingMarker to include modelInfo**

In `src/core/domains/ingest/pipeline/indexing-marker.ts`, at the start marker
payload construction (line ~59), add `modelInfo` from a new parameter. The
function signature gains an optional `modelInfo` parameter:

```typescript
// In the start marker payload (complete=false):
...(modelInfo && { modelInfo }),
```

The caller (BaseIndexingPipeline or IngestFacade) will pass modelInfo when
available.

- [ ] **Step 5: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/indexing-marker-codec.ts \
  src/core/domains/ingest/pipeline/indexing-marker.ts \
  tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts
git commit -m "feat(pipeline): add modelInfo field to indexing marker codec"
```

---

### Task 3: Resolve modelInfo and cap chunkSize in IngestFacade

**Files:**

- Modify: `src/core/api/internal/facades/ingest-facade.ts:123-181`
- Modify: `src/core/domains/ingest/pipeline/base.ts:165-171`
  (BaseIndexingPipeline.createChunkerPool — accept override)
- Modify: `src/core/types.ts` (IngestCodeConfig — optional `chunkSizeOverride`)
- Test: `tests/core/api/internal/facades/ingest-facade.test.ts`

- [ ] **Step 1: Write failing test for chunkSize capping**

```typescript
// tests/core/api/internal/facades/ingest-facade.test.ts — new describe block

describe("model info chunkSize capping", () => {
  it("should cap chunkSize when it exceeds model context limit", async () => {
    // Setup: embeddings with resolveModelInfo returning small context
    const mockEmbeddings = {
      ...baseEmbeddings,
      resolveModelInfo: vi.fn().mockResolvedValue({
        model: "nomic-embed-text",
        contextLength: 2048, // 2048 * 3 = 6144 max chars
        dimensions: 768,
      }),
    };

    // Create facade with chunkSize=10000 (exceeds 6144)
    const facade = createFacadeWith({
      embeddings: mockEmbeddings,
      chunkSize: 10000,
    });

    // indexCodebase should cap chunkSize internally
    await facade.indexCodebase("/test/path");

    // Verify resolveModelInfo was called
    expect(mockEmbeddings.resolveModelInfo).toHaveBeenCalled();
  });
});
```

Note: Exact test setup depends on existing test helpers in the facade test file.
Adapt `createFacadeWith` and assertions to match the project's patterns.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/internal/facades/ingest-facade.test.ts`
Expected: FAIL

- [ ] **Step 3: Add chunkSize capping logic to IngestFacade**

In `src/core/api/internal/facades/ingest-facade.ts`, add private method:

```typescript
/** Tokens-to-chars ratio (conservative for code) */
private static readonly CHARS_PER_TOKEN = 3;
/** Safety margin for breadcrumbs/overlap */
private static readonly CONTEXT_SAFETY_FACTOR = 0.8;

private async resolveEffectiveChunkSize(): Promise<number> {
  const modelInfo = await this.embeddings.resolveModelInfo?.();
  if (!modelInfo) return this.config.chunkSize;

  const maxAllowed = modelInfo.contextLength * IngestFacade.CHARS_PER_TOKEN;
  const defaultChunkSize = Math.floor(
    maxAllowed * IngestFacade.CONTEXT_SAFETY_FACTOR,
  );

  // User didn't set INGEST_CHUNK_SIZE → use model-derived default
  if (!this.config.userSetChunkSize) return defaultChunkSize;

  // User set it but it exceeds model limit → cap silently
  if (this.config.chunkSize > maxAllowed) return maxAllowed;

  return this.config.chunkSize;
}
```

Call it at the start of `indexCodebase()` and pass the result to the pipeline.

- [ ] **Step 4: Accept chunkSize override in BaseIndexingPipeline**

In `src/core/domains/ingest/pipeline/base.ts`, modify
`BaseIndexingPipeline.createChunkerPool()` to accept an optional override:

```typescript
private createChunkerPool(chunkSizeOverride?: number): ChunkerPool {
  const chunkSize = chunkSizeOverride ?? this.config.chunkSize;
  return new ChunkerPool(this.tuning.chunkerPoolSize, {
    chunkSize,
    chunkOverlap: this.config.chunkOverlap,
    maxChunkSize: chunkSize * 2,
  });
}
```

Thread `chunkSizeOverride` from `indexCodebase()` down to `createChunkerPool()`.

- [ ] **Step 5: Track userSetChunkSize flag**

In `src/bootstrap/config/app-config.ts`, the `flags.userSetBatchSize` pattern
already exists. Add `flags.userSetChunkSize`:

```typescript
userSetChunkSize: zodConfig.ingest.chunkSize !== defaultChunkSize,
```

Pass through `IngestCodeConfig` → `IngestFacade`.

- [ ] **Step 6: Pass modelInfo to indexing marker**

In `IngestFacade.indexCodebase()`, after resolving model info, pass it to the
pipeline so the start marker includes `modelInfo`:

```typescript
const modelInfo = await this.embeddings.resolveModelInfo?.();
// ... pass to indexing pipeline for marker storage
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/api/internal/facades/ingest-facade.ts \
  src/core/domains/ingest/pipeline/base.ts \
  src/core/types.ts \
  src/bootstrap/config/app-config.ts \
  tests/core/api/internal/facades/ingest-facade.test.ts
git commit -m "feat(ingest): cap chunkSize by model contextLength from Ollama"
```

---

### Task 4: Auto-detect dimensions from modelInfo

**Files:**

- Modify: `src/core/adapters/embeddings/ollama.ts:116` (constructor dimensions
  line)
- Modify: `src/core/api/internal/facades/ingest-facade.ts` (use dimensions from
  modelInfo for collection creation)
- Test: `tests/core/adapters/embeddings/ollama.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe("dimensions from resolveModelInfo", () => {
  it("should use resolved dimensions over static lookup", async () => {
    // Create with unknown model — static lookup returns undefined, fallback = 768
    const provider = new OllamaEmbeddings(
      "custom-model",
      undefined,
      undefined,
      "http://primary:11434",
      true,
    );
    expect(provider.getDimensions()).toBe(768); // fallback before resolution

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {
          "custom.context_length": 4096,
          "custom.embedding_length": 1024,
        },
      }),
    });

    const info = await provider.resolveModelInfo();
    expect(info?.dimensions).toBe(1024);
  });
});
```

- [ ] **Step 2: Use modelInfo dimensions in collection creation**

In `IngestFacade`, when creating a new collection, if `modelInfo.dimensions` is
available, use it instead of `embeddings.getDimensions()`:

```typescript
const dimensions = modelInfo?.dimensions ?? this.embeddings.getDimensions();
```

This only affects new collection creation. Existing collections already have
vectors of the right size.

- [ ] **Step 3: Run tests**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/adapters/embeddings/ollama.ts \
  src/core/api/internal/facades/ingest-facade.ts \
  tests/core/adapters/embeddings/ollama.test.ts
git commit -m "feat(adapters): use Ollama-reported dimensions for collection creation"
```

---

### Task 5: Read modelInfo from existing marker on re-index

**Files:**

- Modify: `src/core/api/internal/facades/ingest-facade.ts`
- Test: `tests/core/api/internal/facades/ingest-facade.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it("should read modelInfo from existing marker instead of querying Ollama", async () => {
  // Setup: marker has modelInfo, resolveModelInfo should NOT be called
  const mockEmbeddings = {
    ...baseEmbeddings,
    resolveModelInfo: vi.fn(),
  };

  // Mock existing marker with modelInfo
  // ... (setup existing collection with marker containing modelInfo)

  await facade.indexCodebase("/test/path"); // re-index path

  // resolveModelInfo was NOT called — used marker instead
  expect(mockEmbeddings.resolveModelInfo).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement marker-first resolution**

In `IngestFacade.resolveEffectiveChunkSize()`, check marker first:

```typescript
private async resolveModelInfoFromMarkerOrOllama(
  collectionName?: string,
): Promise<{ model: string; contextLength: number; dimensions: number } | undefined> {
  // 1. Try existing marker
  if (collectionName) {
    const marker = await this.readMarker(collectionName);
    if (marker?.modelInfo) return marker.modelInfo;
  }

  // 2. Fallback: query Ollama
  return this.embeddings.resolveModelInfo?.();
}
```

- [ ] **Step 3: Backfill modelInfo for legacy collections**

When marker exists but has no `modelInfo`, query Ollama and update the marker:

```typescript
if (marker && !marker.modelInfo && modelInfo) {
  await this.updateMarkerModelInfo(collectionName, modelInfo);
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/facades/ingest-facade.ts \
  tests/core/api/internal/facades/ingest-facade.test.ts
git commit -m "feat(ingest): read modelInfo from marker, backfill legacy collections"
```
