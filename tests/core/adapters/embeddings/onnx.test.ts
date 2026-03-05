import { beforeEach, describe, expect, it, vi } from "vitest";

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
      expect(mockExtractor).toHaveBeenCalledWith(
        ["function hello() {}"],
        { pooling: "mean", normalize: true },
      );
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
      expect(mockExtractor).toHaveBeenCalledWith(
        ["text1", "text2"],
        { pooling: "mean", normalize: true },
      );
    });
  });

  describe("ensureLoaded error handling", () => {
    it("should throw clear message when @huggingface/transformers is not installed", async () => {
      const { pipeline } = await import("@huggingface/transformers");
      (pipeline as any).mockRejectedValueOnce(
        new Error("Cannot find package '@huggingface/transformers'"),
      );

      const freshProvider = new OnnxEmbeddings();

      await expect(freshProvider.embed("test")).rejects.toThrow(
        "Built-in ONNX embeddings require @huggingface/transformers",
      );
    });

    it("should throw descriptive error for model load failure", async () => {
      const { pipeline } = await import("@huggingface/transformers");
      (pipeline as any).mockRejectedValueOnce(new Error("Network error: model not found"));

      const freshProvider = new OnnxEmbeddings();

      await expect(freshProvider.embed("test")).rejects.toThrow(
        'Failed to load ONNX model "Xenova/jina-embeddings-v2-base-code"',
      );
    });
  });
});
