import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkOllamaAvailability } from "../../src/bootstrap/ollama.js";

describe("checkOllamaAvailability", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should skip check for non-ollama providers", async () => {
    await checkOllamaAvailability("openai");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should succeed when ollama is running and model exists", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Promise.resolve({ models: [{ name: "unclemusclez/jina-embeddings-v2-base-code:latest" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await expect(checkOllamaAvailability("ollama")).resolves.toBeUndefined();
  });

  it("should throw when ollama is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

    await expect(checkOllamaAvailability("ollama")).rejects.toThrow();
  });

  it("should throw when model is not found", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Promise.resolve({ models: [{ name: "other-model" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await expect(checkOllamaAvailability("ollama")).rejects.toThrow(/not found/i);
  });

  it("should use custom baseUrl and modelName", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Promise.resolve({ models: [{ name: "custom-model:latest" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await expect(checkOllamaAvailability("ollama", "http://custom:11434", "custom-model")).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith("http://custom:11434/api/version");
  });
});
