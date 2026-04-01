import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaEmbeddings } from "../../../../src/core/adapters/embeddings/ollama.js";
import {
  OllamaContextOverflowError,
  OllamaModelMissingError,
  OllamaResponseError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from "../../../../src/core/adapters/embeddings/ollama/errors.js";

// Mock fetch globally
global.fetch = vi.fn();

// Mock Bottleneck to pass through directly — avoids internal promise chains
// that cause unhandled rejections when combined with vi.useFakeTimers
vi.mock("bottleneck", () => ({
  default: class MockBottleneck {
    constructor(_options?: any) {}
    async schedule<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
    on() {
      return this;
    }
  },
}));

describe("OllamaEmbeddings", () => {
  let embeddings: OllamaEmbeddings;
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = global.fetch as any;
    mockFetch.mockReset();

    // Use legacy API for tests (old /api/embeddings endpoint) via constructor param
    embeddings = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, undefined, true);
  });

  describe("constructor", () => {
    it("should use default model and dimensions", () => {
      const defaultEmbeddings = new OllamaEmbeddings();
      expect(defaultEmbeddings.getModel()).toBe("unclemusclez/jina-embeddings-v2-base-code:latest");
      expect(defaultEmbeddings.getDimensions()).toBe(768);
    });

    it("should use custom model", () => {
      const customEmbeddings = new OllamaEmbeddings("mxbai-embed-large");
      expect(customEmbeddings.getModel()).toBe("mxbai-embed-large");
      expect(customEmbeddings.getDimensions()).toBe(1024);
    });

    it("should use custom dimensions", () => {
      const customEmbeddings = new OllamaEmbeddings("nomic-embed-text", 512);
      expect(customEmbeddings.getDimensions()).toBe(512);
    });

    it("should use default base URL", () => {
      const defaultEmbeddings = new OllamaEmbeddings();
      expect(defaultEmbeddings).toBeDefined();
    });

    it("should use custom base URL", () => {
      const customEmbeddings = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, "http://custom:11434");
      expect(customEmbeddings).toBeDefined();
    });

    it("should default to 768 for unknown models", () => {
      const unknownEmbeddings = new OllamaEmbeddings("custom-model");
      expect(unknownEmbeddings.getDimensions()).toBe(768);
    });

    it("should use all-minilm model with 384 dimensions", () => {
      const miniEmbeddings = new OllamaEmbeddings("all-minilm");
      expect(miniEmbeddings.getModel()).toBe("all-minilm");
      expect(miniEmbeddings.getDimensions()).toBe(384);
    });
  });

  describe("embed", () => {
    it("should generate embedding for single text", async () => {
      const mockEmbedding = Array(768)
        .fill(0)
        .map((_, i) => i * 0.001);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          embedding: mockEmbedding,
        }),
      });

      const result = await embeddings.embed("test text");

      expect(result).toEqual({
        embedding: mockEmbedding,
        dimensions: 768,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/embeddings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            model: "nomic-embed-text",
            prompt: "test text",
            options: { num_gpu: 999 },
          }),
        }),
      );
    });

    it("should handle long text", async () => {
      const longText = "word ".repeat(1000);
      const mockEmbedding = Array(768).fill(0.5);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          embedding: mockEmbedding,
        }),
      });

      const result = await embeddings.embed(longText);

      expect(result.embedding).toEqual(mockEmbedding);
    });

    it("should use custom base URL", async () => {
      const customEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://custom:11434",
        true,
      );

      const mockEmbedding = Array(768).fill(0.1);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          embedding: mockEmbedding,
        }),
      });

      await customEmbeddings.embed("test");

      expect(mockFetch).toHaveBeenCalledWith("http://custom:11434/api/embeddings", expect.any(Object));
    });

    it("should throw error if no embedding returned", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should handle API errors", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Model not found",
      });

      await expect(embeddings.embed("test")).rejects.toThrow();
    });

    it("should propagate network errors as OllamaUnavailableError", async () => {
      mockFetch.mockRejectedValue(new Error("Network Error"));

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should wrap API error for long text in OllamaResponseError", async () => {
      const longText = "a".repeat(150);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Server error",
      });

      await expect(embeddings.embed(longText)).rejects.toThrow(OllamaResponseError);
    });

    it("should wrap non-Error objects in OllamaUnavailableError", async () => {
      mockFetch.mockRejectedValue("Connection refused");

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should handle errors with message property as OllamaUnavailableError", async () => {
      mockFetch.mockRejectedValue({
        message: "Custom error message",
      });

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should handle non-Error objects in catch block as OllamaUnavailableError", async () => {
      mockFetch.mockRejectedValue({ code: "ERR_UNKNOWN", details: "info" });

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should throw OllamaContextOverflowError when legacy API returns context length error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "context length exceeded for model",
      });

      await expect(embeddings.embed("very long text")).rejects.toThrow(OllamaContextOverflowError);
    });

    it("should detect rate limit from raw error with status 429 in legacy API", async () => {
      const rateLimitError = Object.assign(new Error("rate limit exceeded"), { status: 429 });
      mockFetch.mockRejectedValue(rateLimitError);

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaResponseError);
    });

    it("should detect rate limit from raw error message in legacy API", async () => {
      const rateLimitError = Object.assign(new Error("Rate Limit hit, try again later"), { status: undefined });
      mockFetch.mockRejectedValue(rateLimitError);

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaResponseError);
    });
  });

  describe("embedBatch", () => {
    it("should generate embeddings for multiple texts in parallel", async () => {
      const mockEmbeddings = [Array(768).fill(0.1), Array(768).fill(0.2), Array(768).fill(0.3)];

      // Mock sequential calls for each text
      mockEmbeddings.forEach((embedding) => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding }),
        });
      });

      const texts = ["text1", "text2", "text3"];
      const results = await embeddings.embedBatch(texts);

      expect(results).toEqual([
        { embedding: mockEmbeddings[0], dimensions: 768 },
        { embedding: mockEmbeddings[1], dimensions: 768 },
        { embedding: mockEmbeddings[2], dimensions: 768 },
      ]);

      // Ollama processes each text individually
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should handle empty batch", async () => {
      const results = await embeddings.embedBatch([]);

      expect(results).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should handle single item in batch", async () => {
      const mockEmbedding = Array(768).fill(0.5);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

      const results = await embeddings.embedBatch(["single text"]);

      expect(results).toHaveLength(1);
      expect(results[0].embedding).toEqual(mockEmbedding);
    });

    it("should handle large batches with parallel processing", async () => {
      const batchSize = 20;
      const mockEmbedding = Array(768).fill(0.5);

      // Mock all responses
      for (let i = 0; i < batchSize; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding: mockEmbedding }),
        });
      }

      const texts = Array(batchSize)
        .fill(null)
        .map((_, i) => `text ${i}`);
      const results = await embeddings.embedBatch(texts);

      expect(results).toHaveLength(batchSize);
      expect(mockFetch).toHaveBeenCalledTimes(batchSize);
    });

    it("should propagate errors in batch", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding: Array(768).fill(0.1) }),
        })
        .mockRejectedValueOnce(new Error("Batch API Error"));

      await expect(embeddings.embedBatch(["text1", "text2"])).rejects.toThrow(OllamaUnavailableError);
    });

    it("should handle partial failures in batch", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding: Array(768).fill(0.1) }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "Internal error",
        });

      await expect(embeddings.embedBatch(["text1", "text2"])).rejects.toThrow();
    });
  });

  describe("getDimensions", () => {
    it("should return configured dimensions", () => {
      expect(embeddings.getDimensions()).toBe(768);
    });

    it("should return custom dimensions", () => {
      const customEmbeddings = new OllamaEmbeddings("nomic-embed-text", 512);
      expect(customEmbeddings.getDimensions()).toBe(512);
    });
  });

  describe("getModel", () => {
    it("should return configured model", () => {
      expect(embeddings.getModel()).toBe("nomic-embed-text");
    });

    it("should return custom model", () => {
      const customEmbeddings = new OllamaEmbeddings("mxbai-embed-large");
      expect(customEmbeddings.getModel()).toBe("mxbai-embed-large");
    });
  });

  describe("rate limiting", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      vi.useRealTimers();
    });

    it("should retry on rate limit error (429 status)", async () => {
      const mockEmbedding = Array(768).fill(0.5);

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => "Rate limit exceeded",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => "Rate limit exceeded",
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({ embedding: mockEmbedding }),
        });

      const promise = embeddings.embed("test text");
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result.embedding).toEqual(mockEmbedding);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should retry on rate limit message", async () => {
      const mockEmbedding = Array(768).fill(0.5);

      mockFetch
        .mockRejectedValueOnce({
          message: "You have exceeded the rate limit",
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({ embedding: mockEmbedding }),
        });

      const promise = embeddings.embed("test text");
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result.embedding).toEqual(mockEmbedding);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should use exponential backoff with faster default delay", async () => {
      const rateLimitEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        {
          retryAttempts: 3,
          retryDelayMs: 100,
        },
        undefined,
        true,
      );

      const mockEmbedding = Array(768).fill(0.5);

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => "Rate limit",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => "Rate limit",
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({ embedding: mockEmbedding }),
        });

      const startTime = Date.now();
      const promise = rateLimitEmbeddings.embed("test text");
      await vi.advanceTimersByTimeAsync(10_000);
      await promise;
      const duration = Date.now() - startTime;

      // Should wait: 100ms (first retry) + 200ms (second retry) = 300ms
      expect(duration).toBeGreaterThanOrEqual(250);
    });

    it("should throw error after max retries exceeded", async () => {
      const rateLimitEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        {
          retryAttempts: 2,
          retryDelayMs: 100,
        },
        undefined,
        true,
      );

      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "Rate limit exceeded",
      });

      const promise = rateLimitEmbeddings.embed("test text");
      promise.catch(() => {}); // prevent unhandled rejection detection
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(promise).rejects.toThrow(OllamaResponseError);

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should handle rate limit errors in batch operations", async () => {
      const mockEmbedding = Array(768).fill(0.5);

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => "Rate limit",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding: mockEmbedding }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding: mockEmbedding }),
        });

      const promise = embeddings.embedBatch(["text1", "text2"]);
      await vi.advanceTimersByTimeAsync(10_000);
      const results = await promise;

      expect(results).toHaveLength(2);
      // First call fails and retries, then succeeds. Second call succeeds immediately.
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should not retry on non-rate-limit errors", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Model not found",
      });

      await expect(embeddings.embed("test text")).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should accept custom rate limit configuration", () => {
      const customEmbeddings = new OllamaEmbeddings("nomic-embed-text", undefined, {
        maxRequestsPerMinute: 2000,
        retryAttempts: 5,
        retryDelayMs: 1000,
      });

      expect(customEmbeddings).toBeDefined();
    });

    it("should have higher default rate limit for local deployment", () => {
      // Ollama defaults to 1000 requests/minute (more lenient than cloud providers)
      const defaultEmbeddings = new OllamaEmbeddings();
      expect(defaultEmbeddings).toBeDefined();
    });

    it("should handle primitive error values in retry logic", async () => {
      // This tests line 69: when error is not an OllamaError, convert to { status: 0, message: String(error) }
      mockFetch.mockRejectedValue(null);

      await expect(embeddings.embed("test")).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should handle string primitive errors", async () => {
      mockFetch.mockRejectedValue("Network unreachable");

      await expect(embeddings.embed("test")).rejects.toThrow();
    });

    it("should handle error objects with non-string message property", async () => {
      mockFetch.mockRejectedValue({
        message: 404, // Non-string message
        code: "NOT_FOUND",
      });

      // Should not treat this as a rate limit error even though it has a message property
      await expect(embeddings.embed("test")).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retries
    });

    it("should handle Error instance in retry logic as OllamaUnavailableError", async () => {
      const testError = new Error("Connection timeout");
      mockFetch.mockRejectedValue(testError);

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should handle Error instance from network error as OllamaUnavailableError", async () => {
      const networkError = new Error("ECONNREFUSED");
      mockFetch.mockRejectedValue(networkError);

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should handle object with string message property as OllamaUnavailableError", async () => {
      const customError = {
        code: "API_ERROR",
        message: "Custom API failure",
        details: "Something went wrong",
      };
      mockFetch.mockRejectedValue(customError);

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });
  });

  describe("native batch API (/api/embed)", () => {
    let batchEmbeddings: OllamaEmbeddings;

    beforeEach(() => {
      // Use native batch API (legacyApi=false, which is the default)
      batchEmbeddings = new OllamaEmbeddings("nomic-embed-text");
    });

    it("should use /api/embed endpoint for single text", async () => {
      const mockEmbedding = Array(768).fill(0.5);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: [mockEmbedding],
        }),
      });

      const result = await batchEmbeddings.embed("test text");

      expect(result).toEqual({
        embedding: mockEmbedding,
        dimensions: 768,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/embed",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            model: "nomic-embed-text",
            input: ["test text"],
            options: { num_gpu: 999 },
          }),
        }),
      );
    });

    it("should batch multiple texts in single request", async () => {
      const mockEmbeddings = [Array(768).fill(0.1), Array(768).fill(0.2), Array(768).fill(0.3)];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: mockEmbeddings,
        }),
      });

      const results = await batchEmbeddings.embedBatch(["text1", "text2", "text3"]);

      expect(results).toHaveLength(3);
      expect(results[0].embedding).toEqual(mockEmbeddings[0]);
      expect(results[1].embedding).toEqual(mockEmbeddings[1]);
      expect(results[2].embedding).toEqual(mockEmbeddings[2]);

      // Should be ONE request for all texts
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/embed",
        expect.objectContaining({
          body: JSON.stringify({
            model: "nomic-embed-text",
            input: ["text1", "text2", "text3"],
            options: { num_gpu: 999 },
          }),
        }),
      );
    });

    it("should handle empty embeddings response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: [],
        }),
      });

      await expect(batchEmbeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should handle API error in batch mode", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      });

      await expect(batchEmbeddings.embed("test")).rejects.toThrow();
    });

    it("should send all texts in a single native batch request", async () => {
      const mockEmbeddings = [Array(768).fill(0.1), Array(768).fill(0.2), Array(768).fill(0.3), Array(768).fill(0.4)];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: mockEmbeddings,
        }),
      });

      // Pipeline controls batch size via accumulator.
      // embedBatch sends everything in 1 request — no internal splitting.
      const results = await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(4);
    });

    it("should respect numGpu constructor parameter in batch mode", async () => {
      const cpuEmbeddings = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, undefined, false, 0);

      const mockEmbedding = Array(768).fill(0.5);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: [mockEmbedding],
        }),
      });

      await cpuEmbeddings.embed("test");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/embed",
        expect.objectContaining({
          body: JSON.stringify({
            model: "nomic-embed-text",
            input: ["test"],
            options: { num_gpu: 0 },
          }),
        }),
      );
    });

    it("should default to num_gpu=999 when numGpu not specified", async () => {
      const gpuEmbeddings = new OllamaEmbeddings("nomic-embed-text");

      const mockEmbedding = Array(768).fill(0.5);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: [mockEmbedding],
        }),
      });

      await gpuEmbeddings.embed("test");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/embed",
        expect.objectContaining({
          body: expect.stringContaining('"num_gpu":999'),
        }),
      );
    });

    it("should throw when embedBatch response count mismatches input count", async () => {
      // Return 2 embeddings for 3 input texts
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: [Array(768).fill(0.1), Array(768).fill(0.2)],
        }),
      });

      await expect(batchEmbeddings.embedBatch(["text1", "text2", "text3"])).rejects.toThrow(OllamaUnavailableError);
    });

    it("should throw when embedBatch response has no embeddings field", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
        }),
      });

      await expect(batchEmbeddings.embedBatch(["text1"])).rejects.toThrow(OllamaUnavailableError);
    });

    it("should throw OllamaContextOverflowError when batch API returns context length error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "input length exceeds context window",
      });

      await expect(batchEmbeddings.embed("very long text")).rejects.toThrow(OllamaContextOverflowError);
    });

    it("should throw OllamaResponseError for non-context-overflow batch API errors", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "unprocessable entity",
      });

      await expect(batchEmbeddings.embed("test")).rejects.toThrow(OllamaResponseError);
    });

    it("should detect batch support via checkBatchSupport", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: [Array(768).fill(0.5)],
        }),
      });

      const supported = await batchEmbeddings.checkBatchSupport();
      expect(supported).toBe(true);
    });

    it("should disable native batch when checkBatchSupport fails", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFetch.mockRejectedValue(new Error("404 Not Found"));

      const supported = await batchEmbeddings.checkBatchSupport();
      expect(supported).toBe(false);

      // After checkBatchSupport fails, useNativeBatch should be false
      // Verify by calling embed — it should now use legacy /api/embeddings
      const mockEmbedding = Array(768).fill(0.5);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

      await batchEmbeddings.embed("test");
      // Should call legacy endpoint
      expect(mockFetch).toHaveBeenLastCalledWith("http://localhost:11434/api/embeddings", expect.any(Object));

      consoleSpy.mockRestore();
    });

    it("should use legacy fallback with individual requests when native batch not available", async () => {
      // Create instance without native batch support
      const legacyEmbeddings = new OllamaEmbeddings("nomic-embed-text");
      // Force useNativeBatch to false
      (legacyEmbeddings as unknown as { useNativeBatch: boolean }).useNativeBatch = false;

      const mockEmbedding = Array(768).fill(0.5);
      // Legacy embed() uses /api/embeddings which returns { embedding } (singular)
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embedding: mockEmbedding,
        }),
      });

      await legacyEmbeddings.embedBatch(["t1", "t2"]);

      // Fallback sends individual requests
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("fallback URL", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const mockEmbedding = Array(768)
      .fill(0)
      .map((_, i) => i * 0.001);
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

    /** Create provider with fallback, mocking constructor health check. */
    const createWithFallback = async (opts?: { primaryUp?: boolean; model?: string }): Promise<OllamaEmbeddings> => {
      const primaryUp = opts?.primaryUp ?? false;
      const model = opts?.model ?? "nomic-embed-text";
      if (primaryUp) {
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
      } else {
        mockFetch.mockRejectedValueOnce(new Error("connection refused")); // constructor health check
      }
      const provider = new OllamaEmbeddings(model, undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();
      return provider;
    };

    it("should use fallback when constructor health check fails", async () => {
      const provider = await createWithFallback({ primaryUp: false });

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      const result = await provider.embed("test");

      expect(result.embedding).toEqual(mockEmbedding);
      // constructor health check + fallback embed
      const embedUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(embedUrl).toContain("fallback");
    });

    it("should use primary when constructor health check succeeds", async () => {
      const provider = await createWithFallback({ primaryUp: true });

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("test");

      const embedUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(embedUrl).toContain("primary");
    });

    it("should throw with both URLs when fallback also fails", async () => {
      const provider = await createWithFallback({ primaryUp: false });

      mockFetch.mockRejectedValueOnce(new Error("fallback down"));
      await expect(provider.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should include localhost hint when fallback URL is localhost", async () => {
      mockFetch.mockRejectedValueOnce(new Error("remote down")); // constructor health check
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://remote-gpu:11434",
        true,
        999,
        "http://localhost:11434",
      );
      await flush();

      mockFetch.mockRejectedValueOnce(new Error("local down"));
      try {
        await provider.embed("test");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OllamaUnavailableError);
        const expectedStart = process.platform === "darwin" ? "open -a Ollama" : "ollama serve";
        expect((error as OllamaUnavailableError).hint).toContain(expectedStart);
      }
    });

    it("should switch to fallback when constructor health check returns non-ok status", async () => {
      // Constructor health check returns non-ok (e.g. 500) instead of throwing
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();

      // Embed should use fallback URL since primary health was non-ok
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("test");

      const embedUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(embedUrl).toContain("fallback");
    });

    it("should work without fallback URL", async () => {
      mockFetch.mockRejectedValue(new Error("connection refused"));
      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should keep using fallback on subsequent calls", async () => {
      const provider = await createWithFallback({ primaryUp: false });

      // First call on fallback
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("first");

      // Second call should still use fallback
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("second");

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain("fallback");
    });

    it("should switch back to primary when probe succeeds", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        await vi.advanceTimersByTimeAsync(0); // flush constructor health check

        // Embed on fallback
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("on fallback");

        // Probe fires — primary recovered (cooldown = 0 since primaryFailedAt = 0)
        mockFetch.mockResolvedValueOnce({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);

        // Next embed should go to primary
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("after recovery");

        const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
        expect(lastUrl).toContain("primary");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should keep using fallback when probe fails", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        await vi.advanceTimersByTimeAsync(0);

        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("trigger failover");

        // Probe fires — still down
        mockFetch.mockRejectedValueOnce(new Error("still down"));
        await vi.advanceTimersByTimeAsync(30_000);

        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("still on fallback");

        const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
        expect(lastUrl).toContain("fallback");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should keep usingFallback=true when fallback fails (no state reset)", async () => {
      const provider = await createWithFallback({ primaryUp: false });

      // Fallback also fails
      mockFetch.mockRejectedValueOnce(new Error("fallback also down"));
      await expect(provider.embed("both down")).rejects.toThrow(OllamaUnavailableError);

      // Should STILL use fallback
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("recovery");
      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain("fallback");
    });

    it("should throw OllamaModelMissingError from primary", async () => {
      const provider = await createWithFallback({ primaryUp: true, model: "nonexistent-model" });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "model not found",
      });

      await expect(provider.embed("test")).rejects.toThrow(OllamaModelMissingError);
    });

    it("should throw OllamaModelMissingError from fallback during failover", async () => {
      const provider = await createWithFallback({ primaryUp: false, model: "nonexistent-model" });

      // Embed on fallback ok first
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("trigger failover");

      // Now fallback returns model not found
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "model not found",
      });

      await expect(provider.embed("missing model")).rejects.toThrow(OllamaModelMissingError);
    });
  });

  describe("health probe integration", () => {
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

    it("should not probe per-call when no fallback configured", async () => {
      const mockEmbedding = Array(768).fill(0.5);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

      await embeddings.embed("test");

      // Only 1 call — embed, no health check
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should NOT switch to fallback on embed failure — stays on primary", async () => {
      const PRIMARY = "http://primary:11434";
      const FALLBACK = "http://fallback:11434";
      const mockEmbedding = Array(768).fill(0.5);

      // Constructor health check succeeds
      mockFetch.mockResolvedValueOnce({ ok: true });
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();

      // First embed fails on primary — no fallback switch
      mockFetch.mockRejectedValueOnce(new Error("primary embed failed"));
      await expect(provider.embed("test")).rejects.toThrow(OllamaUnavailableError);

      // Next call still uses primary (no fallback switch during operation)
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("second");

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain("primary");
    });
  });

  describe("checkHealth", () => {
    it("should return true when root URL responds ok", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const result = await embeddings.checkHealth();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/", expect.objectContaining({ method: "GET" }));
    });

    it("should return false when root URL throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await embeddings.checkHealth();

      expect(result).toBe(false);
    });

    it("should return false when root URL returns non-ok", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await embeddings.checkHealth();

      expect(result).toBe(false);
    });

    it("should check fallback URL when using fallback", async () => {
      const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

      // Constructor health check fails — switches to fallback
      mockFetch.mockRejectedValueOnce(new Error("primary down"));
      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );
      await flush();

      // Now check health — should probe fallback URL
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const result = await fallbackEmbeddings.checkHealth();

      expect(result).toBe(true);
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("http://fallback:11434/");
    });
  });

  describe("getProviderName", () => {
    it("should return 'ollama'", () => {
      expect(embeddings.getProviderName()).toBe("ollama");
    });
  });

  describe("getBaseUrl", () => {
    it("should return base URL", () => {
      expect(embeddings.getBaseUrl()).toBe("http://localhost:11434");
    });
  });

  describe("fallback observability", () => {
    const PRIMARY = "http://192.168.1.71:11434";
    const FALLBACK = "http://localhost:11434";
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

    it("should call onFallbackSwitch when constructor health check fails", async () => {
      const onSwitch = vi.fn();
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      provider.onFallbackSwitch = onSwitch;
      await flush();

      expect(onSwitch).toHaveBeenCalledOnce();
      expect(onSwitch).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: "to-fallback",
          primaryUrl: PRIMARY,
          fallbackUrl: FALLBACK,
        }),
      );
    });

    it("should call onFallbackSwitch when primary recovers", async () => {
      vi.useFakeTimers();
      try {
        const onSwitch = vi.fn();
        mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        provider.onFallbackSwitch = onSwitch;
        await vi.advanceTimersByTimeAsync(0);
        onSwitch.mockClear();

        // Primary probe succeeds → probePrimary switches back
        mockFetch.mockResolvedValueOnce({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);

        expect(onSwitch).toHaveBeenCalledWith(
          expect.objectContaining({
            direction: "to-primary",
            primaryUrl: PRIMARY,
            fallbackUrl: FALLBACK,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("should include reason in fallback switch event", async () => {
      const onSwitch = vi.fn();
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      provider.onFallbackSwitch = onSwitch;
      await flush();

      expect(onSwitch.mock.calls[0][0]).toHaveProperty("reason");
      expect(typeof onSwitch.mock.calls[0][0].reason).toBe("string");
    });

    it("should not call onFallbackSwitch when no fallback configured", async () => {
      const onSwitch = vi.fn();
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        PRIMARY,
        true,
        999,
        undefined, // no fallback
      );
      provider.onFallbackSwitch = onSwitch;

      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(provider.embed("test")).rejects.toThrow();
      expect(onSwitch).not.toHaveBeenCalled();
    });
  });

  describe("recovery cooldown", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const mockEmbedding = Array(768).fill(0.5);

    it("should stay on primary after embed failure (no fallback switch)", async () => {
      // Constructor: primary up
      const flush = async () => new Promise<void>((r) => setTimeout(r, 0));
      mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();

      // Primary embed fails — error propagated, no fallback
      mockFetch.mockRejectedValueOnce(new Error("primary embed failed"));
      await expect(provider.embed("first")).rejects.toThrow(OllamaUnavailableError);

      // Next call still on primary
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("second");

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain("primary");
    });

    it("should recover from initial fallback after cooldown expires", async () => {
      vi.useFakeTimers();
      try {
        // Constructor: primary DOWN → uses fallback
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        await vi.advanceTimersByTimeAsync(0);

        // Embed on fallback
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("on fallback");

        // Probe fires — primary recovered (cooldown = 0 since initial failure)
        mockFetch.mockResolvedValueOnce({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);

        // Should now use primary
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("recovered");

        const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
        expect(lastUrl).toContain("primary");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("URL snapshot per operation", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const mockEmbedding = Array(768).fill(0.5);
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

    it("should use snapshot URL for entire embed call", async () => {
      // Constructor: primary up
      mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();

      // Embed succeeds on primary
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      const result = await provider.embed("test");

      expect(result.embedding).toEqual(mockEmbedding);
      const embedUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(embedUrl).toContain("primary");
    });

    it("should stay on primary after embed failure (no mid-operation fallback)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();

      // Primary embed fails — error propagated, no fallback switch
      mockFetch.mockRejectedValueOnce(new Error("connection error"));
      await expect(provider.embed("test")).rejects.toThrow(OllamaUnavailableError);

      // Next call still on primary
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("second");

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain("primary");
    });

    it("should include both URLs in error when fallback fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("primary down")); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();

      // Fallback also fails
      mockFetch.mockRejectedValueOnce(new Error("fallback down"));

      try {
        await provider.embed("fail");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OllamaUnavailableError);
        const msg = (error as OllamaUnavailableError).message;
        expect(msg).toContain(PRIMARY);
        expect(msg).toContain(FALLBACK);
      }
    });
  });

  describe("no fallback during operation", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const mockEmbedding = Array(768).fill(0.5);
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

    it("should NOT switch to fallback on primary embed failure", async () => {
      // Constructor: primary up
      mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await flush();

      // Primary embed fails — connection error
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(provider.embed("test")).rejects.toThrow(OllamaUnavailableError);

      // Next call should STILL go to primary (no fallback switch)
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("second");

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain("primary");
    });

    it("should throw OllamaTimeoutError on batch embed timeout without fallback", async () => {
      vi.useFakeTimers();
      try {
        // Constructor: primary up, native batch (legacyApi = false)
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, false, 999, FALLBACK);
        await vi.advanceTimersByTimeAsync(0);

        // Mock fetch that hangs until abort signal fires (simulates slow Ollama)
        mockFetch.mockImplementationOnce(
          async (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted", "AbortError"));
              });
            }),
        );

        const embedPromise = provider.embedBatch(["text1", "text2"]);
        // Prevent unhandled rejection during timer advancement
        embedPromise.catch(() => {});
        // Advance past batch timeout: 30000 + 2*200 = 30400ms
        await vi.advanceTimersByTimeAsync(31_000);

        await expect(embedPromise).rejects.toThrow(OllamaTimeoutError);

        // Next call should STILL go to primary (no fallback switch)
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ model: "nomic-embed-text", embeddings: [[0.1], [0.2]] }),
        });
        await provider.embedBatch(["a", "b"]);

        const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
        expect(lastUrl).toContain("primary");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should include EMBEDDING_BATCH_SIZE hint in timeout error", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, false, 999, FALLBACK);
        await vi.advanceTimersByTimeAsync(0);

        // Mock fetch that hangs until abort
        mockFetch.mockImplementationOnce(
          async (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted", "AbortError"));
              });
            }),
        );

        const embedPromise = provider.embedBatch(["text1"]);
        embedPromise.catch(() => {});
        await vi.advanceTimersByTimeAsync(31_000);

        const error = await embedPromise.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OllamaTimeoutError);
        expect((error as OllamaTimeoutError).hint).toContain("EMBEDDING_BATCH_SIZE");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should preserve Ollama HTTP error body in OllamaResponseError", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, false, 999, FALLBACK);
      await flush();

      // Ollama returns HTTP 500 with error body
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "GPU out of memory: failed to allocate 2.1GB",
      });

      try {
        await provider.embedBatch(["text1"]);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OllamaResponseError);
        expect((error as OllamaResponseError).message).toContain("GPU out of memory");
        expect((error as OllamaResponseError).responseStatus).toBe(500);
      }
    });
  });
});
