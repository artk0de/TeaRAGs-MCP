import { describe, expect, it } from "vitest";

import { shareProviderLease } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-shared-lease.js";
import type { ResidualModelProvider } from "../../../../../../src/core/domains/trajectory/codegraph/residual/types.js";

function leasing(events: string[], failFirst = false): ResidualModelProvider {
  let attempts = 0;
  return {
    id: "kev",
    threshold: 0.7,
    promptTemplate: "T",
    version: async () => "v1",
    health: async () => ({ ok: true }),
    acquire: async () => {
      attempts++;
      if (failFirst && attempts === 1) throw new Error("busy");
      events.push("acquire");
      return { release: async () => void events.push("release") };
    },
    resolveGroup: async () => [],
  };
}

describe("shareProviderLease", () => {
  it("takes the hardware once for every asker and gives it back on release", async () => {
    const events: string[] = [];
    const shared = shareProviderLease(leasing(events));

    await (await shared.provider.acquire?.())?.release();
    await (await shared.provider.acquire?.())?.release();
    expect(events).toEqual(["acquire"]);

    await shared.release();
    expect(events).toEqual(["acquire", "release"]);
    expect(shared.provider).toMatchObject({ id: "kev", threshold: 0.7, promptTemplate: "T" });
  });

  it("lets a later asker retry after a failed acquire", async () => {
    const events: string[] = [];
    const shared = shareProviderLease(leasing(events, true));

    await expect(shared.provider.acquire?.()).rejects.toThrow("busy");
    await shared.provider.acquire?.();
    await shared.release();

    expect(events).toEqual(["acquire", "release"]);
  });

  it("leaves a provider without a lease as it is", async () => {
    const plain: ResidualModelProvider = { ...leasing([]), acquire: undefined };

    expect(shareProviderLease(plain).provider).toBe(plain);
  });
});
