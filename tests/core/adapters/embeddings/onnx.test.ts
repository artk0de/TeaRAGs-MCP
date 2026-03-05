import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ONNX_MODEL, OnnxEmbeddings } from "../../../../src/core/adapters/embeddings/onnx.js";

// Mock the dynamic import of @huggingface/transformers
const mockExtractor = vi.fn();
const mockPipeline = vi.fn().mockResolvedValue(mockExtractor);

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipeline,
  env: { cacheDir: "", allowLocalModels: true },
}));

describe("OnnxEmbeddings", () => {
  let provider: OnnxEmbeddings;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OnnxEmbeddings();
  });

  describe("constructor", () => {
    it("should use default model with int8 quantization", () => {
      expect(provider.getModel()).toBe(DEFAULT_ONNX_MODEL);
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

      expect(mockPipeline).toHaveBeenCalledWith("feature-extraction", "jinaai/jina-embeddings-v2-base-code", {
        dtype: "q8",
      });
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

      expect(mockPipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/jina-embeddings-v2-base-code", {
        dtype: "q4",
      });
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

  describe("adaptive batch sizing", () => {
    it("should use initial batch size of 32, not full input length", async () => {
      const texts = Array.from({ length: 100 }, (_, i) => `text${i}`);
      mockExtractor.mockResolvedValue({
        tolist: () => texts.slice(0, 32).map(() => [0.1]),
      });

      await provider.embedBatch(texts);

      // First call should be capped at 32, not 100
      const firstCallTexts = mockExtractor.mock.calls[0][0] as string[];
      expect(firstCallTexts).toHaveLength(32);
    });

    it("should halve batch size on failure and retry", async () => {
      const texts = Array.from({ length: 10 }, (_, i) => `text${i}`);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // First call (10 texts, capped at 10 since < 32): fail
      // Retry with 5: succeed
      // Next batch of 5: succeed
      let callCount = 0;
      mockExtractor.mockImplementation(async (batch: string[]) => {
        callCount++;
        if (callCount === 1) throw new Error("OOM");
        return Promise.resolve({ tolist: () => batch.map(() => [0.1]) });
      });

      const results = await provider.embedBatch(texts);

      expect(results).toHaveLength(10);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("reducing to 5"));
      consoleSpy.mockRestore();
    });

    it("should halve multiple times until batch succeeds", async () => {
      const texts = Array.from({ length: 40 }, (_, i) => `text${i}`);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockExtractor.mockImplementation(async (batch: string[]) => {
        // Fail at 32 and 16, succeed at 8
        if (batch.length > 8) throw new Error("OOM");
        return Promise.resolve({ tolist: () => batch.map(() => [0.1]) });
      });

      const results = await provider.embedBatch(texts);

      expect(results).toHaveLength(40);
      // Should have reduced: 32 → 16 → 8
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("reducing to 16"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("reducing to 8"));
      consoleSpy.mockRestore();
    });

    it("should throw when batch size reaches minimum and still fails", async () => {
      const texts = Array.from({ length: 10 }, (_, i) => `text${i}`);
      vi.spyOn(console, "error").mockImplementation(() => {});

      mockExtractor.mockRejectedValue(new Error("OOM"));

      await expect(provider.embedBatch(texts)).rejects.toThrow("OOM");
    });

    it("should persist learned batch size across calls", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // First call: fail at 5, succeed at 4 (min)
      let firstCallCount = 0;
      mockExtractor.mockImplementation(async (batch: string[]) => {
        firstCallCount++;
        if (firstCallCount === 1) throw new Error("OOM");
        return Promise.resolve({ tolist: () => batch.map(() => [0.1]) });
      });

      await provider.embedBatch(["a", "b", "c", "d", "e"]);

      // Reset mock for second call
      mockExtractor.mockReset();
      mockExtractor.mockImplementation(async (batch: string[]) => {
        return Promise.resolve({ tolist: () => batch.map(() => [0.2]) });
      });

      await provider.embedBatch(["x", "y", "z"]);

      // Second call should use the learned batch size, not INITIAL_BATCH_SIZE
      const secondCallTexts = mockExtractor.mock.calls[0][0] as string[];
      expect(secondCallTexts.length).toBeLessThanOrEqual(5);
      consoleSpy.mockRestore();
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

    it("should throw guided HF auth flow when Unauthorized", async () => {
      mockPipeline.mockRejectedValueOnce(new Error('Unauthorized access to file: "https://huggingface.co/..."'));

      const freshProvider = new OnnxEmbeddings();

      const error = await freshProvider.embed("test").catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("requires HuggingFace authentication");
      expect((error as Error).message).toContain("https://huggingface.co/join");
      expect((error as Error).message).toContain("HF_TOKEN");
    });

    it("should throw descriptive error for model load failure", async () => {
      mockPipeline.mockRejectedValueOnce(new Error("Network error: model not found"));

      const freshProvider = new OnnxEmbeddings();

      await expect(freshProvider.embed("test")).rejects.toThrow(`Failed to load ONNX model "${DEFAULT_ONNX_MODEL}"`);
    });
  });
});
