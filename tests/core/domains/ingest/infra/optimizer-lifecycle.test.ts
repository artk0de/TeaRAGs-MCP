import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../__helpers__/test-helpers.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { OptimizerLifecycle } from "../../../../../src/core/domains/ingest/infra/optimizer-lifecycle.js";

describe("OptimizerLifecycle", () => {
  it("calls resume even when wrapped fn throws", async () => {
    const qdrant = new MockQdrantManager();
    const pause = vi.spyOn(qdrant, "pauseOptimizer").mockResolvedValue();
    const resume = vi.spyOn(qdrant, "resumeOptimizer").mockResolvedValue();

    const lifecycle = new OptimizerLifecycle(qdrant as unknown as QdrantManager);
    await expect(
      lifecycle.with("test-collection", async () => {
        throw new Error("ingest failed");
      }),
    ).rejects.toThrow("ingest failed");

    expect(pause).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });
});
