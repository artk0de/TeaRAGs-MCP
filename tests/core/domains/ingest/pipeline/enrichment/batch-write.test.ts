import { describe, expect, it, vi } from "vitest";

import { batchSetPayloadWithRetry } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/batch-write.js";

const OPS = [{ payload: { enrichedAt: "ts" }, points: ["c1"], key: "git.file" }];

describe("batchSetPayloadWithRetry", () => {
  it("returns true on first-attempt success (single call)", async () => {
    const qdrant = { batchSetPayload: vi.fn().mockResolvedValue(undefined) };

    const ok = await batchSetPayloadWithRetry(qdrant as any, "coll", OPS, { baseDelayMs: 0 });

    expect(ok).toBe(true);
    expect(qdrant.batchSetPayload).toHaveBeenCalledTimes(1);
    expect(qdrant.batchSetPayload).toHaveBeenCalledWith("coll", OPS);
  });

  it("retries a transient failure and returns true when a later attempt succeeds", async () => {
    // Models a transient Qdrant blip (timeout / 429): first write throws,
    // the retry lands. Without retry the chunks would silently lose signals.
    const qdrant = {
      batchSetPayload: vi.fn().mockRejectedValueOnce(new Error("ETIMEDOUT")).mockResolvedValueOnce(undefined),
    };

    const ok = await batchSetPayloadWithRetry(qdrant as any, "coll", OPS, { baseDelayMs: 0 });

    expect(ok).toBe(true);
    expect(qdrant.batchSetPayload).toHaveBeenCalledTimes(2);
  });

  it("returns false after exhausting maxAttempts on persistent failure", async () => {
    const qdrant = { batchSetPayload: vi.fn().mockRejectedValue(new Error("down")) };

    const ok = await batchSetPayloadWithRetry(qdrant as any, "coll", OPS, { maxAttempts: 3, baseDelayMs: 0 });

    expect(ok).toBe(false);
    expect(qdrant.batchSetPayload).toHaveBeenCalledTimes(3);
  });
});
