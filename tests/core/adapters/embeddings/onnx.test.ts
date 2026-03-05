import { beforeEach, describe, expect, it, vi } from "vitest";

import { OnnxEmbeddings } from "../../../../src/core/adapters/embeddings/onnx.js";

// Mock the dynamic import of @huggingface/transformers
const mockExtractor = vi.fn();
const mockPipeline = vi.fn().mockResolvedValue(mockExtractor);

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipeline,
}));

describe("OnnxEmbeddings", () => {
  let provider: OnnxEmbeddings;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OnnxEmbeddings();
  });

  describe("constructor", () => {
    it("should use default model with q8 quantization", () => {
      expect(provider.getModel()).toBe("Xenova/jina-embeddings-v2-base-code-q8");
      expect(provider.getDimensions()).toBe(768);
    });

    it("should accept custom model and dimensions", () => {
      const custom = new OnnxEmbeddings("Xenova/all-MiniLM-L6-v2", 384);
      expect(custom.getModel()).toBe("Xenova/all-MiniLM-L6-v2");
      expect(custom.getDimensions()).toBe(384);
    });
  });

  describe("parseModelSpec (via ensureLoaded)", () => {
    it("should extract dtype from model name suffix", async () => {
      mockExtractor.mockResolvedValue({ tolist: () => [[0.1]] });

      await provider.embed("test");

      expect(mockPipeline).toHaveBeenCalledWith(
        "feature-extraction",
        "Xenova/jina-embeddings-v2-base-code",
        { dtype: "q8" },
      );
    });

    it("should pass fp16 dtype when model ends with -fp16", async () => {
      mockExtractor.mockResolvedValue({ tolist: () => [[0.1]] });
      const fp16Provider = new OnnxEmbeddings("Xenova/model-fp16", 384);

      await fp16Provider.embed("test");

      expect(mockPipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/model", { dtype: "fp16" });
    });

    it("should not extract dtype when suffix is not a known quantization", async () => {
      mockExtractor.mockResolvedValue({ tolist: () => [[0.1]] });
      const plainProvider = new OnnxEmbeddings("Xenova/all-MiniLM-L6-v2", 384);

      await plainProvider.embed("test");

      expect(mockPipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/all-MiniLM-L6-v2", {});
    });

    it("should handle q4 quantization", async () => {
      mockExtractor.mockResolvedValue({ tolist: () => [[0.1]] });
      const q4Provider = new OnnxEmbeddings("Xenova/jina-embeddings-v2-base-code-q4", 768);

      await q4Provider.embed("test");

      expect(mockPipeline).toHaveBeenCalledWith(
        "feature-extraction",
        "Xenova/jina-embeddings-v2-base-code",
        { dtype: "q4" },
      );
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
      expect(mockExtractor).toHaveBeenCalledWith(["function hello() {}"], { pooling: "mean", normalize: true });
    });

    it("should lazy-load pipeline on first call", async () => {
      const fakeEmbedding = new Float32Array(768).fill(0.1);
      mockExtractor.mockResolvedValue({
        tolist: () => [[...fakeEmbedding]],
      });

      await provider.embed("test");
      await provider.embed("test2");

      // pipeline() called only once (lazy init)
      expect(mockPipeline).toHaveBeenCalledTimes(1);
    });
  });

  describe("embedBatch", () => {
    it("should return empty array for empty input", async () => {
      const result = await provider.embedBatch([]);
      expect(result).toEqual([]);
    });

    it("should return embeddings for multiple texts", async () => {
      const fakeEmbeddings = [new Float32Array(768).fill(0.1), new Float32Array(768).fill(0.2)];
      mockExtractor.mockResolvedValue({
        tolist: () => fakeEmbeddings.map((e) => [...e]),
      });

      const results = await provider.embedBatch(["text1", "text2"]);

      expect(results).toHaveLength(2);
      expect(results[0].dimensions).toBe(768);
      expect(results[1].dimensions).toBe(768);
      expect(mockExtractor).toHaveBeenCalledWith(["text1", "text2"], { pooling: "mean", normalize: true });
    });
  });

  describe("ensureLoaded error handling", () => {
    it("should throw clear message when @huggingface/transformers is not installed", async () => {
      mockPipeline.mockRejectedValueOnce(new Error("Cannot find package '@huggingface/transformers'"));

      const freshProvider = new OnnxEmbeddings();

      await expect(freshProvider.embed("test")).rejects.toThrow(
        "Built-in ONNX embeddings require @huggingface/transformers",
      );
    });

    it("should throw descriptive error for model load failure", async () => {
      mockPipeline.mockRejectedValueOnce(new Error("Network error: model not found"));

      const freshProvider = new OnnxEmbeddings();

      await expect(freshProvider.embed("test")).rejects.toThrow(
        'Failed to load ONNX model "Xenova/jina-embeddings-v2-base-code-q8"',
      );
    });
  });
});
