/**
 * Tests for the TurboQuant startup reconcile: existing collections that lack
 * turbo-bits4 quantization are PATCHed to turbo at startup (idempotent, no
 * reindex). The `isTurboBits4` predicate is the pure decision gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTurboBits4, reconcileTurbo } from "../../src/bootstrap/config/turbo-reconcile.js";

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
});
