import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResidualCalibrationRow } from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import {
  bootstrapLowerBounds,
  CALIBRATION_CUTS,
  cumulativeThreshold,
  externalShare,
  fitResidualThresholds,
  mixtureModel,
  validResidualCalibration,
  wilsonLower,
  type CalibrationAnswer,
  type ResidualAnswerMix,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-calibration-fit.js";

/**
 * TaxDome phase 1 (bd tea-rags-mcp-2m83f.62, seed 20261018): S1 as `fullMenu`,
 * S2+S2T as `block1`, S3 (field-resolved dropped) as `external`; `residual` is
 * the labelled full-menu run the mixture was checked against.
 */
const PHASE1 = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../../../fixtures/residual-calibration/taxdome-phase1.json"), "utf-8"),
) as { records: CalibrationAnswer[]; residual: ResidualAnswerMix };

const stratum = (s: CalibrationAnswer["stratum"]): CalibrationAnswer[] => PHASE1.records.filter((r) => r.stratum === s);
const classTops = (rows: CalibrationAnswer[]): CalibrationAnswer[] => rows.filter((r) => r.top === "class");

/** `curves.json` → `mixtureCumulative`: menu-matched mixture precision per cut. */
const MIXTURE_CUMULATIVE: [number, number][] = [
  [0.4, 0.819],
  [0.45, 0.823],
  [0.5, 0.901],
  [0.55, 0.951],
  [0.6, 0.941],
  [0.65, 0.931],
  [0.7, 0.942],
  [0.75, 0.972],
  [0.8, 1],
  [0.85, 1],
  [0.9, 1],
];

const answer = (over: Partial<CalibrationAnswer>): CalibrationAnswer => ({
  stratum: "fullMenu",
  p: 0.9,
  top: "class",
  correct: true,
  menuSize: 3,
  ...over,
});

describe("wilsonLower", () => {
  it("is the lower end of the 95% Wilson score interval", () => {
    expect(wilsonLower(66, 67)).toBeCloseTo(0.92, 3);
    expect(wilsonLower(13, 18)).toBeCloseTo(0.491, 3);
    expect(wilsonLower(50, 50)).toBeCloseTo(0.929, 3);
  });

  it("is null without trials", () => {
    expect(wilsonLower(0, 0)).toBeNull();
  });
});

describe("cumulativeThreshold", () => {
  it("reproduces the phase-1 full-menu held-out cut", () => {
    expect(cumulativeThreshold(classTops(stratum("fullMenu")), 0.93)).toMatchObject({
      cut: 0.4,
      n: 295,
      precision: expect.closeTo(0.99, 3),
      lowerBound: expect.closeTo(0.971, 3),
      coverage: expect.closeTo(0.776, 3),
    });
  });

  it("reproduces the phase-1 block-1 cut over S2+S2T", () => {
    expect(cumulativeThreshold(classTops(stratum("block1")), 0.93)).toMatchObject({
      cut: 0.4,
      n: 281,
      precision: expect.closeTo(0.972, 3),
      lowerBound: expect.closeTo(0.945, 3),
    });
  });

  it("is null when no cut reaches the target", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ p: 0.9, correct: i % 2 === 0 }));
    expect(cumulativeThreshold(rows, 0.93)).toBeNull();
  });

  it("walks the cuts 0.40..0.95 in 0.05 steps", () => {
    expect(CALIBRATION_CUTS).toEqual([0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]);
  });
});

describe("externalShare", () => {
  it("places the residual none rate between the on-menu and the outside one", () => {
    expect(externalShare(0.5, 0.1, 0.9)).toBeCloseTo(0.5, 6);
  });

  it("clamps to [0, 1]", () => {
    expect(externalShare(0.95, 0.1, 0.9)).toBe(1);
    expect(externalShare(0.05, 0.1, 0.9)).toBe(0);
  });

  it("is null when outside sites answer none no more often than on-menu ones", () => {
    expect(externalShare(0.5, 0.4, 0.4)).toBeNull();
  });
});

