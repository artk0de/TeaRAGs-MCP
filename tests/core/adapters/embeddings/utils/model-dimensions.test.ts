import { describe, test, expect } from "vitest";
import { getModelDimensions, stripQuantizationSuffix } from "../../../../../src/core/adapters/embeddings/utils/model-dimensions.js";

describe("stripQuantizationSuffix", () => {
  test("strips -fp16 suffix", () => {
    expect(stripQuantizationSuffix("jinaai/jina-embeddings-v2-base-code-fp16")).toBe(
      "jinaai/jina-embeddings-v2-base-code",
    );
  });

  test("strips -fp32 suffix", () => {
    expect(stripQuantizationSuffix("jinaai/jina-embeddings-v2-base-code-fp32")).toBe(
      "jinaai/jina-embeddings-v2-base-code",
    );
  });

  test("strips -q8 suffix", () => {
    expect(stripQuantizationSuffix("nomic-ai/nomic-embed-text-v1.5-q8")).toBe("nomic-ai/nomic-embed-text-v1.5");
  });

  test("strips -q4 suffix", () => {
    expect(stripQuantizationSuffix("model-q4")).toBe("model");
  });

  test("strips -q8_0 suffix", () => {
    expect(stripQuantizationSuffix("model-q8_0")).toBe("model");
  });

  test("does not strip from model names where it is not a suffix", () => {
    expect(stripQuantizationSuffix("fp16-model")).toBe("fp16-model");
  });

  test("returns model unchanged when no quantization suffix", () => {
    expect(stripQuantizationSuffix("text-embedding-3-small")).toBe("text-embedding-3-small");
  });
});

describe("getModelDimensions", () => {
  // OpenAI models
  test("returns 1536 for text-embedding-3-small", () => {
    expect(getModelDimensions("text-embedding-3-small")).toBe(1536);
  });

  test("returns 3072 for text-embedding-3-large", () => {
    expect(getModelDimensions("text-embedding-3-large")).toBe(3072);
  });

  test("returns 1536 for text-embedding-ada-002", () => {
    expect(getModelDimensions("text-embedding-ada-002")).toBe(1536);
  });

  // Cohere models
  test("returns 1024 for embed-english-v3.0", () => {
    expect(getModelDimensions("embed-english-v3.0")).toBe(1024);
  });

  test("returns 384 for embed-english-light-v3.0", () => {
    expect(getModelDimensions("embed-english-light-v3.0")).toBe(384);
  });

  test("returns 1024 for embed-multilingual-v3.0", () => {
    expect(getModelDimensions("embed-multilingual-v3.0")).toBe(1024);
  });

  test("returns 384 for embed-multilingual-light-v3.0", () => {
    expect(getModelDimensions("embed-multilingual-light-v3.0")).toBe(384);
  });

  // Voyage models (including new ones)
  test("returns 1024 for voyage-2", () => {
    expect(getModelDimensions("voyage-2")).toBe(1024);
  });

  test("returns 1536 for voyage-large-2", () => {
    expect(getModelDimensions("voyage-large-2")).toBe(1536);
  });

  test("returns 1536 for voyage-code-2", () => {
    expect(getModelDimensions("voyage-code-2")).toBe(1536);
  });

  test("returns 1024 for voyage-code-3", () => {
    expect(getModelDimensions("voyage-code-3")).toBe(1024);
  });

  test("returns 1024 for voyage-3-large", () => {
    expect(getModelDimensions("voyage-3-large")).toBe(1024);
  });

  test("returns 1024 for voyage-lite-02-instruct", () => {
    expect(getModelDimensions("voyage-lite-02-instruct")).toBe(1024);
  });

  test("returns 1024 for voyage-4", () => {
    expect(getModelDimensions("voyage-4")).toBe(1024);
  });

  test("returns 1024 for voyage-3.5", () => {
    expect(getModelDimensions("voyage-3.5")).toBe(1024);
  });

  test("returns 512 for voyage-4-lite", () => {
    expect(getModelDimensions("voyage-4-lite")).toBe(512);
  });

  test("returns 512 for voyage-3.5-lite", () => {
    expect(getModelDimensions("voyage-3.5-lite")).toBe(512);
  });

  // Ollama models
  test("returns 768 for nomic-embed-text", () => {
    expect(getModelDimensions("nomic-embed-text")).toBe(768);
  });

  test("returns 1024 for mxbai-embed-large", () => {
    expect(getModelDimensions("mxbai-embed-large")).toBe(1024);
  });

  test("returns 384 for all-minilm", () => {
    expect(getModelDimensions("all-minilm")).toBe(384);
  });

  test("returns 768 for unclemusclez/jina-embeddings-v2-base-code:latest", () => {
    expect(getModelDimensions("unclemusclez/jina-embeddings-v2-base-code:latest")).toBe(768);
  });

  // ONNX / HuggingFace models
  test("returns 768 for jinaai/jina-embeddings-v2-base-code", () => {
    expect(getModelDimensions("jinaai/jina-embeddings-v2-base-code")).toBe(768);
  });

  test("returns 768 for Xenova/bge-base-en-v1.5", () => {
    expect(getModelDimensions("Xenova/bge-base-en-v1.5")).toBe(768);
  });

  test("returns 384 for Xenova/all-MiniLM-L6-v2", () => {
    expect(getModelDimensions("Xenova/all-MiniLM-L6-v2")).toBe(384);
  });

  test("returns 768 for nomic-ai/nomic-embed-text-v1.5", () => {
    expect(getModelDimensions("nomic-ai/nomic-embed-text-v1.5")).toBe(768);
  });

  test("returns 384 for BAAI/bge-small-en-v1.5", () => {
    expect(getModelDimensions("BAAI/bge-small-en-v1.5")).toBe(384);
  });

  test("returns 768 for Xenova/multilingual-e5-base", () => {
    expect(getModelDimensions("Xenova/multilingual-e5-base")).toBe(768);
  });

  // Quantization suffix stripping
  test("resolves fp16-suffixed model to same dimensions", () => {
    expect(getModelDimensions("jinaai/jina-embeddings-v2-base-code-fp16")).toBe(768);
  });

  test("resolves q8-suffixed model to same dimensions", () => {
    expect(getModelDimensions("nomic-ai/nomic-embed-text-v1.5-q8")).toBe(768);
  });

  // Unknown model
  test("returns undefined for unknown model", () => {
    expect(getModelDimensions("unknown-model-xyz")).toBeUndefined();
  });
});
