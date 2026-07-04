# ONNX Embedding Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Add built-in ONNX embedding provider that works without Ollama or API
keys.

**Architecture:** New `OnnxEmbeddings` class implementing existing
`EmbeddingProvider` interface. Uses `@huggingface/transformers` as optional
dependency with lazy loading. No changes to pipeline or other providers.

**Tech Stack:** `@huggingface/transformers` (optional dep), `onnxruntime-node`
(transitive), `jina-embeddings-v2-base-code` (q8, ~70MB auto-download)

---

### Task 1: Add optional dependency

**Files:**

- Modify: `package.json`

**Step 1: Add @huggingface/transformers as optional dependency**

In `package.json`, add to `optionalDependencies` (NOT `dependencies`):

```json
{
  "optionalDependencies": {
    "@huggingface/transformers": "^3.0.0"
  }
}
```

**Step 2: Install**

Run: `npm install` Expected: Package installs successfully, appears in
node_modules.

**Step 3: Commit**

```
chore(deps): add @huggingface/transformers as optional dependency
```

---

### Task 2: Add "onnx" to config schema

**Files:**

- Modify: `src/bootstrap/config/schemas.ts:38`
- Modify: `src/bootstrap/config/parse.ts:127-141`
- Test: `tests/bootstrap/config/` (existing tests should still pass)

**Step 1: Write failing test**

Create `tests/core/adapters/embeddings/onnx.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { OnnxEmbeddings } from "../../../../src/core/adapters/embeddings/onnx.js";

describe("OnnxEmbeddings", () => {
  describe("constructor", () => {
    it("should use default model and dimensions", () => {
      const provider = new OnnxEmbeddings();
      expect(provider.getModel()).toBe("Xenova/jina-embeddings-v2-base-code");
      expect(provider.getDimensions()).toBe(768);
    });

    it("should accept custom model", () => {
      const provider = new OnnxEmbeddings("Xenova/all-MiniLM-L6-v2", 384);
      expect(provider.getModel()).toBe("Xenova/all-MiniLM-L6-v2");
      expect(provider.getDimensions()).toBe(384);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: FAIL
— module `onnx.js` not found.

**Step 3: Add "onnx" to schema enum**

In `src/bootstrap/config/schemas.ts:38`, change:

```typescript
provider: z.enum(["ollama", "openai", "cohere", "voyage", "onnx"]).default("ollama"),
```

**Step 4: Update API key validation in parse.ts**

In `src/bootstrap/config/parse.ts:127`, the API key validation block skips
`ollama`. Add `onnx` to the skip list:

```typescript
if (embedding.provider !== "ollama" && embedding.provider !== "onnx") {
```

**Step 5: Verify existing config tests pass**

Run: `npx vitest run tests/bootstrap/` Expected: All PASS — "onnx" is just a new
enum value, defaults unchanged.

**Step 6: Commit**

```
feat(config): add "onnx" to embedding provider enum
```

---

### Task 3: Implement OnnxEmbeddings class

**Files:**

- Create: `src/core/adapters/embeddings/onnx.ts`
- Test: `tests/core/adapters/embeddings/onnx.test.ts`

**Step 1: Write failing tests for embed and embedBatch**

Add to `tests/core/adapters/embeddings/onnx.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnnxEmbeddings } from "../../../../src/core/adapters/embeddings/onnx.js";

// Mock the dynamic import of @huggingface/transformers
const mockExtractor = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(mockExtractor),
}));

