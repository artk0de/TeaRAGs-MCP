import { afterEach, describe, expect, test, vi } from "vitest";

import { MODEL_INFO_BUDGET_MS, resolveEmbeddingModelParameters } from "../../src/bootstrap/embedding-parameters.js";
import type { EmbeddingProvider } from "../../src/core/adapters/embeddings/base.js";

/**
 * Minimal provider stub. Only the members this step touches are real; the rest
 * satisfy the interface.
 */
function stubProvider(overrides: Partial<EmbeddingProvider> & { model: string; dimensions: number }): {
  provider: EmbeddingProvider;
  currentDimensions: () => number;
} {
  let { dimensions } = overrides;
  const provider: EmbeddingProvider = {
    embed: async () => ({ embedding: [], dimensions }),
    embedBatch: async () => [],
    getDimensions: () => dimensions,
    getModel: () => overrides.model,
    checkHealth: async () => true,
    getProviderName: () => "stub",
    ...(overrides.resolveModelInfo
      ? {
          resolveModelInfo: async () => {
            const info = await overrides.resolveModelInfo?.();
            // Mirror the real adapters: adopting the reported width is what
            // makes the eager resolve worth doing at all.
            if (info) ({ dimensions } = info);
            return info;
          },
        }
      : {}),
  };
  return { provider, currentDimensions: () => dimensions };
}

describe("resolveEmbeddingModelParameters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("adopts the width the model's own config reports, over the table guess", async () => {
    const { provider, currentDimensions } = stubProvider({
      model: "someone/unlisted-embed:latest",
      dimensions: 768,
      resolveModelInfo: async () => ({
        model: "someone/unlisted-embed:latest",
        contextLength: 32768,
        dimensions: 1024,
      }),
    });

    await resolveEmbeddingModelParameters(provider, undefined);

    expect(currentDimensions()).toBe(1024);
  });

  test("stays silent when the provider described the model", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = stubProvider({
      model: "someone/unlisted-embed:latest",
      dimensions: 768,
      resolveModelInfo: async () => ({
        model: "someone/unlisted-embed:latest",
        contextLength: 32768,
        dimensions: 1024,
      }),
    });

    await resolveEmbeddingModelParameters(provider, undefined);

    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when nothing could verify the width — no model info, no registry entry", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = stubProvider({ model: "someone/unlisted-embed:latest", dimensions: 768 });

    await resolveEmbeddingModelParameters(provider, undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("someone/unlisted-embed:latest");
    expect(message).toContain("768");
    expect(message).toContain("EMBEDDING_DIMENSIONS");
  });

  test("stays silent when the registry knows the model, even without model info", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = stubProvider({ model: "mxbai-embed-large:latest", dimensions: 1024 });

    await resolveEmbeddingModelParameters(provider, undefined);

    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent when the operator pinned the width", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = stubProvider({ model: "someone/unlisted-embed:latest", dimensions: 1024 });

    await resolveEmbeddingModelParameters(provider, 1024);

    expect(warn).not.toHaveBeenCalled();
  });

  test("treats an unreachable provider as unverified rather than fatal", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider: EmbeddingProvider = {
      embed: async () => ({ embedding: [], dimensions: 768 }),
      embedBatch: async () => [],
      getDimensions: () => 768,
      getModel: () => "someone/unlisted-embed:latest",
      checkHealth: async () => false,
      getProviderName: () => "stub",
      resolveModelInfo: async () => {
        throw new Error("connection refused");
      },
    };

    await expect(resolveEmbeddingModelParameters(provider, undefined)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("is silent for a provider that has no model-info API but a known model", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = stubProvider({ model: "text-embedding-3-small", dimensions: 1536 });

    await resolveEmbeddingModelParameters(provider, undefined);

    expect(warn).not.toHaveBeenCalled();
  });

  // A refused connection fails instantly, but an endpoint that black-holes packets
  // does not: the request sits until the provider's own probe budget expires, and
  // that budget is sized for the index path, which can afford to wait. Startup
  // cannot — this runs on every MCP server start and every CLI command.
  describe("unresponsive endpoint", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test("gives up on its own budget instead of stalling startup", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const { provider } = stubProvider({
        model: "someone/unlisted-embed:latest",
        dimensions: 768,
        // Never settles — the shape of a black-holed endpoint.
        resolveModelInfo: async () => new Promise<never>(() => {}),
      });

      const pending = resolveEmbeddingModelParameters(provider, undefined);
      await vi.advanceTimersByTimeAsync(MODEL_INFO_BUDGET_MS + 1);

      await expect(pending).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    test("still prefers a live answer that arrives inside the budget", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const { provider, currentDimensions } = stubProvider({
        model: "someone/unlisted-embed:latest",
        dimensions: 768,
        resolveModelInfo: async () => {
          await new Promise((r) => setTimeout(r, MODEL_INFO_BUDGET_MS / 2));
          return { model: "someone/unlisted-embed:latest", contextLength: 32768, dimensions: 1024 };
        },
      });

      const pending = resolveEmbeddingModelParameters(provider, undefined);
      await vi.advanceTimersByTimeAsync(MODEL_INFO_BUDGET_MS + 1);

      await pending;
      expect(currentDimensions()).toBe(1024);
      expect(warn).not.toHaveBeenCalled();
    });

    test("survives a rejection that lands after the budget already expired", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      const { provider } = stubProvider({
        model: "someone/unlisted-embed:latest",
        dimensions: 768,
        resolveModelInfo: async () => {
          await new Promise((r) => setTimeout(r, MODEL_INFO_BUDGET_MS * 3));
          throw new Error("host unreachable");
        },
      });

      const pending = resolveEmbeddingModelParameters(provider, undefined);
      await vi.advanceTimersByTimeAsync(MODEL_INFO_BUDGET_MS + 1);
      await pending;

      // The abandoned request rejects long after nobody is awaiting it.
      await vi.advanceTimersByTimeAsync(MODEL_INFO_BUDGET_MS * 3);
      await Promise.resolve();

      process.off("unhandledRejection", unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });
  });
});
