import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaEmbeddings } from "../../../../src/core/adapters/embeddings/ollama.js";
import {
  OllamaContextOverflowError,
  OllamaMalformedResponseError,
  OllamaModelMissingError,
  OllamaResponseError,
  OllamaRunnerCrashError,
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

    it("should throw OllamaMalformedResponseError if no embedding returned", async () => {
      // HTTP 200 without a vector: the server answered, so this is a malformed
      // response, not "not reachable" (bd tea-rags-mcp-jyka).
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { retryAttempts: 1, retryDelayMs: 1 },
        undefined,
        true,
      );
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await expect(provider.embed("test")).rejects.toThrow(OllamaMalformedResponseError);
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

    // Invariant: once the provider has asked Ollama what the model actually is,
    // getDimensions() reports that truth. Otherwise the collection is created at
    // the real width while every zero-vector artifact is built at the guess.
    it("adopts the width Ollama reports for the model", async () => {
      const provider = new OllamaEmbeddings("some-unlisted-model");
      expect(provider.getDimensions()).toBe(768); // registry miss → fallback

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: { "bert.embedding_length": 1024, "bert.context_length": 512 } }),
      } as Response);

      await provider.resolveModelInfo();

      expect(provider.getDimensions()).toBe(1024);
    });

    it("keeps an operator-supplied width even when Ollama reports another", async () => {
      // EMBEDDING_DIMENSIONS is an explicit override; probing must not undo it.
      const provider = new OllamaEmbeddings("some-unlisted-model", 512);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: { "bert.embedding_length": 1024, "bert.context_length": 512 } }),
      } as Response);

      await provider.resolveModelInfo();

      expect(provider.getDimensions()).toBe(512);
    });

    it("keeps the fallback width when the probe fails", async () => {
      const provider = new OllamaEmbeddings("some-unlisted-model");
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error("connection refused"));

      await provider.resolveModelInfo();

      expect(provider.getDimensions()).toBe(768);
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

  describe("connection recovery (bounded wait)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
      vi.useRealTimers();
    });

    it("should retry a transient 'not reachable' failure and resolve once the host recovers", async () => {
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        {
          retryAttempts: 3,
          retryDelayMs: 100,
          unavailableRetryMaxWaitMs: 60_000,
          unavailableRetryBaseDelayMs: 100,
        },
        undefined,
        true,
      );
      const mockEmbedding = Array(768).fill(0.5);

      mockFetch
        .mockRejectedValueOnce(new Error("ECONNREFUSED")) // host briefly down under load
        .mockRejectedValueOnce(new Error("ECONNREFUSED")) // still recovering
        .mockResolvedValue({
          ok: true,
          json: async () => ({ embedding: mockEmbedding }),
        });

      const promise = provider.embed("test text");
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result.embedding).toEqual(mockEmbedding);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should keep the whole batch alive across a transient flap (native batch API)", async () => {
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        {
          retryAttempts: 3,
          retryDelayMs: 100,
          unavailableRetryMaxWaitMs: 60_000,
          unavailableRetryBaseDelayMs: 100,
        },
        undefined,
        false, // native batch API
      );
      const mockEmbeddings = [Array(768).fill(0.1), Array(768).fill(0.2)];

      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue({
        ok: true,
        json: async () => ({ model: "nomic-embed-text", embeddings: mockEmbeddings }),
      });

      const promise = provider.embedBatch(["text1", "text2"]);
      await vi.advanceTimersByTimeAsync(10_000);
      const results = await promise;

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should abort with OllamaUnavailableError only after the bounded wait is exhausted", async () => {
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        {
          retryAttempts: 3,
          retryDelayMs: 100,
          unavailableRetryMaxWaitMs: 500,
          unavailableRetryBaseDelayMs: 100,
        },
        undefined,
        true,
      );
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const promise = provider.embed("test text");
      promise.catch(() => {}); // prevent unhandled rejection detection
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(promise).rejects.toThrow(OllamaUnavailableError);
      // Multiple attempts within the budget, not a single immediate abort.
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it("should abort immediately when recovery wait is disabled (default)", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, undefined, true);
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const promise = provider.embed("test text");
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(promise).rejects.toThrow(OllamaUnavailableError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should report how long it waited before giving up, so a caller does not wait the budget again (bd tea-rags-mcp-umatc)", async () => {
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { unavailableRetryMaxWaitMs: 500, unavailableRetryBaseDelayMs: 100 },
        undefined,
        true,
      );
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const promise = provider.embed("test text");
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(10_000);

      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OllamaUnavailableError);
      expect((error as OllamaUnavailableError).recoveryWaitMs).toBe(500);
    });

    it("should announce each recovery wait and the recovery, so a caller can show it is waiting (bd tea-rags-mcp-umatc)", async () => {
      // Without this the wait is silent outside DEBUG: an index run sat for the
      // whole budget with nothing on screen, then printed the error.
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { unavailableRetryMaxWaitMs: 60_000, unavailableRetryBaseDelayMs: 100 },
        "http://127.0.0.1:9",
        true,
      );
      const events: unknown[] = [];
      provider.onRecoveryWait = (event) => events.push(event);
      mockFetch
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue({ ok: true, json: async () => ({ embedding: Array(768).fill(0.5) }) });

      const promise = provider.embed("test text");
      await vi.advanceTimersByTimeAsync(10_000);
      await promise;

      expect(events).toEqual([
        { state: "waiting", url: "http://127.0.0.1:9", elapsedMs: 0, budgetMs: 60_000 },
        { state: "waiting", url: "http://127.0.0.1:9", elapsedMs: 100, budgetMs: 60_000 },
        { state: "recovered", url: "http://127.0.0.1:9", elapsedMs: 300 },
      ]);
    });

    it("should announce nothing when the host answers first time", async () => {
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { unavailableRetryMaxWaitMs: 60_000, unavailableRetryBaseDelayMs: 100 },
        undefined,
        true,
      );
      const onRecoveryWait = vi.fn();
      provider.onRecoveryWait = onRecoveryWait;
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ embedding: Array(768).fill(0.5) }) });

      await provider.embed("test text");

      expect(onRecoveryWait).not.toHaveBeenCalled();
    });

    it("should report no recovery wait when the wait is disabled", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, undefined, true);
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const error = await provider.embed("test text").catch((e: unknown) => e);

      expect((error as OllamaUnavailableError).recoveryWaitMs).toBe(0);
    });
  });

  describe("native batch API (/api/embed)", () => {
    let batchEmbeddings: OllamaEmbeddings;

    // Malformed responses are retried by the normal batch retries; keep them fast.
    const fastRetryProvider = () =>
      new OllamaEmbeddings("nomic-embed-text", undefined, { retryAttempts: 1, retryDelayMs: 1 });

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

    it("should classify an empty embeddings response as malformed", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
          embeddings: [],
        }),
      });

      await expect(fastRetryProvider().embed("test")).rejects.toThrow(OllamaMalformedResponseError);
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

    describe("batch the server cannot process", () => {
      // An ollama runner that dies on a large /api/embed makes the server answer
      // with the runner's own transport error — 500, or 400 as ollama 0.34.4 on
      // Windows does (measured 2026-09-27); any batch above `limit` inputs fails that way.
      const RUNNER_CRASH_BODY =
        '{"error":"Post \\"http://127.0.0.1:53912/tokenize\\": dial tcp 127.0.0.1:53912: connectex: No connection could be made because the target machine actively refused it."}';
      const serverFailingAbove = (limit: number, status = 500) =>
        mockFetch.mockImplementation(async (_url: string, init?: { body?: string }) => {
          if (!init?.body) return { ok: true }; // health probe GET /
          const { input } = JSON.parse(init.body) as { input: string[] };
          if (input.length > limit) {
            return { ok: false, status, text: async () => RUNNER_CRASH_BODY };
          }
          return {
            ok: true,
            json: async () => ({ embeddings: input.map((text) => [Number(text.slice(1))]) }),
          };
        });
      const sentBatchSizes = () =>
        mockFetch.mock.calls.map(([, init]: [string, { body: string }]) => JSON.parse(init.body).input.length);

      it("splits the batch and returns every vector in input order", async () => {
        serverFailingAbove(2);

        const results = await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4", "t5"]);

        expect(results.map((r) => r.embedding)).toEqual([[1], [2], [3], [4], [5]]);
      });

      it("sends later batches at the size that worked instead of failing again", async () => {
        serverFailingAbove(2);
        await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4"]);
        mockFetch.mockClear();

        const results = await batchEmbeddings.embedBatch(["t5", "t6", "t7", "t8"]);

        expect(sentBatchSizes()).toEqual([2, 2]);
        expect(results.map((r) => r.embedding)).toEqual([[5], [6], [7], [8]]);
      });

      describe("with a server-batch-failure observer attached (bd tea-rags-mcp-7ju66)", () => {
        it("reports every size failure with the size it retries at", async () => {
          serverFailingAbove(2);
          const events: unknown[] = [];
          batchEmbeddings.observeServerBatchFailures((event) => events.push(event));

          await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4", "t5"]);

          expect(events[0]).toEqual({ failedSize: 5, retrySize: 3, endpointUrl: "http://localhost:11434" });
          expect(events).toContainEqual(expect.objectContaining({ failedSize: 3, retrySize: 2 }));
        });

        it("leaves the working size of LATER calls to the observer instead of pinning it for the run", async () => {
          serverFailingAbove(2);
          batchEmbeddings.observeServerBatchFailures(() => {});
          await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4"]);
          mockFetch.mockClear();

          await batchEmbeddings.embedBatch(["t5", "t6", "t7", "t8"]);

          expect(sentBatchSizes()[0]).toBe(4);
        });

        it("still sends the remaining slices of the failing call at the size that worked", async () => {
          serverFailingAbove(1);
          batchEmbeddings.observeServerBatchFailures(() => {});

          const results = await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4"]);

          expect(sentBatchSizes()).toEqual([4, 2, 1, 1, 1, 1]);
          expect(results.map((r) => r.embedding)).toEqual([[1], [2], [3], [4]]);
        });

        it("restores the run-long ceiling once the last observer detaches", async () => {
          serverFailingAbove(2);
          const detach = batchEmbeddings.observeServerBatchFailures(() => {});
          detach();
          await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4"]);
          mockFetch.mockClear();

          await batchEmbeddings.embedBatch(["t5", "t6", "t7", "t8"]);

          expect(sentBatchSizes()).toEqual([2, 2]);
        });
      });

      it("does not split on a caller-side 4xx", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" });

        await expect(batchEmbeddings.embedBatch(["t1", "t2"])).rejects.toThrow(OllamaResponseError);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it("rethrows when even a single text fails", async () => {
        serverFailingAbove(0);

        await expect(batchEmbeddings.embedBatch(["t1", "t2"])).rejects.toThrow(OllamaRunnerCrashError);
      });

      it("splits on the 400 an ollama server answers when its runner crashed", async () => {
        serverFailingAbove(2, 400);

        const results = await batchEmbeddings.embedBatch(["t1", "t2", "t3", "t4"]);

        expect(results.map((r) => r.embedding)).toEqual([[1], [2], [3], [4]]);
      });

      it("surfaces a runner crash on a single text as a runner crash, not a rejected input", async () => {
        serverFailingAbove(0, 400);

        await expect(batchEmbeddings.embedBatch(["t1"])).rejects.toThrow(OllamaRunnerCrashError);
      });

      it("does not fail over when concurrent batches crash the runner", async () => {
        const PRIMARY = "http://primary:11434";
        const FALLBACK = "http://fallback:11434";
        serverFailingAbove(1, 400);
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, false, 999, FALLBACK);

        await Promise.all([
          provider.embedBatch(["t1", "t2"]),
          provider.embedBatch(["t3", "t4"]),
          provider.embedBatch(["t5", "t6"]),
        ]);

        const urls = mockFetch.mock.calls.map(([url]: [string]) => url);
        expect(urls.some((url: string) => url.startsWith(FALLBACK))).toBe(false);
      });
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

      await expect(fastRetryProvider().embedBatch(["text1", "text2", "text3"])).rejects.toThrow(
        OllamaMalformedResponseError,
      );
    });

    it("should throw when embedBatch response has no embeddings field", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "nomic-embed-text",
        }),
      });

      await expect(fastRetryProvider().embedBatch(["text1"])).rejects.toThrow(OllamaMalformedResponseError);
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
        // Probe attempt 1 + retry — both must fail before the run falls back.
        mockFetch.mockRejectedValueOnce(new Error("connection refused"));
        mockFetch.mockRejectedValueOnce(new Error("connection refused"));
      }
      const provider = new OllamaEmbeddings(model, undefined, undefined, PRIMARY, true, 999, FALLBACK);
      // The endpoint decision is lazy (B3): start it where the constructor used to.
      void provider.resolveEndpoint();
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

    it("should stay on primary when the first initial-probe attempt fails but the retry succeeds", async () => {
      mockFetch.mockRejectedValueOnce(new Error("transient LAN blip")); // probe attempt 1 — jitter
      mockFetch.mockResolvedValueOnce({ ok: true }); // probe retry — primary alive

      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      // Probe retry fires after its delay — let it settle before embedding.
      await new Promise((resolve) => setTimeout(resolve, 400));

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("test");

      const embedUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(embedUrl).toContain("primary");
    });

    it("should switch to fallback only after both initial-probe attempts fail", async () => {
      mockFetch.mockRejectedValueOnce(new Error("down"));
      mockFetch.mockRejectedValueOnce(new Error("down"));

      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      await new Promise((resolve) => setTimeout(resolve, 400));

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
      await provider.embed("test");

      const embedUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(embedUrl).toContain("fallback");
    });

    it("should include localhost hint when fallback URL is localhost", async () => {
      mockFetch.mockRejectedValueOnce(new Error("remote down")); // probe attempt 1
      mockFetch.mockRejectedValueOnce(new Error("remote down")); // probe retry
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
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
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
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe attempt 1
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe retry
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
        await vi.advanceTimersByTimeAsync(300); // flush constructor probe incl. retry delay

        // Embed on fallback
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("on fallback");

        // Advance past recovery cooldown (60s) then probe fires
        mockFetch.mockResolvedValueOnce({ ok: true }); // probe at 30s — cooldown not expired
        await vi.advanceTimersByTimeAsync(30_000);
        mockFetch.mockResolvedValueOnce({ ok: true }); // probe at 60s — cooldown expired, switches back
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
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe attempt 1
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe retry
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
        await vi.advanceTimersByTimeAsync(300);

        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("trigger failover");

        // Probe fires — still down (both attempts). Advance past the 30s
        // interval AND the probe retry delay so both attempts complete here.
        mockFetch.mockRejectedValueOnce(new Error("still down"));
        mockFetch.mockRejectedValueOnce(new Error("still down"));
        await vi.advanceTimersByTimeAsync(31_000);

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
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
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
      // Constructor health check fails — switches to fallback (both probe attempts)
      mockFetch.mockRejectedValueOnce(new Error("primary down"));
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
      // Let the probe retry (250ms) settle before asserting endpoint state.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Now check health — should probe fallback URL
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const result = await fallbackEmbeddings.checkHealth();

      expect(result).toBe(true);
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("http://fallback:11434/");
    });

    // bd tea-rags-mcp-jyka — `tea-rags doctor` asks for health right after
    // construction. A dead primary that times out (rather than refusing) keeps
    // the constructor's failover decision pending, and a probe that does not
    // wait for it reports the endpoint the next embed will NOT use.
    it("reports the endpoint the provider will actually use when asked before its startup failover settles", async () => {
      let failPrimary: (error: Error) => void = () => undefined;
      const primaryDown = new Promise<never>((_, reject) => {
        failPrimary = reject;
      });
      mockFetch.mockImplementation(async (url: string) =>
        url.startsWith("http://primary:11434") ? primaryDown : { ok: true, json: async () => ({}) },
      );
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      const health = provider.checkHealth();
      failPrimary(new Error("primary unreachable (probe timed out)"));

      expect(await health).toBe(true);
      expect(provider.getBaseUrl()).toBe("http://fallback:11434");
    });

    it("asks the endpoint it will actually use for model info when asked before its startup failover settles", async () => {
      let failPrimary: (error: Error) => void = () => undefined;
      const primaryDown = new Promise<never>((_, reject) => {
        failPrimary = reject;
      });
      mockFetch.mockImplementation(async (url: string) =>
        url.startsWith("http://primary:11434") ? primaryDown : { ok: true, json: async () => ({}) },
      );
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        undefined,
        "http://primary:11434",
        true,
        999,
        "http://fallback:11434",
      );

      const info = provider.resolveModelInfo();
      failPrimary(new Error("primary unreachable (probe timed out)"));
      await info;

      const showUrls = mockFetch.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .filter((u: string) => u.endsWith("/api/show"));
      expect(showUrls).toEqual(["http://fallback:11434/api/show"]);
    });
  });

  describe("checkFallbackHealth", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

    it("should return undefined when no fallback URL is configured", async () => {
      // `embeddings` from beforeEach has no fallback configured.
      expect(await embeddings.checkFallbackHealth()).toBeUndefined();
    });

    it("should probe the configured fallback URL and return true when it responds ok", async () => {
      // Constructor health check succeeds so usingFallback stays false —
      // the probe must still target the CONFIGURED fallback, not the active URL.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await flush();

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const result = await provider.checkFallbackHealth();

      expect(result).toBe(true);
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("http://fallback:11434/");
    });

    it("should return false when the fallback URL throws", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await flush();

      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await provider.checkFallbackHealth()).toBe(false);
    });

    it("should return false when the fallback URL returns non-ok", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await flush();

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      expect(await provider.checkFallbackHealth()).toBe(false);
    });
  });

  describe("checkPrimaryHealth", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));

    it("should probe the configured primary URL and return true when it responds ok", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true);
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const result = await provider.checkPrimaryHealth();

      expect(result).toBe(true);
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("http://primary:11434/");
    });

    it("should return false when the primary URL returns non-ok", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      expect(await provider.checkPrimaryHealth()).toBe(false);
    });

    it("should return false when the primary URL throws", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true);
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await provider.checkPrimaryHealth()).toBe(false);
    });

    it("should probe the CONFIGURED primary even while failover is active", async () => {
      // Constructor initial probe fails → switches to fallback (usingFallback=true).
      // checkPrimaryHealth must still target the configured primary, NOT the active fallback.
      mockFetch.mockRejectedValueOnce(new Error("primary down at startup"));
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await flush();

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const result = await provider.checkPrimaryHealth();

      expect(result).toBe(true);
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("http://primary:11434/");
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

  describe("getPrimaryBaseUrl", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";

    it("should return configured primary URL when no fallback is configured", () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true);
      expect(provider.getPrimaryBaseUrl()).toBe(PRIMARY);
    });

    it("should return configured primary URL even when usingFallback is true", async () => {
      // Force constructor health check to fail so the provider flips usingFallback=true.
      mockFetch.mockRejectedValueOnce(new Error("connection refused")); // probe attempt 1
      mockFetch.mockRejectedValueOnce(new Error("connection refused")); // probe retry
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Sanity: live endpoint moved to fallback...
      expect(provider.getBaseUrl()).toBe(FALLBACK);
      // ...but the CONFIGURED primary is what getPrimaryBaseUrl reports.
      expect(provider.getPrimaryBaseUrl()).toBe(PRIMARY);
    });
  });

  describe("fallback observability", () => {
    const PRIMARY = "http://192.168.1.71:11434";
    const FALLBACK = "http://localhost:11434";

    it("should call onFallbackSwitch when constructor health check fails", async () => {
      const onSwitch = vi.fn();
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // probe attempt 1
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // probe retry
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      provider.onFallbackSwitch = onSwitch;
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await new Promise((resolve) => setTimeout(resolve, 400));

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
        mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // probe attempt 1
        mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // probe retry
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        provider.onFallbackSwitch = onSwitch;
        void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
        await vi.advanceTimersByTimeAsync(300);
        onSwitch.mockClear();

        // Advance past recovery cooldown (60s) then probe switches back
        mockFetch.mockResolvedValueOnce({ ok: true }); // probe at 30s — cooldown blocks
        await vi.advanceTimersByTimeAsync(30_000);
        mockFetch.mockResolvedValueOnce({ ok: true }); // probe at 60s — cooldown expired
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
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // probe attempt 1
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED")); // probe retry
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      provider.onFallbackSwitch = onSwitch;
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await new Promise((resolve) => setTimeout(resolve, 400));

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
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
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
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe attempt 1
        mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe retry
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
        await vi.advanceTimersByTimeAsync(300);

        // Embed on fallback
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("on fallback");

        // Advance past recovery cooldown (60s) then probe recovers
        mockFetch.mockResolvedValueOnce({ ok: true }); // probe at 30s — cooldown blocks
        await vi.advanceTimersByTimeAsync(30_000);
        mockFetch.mockResolvedValueOnce({ ok: true }); // probe at 60s — cooldown expired
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

  describe("background primary health probe", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const mockEmbedding = Array(768).fill(0.5);

    it("should switch to fallback when background probe detects primary died mid-session", async () => {
      vi.useFakeTimers();
      try {
        // Constructor: primary up
        mockFetch.mockResolvedValueOnce({ ok: true });
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
        await vi.advanceTimersByTimeAsync(0);

        // Background probe fires at 30s — primary is now dead (both attempts,
        // and the advance covers the probe retry delay)
        mockFetch.mockRejectedValueOnce(new Error("primary died"));
        mockFetch.mockRejectedValueOnce(new Error("primary died"));
        await vi.advanceTimersByTimeAsync(31_000);

        // Next embed should go to fallback (no session restart required)
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("after death");

        const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
        expect(lastUrl).toContain("fallback");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should emit to-fallback event when background probe detects primary failure", async () => {
      vi.useFakeTimers();
      try {
        const onSwitch = vi.fn();
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        provider.onFallbackSwitch = onSwitch;
        void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
        await vi.advanceTimersByTimeAsync(0);
        onSwitch.mockClear();

        // Probe fires at 30s — primary dead (both attempts, retry covered)
        mockFetch.mockRejectedValueOnce(new Error("primary died"));
        mockFetch.mockRejectedValueOnce(new Error("primary died"));
        await vi.advanceTimersByTimeAsync(31_000);

        expect(onSwitch).toHaveBeenCalledWith(
          expect.objectContaining({
            direction: "to-fallback",
            primaryUrl: PRIMARY,
            fallbackUrl: FALLBACK,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("should stay on primary when probe succeeds (transient embed error does not flap)", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
        void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
        await vi.advanceTimersByTimeAsync(0);

        // Background probe at 30s — primary still ok
        mockFetch.mockResolvedValueOnce({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);

        // Next embed still uses primary
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
        await provider.embed("normal");

        const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
        expect(lastUrl).toContain("primary");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should not start probe when no fallback configured", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, undefined);
        await vi.advanceTimersByTimeAsync(0);
        const callsBefore = mockFetch.mock.calls.length;

        // Advance 30s — no probe should fire (no fallback → no probe)
        await vi.advanceTimersByTimeAsync(30_000);

        expect(mockFetch.mock.calls.length).toBe(callsBefore);
        expect(provider).toBeDefined();
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
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
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
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
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
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
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
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
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
        // Background probe fires at 30s while embed hangs — report primary alive so the
        // probe doesn't falsely switch to fallback (embed hang ≠ primary down at / health)
        mockFetch.mockResolvedValueOnce({ ok: true });
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
        // Background probe fires at 30s while embed hangs — report primary alive
        // (same premise as the test above: the primary is up, the embed is slow).
        mockFetch.mockResolvedValueOnce({ ok: true });
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

  // bd tea-rags-mcp-80maa: the primary answers GET / (so neither the startup
  // check nor the background probe ever fails) while every embed on it fails.
  // Consecutive embed failures on the primary are the only signal left.
  describe("consecutive embed-failure failover", () => {
    const PRIMARY = "http://primary:11434";
    const FALLBACK = "http://fallback:11434";
    const mockEmbedding = Array(768).fill(0.5);
    const flush = async () => new Promise<void>((r) => setTimeout(r, 0));
    const legacyOk = () => ({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
    const lastUrl = () => mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;

    async function makeProvider(
      failoverConsecutiveFailures: number,
      opts: { legacyApi?: boolean; fallback?: string | undefined } = {},
    ): Promise<OllamaEmbeddings> {
      const fallback = "fallback" in opts ? opts.fallback : FALLBACK;
      if (fallback) mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check: primary healthy
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { failoverConsecutiveFailures, retryAttempts: 1, retryDelayMs: 1 },
        PRIMARY,
        opts.legacyApi ?? true,
        999,
        fallback,
      );
      await flush();
      return provider;
    }

    it("switches to the fallback after N consecutive transport failures while GET / stays healthy", async () => {
      const provider = await makeProvider(3);
      const onSwitch = vi.fn();
      provider.onFallbackSwitch = onSwitch;

      for (let i = 0; i < 3; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }

      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("after threshold");

      expect(lastUrl()).toContain("fallback");
      expect(onSwitch).toHaveBeenCalledTimes(1);
      expect(onSwitch).toHaveBeenCalledWith(
        expect.objectContaining({ direction: "to-fallback", primaryUrl: PRIMARY, fallbackUrl: FALLBACK }),
      );
    });

    it("stays on the primary below the threshold", async () => {
      const provider = await makeProvider(3);

      for (let i = 0; i < 2; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }

      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("still primary");

      expect(lastUrl()).toContain("primary");
    });

    it("counts 5xx responses from embed as failures", async () => {
      const provider = await makeProvider(2, { legacyApi: false });

      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "server overloaded" });
      await expect(provider.embedBatch(["t"])).rejects.toThrow(OllamaResponseError);

      // The second failure crosses the threshold; the same call retries on the fallback.
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "server overloaded" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: "nomic-embed-text", embeddings: [[0.1]] }),
      });
      await provider.embedBatch(["t"]);

      expect(lastUrl()).toContain("fallback");
    });

    it("counts a malformed embed response as a failure", async () => {
      const provider = await makeProvider(2);

      // retryAttempts 1 → each call makes two requests before it fails
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await expect(provider.embed("bad 0")).rejects.toThrow(OllamaMalformedResponseError);

      // The second failure crosses the threshold; the same call retries on the fallback.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("bad 1");

      expect(lastUrl()).toContain("fallback");
    });

    it("counts embed timeouts as failures", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings(
          "nomic-embed-text",
          undefined,
          { failoverConsecutiveFailures: 1 },
          PRIMARY,
          false,
          999,
          FALLBACK,
        );
        await vi.advanceTimersByTimeAsync(0);

        mockFetch.mockImplementationOnce(
          async (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted", "AbortError"));
              });
            }),
        );
        const embedPromise = provider.embedBatch(["t"]);
        mockFetch.mockResolvedValueOnce({ ok: true }); // background probe at 30s: GET / healthy
        // The timeout crosses the threshold; the same call retries on the fallback.
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ model: "nomic-embed-text", embeddings: [[0.1]] }),
        });
        await vi.advanceTimersByTimeAsync(31_000);
        await embedPromise;

        expect(lastUrl()).toContain("fallback");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the count on any successful embed", async () => {
      const provider = await makeProvider(3);

      for (let i = 0; i < 2; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }
      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("success resets");
      for (let i = 0; i < 2; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail again ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }

      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("still primary");

      expect(lastUrl()).toContain("primary");
    });

    it("does not count caller-side 4xx input errors", async () => {
      const provider = await makeProvider(2, { legacyApi: false });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "the input length exceeds the context length",
      });
      await expect(provider.embedBatch(["huge"])).rejects.toThrow(OllamaContextOverflowError);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "invalid input type" });
      await expect(provider.embedBatch(["bad"])).rejects.toThrow(OllamaResponseError);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "model not found" });
      await expect(provider.embedBatch(["t"])).rejects.toThrow(OllamaModelMissingError);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: "nomic-embed-text", embeddings: [[0.1]] }),
      });
      await provider.embedBatch(["t"]);

      expect(lastUrl()).toContain("primary");
    });

    it("a 4xx input error between failures neither counts nor resets", async () => {
      const provider = await makeProvider(2, { legacyApi: false });

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
      await expect(provider.embedBatch(["t"])).rejects.toThrow(OllamaResponseError);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "input length exceeds" });
      await expect(provider.embedBatch(["huge"])).rejects.toThrow(OllamaContextOverflowError);
      // The second counted failure crosses the threshold; the same call retries on the fallback.
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: "nomic-embed-text", embeddings: [[0.1]] }),
      });
      await provider.embedBatch(["t"]);

      expect(lastUrl()).toContain("fallback");
    });

    it("keeps behaviour unchanged when no fallback is configured", async () => {
      const provider = await makeProvider(2, { fallback: undefined });

      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }

      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("primary only");

      expect(lastUrl()).toContain("primary");
      expect(provider.getBaseUrl()).toBe(PRIMARY);
    });

    it("threshold 0 disables embed-failure failover", async () => {
      const provider = await makeProvider(0);

      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }

      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("still primary");

      expect(lastUrl()).toContain("primary");
    });

    it("defaults to 3 consecutive failures when the knob is unset", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await flush();

      for (let i = 0; i < 2; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }
      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("two failures are not enough");
      expect(lastUrl()).toContain("primary");

      for (let i = 0; i < 3; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }
      mockFetch.mockResolvedValueOnce(legacyOk());
      await provider.embed("three are");
      expect(lastUrl()).toContain("fallback");
    });

    it("fails over inside one call's recovery wait instead of spending the whole budget on the primary", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings(
          "nomic-embed-text",
          undefined,
          { failoverConsecutiveFailures: 3, unavailableRetryMaxWaitMs: 240_000, unavailableRetryBaseDelayMs: 100 },
          PRIMARY,
          true,
          999,
          FALLBACK,
        );
        await vi.advanceTimersByTimeAsync(0);

        mockFetch.mockImplementation(async (url: string) => {
          if (url.startsWith(PRIMARY) && url.endsWith("/api/embeddings")) throw new Error("ECONNRESET");
          if (url.startsWith(PRIMARY)) return { ok: true }; // GET / healthy
          return legacyOk();
        });

        const embedPromise = provider.embed("long operation");
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await embedPromise;

        expect(result.embedding).toEqual(mockEmbedding);
        const embedCalls = mockFetch.mock.calls
          .map((c: unknown[]) => c[0] as string)
          .filter((u: string) => u.endsWith("/api/embeddings"));
        expect(embedCalls.filter((u: string) => u.startsWith(PRIMARY))).toHaveLength(3);
        expect(embedCalls[embedCalls.length - 1]).toContain("fallback");
      } finally {
        mockFetch.mockReset();
        vi.useRealTimers();
      }
    });

    it("switches exactly once when concurrent callers fail together", async () => {
      const provider = await makeProvider(3);
      const onSwitch = vi.fn();
      provider.onFallbackSwitch = onSwitch;

      // Six workers in flight on the primary, all failing.
      for (let i = 0; i < 6; i++) mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
      const results = await Promise.allSettled(Array.from({ length: 6 }, async (_, i) => provider.embed(`c${i}`)));

      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(onSwitch).toHaveBeenCalledTimes(1);
      expect(provider.getBaseUrl()).toBe(FALLBACK);
    });

    it("an in-flight primary success landing after the switch does not flip back", async () => {
      const provider = await makeProvider(2);

      let releaseSlow: (v: unknown) => void = () => {};
      mockFetch.mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            releaseSlow = resolve;
          }),
      );
      const slow = provider.embed("slow on primary");

      for (let i = 0; i < 2; i++) {
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
      }
      expect(provider.getBaseUrl()).toBe(FALLBACK);

      releaseSlow(legacyOk());
      await slow;

      expect(provider.getBaseUrl()).toBe(FALLBACK);
    });

    it("governs the way back through the existing cooldown, then needs N fresh failures", async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check
        const provider = new OllamaEmbeddings(
          "nomic-embed-text",
          undefined,
          { failoverConsecutiveFailures: 2 },
          PRIMARY,
          true,
          999,
          FALLBACK,
        );
        await vi.advanceTimersByTimeAsync(0);

        for (let i = 0; i < 2; i++) {
          mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
          await expect(provider.embed(`fail ${i}`)).rejects.toThrow(OllamaUnavailableError);
        }
        expect(provider.getBaseUrl()).toBe(FALLBACK);

        // Probe at 30s: primary GET / healthy, but the 60s cooldown holds the fallback.
        mockFetch.mockResolvedValueOnce({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(provider.getBaseUrl()).toBe(FALLBACK);

        // Probe at 60s: cooldown expired → back to primary.
        mockFetch.mockResolvedValueOnce({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(provider.getBaseUrl()).toBe(PRIMARY);

        // The pre-switch failures do not carry over: one fresh failure is below N.
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        await expect(provider.embed("one fresh failure")).rejects.toThrow(OllamaUnavailableError);
        expect(provider.getBaseUrl()).toBe(PRIMARY);
      } finally {
        vi.useRealTimers();
      }
    });

    // bd tea-rags-mcp-sbu0s: a primary that fails from the very first embed of
    // a run (GET / 200, /api/embed 503 or a malformed 200). The call that
    // crosses the threshold must retry on the fallback it just switched to —
    // otherwise the pre-run health probe (whose attempt count equals the
    // threshold) switches on its last attempt and still aborts the run.
    describe("the call that crosses the threshold retries on the fallback (sbu0s)", () => {
      const batchOk = () => ({ ok: true, json: async () => ({ model: "nomic-embed-text", embeddings: [[0.1]] }) });

      it("an HTTP 503 from the primary", async () => {
        const provider = await makeProvider(2, { legacyApi: false });
        mockFetch.mockImplementation(async (url: string) =>
          url.startsWith(PRIMARY) ? { ok: false, status: 503, text: async () => "busy" } : batchOk(),
        );
        try {
          await expect(provider.embedBatch(["t"])).rejects.toThrow(OllamaResponseError);
          const results = await provider.embedBatch(["t"]);

          expect(results).toHaveLength(1);
          expect(lastUrl()).toBe(`${FALLBACK}/api/embed`);
        } finally {
          mockFetch.mockReset();
        }
      });

      it("a malformed 200 from the primary", async () => {
        const provider = await makeProvider(1, { legacyApi: false });
        mockFetch.mockImplementation(async (url: string) =>
          url.startsWith(PRIMARY) ? { ok: true, json: async () => ({ embeddings: [] }) } : batchOk(),
        );
        try {
          const results = await provider.embedBatch(["t"]);

          expect(results).toHaveLength(1);
          expect(lastUrl()).toBe(`${FALLBACK}/api/embed`);
        } finally {
          mockFetch.mockReset();
        }
      });

      it("a transport failure with no recovery budget", async () => {
        const provider = await makeProvider(1);
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
        mockFetch.mockResolvedValueOnce(legacyOk());

        const result = await provider.embed("t");

        expect(result.embedding).toEqual(mockEmbedding);
        expect(lastUrl()).toContain("fallback");
      });

      it("a caller-side 4xx never switches, so it is not retried elsewhere", async () => {
        const provider = await makeProvider(1, { legacyApi: false });
        mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "invalid input type" });

        await expect(provider.embedBatch(["bad"])).rejects.toThrow(OllamaResponseError);
        expect(provider.getBaseUrl()).toBe(PRIMARY);
      });
    });

    // bd tea-rags-mcp-sbu0s residual race: the background health probe switches
    // to the fallback while an embed is still in flight against the primary
    // snapshot. That call's failure does not cross the threshold (the switch
    // already happened, by someone else), yet the endpoint it failed on is no
    // longer the active one — it must be retried on the fallback, not rethrown.
    describe("a call whose endpoint was switched away mid-flight retries on the active one (sbu0s)", () => {
      const batchOk = () => ({ ok: true, json: async () => ({ model: "nomic-embed-text", embeddings: [[0.1]] }) });

      async function runProbeSwitchesMidCall(primaryEmbedFailure: () => unknown): Promise<void> {
        vi.useFakeTimers();
        try {
          mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check: primary healthy
          const provider = new OllamaEmbeddings(
            "nomic-embed-text",
            undefined,
            // Threshold far above one failure: only the probe can switch here.
            { failoverConsecutiveFailures: 5, retryAttempts: 1, retryDelayMs: 1 },
            PRIMARY,
            false,
            999,
            FALLBACK,
          );
          await vi.advanceTimersByTimeAsync(0);

          let releasePrimaryEmbed: () => void = () => {};
          const primaryEmbedGate = new Promise<void>((resolve) => {
            releasePrimaryEmbed = resolve;
          });
          mockFetch.mockImplementation(async (url: string) => {
            if (url === `${PRIMARY}/`) return { ok: false, status: 500 }; // probe: primary looks down
            if (url.startsWith(PRIMARY)) {
              await primaryEmbedGate;
              return primaryEmbedFailure();
            }
            return batchOk();
          });

          const embedPromise = provider.embedBatch(["t"]);
          embedPromise.catch(() => {});
          // Probe fires at 30s while the embed is still in flight on the primary.
          await vi.advanceTimersByTimeAsync(30_000);
          expect(provider.getBaseUrl()).toBe(FALLBACK);

          releasePrimaryEmbed();
          await vi.advanceTimersByTimeAsync(100);
          const results = await embedPromise;

          expect(results).toHaveLength(1);
          expect(lastUrl()).toBe(`${FALLBACK}/api/embed`);
        } finally {
          mockFetch.mockReset();
          vi.useRealTimers();
        }
      }

      it("an HTTP 503 from the primary", async () => {
        await runProbeSwitchesMidCall(() => ({ ok: false, status: 503, text: async () => "busy" }));
      });

      it("a malformed 200 (empty embeddings) from the primary", async () => {
        await runProbeSwitchesMidCall(() => ({ ok: true, json: async () => ({ embeddings: [] }) }));
      });
    });

    it("does not count failures of calls that ran against the fallback", async () => {
      mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe attempt 1
      mockFetch.mockRejectedValueOnce(new Error("primary down")); // probe retry — constructor: start on fallback
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { failoverConsecutiveFailures: 1 },
        PRIMARY,
        true,
        999,
        FALLBACK,
      );
      void provider.resolveEndpoint(); // lazy since B3: start it where the constructor used to
      await new Promise((resolve) => setTimeout(resolve, 400));
      const onSwitch = vi.fn();
      provider.onFallbackSwitch = onSwitch;

      mockFetch.mockRejectedValueOnce(new Error("fallback hiccup"));
      await expect(provider.embed("on fallback")).rejects.toThrow(OllamaUnavailableError);

      expect(onSwitch).not.toHaveBeenCalled();
    });
  });

  // bd tea-rags-mcp-jyka (owner decision A): an HTTP 200 whose body carries no
  // vectors or the wrong number of them is a malformed response from a server
  // that IS reachable — retried by the normal batch retries, never routed into
  // the unavailable-host recovery wait and never reported as "not reachable".
  describe("malformed embed response", () => {
    const URL = "http://primary:11434";
    const vec = Array(768).fill(0.1);
    const batchBody = (embeddings: unknown) => ({
      ok: true,
      json: async () => ({ model: "nomic-embed-text", embeddings }),
    });

    function makeProvider(overrides: Record<string, number> = {}): OllamaEmbeddings {
      return new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { retryAttempts: 2, retryDelayMs: 1, ...overrides },
        URL,
        false,
        999,
      );
    }

    it("an empty body is malformed: expected 1 vector, got 0, names the endpoint", async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

      const error = await makeProvider()
        .embed("t")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OllamaMalformedResponseError);
      expect(error).not.toBeInstanceOf(OllamaUnavailableError);
      const malformed = error as OllamaMalformedResponseError;
      expect(malformed.code).toBe("INFRA_OLLAMA_MALFORMED_RESPONSE");
      expect(malformed.expectedCount).toBe(1);
      expect(malformed.receivedCount).toBe(0);
      expect(malformed.message).toContain("expected 1");
      expect(malformed.message).toContain("got 0");
      expect(malformed.message).toContain(URL);
    });

    it("a wrong vector count is malformed: expected N, got M", async () => {
      mockFetch.mockResolvedValue(batchBody([vec, vec]));

      const error = await makeProvider()
        .embedBatch(["a", "b", "c"])
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OllamaMalformedResponseError);
      expect((error as OllamaMalformedResponseError).expectedCount).toBe(3);
      expect((error as OllamaMalformedResponseError).receivedCount).toBe(2);
      expect((error as OllamaMalformedResponseError).message).toContain("expected 3");
      expect((error as OllamaMalformedResponseError).message).toContain("got 2");
    });

    it("the legacy single-embedding API reports a missing vector as malformed too", async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
      const legacy = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { retryAttempts: 1, retryDelayMs: 1 },
        URL,
        true,
      );

      await expect(legacy.embed("t")).rejects.toThrow(OllamaMalformedResponseError);
    });

    it("is retried by the normal batch retries and succeeds once the server answers properly", async () => {
      mockFetch.mockResolvedValueOnce(batchBody([vec])).mockResolvedValueOnce(batchBody([vec, vec]));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      const results = await makeProvider().embedBatch(["a", "b"]);

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // The retry log names what it retries, not a rate limit it never hit.
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Malformed Ollama embed response. Retrying"));
      log.mockRestore();
    });

    it("exhausted retries surface the typed malformed error without any recovery wait", async () => {
      mockFetch.mockResolvedValue(batchBody([]));
      const provider = makeProvider({ retryAttempts: 2, unavailableRetryMaxWaitMs: 240_000 });
      const onRecoveryWait = vi.fn();
      provider.onRecoveryWait = onRecoveryWait;

      const error = await provider.embedBatch(["a"]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OllamaMalformedResponseError);
      expect(error).not.toBeInstanceOf(OllamaUnavailableError);
      // 1 attempt + EMBEDDING_TUNE_RETRY_ATTEMPTS retries, nothing more
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(onRecoveryWait).not.toHaveBeenCalled();
    });

    it("N consecutive malformed responses on the primary fail over to the fallback", async () => {
      const FALLBACK = "http://fallback:11434";
      mockFetch.mockResolvedValueOnce({ ok: true }); // constructor health check: primary healthy
      const provider = new OllamaEmbeddings(
        "nomic-embed-text",
        undefined,
        { retryAttempts: 1, retryDelayMs: 1, failoverConsecutiveFailures: 2 },
        URL,
        false,
        999,
        FALLBACK,
      );
      await new Promise<void>((r) => setTimeout(r, 0));

      mockFetch.mockImplementation(async (url: string) => (url.startsWith(URL) ? batchBody([]) : batchBody([vec])));
      await expect(provider.embedBatch(["a"])).rejects.toThrow(OllamaMalformedResponseError);
      // The second failure crosses the threshold; the same call retries on the fallback.
      await provider.embedBatch(["a"]);

      const last = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(last).toBe(`${FALLBACK}/api/embed`);
      mockFetch.mockReset();
    });
  });

  describe("resolveModelInfo", () => {
    it("should return model info from /api/show", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, "http://primary:11434", true);

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
      const url = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(url).toBe("http://primary:11434/api/show");
    });

    it("should return undefined when /api/show fails", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, "http://primary:11434", true);
      mockFetch.mockRejectedValueOnce(new Error("connection refused"));
      const info = await provider.resolveModelInfo();
      expect(info).toBeUndefined();
    });

    it("should return undefined when model_info has no context_length", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, "http://primary:11434", true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      });
      const info = await provider.resolveModelInfo();
      expect(info).toBeUndefined();
    });

    it("should cache result on second call", async () => {
      const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, "http://primary:11434", true);
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
      const showCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/api/show"),
      );
      expect(showCalls.length).toBe(1);
    });
  });

  // Invariant: an embed request asks Ollama for a context (and a batch, which
  // bounds a non-causal input) as wide as the model's own context length. With
  // Ollama's defaults the per-input ceiling is the 2048-token ubatch, and an
  // input past it is either silently truncated or fails the whole request.
  describe("embed request context window", () => {
    const PRIMARY = "http://primary:11434";
    const vector = Array(768).fill(0.1);

    /** Route by endpoint: /api/show answers `show`, embed endpoints answer a vector per input. */
    function routeFetch(show: () => Promise<unknown>): void {
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/show")) return show();
        const body = JSON.parse(init?.body as string) as { input?: string[] };
        if (url.endsWith("/api/embed")) {
          return { ok: true, json: async () => ({ embeddings: (body.input ?? []).map(() => vector) }) };
        }
        return { ok: true, json: async () => ({ embedding: vector }) };
      });
    }

    const showWithContext = async () => ({
      ok: true,
      json: async () => ({
        model_info: { "jina-bert-v2.context_length": 8192, "jina-bert-v2.embedding_length": 768 },
      }),
    });

    function embedOptions(endpoint: string): Record<string, unknown>[] {
      return mockFetch.mock.calls
        .filter((c: any[]) => typeof c[0] === "string" && c[0].endsWith(endpoint))
        .map((c: any[]) => JSON.parse((c[1] as RequestInit).body as string).options);
    }

    it("sends num_ctx and num_batch equal to the context length on the batch API", async () => {
      routeFetch(showWithContext);
      const provider = new OllamaEmbeddings("jina", undefined, undefined, PRIMARY, false, 999);

      await provider.resolveModelInfo();
      await provider.embedBatch(["a", "b"]);

      expect(embedOptions("/api/embed")).toEqual([{ num_gpu: 999, num_ctx: 8192, num_batch: 8192 }]);
    });

    it("sends num_ctx and num_batch equal to the context length on the legacy API", async () => {
      routeFetch(showWithContext);
      const provider = new OllamaEmbeddings("jina", undefined, undefined, PRIMARY, true, 0);

      await provider.resolveModelInfo();
      await provider.embed("a");

      expect(embedOptions("/api/embeddings")).toEqual([{ num_gpu: 0, num_ctx: 8192, num_batch: 8192 }]);
    });

    it("caps the window at 8192 for a model whose context length is larger", async () => {
      routeFetch(async () => ({
        ok: true,
        json: async () => ({
          model_info: { "qwen3.context_length": 40960, "qwen3.embedding_length": 1024 },
        }),
      }));
      const provider = new OllamaEmbeddings("qwen3-embedding", undefined, undefined, PRIMARY, false, 999);

      await provider.resolveModelInfo();
      await provider.embedBatch(["a"]);

      expect(embedOptions("/api/embed")).toEqual([{ num_gpu: 999, num_ctx: 8192, num_batch: 8192 }]);
    });

    it("omits num_ctx and num_batch when /api/show fails", async () => {
      routeFetch(async () => {
        throw new Error("connection refused");
      });
      const provider = new OllamaEmbeddings("jina", undefined, undefined, PRIMARY, false, 999);

      await provider.resolveModelInfo();
      await provider.embedBatch(["a"]);

      expect(embedOptions("/api/embed")).toEqual([{ num_gpu: 999 }]);
    });

    it("omits num_ctx and num_batch when the model reports no context length", async () => {
      routeFetch(async () => ({ ok: true, json: async () => ({ model_info: { "bert.embedding_length": 768 } }) }));
      const provider = new OllamaEmbeddings("jina", undefined, undefined, PRIMARY, true, 999);

      await provider.resolveModelInfo();
      await provider.embed("a");

      expect(embedOptions("/api/embeddings")).toEqual([{ num_gpu: 999 }]);
    });

    it("asks /api/show once, not per embed request", async () => {
      routeFetch(showWithContext);
      const provider = new OllamaEmbeddings("jina", undefined, undefined, PRIMARY, false, 999);

      await provider.resolveModelInfo();
      await provider.embedBatch(["a"]);
      await provider.embedBatch(["b", "c"]);
      await provider.embed("d");

      const showCalls = mockFetch.mock.calls.filter((c: any[]) => (c[0] as string).endsWith("/api/show"));
      expect(showCalls).toHaveLength(1);
      expect(embedOptions("/api/embed").every((o) => o.num_ctx === 8192 && o.num_batch === 8192)).toBe(true);
    });

    it("waits for an in-flight model-info probe instead of embedding with the default window", async () => {
      routeFetch(showWithContext);
      const provider = new OllamaEmbeddings("jina", undefined, undefined, PRIMARY, false, 999);

      // Startup fired the probe and moved on without awaiting it.
      const pending = provider.resolveModelInfo();
      await provider.embedBatch(["a"]);
      await pending;

      expect(embedOptions("/api/embed")).toEqual([{ num_gpu: 999, num_ctx: 8192, num_batch: 8192 }]);
      const showCalls = mockFetch.mock.calls.filter((c: any[]) => (c[0] as string).endsWith("/api/show"));
      expect(showCalls).toHaveLength(1);
    });
  });

  describe("model quantization", () => {
    const PRIMARY = "http://primary:11434";
    const BASE = "unclemusclez/jina-embeddings-v2-base-code:latest";
    const mockEmbedding = Array(768)
      .fill(0)
      .map((_, i) => i * 0.001);

    it("embeds against the quantized tag after the server provisions it", async () => {
      // Server already has the quantized tag — /api/show answers ok.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ model_info: {} }) });

      const provider = new OllamaEmbeddings(BASE, 768, { ollamaQuantization: "turbo" }, PRIMARY, false, 999);
      // Provisioning is async from the constructor — let it settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: [mockEmbedding] }) });
      await provider.embedBatch(["chunk"]);

      const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
      expect(url).toBe(`${PRIMARY}/api/embed`);
      expect(JSON.parse(init.body as string).model).toBe(`${BASE}-q4_K_M`);
    });

    it("warns and keeps the base model when the server cannot quantize", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // /api/show misses, /api/create refuses (unsupported or old server).
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

        const provider = new OllamaEmbeddings(BASE, 768, { ollamaQuantization: "turbo" }, PRIMARY, false, 999);
        await new Promise((resolve) => setTimeout(resolve, 50));

        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: [mockEmbedding] }) });
        await provider.embedBatch(["chunk"]);

        const init = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1] as RequestInit;
        expect(JSON.parse(init.body as string).model).toBe(BASE);
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[Ollama]"));
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("model auto-pull", () => {
    const PRIMARY = "http://primary:11434";
    const BASE = "unclemusclez/jina-embeddings-v2-base-code:latest";
    const mockEmbedding = Array(768)
      .fill(0)
      .map((_, i) => i * 0.001);
    const urls = () => mockFetch.mock.calls.map((c: any[]) => c[0] as string);

    it("pulls a model the server does not have before the first embed", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
        mockFetch.mockResolvedValueOnce(new Response(`${JSON.stringify({ status: "success" })}\n`, { status: 200 }));
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: [mockEmbedding] }) });

        const provider = new OllamaEmbeddings(BASE, 768, { ollamaAutoPull: true }, PRIMARY, false, 999);
        await provider.embedBatch(["chunk"]);

        expect(urls()).toEqual([`${PRIMARY}/api/show`, `${PRIMARY}/api/pull`, `${PRIMARY}/api/embed`]);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("fails the first embed with the pull remedy when the pull fails", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
        mockFetch.mockResolvedValueOnce(new Response('{"error":"manifest unknown"}', { status: 500 }));

        const provider = new OllamaEmbeddings(BASE, 768, { ollamaAutoPull: true }, PRIMARY, false, 999);

        await expect(provider.embedBatch(["chunk"])).rejects.toMatchObject({
          hint: expect.stringContaining(`ollama pull ${BASE}`),
        });
      } finally {
        errSpy.mockRestore();
      }
    });

    it("never probes or pulls when auto-pull is off (EMBEDDING_AUTO_PULL=false)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: [mockEmbedding] }) });

      const provider = new OllamaEmbeddings(BASE, 768, { ollamaAutoPull: false }, PRIMARY, false, 999);
      await provider.embedBatch(["chunk"]);

      expect(urls()).toEqual([`${PRIMARY}/api/embed`]);
    });
  });
});

