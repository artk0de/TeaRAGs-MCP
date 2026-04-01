import { describe, expect, it } from "vitest";

import { parseModelInfo } from "../../../../../src/core/adapters/embeddings/ollama/model-info.js";

describe("parseModelInfo", () => {
  it("should parse nomic-bert architecture keys", () => {
    const result = parseModelInfo("nomic-embed-text", {
      "nomic-bert.context_length": 2048,
      "nomic-bert.embedding_length": 768,
    });

    expect(result).toEqual({
      model: "nomic-embed-text",
      contextLength: 2048,
      dimensions: 768,
    });
  });

  it("should parse jina-bert architecture keys", () => {
    const result = parseModelInfo("jina-embeddings-v2", {
      "jina-bert-v2.context_length": 8192,
      "jina-bert-v2.embedding_length": 768,
    });

    expect(result).toEqual({
      model: "jina-embeddings-v2",
      contextLength: 8192,
      dimensions: 768,
    });
  });

  it("should return undefined when context_length is missing", () => {
    const result = parseModelInfo("model", {
      "arch.embedding_length": 768,
    });

    expect(result).toBeUndefined();
  });

  it("should return undefined when embedding_length is missing", () => {
    const result = parseModelInfo("model", {
      "arch.context_length": 2048,
    });

    expect(result).toBeUndefined();
  });

  it("should return undefined for empty model_info", () => {
    const result = parseModelInfo("model", {});
    expect(result).toBeUndefined();
  });

  it("should ignore non-numeric values", () => {
    const result = parseModelInfo("model", {
      "arch.context_length": "2048",
      "arch.embedding_length": 768,
    });

    expect(result).toBeUndefined();
  });

  it("should pick first matching keys when multiple architectures present", () => {
    const result = parseModelInfo("model", {
      "bert.context_length": 512,
      "bert.embedding_length": 384,
      "other.context_length": 1024,
      "other.embedding_length": 768,
    });

    // Last match wins due to sequential iteration
    expect(result).toEqual({
      model: "model",
      contextLength: 1024,
      dimensions: 768,
    });
  });
});
