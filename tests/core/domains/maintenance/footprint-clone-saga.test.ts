import { describe, expect, it, vi } from "vitest";

import { cloneCollectionFootprint } from "../../../../src/core/domains/maintenance/footprint/clone-saga.js";

function resolved(logicalName: string) {
  return {
    logicalName,
    physicalName: `${logicalName}_v1`,
    path: `/${logicalName}`,
    embeddingModel: "m",
    embeddingDimensions: 8,
    qdrantUrl: "embedded",
    codegraphEnabled: false,
  } as never;
}

function factoryOf(ids: string[], calls: string[], failOn?: string) {
  return {
    build: vi.fn((source: unknown, target: unknown) => ({
      context: { source, target },
      artifacts: ids.map((id) => ({
        id,
        addressing: "logical",
        clone: vi.fn(async () => {
          calls.push(`clone:${id}`);
          if (failOn === id) throw new Error(`boom ${id}`);
        }),
        remove: vi.fn(async () => {
          calls.push(`remove:${id}`);
          if (id === "stats") throw new Error("teardown failure is swallowed");
        }),
      })),
    })),
  } as never;
}

describe("cloneCollectionFootprint", () => {
  it("clones every artifact of the footprint in the factory's order", async () => {
    const calls: string[] = [];
    await cloneCollectionFootprint(factoryOf(["qdrant", "snapshot", "stats"], calls), resolved("a"), resolved("b"));
    expect(calls).toEqual(["clone:qdrant", "clone:snapshot", "clone:stats"]);
  });

  it("rolls back in reverse — the failing artifact included — and rethrows the clone's own error", async () => {
    const calls: string[] = [];
    const factory = factoryOf(["qdrant", "stats", "snapshot", "quarantine"], calls, "snapshot");

    await expect(cloneCollectionFootprint(factory, resolved("a"), resolved("b"))).rejects.toThrow("boom snapshot");

    // `stats.remove` throws and is swallowed: one dead teardown step must not
    // abandon the rest of the rollback.
    expect(calls).toEqual([
      "clone:qdrant",
      "clone:stats",
      "clone:snapshot",
      "remove:snapshot",
      "remove:stats",
      "remove:qdrant",
    ]);
  });
});