/**
 * Lazy endpoint resolution (bd tea-rags-mcp-xi2r9, B3). A cold `tea-rags call`
 * of a tool that embeds nothing — `rank_chunks`, `get_callers`, `find_symbol` —
 * waited ~6.4 s on the failover probe of an unreachable primary that the
 * constructor started. The probe now runs when something first needs the
 * endpoint (an embed, model info, a health check), and the fallback semantics
 * are unchanged once it does.
 */
describe("OllamaEmbeddings lazy endpoint resolution", () => {
  const PRIMARY = "http://primary:11434";
  const FALLBACK = "http://fallback:11434";
  const mockEmbedding = [0.1, 0.2, 0.3];
  let mockFetch: any;
  const urls = (): string[] => mockFetch.mock.calls.map((call: unknown[]) => call[0] as string);

  beforeEach(() => {
    mockFetch = global.fetch as any;
    mockFetch.mockReset();
  });

  it("probes no endpoint at construction; the first embed resolves it and fails over", async () => {
    const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(provider.getBaseUrl()).toBe(PRIMARY);

    mockFetch.mockRejectedValueOnce(new Error("unreachable")); // probe attempt 1
    mockFetch.mockRejectedValueOnce(new Error("unreachable")); // probe retry
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
    const result = await provider.embed("query");

    expect(result.embedding).toEqual(mockEmbedding);
    expect(urls()).toEqual([`${PRIMARY}/`, `${PRIMARY}/`, `${FALLBACK}/api/embeddings`]);
    expect(provider.getBaseUrl()).toBe(FALLBACK);
  });

  it("resolves the endpoint once, however many calls need it", async () => {
    const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
    mockFetch.mockImplementation(async (url: string) =>
      url === `${PRIMARY}/` ? { ok: true } : { ok: true, json: async () => ({ embedding: mockEmbedding }) },
    );

    await Promise.all([provider.embed("a"), provider.embed("b")]);
    await provider.embed("c");

    expect(urls().filter((url) => url === `${PRIMARY}/`)).toHaveLength(1);
  });

  it("runs an endpoint-resolved hook once, after the decision and before the first embed request", async () => {
    const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
    const seen: { baseUrl: string; requests: string[] }[] = [];
    provider.whenEndpointResolved(() => seen.push({ baseUrl: provider.getBaseUrl(), requests: urls() }));
    expect(seen).toEqual([]);

    mockFetch.mockRejectedValueOnce(new Error("unreachable"));
    mockFetch.mockRejectedValueOnce(new Error("unreachable"));
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
    await provider.embed("first");
    await provider.embed("second");

    expect(seen).toEqual([{ baseUrl: FALLBACK, requests: [`${PRIMARY}/`, `${PRIMARY}/`] }]);
  });

  it("runs a hook registered after the decision at once", async () => {
    const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
    await provider.embed("x");

    const hook = vi.fn();
    provider.whenEndpointResolved(hook);

    expect(hook).toHaveBeenCalledOnce();
  });

  it("resolveEndpoint decides without embedding", async () => {
    const provider = new OllamaEmbeddings("nomic-embed-text", undefined, undefined, PRIMARY, true, 999, FALLBACK);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await provider.resolveEndpoint();

    expect(urls()).toEqual([`${PRIMARY}/`]);
    expect(provider.getBaseUrl()).toBe(FALLBACK);
  });
});
