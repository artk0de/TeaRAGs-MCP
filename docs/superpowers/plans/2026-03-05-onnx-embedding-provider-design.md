# Built-in ONNX Embedding Provider

**Date:** 2026-03-05 **Issue:** tea-86w2 **Epic:** tea-at1 (Adoption
improvement) **Priority:** P1

## Problem

tea-rags requires Ollama (~800MB + 274MB model) or an API key to generate
embeddings. This is the second biggest adoption barrier after Qdrant Docker
dependency.

## Solution

Add `onnx` embedding provider using `@huggingface/transformers` as optional
dependency. Auto-downloads `jina-embeddings-v2-base-code` quantized model
(~70MB) on first use. No Ollama, no API key, no GPU required. Works on CPU, GPU
via CoreML/CUDA in Phase B.

## Architecture

### Interface (unchanged)

```typescript
// src/core/adapters/embeddings/base.ts — NO CHANGES
interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModel(): string;
}
```

### New provider

```
src/core/adapters/embeddings/onnx.ts

OnnxEmbeddings implements EmbeddingProvider
├── constructor(model?, dimensions?)
│   └── Sets config only — no loading
├── ensureLoaded()  [private, lazy]
│   ├── Dynamic import @huggingface/transformers
│   ├── pipeline('feature-extraction', model, { dtype: 'q8' })
│   └── Model auto-downloaded to HF cache (~/.cache/huggingface/)
├── embed(text)
│   └── ensureLoaded() → extractor([text]) → result[0]
├── embedBatch(texts)
│   └── ensureLoaded() → extractor(texts) → results
├── getDimensions() → 768
└── getModel() → "Xenova/jina-embeddings-v2-base-code"
```

### Factory change

```typescript
// src/core/adapters/embeddings/factory.ts
case "onnx":
  return new OnnxEmbeddings(
    model || "Xenova/jina-embeddings-v2-base-code",
    dimensions,
  );
```

### Schema change

```typescript
// src/bootstrap/config/schemas.ts
provider: z.enum(["ollama", "openai", "cohere", "voyage", "onnx"]).default("ollama"),
```

### package.json change

```json
{
  "optionalDependencies": {
    "@huggingface/transformers": "^3.0.0"
  }
}
```

## Model choice

`jina-embeddings-v2-base-code` quantized (q8):

- 137M params, ~70MB download (q8)
- 768 dimensions — matches existing Ollama jina-embeddings-v2-base-code
- Trained on 15+ programming languages
- ONNX format available via Xenova/HuggingFace
- Existing Qdrant collections with 768-dim vectors remain compatible

## Lazy loading

Nothing loads at startup. First `embed()` or `embedBatch()` call triggers:

1. Dynamic `import('@huggingface/transformers')`
2. Pipeline creation (downloads model if not cached)
3. Subsequent calls reuse the loaded pipeline

If `@huggingface/transformers` is not installed, throws clear error message.

## Batch support

`@huggingface/transformers` pipeline accepts `string[]` — native batch. No
special handling needed. Pipeline internally handles padding/tokenization.

## Error handling

| Scenario                                  | Behavior                                                |
| ----------------------------------------- | ------------------------------------------------------- |
| `@huggingface/transformers` not installed | Error: "Install: npm install @huggingface/transformers" |
| Model download fails (no internet)        | Error with model URL, suggest manual download           |
| First embed() slow (model loading)        | Expected: log "[ONNX] Loading model... (first time)"    |

## What changes

| File                                          | Change                          |
| --------------------------------------------- | ------------------------------- |
| `src/core/adapters/embeddings/onnx.ts`        | New file — OnnxEmbeddings class |
| `src/core/adapters/embeddings/factory.ts`     | Add `case "onnx"` + import      |
| `src/bootstrap/config/schemas.ts`             | Add `"onnx"` to provider enum   |
| `src/bootstrap/config/parse.ts`               | Map env var (if needed)         |
| `package.json`                                | Add optionalDependency          |
| `tests/core/adapters/embeddings/onnx.test.ts` | New test file                   |

## What does NOT change

- `EmbeddingProvider` interface
- `EmbeddingResult` type
- Pipeline batching logic (accumulator)
- Other providers (ollama, openai, cohere, voyage)
- Qdrant storage format

## Phase B (future): GPU acceleration

Replace `@huggingface/transformers` inference with `onnxruntime-node` directly:

- CoreML on macOS (Neural Engine, 5-10x CPU)
- CUDA on Linux
- DirectML on Windows
- Keep `@huggingface/transformers` for tokenizer only
- Manual mean pooling + L2 normalization