describe("OnnxEmbeddings", () => {
  let provider: OnnxEmbeddings;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OnnxEmbeddings();
  });

  describe("constructor", () => {
    it("should use default model and dimensions", () => {
      expect(provider.getModel()).toBe("Xenova/jina-embeddings-v2-base-code");
      expect(provider.getDimensions()).toBe(768);
    });

    it("should accept custom model and dimensions", () => {
      const custom = new OnnxEmbeddings("Xenova/all-MiniLM-L6-v2", 384);
      expect(custom.getModel()).toBe("Xenova/all-MiniLM-L6-v2");
      expect(custom.getDimensions()).toBe(384);
    });
  });

  describe("embed", () => {
    it("should return embedding result for single text", async () => {
      const fakeEmbedding = new Float32Array(768).fill(0.1);
      mockExtractor.mockResolvedValue({
        tolist: () => [[...fakeEmbedding]],
      });

      const result = await provider.embed("function hello() {}");

      expect(result.embedding).toHaveLength(768);
      expect(result.dimensions).toBe(768);
      expect(mockExtractor).toHaveBeenCalledWith(["function hello() {}"], {
        pooling: "mean",
        normalize: true,
      });
    });

    it("should lazy-load pipeline on first call", async () => {
      const fakeEmbedding = new Float32Array(768).fill(0.1);
      mockExtractor.mockResolvedValue({
        tolist: () => [[...fakeEmbedding]],
      });

      const { pipeline } = await import("@huggingface/transformers");

      await provider.embed("test");
      await provider.embed("test2");

      // pipeline() called only once (lazy init)
      expect(pipeline).toHaveBeenCalledTimes(1);
    });
  });

  describe("embedBatch", () => {
    it("should return empty array for empty input", async () => {
      const result = await provider.embedBatch([]);
      expect(result).toEqual([]);
    });

    it("should return embeddings for multiple texts", async () => {
      const fakeEmbeddings = [
        new Float32Array(768).fill(0.1),
        new Float32Array(768).fill(0.2),
      ];
      mockExtractor.mockResolvedValue({
        tolist: () => fakeEmbeddings.map((e) => [...e]),
      });

      const results = await provider.embedBatch(["text1", "text2"]);

      expect(results).toHaveLength(2);
      expect(results[0].dimensions).toBe(768);
      expect(results[1].dimensions).toBe(768);
      expect(mockExtractor).toHaveBeenCalledWith(["text1", "text2"], {
        pooling: "mean",
        normalize: true,
      });
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: FAIL
— module `onnx.js` not found.

**Step 3: Implement OnnxEmbeddings**

Create `src/core/adapters/embeddings/onnx.ts`:

```typescript
import type { EmbeddingProvider, EmbeddingResult } from "./base.js";

type Pipeline = (
  texts: string[],
  options: Record<string, unknown>,
) => Promise<{ tolist: () => number[][] }>;

export class OnnxEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private extractor: Pipeline | null = null;

  constructor(model = "Xenova/jina-embeddings-v2-base-code", dimensions = 768) {
    this.model = model;
    this.dimensions = dimensions;
  }

  private async ensureLoaded(): Promise<Pipeline> {
    if (this.extractor) return this.extractor;

    try {
      const { pipeline } = await import("@huggingface/transformers");
      console.error(
        `[ONNX] Loading model ${this.model}... (first time, may download ~70MB)`,
      );
      this.extractor = (await pipeline("feature-extraction", this.model, {
        dtype: "q8",
      })) as unknown as Pipeline;
      console.error(`[ONNX] Model loaded.`);
      return this.extractor;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("Cannot find package") ||
        message.includes("MODULE_NOT_FOUND")
      ) {
        throw new Error(
          "Built-in ONNX embeddings require @huggingface/transformers. " +
            "Install: npm install @huggingface/transformers",
        );
      }
      throw new Error(`Failed to load ONNX model "${this.model}": ${message}`);
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const extractor = await this.ensureLoaded();
    const output = await extractor([text], {
      pooling: "mean",
      normalize: true,
    });
    const vectors = output.tolist();
    return {
      embedding: vectors[0],
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const extractor = await this.ensureLoaded();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const vectors = output.tolist();

    return vectors.map((embedding: number[]) => ({
      embedding,
      dimensions: this.dimensions,
    }));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: All
PASS.

**Step 5: Commit**

```
feat(embedding): add OnnxEmbeddings provider with lazy loading
```

---

### Task 4: Wire into factory

**Files:**

- Modify: `src/core/adapters/embeddings/factory.ts`
- Test: `tests/core/adapters/embeddings/factory.test.ts`

**Step 1: Write failing factory tests**

Add to `tests/core/adapters/embeddings/factory.test.ts`, new describe block
after "Ollama provider":

```typescript
import { OnnxEmbeddings } from "../../../../src/core/adapters/embeddings/onnx.js";

// ... inside describe("create") ...

describe("ONNX provider", () => {
  it("should not require API key", () => {
    const provider = EmbeddingProviderFactory.create(
      makeConfig({ provider: "onnx" }),
    );

    expect(provider).toBeInstanceOf(OnnxEmbeddings);
    expect(provider.getModel()).toBe("Xenova/jina-embeddings-v2-base-code");
    expect(provider.getDimensions()).toBe(768);
  });

  it("should use custom model", () => {
    const provider = EmbeddingProviderFactory.create(
      makeConfig({
        provider: "onnx",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 384,
      }),
    );

    expect(provider.getModel()).toBe("Xenova/all-MiniLM-L6-v2");
    expect(provider.getDimensions()).toBe(384);
  });
});
```

Also update the "should list supported providers in error message" test:

```typescript
it("should list supported providers in error message", () => {
  expect(() =>
    EmbeddingProviderFactory.create(makeConfig({ provider: "invalid" as any })),
  ).toThrow("openai, cohere, voyage, ollama, onnx");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/adapters/embeddings/factory.test.ts` Expected:
FAIL — `case "onnx"` not in factory.

**Step 3: Add ONNX to factory**

In `src/core/adapters/embeddings/factory.ts`:

Add import at top:

```typescript
import { OnnxEmbeddings } from "./onnx.js";
```

Update `EmbeddingProviderType`:

```typescript
export type EmbeddingProviderType =
  | "openai"
  | "cohere"
  | "voyage"
  | "ollama"
  | "onnx";
```

Add case before `default:`:

```typescript
case "onnx":
  return new OnnxEmbeddings(
    model || "Xenova/jina-embeddings-v2-base-code",
    dimensions,
  );
```

Update error message:

```typescript
`Unknown embedding provider: ${String(provider)}. Supported providers: openai, cohere, voyage, ollama, onnx`;
```

**Step 4: Run all factory tests**

Run: `npx vitest run tests/core/adapters/embeddings/factory.test.ts` Expected:
All PASS.

**Step 5: Commit**

```
feat(embedding): wire OnnxEmbeddings into factory
```

---

### Task 5: Test ensureLoaded error handling

**Files:**

- Test: `tests/core/adapters/embeddings/onnx.test.ts`

**Step 1: Add error handling tests**

Add to `tests/core/adapters/embeddings/onnx.test.ts`:

```typescript
describe("ensureLoaded error handling", () => {
  it("should throw clear message when @huggingface/transformers is not installed", async () => {
    // Override the mock to simulate missing package
    const { pipeline } = await import("@huggingface/transformers");
    (pipeline as any).mockRejectedValueOnce(
      new Error("Cannot find package '@huggingface/transformers'"),
    );

    // Need a fresh instance to reset lazy state
    const freshProvider = new OnnxEmbeddings();

    await expect(freshProvider.embed("test")).rejects.toThrow(
      "Built-in ONNX embeddings require @huggingface/transformers",
    );
  });

  it("should throw descriptive error for model load failure", async () => {
    const { pipeline } = await import("@huggingface/transformers");
    (pipeline as any).mockRejectedValueOnce(
      new Error("Network error: model not found"),
    );

    const freshProvider = new OnnxEmbeddings();

    await expect(freshProvider.embed("test")).rejects.toThrow(
      'Failed to load ONNX model "Xenova/jina-embeddings-v2-base-code"',
    );
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: All
PASS (error handling already implemented in Task 3).

**Step 3: Commit**

```
test(embedding): add OnnxEmbeddings error handling tests
```

---

### Task 6: Full integration test

**Files:**

- All modified files

**Step 1: Run full test suite**

Run: `npx vitest run` Expected: All tests pass (1929+ tests). No regressions.

**Step 2: Run type check**

Run: `npx tsc --noEmit` Expected: No type errors.

**Step 3: Commit (if any formatting fixes needed)**

```
chore: fix formatting after ONNX provider integration
```
