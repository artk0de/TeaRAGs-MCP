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

  it("treats the 'embedded' sentinel (explicit) as spawn-embedded, not a literal URL", async () => {
    // The registry persists qdrantUrl='embedded' (the daemon's port is
    // ephemeral). applyProjectDefaults feeds it in as the explicit URL; without
    // this it reached the benchmark verbatim → "Failed to parse URL from embedded".
    const resolveEmbedded = vi
      .fn()
      .mockResolvedValue({ mode: "embedded", url: "http://127.0.0.1:60123", release: vi.fn() });
    const out = await resolveTuneQdrantUrl("embedded", { resolveEmbedded, env: {} });
    expect(out.url).toBe("http://127.0.0.1:60123");
    expect(resolveEmbedded).toHaveBeenCalledOnce();
  });

  it("treats QDRANT_URL='embedded' (replayed from the registry) as spawn-embedded", async () => {
    const resolveEmbedded = vi.fn().mockResolvedValue({ mode: "external", url: "http://localhost:6333" });
    const out = await resolveTuneQdrantUrl(undefined, { resolveEmbedded, env: { QDRANT_URL: "embedded" } });
    expect(out.url).toBe("http://localhost:6333");
    expect(resolveEmbedded).toHaveBeenCalledOnce();
  });

  it("propagates errors from the embedded resolver (daemon spawn failures surface to the user)", async () => {
    const resolveEmbedded = vi.fn().mockRejectedValue(new Error("qdrant binary missing"));
    await expect(resolveTuneQdrantUrl(undefined, { resolveEmbedded, env: {} })).rejects.toThrow(
      "qdrant binary missing",
    );
  });
});
