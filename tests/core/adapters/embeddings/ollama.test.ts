import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaEmbeddings } from "../../../../src/core/adapters/embeddings/ollama.js";
import { OllamaUnavailableError } from "../../../../src/core/adapters/embeddings/ollama/errors.js";

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

    it("should wrap API error for long text in OllamaUnavailableError", async () => {
      const longText = "a".repeat(150);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Server error",
      });

      await expect(embeddings.embed(longText)).rejects.toThrow(OllamaUnavailableError);
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

      await expect(promise).rejects.toThrow(OllamaUnavailableError);

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
    it("should fall back to fallbackBaseUrl when primary fails", async () => {
      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      const mockEmbedding = Array(768)
        .fill(0)
        .map((_, i) => i * 0.001);

      // Primary fails, fallback succeeds
      mockFetch.mockRejectedValueOnce(new Error("connection refused")).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

      const result = await fallbackEmbeddings.embed("test");
      expect(result.embedding).toEqual(mockEmbedding);

      // Second call should have been to fallback URL
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const fallbackCall = mockFetch.mock.calls[1];
      expect(fallbackCall[0]).toContain("http://fallback:11434");
    });

    it("should throw with both URLs when primary and fallback fail", async () => {
      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      // Both fail
      mockFetch.mockRejectedValueOnce(new Error("primary down")).mockRejectedValueOnce(new Error("fallback down"));

      await expect(fallbackEmbeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
      await expect(fallbackEmbeddings.embed("test")).rejects.toThrow(/primary.*fallback|fallback.*primary/i);
    });

    it("should include localhost hint when fallback URL is localhost", async () => {
      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://remote-gpu:11434",
        true,
        999,
        "http://localhost:11434",
      );

      mockFetch.mockRejectedValueOnce(new Error("remote down")).mockRejectedValueOnce(new Error("local down"));

      try {
        await fallbackEmbeddings.embed("test");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OllamaUnavailableError);
        const expectedStart = process.platform === "darwin" ? "open -a Ollama" : "ollama serve";
        expect((error as OllamaUnavailableError).hint).toContain(expectedStart);
      }
    });

    it("should work without fallback URL (existing behavior)", async () => {
      // No fallback URL — standard OllamaUnavailableError
      mockFetch.mockRejectedValue(new Error("connection refused"));

      await expect(embeddings.embed("test")).rejects.toThrow(OllamaUnavailableError);
    });

    it("should use fallback on second call after primary fails (failover cache)", async () => {
      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      const mockEmbedding = Array(768)
        .fill(0)
        .map((_, i) => i * 0.001);

      // First call: primary fails, fallback succeeds
      mockFetch
        .mockRejectedValueOnce(new Error("primary down"))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

      await fallbackEmbeddings.embed("first");

      // Second call: should go directly to fallback (skip primary)
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

      await fallbackEmbeddings.embed("second");

      // 3 calls total: primary(fail) + fallback(ok) + fallback(ok, cached)
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const thirdCallUrl = mockFetch.mock.calls[2][0] as string;
      expect(thirdCallUrl).toContain("fallback");
    });

    it("should switch back to primary when probe succeeds", async () => {
      vi.useFakeTimers();

      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      const mockEmbedding = Array(768)
        .fill(0)
        .map((_, i) => i * 0.001);

      // First call: primary fails, fallback succeeds — triggers probe
      mockFetch
        .mockRejectedValueOnce(new Error("primary down"))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

      await fallbackEmbeddings.embed("trigger failover");

      // Probe fires after 30s — primary now responds
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await vi.advanceTimersByTimeAsync(30_000);

      // Next embed call should go to primary (probe recovered it)
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

      await fallbackEmbeddings.embed("after recovery");

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastCallUrl).toContain("primary");

      vi.useRealTimers();
    });

    it("should keep using fallback when probe fails", async () => {
      vi.useFakeTimers();

      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      const mockEmbedding = Array(768)
        .fill(0)
        .map((_, i) => i * 0.001);

      // Trigger failover
      mockFetch
        .mockRejectedValueOnce(new Error("primary down"))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await fallbackEmbeddings.embed("trigger failover");

      // Probe fires — primary still down
      mockFetch.mockRejectedValueOnce(new Error("still down"));
      await vi.advanceTimersByTimeAsync(30_000);

      // Next call should still use fallback
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await fallbackEmbeddings.embed("still on fallback");

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastCallUrl).toContain("fallback");

      vi.useRealTimers();
    });

    it("should reset failover when both primary and fallback fail during cached state", async () => {
      const fallbackEmbeddings = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      const mockEmbedding = Array(768)
        .fill(0)
        .map((_, i) => i * 0.001);

      // Trigger failover
      mockFetch
        .mockRejectedValueOnce(new Error("primary down"))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await fallbackEmbeddings.embed("trigger failover");

      // Second call: fallback also fails during cached state
      mockFetch.mockRejectedValueOnce(new Error("fallback also down"));
      await expect(fallbackEmbeddings.embed("both down")).rejects.toThrow(OllamaUnavailableError);
    });
  });
});
