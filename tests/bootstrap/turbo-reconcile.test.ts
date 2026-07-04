/**
 * Tests for the TurboQuant startup reconcile: existing collections that lack
 * turbo-bits4 quantization are PATCHed to turbo at startup (idempotent, no
 * reindex). The `isTurboBits4` predicate is the pure decision gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isStrictModeApplied,
  isTurboBits4,
  reconcileStrictMode,
  reconcileTurbo,
  reportTurboMigration,
  waitForQuantization,
  type TurboMigrationEvent,
} from "../../src/bootstrap/config/turbo-reconcile.js";

const TURBO_CONFIG = { turbo: { bits: "bits4", always_ram: true } } as const;

function makeManager(overrides: Record<string, unknown> = {}) {
  return {
    listCollections: vi.fn().mockResolvedValue(["col"]),
    getQuantizationConfig: vi.fn().mockResolvedValue(undefined),
    updateCollectionQuantization: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("isTurboBits4", () => {
  it("returns true only for a turbo bits4 config", () => {
    expect(isTurboBits4({ turbo: { bits: "bits4", always_ram: true } })).toBe(true);
  });

  it("returns false for scalar quantization", () => {
    expect(isTurboBits4({ scalar: { type: "int8", always_ram: true } })).toBe(false);
  });

  it("returns false for undefined / null / wrong bit width", () => {
    expect(isTurboBits4(undefined)).toBe(false);
    expect(isTurboBits4(null)).toBe(false);
    expect(isTurboBits4({ turbo: { bits: "bits8" } })).toBe(false);
  });
});

describe("reconcileTurbo", () => {
  let manager: ReturnType<typeof makeManager>;

  beforeEach(() => {
    manager = makeManager();
  });

  it("calls updateCollectionQuantization when collection lacks turbo", async () => {
    manager.getQuantizationConfig.mockResolvedValue(undefined);

    await reconcileTurbo(manager as never, ["col"]);

    expect(manager.updateCollectionQuantization).toHaveBeenCalledWith("col");
  });

  it("is a no-op when collection already has turbo bits4", async () => {
    manager.getQuantizationConfig.mockResolvedValue(TURBO_CONFIG);

    await reconcileTurbo(manager as never, ["col"]);

    expect(manager.updateCollectionQuantization).not.toHaveBeenCalled();
  });

  it("lists collections itself when no explicit list is passed", async () => {
    manager.listCollections.mockResolvedValue(["a", "b"]);
    manager.getQuantizationConfig.mockResolvedValue(undefined);

    await reconcileTurbo(manager as never);

    expect(manager.listCollections).toHaveBeenCalledTimes(1);
    expect(manager.updateCollectionQuantization).toHaveBeenCalledWith("a");
    expect(manager.updateCollectionQuantization).toHaveBeenCalledWith("b");
  });

  it("returns the names of the collections it migrated", async () => {
    manager.listCollections.mockResolvedValue(["a", "b"]);
    manager.getQuantizationConfig.mockImplementation(async (name: string) => (name === "b" ? TURBO_CONFIG : undefined));

    await expect(reconcileTurbo(manager as never)).resolves.toEqual(["a"]);
  });

  it("returns an empty array when every collection is already turbo", async () => {
    manager.getQuantizationConfig.mockResolvedValue(TURBO_CONFIG);

    await expect(reconcileTurbo(manager as never, ["col"])).resolves.toEqual([]);
  });
});

describe("waitForQuantization", () => {
  const noSleep = async (): Promise<void> => {};

  it("resolves 'settled' as soon as the collection status reaches green", async () => {
    const getCollectionStatus = vi
      .fn()
      .mockResolvedValueOnce("yellow")
      .mockResolvedValueOnce("yellow")
      .mockResolvedValueOnce("green");

    await expect(
      waitForQuantization({ getCollectionStatus }, "col", { maxPolls: 10, intervalMs: 1, sleep: noSleep }),
    ).resolves.toBe("settled");
    expect(getCollectionStatus).toHaveBeenCalledTimes(3);
  });

  it("resolves 'background' when still optimizing at the poll cap", async () => {
    const getCollectionStatus = vi.fn().mockResolvedValue("yellow");

    await expect(
      waitForQuantization({ getCollectionStatus }, "col", { maxPolls: 3, intervalMs: 1, sleep: noSleep }),
    ).resolves.toBe("background");
    expect(getCollectionStatus).toHaveBeenCalledTimes(3);
  });

  it("uses the real setTimeout-based default sleep when no `sleep` override is passed", async () => {
    // Every other test in this describe injects `sleep: noSleep` to keep the
    // suite instant — the production default (`options.sleep ?? (async (ms) =>
    // new Promise((resolve) => setTimeout(resolve, ms)))`) has never actually
    // run. Omitting `sleep` here forces the real setTimeout-based wait, proving
    // production callers (which never pass `sleep`) actually delay between polls.
    const getCollectionStatus = vi.fn().mockResolvedValueOnce("yellow").mockResolvedValueOnce("green");

    const start = Date.now();
    await expect(waitForQuantization({ getCollectionStatus }, "col", { maxPolls: 5, intervalMs: 10 })).resolves.toBe(
      "settled",
    );
    const elapsed = Date.now() - start;

    expect(getCollectionStatus).toHaveBeenCalledTimes(2);
    // One real sleep of ~10ms must have elapsed between the "yellow" and "green" polls.
    expect(elapsed).toBeGreaterThanOrEqual(9);
  });
});

describe("reportTurboMigration", () => {
  const noSleep = async (): Promise<void> => {};

  it("emits a start then a terminal 'done' event per migrated collection", async () => {
    const events: TurboMigrationEvent[] = [];
    const getCollectionStatus = vi.fn().mockResolvedValue("green");

    await reportTurboMigration(
      { getCollectionStatus },
      ["a"],
      (e) => events.push(e),
      { maxPolls: 5, intervalMs: 1, sleep: noSleep },
      () => 0,
    );

    expect(events).toEqual([
      { collection: "a", stage: "start" },
      { collection: "a", stage: "done", elapsedMs: 0 },
    ]);
  });

  it("emits a 'background' terminal event when the poll cap is hit", async () => {
    const events: TurboMigrationEvent[] = [];
    const getCollectionStatus = vi.fn().mockResolvedValue("yellow");

    await reportTurboMigration(
      { getCollectionStatus },
      ["a"],
      (e) => events.push(e),
      { maxPolls: 2, intervalMs: 1, sleep: noSleep },
      () => 0,
    );

    expect(events.at(-1)).toEqual({ collection: "a", stage: "background", elapsedMs: 0 });
  });
});

describe("isStrictModeApplied", () => {
  it("returns true when the live percent matches desired", () => {
    expect(
      isStrictModeApplied({ enabled: true, max_resident_memory_percent: 90 }, { maxResidentMemoryPercent: 90 }),
    ).toBe(true);
  });

  it("returns false when the live percent differs from desired", () => {
    expect(
      isStrictModeApplied({ enabled: true, max_resident_memory_percent: 80 }, { maxResidentMemoryPercent: 90 }),
    ).toBe(false);
  });

  it("returns false for undefined / null live config when a field is desired", () => {
    expect(isStrictModeApplied(undefined, { maxResidentMemoryPercent: 90 })).toBe(false);
    expect(isStrictModeApplied(null, { searchMaxBatchsize: 256 })).toBe(false);
  });

  it("matches on the search batch cap", () => {
    expect(isStrictModeApplied({ enabled: true, search_max_batchsize: 256 }, { searchMaxBatchsize: 256 })).toBe(true);
    expect(isStrictModeApplied({ enabled: true, search_max_batchsize: 128 }, { searchMaxBatchsize: 256 })).toBe(false);
  });
});

describe("reconcileStrictMode", () => {
  function makeStrictManager(overrides: Record<string, unknown> = {}) {
    return {
      listCollections: vi.fn().mockResolvedValue(["col"]),
      getStrictModeConfig: vi.fn().mockResolvedValue(undefined),
      updateCollectionStrictMode: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("updates a collection whose live strict config differs from desired", async () => {
    const manager = makeStrictManager();

    await reconcileStrictMode(manager as never, { maxResidentMemoryPercent: 90 }, ["col"]);

    expect(manager.updateCollectionStrictMode).toHaveBeenCalledWith("col", { maxResidentMemoryPercent: 90 });
  });

  it("is a no-op when the collection already matches desired", async () => {
    const manager = makeStrictManager({
      getStrictModeConfig: vi.fn().mockResolvedValue({ enabled: true, max_resident_memory_percent: 90 }),
    });

    await reconcileStrictMode(manager as never, { maxResidentMemoryPercent: 90 }, ["col"]);

    expect(manager.updateCollectionStrictMode).not.toHaveBeenCalled();
  });

  it("is a no-op when desired is empty (both fields unset)", async () => {
    const manager = makeStrictManager();

    await reconcileStrictMode(manager as never, {}, ["col"]);

    expect(manager.getStrictModeConfig).not.toHaveBeenCalled();
    expect(manager.updateCollectionStrictMode).not.toHaveBeenCalled();
  });

  it("lists collections itself when no explicit list is passed", async () => {
    const manager = makeStrictManager({ listCollections: vi.fn().mockResolvedValue(["a", "b"]) });

    await reconcileStrictMode(manager as never, { maxResidentMemoryPercent: 70 });

    expect(manager.listCollections).toHaveBeenCalledTimes(1);
    expect(manager.updateCollectionStrictMode).toHaveBeenCalledWith("a", { maxResidentMemoryPercent: 70 });
    expect(manager.updateCollectionStrictMode).toHaveBeenCalledWith("b", { maxResidentMemoryPercent: 70 });
  });
});