describe("mixtureModel", () => {
  const model = mixtureModel({ onMenu: stratum("fullMenu"), external: stratum("external"), residual: PHASE1.residual });

  it("estimates the phase-1 outside share and none rates", () => {
    expect(model.pi).toBeCloseTo(0.733, 3);
    expect(model.noneRates.residual).toBeCloseTo(0.65, 3);
    expect(model.noneRates.onMenu).toBeCloseTo(0.05, 3);
    expect(model.noneRates.external).toBeCloseTo(0.869, 3);
  });

  it.each(MIXTURE_CUMULATIVE)("reproduces the phase-1 mixture precision at cut %s", (cut, expected) => {
    expect(Math.abs(model.classPrecision(cut)! - expected)).toBeLessThanOrEqual(0.005);
  });

  it("is null at a cut no class pick reaches", () => {
    expect(model.classPrecision(0.95)).toBeNull();
  });

  it("reads none answers as mostly right on TaxDome", () => {
    expect(model.nonePrecision(0.5)).toBeGreaterThan(0.98);
  });

  it("collapses to the on-menu precision when the residual run never answers none", () => {
    const onMenu = [answer({ correct: true }), answer({ correct: false }), answer({ top: "none", correct: false })];
    const external = [answer({ stratum: "external", top: "none", correct: true })];
    const m = mixtureModel({
      onMenu,
      external,
      residual: { answered: 10, noneAnswers: 0, menuSizeMix: { "2-4": 10 } },
    });
    expect(m.pi).toBe(0);
    expect(m.classPrecision(0.5)).toBeCloseTo(0.5, 6);
  });
});

describe("bootstrapLowerBounds", () => {
  const input = { onMenu: stratum("fullMenu"), external: stratum("external"), residual: PHASE1.residual };

  it("is deterministic for a seed", () => {
    const a = bootstrapLowerBounds(input, { seed: 7, resamples: 100 });
    const b = bootstrapLowerBounds(input, { seed: 7, resamples: 100 });
    expect(a).toEqual(b);
  });

  it("sits below the point estimate", () => {
    const lb = bootstrapLowerBounds(input, { seed: 7, resamples: 200 });
    const point = mixtureModel(input).classPrecision(0.6)!;
    expect(lb.classPrecision.get(0.6)).toBeLessThan(point);
  });
});

describe("fitResidualThresholds", () => {
  const fit = fitResidualThresholds(PHASE1.records, PHASE1.residual);

  it("floors block 1 at 0.5 when the curve clears the target lower", () => {
    expect(fit.block1).toMatchObject({ threshold: 0.5, n: 320 });
    expect(fit.block1!.lowerBound).toBeGreaterThanOrEqual(0.93);
  });

  it("puts the full-menu cut where the bootstrap lower bound clears 0.93", () => {
    // The point estimate clears 0.93 from 0.55; the outside-sample noise holds the bound below it until 0.80.
    expect(fit.fullMenu).toMatchObject({ threshold: 0.8, n: 400 });
    expect(fit.fullMenu!.lowerBound).toBeGreaterThanOrEqual(0.93);
  });

  it("puts the none cut at the floor on TaxDome", () => {
    expect(fit.none).toMatchObject({ threshold: 0.5, n: 216 });
    expect(fit.none!.lowerBound).toBeGreaterThanOrEqual(0.9);
  });

  it("reports the outside share it fitted with", () => {
    expect(fit.pi).toBeCloseTo(0.733, 3);
  });

  it("leaves a stratum with too few records to the defaults", () => {
    const thin = fitResidualThresholds(PHASE1.records, PHASE1.residual, { minRecords: 330 });
    expect(thin.block1).toBeNull();
    expect(thin.fullMenu).toBeNull();
    expect(thin.none).toBeNull();
  });

  it("fits nothing from the mixture when the residual run is too small", () => {
    const small = fitResidualThresholds(PHASE1.records, { ...PHASE1.residual, answered: 20, noneAnswers: 13 });
    expect(small.fullMenu).toBeNull();
    expect(small.none).toBeNull();
    expect(small.block1).not.toBeNull();
  });
});

describe("validResidualCalibration", () => {
  const row = (over: Partial<ResidualCalibrationRow> = {}): ResidualCalibrationRow => ({
    language: "ruby",
    stratum: "block1",
    threshold: 0.5,
    lowerBound: 0.95,
    n: 320,
    pi: 0.73,
    noneRates: { residual: 0.65, onMenu: 0.05, external: 0.87 },
    model: "kev-1",
    templateHash: "fold-a",
    graphFingerprint: "g1",
    createdAt: 1,
    ...over,
  });

  it("keeps rows asked under the current model and fold", () => {
    expect(validResidualCalibration([row()], { model: "kev-1", templateHash: "fold-a" })).toHaveLength(1);
  });

  it("drops the whole calibration when any row was asked under another model or fold", () => {
    expect(validResidualCalibration([row({ model: "kev-0" })], { model: "kev-1", templateHash: "fold-a" })).toBeNull();
    expect(
      validResidualCalibration([row(), row({ stratum: "none", templateHash: "fold-b" })], {
        model: "kev-1",
        templateHash: "fold-a",
      }),
    ).toBeNull();
  });

  it("is null when nothing is stored", () => {
    expect(validResidualCalibration([], { model: "kev-1", templateHash: "fold-a" })).toBeNull();
  });
});
