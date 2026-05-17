import { describe, expect, it, vi } from "vitest";

import { HeartbeatGuard } from "../../../../src/core/domains/ingest/heartbeat-guard.js";

describe("HeartbeatGuard", () => {
  it("stops the heartbeat even if the wrapped function throws", async () => {
    const stop = vi.fn();
    const guard = new HeartbeatGuard({ start: () => stop, intervalMs: 100 });

    await expect(
      guard.run(async () => {
        throw new Error("simulated failure");
      }),
    ).rejects.toThrow("simulated failure");

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
