import { describe, expect, it, vi } from "vitest";

import type { ResidualCalibrationRow } from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import type { CalibrationAnswer } from "../../../../../../src/core/domains/trajectory/codegraph/residual/calibration-answer.js";
import { StoredResidualThresholds } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-thresholds.js";

const row = (stratum: ResidualCalibrationRow["stratum"], over: Partial<ResidualCalibrationRow> = {}) => ({
  language: "ruby",
  stratum,
  threshold: 0.5,
  lowerBound: 0.94,
  n: 120,
  pi: 0.2,
  noneRates: { residual: 0.3, onMenu: 0.05, external: 0.8 },
  model: "kev@q8-2026-10",
  templateHash: "fold-1",
  graphFingerprint: "g1",
  createdAt: 1,
  ...over,
});

function fakeGraphDb(rows: ResidualCalibrationRow[]) {
  const written: ResidualCalibrationRow[][] = [];
  return {
    written,
    readResidualCalibration: vi.fn(async () => rows),
    writeResidualCalibration: vi.fn(async (_language: string, next: readonly ResidualCalibrationRow[]) => {
      written.push([...next]);
    }),
  };
}

const KEY = { providerId: "kev", servedVersion: "q8-2026-10", templateHash: "fold-1" };

describe("StoredResidualThresholds", () => {
  it("reads a calibration asked under the served model and fold, a null stratum as null", async () => {
    const graphDb = fakeGraphDb([row("block1"), row("fullMenu", { threshold: 0.8 }), row("none", { threshold: null })]);

    const stored = await new StoredResidualThresholds(graphDb).stored("ruby", KEY);

    expect(graphDb.readResidualCalibration).toHaveBeenCalledWith("ruby");
    expect(stored).toEqual({
      block1: { threshold: 0.5, lowerBound: 0.94, n: 120 },
      fullMenu: { threshold: 0.8, lowerBound: 0.94, n: 120 },
      none: null,
      pi: 0.2,
    });
  });

  it("finds no calibration when the served model version or the question fold changed", async () => {
    const graphDb = fakeGraphDb([row("block1"), row("fullMenu"), row("none")]);
    const source = new StoredResidualThresholds(graphDb);

    expect(await source.stored("ruby", { ...KEY, servedVersion: "q8-2026-11" })).toBeUndefined();
    expect(await source.stored("ruby", { ...KEY, templateHash: "fold-2" })).toBeUndefined();
  });

  it("matches any version of the provider when the run serves none", async () => {
    const graphDb = fakeGraphDb([row("block1"), row("fullMenu"), row("none")]);

    const stored = await new StoredResidualThresholds(graphDb).stored("ruby", {
      providerId: "kev",
      templateHash: "fold-1",
    });

    expect(stored?.fullMenu?.threshold).toBe(0.5);
  });

  it("only reads without an asker", () => {
    expect(new StoredResidualThresholds(fakeGraphDb([])).calibrate).toBeUndefined();
  });

  it("asks, fits against the run's mix and stores one row per stratum", async () => {
    const graphDb = fakeGraphDb([]);
    const records: CalibrationAnswer[] = Array.from({ length: 80 }, () => ({
      stratum: "block1",
      p: 0.9,
      top: "class",
      correct: true,
      menuSize: 3,
    }));
    const ask = vi.fn(async () => records);
    const source = new StoredResidualThresholds(graphDb, ask, () => 42);

    const fit = await source.calibrate?.({
      language: "ruby",
      key: KEY,
      mix: { answered: 10, noneAnswers: 2, menuSizeMix: { "2-4": 10 } },
      graphFingerprint: "g2",
    });

    expect(ask).toHaveBeenCalledExactlyOnceWith("ruby");
    expect(fit?.block1?.threshold).toBeGreaterThanOrEqual(0.5);
    expect(fit?.fullMenu).toBeNull();
    expect(graphDb.written[0]).toHaveLength(3);
    expect(graphDb.written[0]?.find((r) => r.stratum === "block1")).toMatchObject({
      language: "ruby",
      threshold: fit?.block1?.threshold,
      n: 80,
      model: "kev@q8-2026-10",
      templateHash: "fold-1",
      graphFingerprint: "g2",
      createdAt: 42,
    });
    expect(graphDb.written[0]?.find((r) => r.stratum === "fullMenu")).toMatchObject({ threshold: null, pi: null });
  });
});
