import { describe, expect, it, vi } from "vitest";

import { resolveTuneQdrantUrl } from "../../src/cli/qdrant-url-resolver.js";

describe("resolveTuneQdrantUrl", () => {
  it("returns explicit URL without calling the embedded resolver", async () => {
    const resolveEmbedded = vi.fn();
    const out = await resolveTuneQdrantUrl("http://custom:6333", {
      resolveEmbedded,
      env: {},
    });
    expect(out).toEqual({ url: "http://custom:6333" });
    expect(resolveEmbedded).not.toHaveBeenCalled();
  });

  it("passes through QDRANT_URL env without calling the embedded resolver", async () => {
    const resolveEmbedded = vi.fn();
    const out = await resolveTuneQdrantUrl(undefined, {
      resolveEmbedded,
      env: { QDRANT_URL: "http://env-qdrant:7777" },
    });
    expect(out).toEqual({ url: "http://env-qdrant:7777" });
    expect(resolveEmbedded).not.toHaveBeenCalled();
  });

  it("delegates to embedded resolver when neither explicit nor env URL set (external probe wins)", async () => {
    const resolveEmbedded = vi.fn().mockResolvedValue({
      mode: "external",
      url: "http://localhost:6333",
    });
    const out = await resolveTuneQdrantUrl(undefined, {
      resolveEmbedded,
      env: {},
    });
    expect(out).toEqual({ url: "http://localhost:6333", release: undefined });
    expect(resolveEmbedded).toHaveBeenCalledOnce();
  });

  it("returns the embedded daemon URL and release handle when daemon is spawned", async () => {
    const release = vi.fn();
    const resolveEmbedded = vi.fn().mockResolvedValue({
      mode: "embedded",
      url: "http://127.0.0.1:57321",
      release,
    });
    const out = await resolveTuneQdrantUrl(undefined, {
      resolveEmbedded,
      env: {},
    });
    expect(out.url).toBe("http://127.0.0.1:57321");
    expect(out.release).toBe(release);
    expect(release).not.toHaveBeenCalled();
  });

  it("propagates errors from the embedded resolver (daemon spawn failures surface to the user)", async () => {
    const resolveEmbedded = vi.fn().mockRejectedValue(new Error("qdrant binary missing"));
    await expect(resolveTuneQdrantUrl(undefined, { resolveEmbedded, env: {} })).rejects.toThrow(
      "qdrant binary missing",
    );
  });
});
