/**
 * Per-repo Kev accept thresholds fitted from answers on statically settled
 * sites (bd tea-rags-mcp-2m83f.62). Pure: the caller asks the sample, this
 * module turns the answers into thresholds.
 *
 * - Block 1: the lowest cut whose cumulative Wilson lower bound clears the
 *   class target — name-matched held-out sites already include off-block truth.
 * - Full menu: a held-out site always has its truth on the menu, so the raw
 *   curve is optimistic. Precision is modelled as a mixture of on-menu sites
 *   and outside sites, `prec(t) = (1−π)·TP_S1(t) / ((1−π)·C_S1(t) + π·C_S3(t))`,
 *   with the outside answers reweighted to the residual run's menu-size mix and
 *   `π` solved label-free from the residual run's none rate. The cut is where a
 *   seeded bootstrap lower bound clears the target.
 * - None: the same mixture over none answers.
 *
 * Every threshold is floored at {@link CALIBRATION_FLOOR}: there is no evidence
 * below it.
 */
import type {
  ResidualCalibrationNoneRates,
  ResidualCalibrationRow,
} from "../../../../contracts/types/codegraph-residual.js";
import { mulberry32 } from "../../../../primitives/math/index.js";

/** The sample a calibration answer came from. */
export type CalibrationAnswerStratum = "fullMenu" | "block1" | "external";

/** Kev's top answer on one sampled site, scored against the static truth. */
export interface CalibrationAnswer {
  stratum: CalibrationAnswerStratum;
  /** Probability of the top answer. */
  p: number;
  top: "class" | "none";
  correct: boolean;
  /** Classes on the menu, `none` excluded. */
  menuSize: number;
}

export type MenuSizeBucket = "1" | "2-4" | "5+";

/** The residual run's own answers: its none share and menu-size mix. */
export interface ResidualAnswerMix {
  answered: number;
  noneAnswers: number;
  /** Residual questions per menu-size bucket. */
  menuSizeMix: Readonly<Partial<Record<MenuSizeBucket, number>>>;
}

export interface MixtureInput {
  onMenu: readonly CalibrationAnswer[];
  external: readonly CalibrationAnswer[];
  residual: ResidualAnswerMix;
}

export interface CumulativeThreshold {
  cut: number;
  /** Answers at or above the cut. */
  n: number;
  precision: number;
  lowerBound: number;
  /** Share of the given answers at or above the cut. */
  coverage: number;
}

export interface MixtureModel {
  pi: number;
  noneRates: ResidualCalibrationNoneRates;
  /** Class-answer precision at `p ≥ cut`; `null` when no class pick reaches it. */
  classPrecision: (cut: number) => number | null;
  /** None-answer precision at `p ≥ cut`; `null` when no none answer reaches it. */
  nonePrecision: (cut: number) => number | null;
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
  /** Lower-tail quantile read as the bound. */
  quantile?: number;
  cuts?: readonly number[];
}

export interface BootstrapLowerBounds {
  classPrecision: Map<number, number>;
  nonePrecision: Map<number, number>;
}

export interface StratumFit {
  threshold: number;
  lowerBound: number;
  n: number;
}

export interface ResidualThresholdFit {
  /** `null` = too few records or no cut clears the target: keep the default. */
  block1: StratumFit | null;
  fullMenu: StratumFit | null;
  none: StratumFit | null;
  pi: number | null;
  noneRates: ResidualCalibrationNoneRates | null;
}

export interface FitOptions {
  /** Fewest records a stratum (and the residual run) needs to be fitted. */
  minRecords?: number;
  classTarget?: number;
  noneTarget?: number;
  floor?: number;
  bootstrap?: BootstrapOptions;
}

export const CALIBRATION_CUTS: readonly number[] = Array.from(
  { length: 12 },
  (_, i) => Math.round((0.4 + 0.05 * i) * 100) / 100,
);
export const CALIBRATION_FLOOR = 0.5;
export const CALIBRATION_CLASS_TARGET = 0.93;
export const CALIBRATION_NONE_TARGET = 0.9;
export const CALIBRATION_MIN_RECORDS = 60;
export const CALIBRATION_BOOTSTRAP_RESAMPLES = 500;
export const CALIBRATION_BOOTSTRAP_SEED = 20261018;
const BOOTSTRAP_QUANTILE = 0.025;

export function wilsonLower(k: number, n: number, z = 1.96): number | null {
  if (n === 0) return null;
  const ph = k / n;
  const d = 1 + (z * z) / n;
  const centre = (ph + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
  return centre - half;
}

/** The lowest cut whose answers at or above it have a Wilson lower bound ≥ `target`. */
export function cumulativeThreshold(
  records: readonly { p: number; correct: boolean }[],
  target: number,
  cuts: readonly number[] = CALIBRATION_CUTS,
): CumulativeThreshold | null {
  for (const cut of cuts) {
    const above = records.filter((r) => r.p >= cut);
    const k = above.filter((r) => r.correct).length;
    const lowerBound = wilsonLower(k, above.length);
    if (lowerBound !== null && lowerBound >= target) {
      return {
        cut,
        n: above.length,
        precision: k / above.length,
        lowerBound,
        coverage: above.length / Math.max(1, records.length),
      };
    }
  }
  return null;
}

export function menuSizeBucket(menuSize: number): MenuSizeBucket {
  if (menuSize <= 1) return "1";
  return menuSize <= 4 ? "2-4" : "5+";
}

/**
 * The outside share of the residual run, from where its none rate falls between
 * the on-menu and the outside one, clamped to [0, 1]. `null` when outside sites
 * answer none no more often than on-menu ones — the rates cannot separate them.
 */
export function externalShare(
  residualNoneRate: number,
  onMenuNoneRate: number,
  externalNoneRate: number,
): number | null {
  if (externalNoneRate <= onMenuNoneRate) return null;
  return Math.min(1, Math.max(0, (residualNoneRate - onMenuNoneRate) / (externalNoneRate - onMenuNoneRate)));
}

/** Per-bucket weight taking the outside answers to the residual run's menu-size mix. */
function menuSizeWeights(
  mix: ResidualAnswerMix["menuSizeMix"],
  external: readonly CalibrationAnswer[],
): Map<MenuSizeBucket, number> {
  const targetTotal = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
  const source = new Map<MenuSizeBucket, number>();
  for (const r of external) source.set(menuSizeBucket(r.menuSize), (source.get(menuSizeBucket(r.menuSize)) ?? 0) + 1);
  const weights = new Map<MenuSizeBucket, number>();
  for (const [bucket, count] of source) {
    const targetShare = targetTotal > 0 ? (mix[bucket] ?? 0) / targetTotal : 0;
    weights.set(bucket, targetShare / (count / external.length));
  }
  return weights;
}

/** The mixture over a fixed sample; `pi` 0 when the none rates cannot separate the strata. */
export function mixtureModel(input: MixtureInput): MixtureModel {
  return mixtureFrom(
    input.onMenu,
    input.external,
    input.residual.noneAnswers / input.residual.answered,
    input.residual,
  );
}

function mixtureFrom(
  onMenu: readonly CalibrationAnswer[],
  external: readonly CalibrationAnswer[],
  residualNoneRate: number,
  residual: ResidualAnswerMix,
): MixtureModel {
  const weights = menuSizeWeights(residual.menuSizeMix, external);
  const w = (r: CalibrationAnswer): number => weights.get(menuSizeBucket(r.menuSize)) ?? 0;
  const externalTotal = external.reduce((a, r) => a + w(r), 0);
  const onMenuNoneRate = onMenu.filter((r) => r.top === "none").length / onMenu.length;
  const externalNoneRate = externalTotal > 0 ? sumOf(external, w, (r) => r.top === "none") / externalTotal : 0;
  const pi = externalShare(residualNoneRate, onMenuNoneRate, externalNoneRate) ?? 0;
  const onMenuShare = (pick: (r: CalibrationAnswer) => boolean): number => onMenu.filter(pick).length / onMenu.length;
  const externalShareOf = (pick: (r: CalibrationAnswer) => boolean): number =>
    externalTotal > 0 ? sumOf(external, w, pick) / externalTotal : 0;
  const precision = (top: CalibrationAnswer["top"], cut: number): number | null => {
    const at = (r: CalibrationAnswer): boolean => r.top === top && r.p >= cut;
    const right = (r: CalibrationAnswer): boolean => at(r) && r.correct;
    const den = (1 - pi) * onMenuShare(at) + pi * externalShareOf(at);
    if (den === 0) return null;
    return ((1 - pi) * onMenuShare(right) + pi * externalShareOf(right)) / den;
  };
  return {
    pi,
    noneRates: { residual: residualNoneRate, onMenu: onMenuNoneRate, external: externalNoneRate },
    classPrecision: (cut) => precision("class", cut),
    nonePrecision: (cut) => precision("none", cut),
  };
}

function sumOf(
  rows: readonly CalibrationAnswer[],
  weight: (r: CalibrationAnswer) => number,
  pick: (r: CalibrationAnswer) => boolean,
): number {
  let total = 0;
  for (const r of rows) if (pick(r)) total += weight(r);
  return total;
}

/**
 * Per-cut lower bounds of the mixture precisions: both samples are resampled
 * with replacement and the residual none count is redrawn binomially, so `π`
 * carries its own noise. Deterministic for a seed. A resample where no answer
 * reaches the cut counts as precision 0.
 */
export function bootstrapLowerBounds(input: MixtureInput, options: BootstrapOptions = {}): BootstrapLowerBounds {
  const resamples = options.resamples ?? CALIBRATION_BOOTSTRAP_RESAMPLES;
  const quantile = options.quantile ?? BOOTSTRAP_QUANTILE;
  const cuts = options.cuts ?? CALIBRATION_CUTS;
  const random = mulberry32(options.seed ?? CALIBRATION_BOOTSTRAP_SEED);
  const draws = { class: cuts.map((): number[] => []), none: cuts.map((): number[] => []) };
  const residualRate = input.residual.noneAnswers / input.residual.answered;
  for (let b = 0; b < resamples; b++) {
    const onMenu = resample(input.onMenu, random);
    const external = resample(input.external, random);
    let none = 0;
    for (let i = 0; i < input.residual.answered; i++) if (random() < residualRate) none++;
    const model = mixtureFrom(onMenu, external, none / input.residual.answered, input.residual);
    cuts.forEach((cut, i) => {
      draws.class[i].push(model.classPrecision(cut) ?? 0);
      draws.none[i].push(model.nonePrecision(cut) ?? 0);
    });
  }
  const bound = (values: number[]): number => {
    values.sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor(quantile * values.length))];
  };
  return {
    classPrecision: new Map(cuts.map((cut, i) => [cut, bound(draws.class[i])])),
    nonePrecision: new Map(cuts.map((cut, i) => [cut, bound(draws.none[i])])),
  };
}

function resample<T>(rows: readonly T[], random: () => number): T[] {
  return Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
}

/** Block 1, full-menu and none thresholds from one calibration sample and the residual run's answer mix. */
export function fitResidualThresholds(
  records: readonly CalibrationAnswer[],
  residual: ResidualAnswerMix,
  options: FitOptions = {},
): ResidualThresholdFit {
  const minRecords = options.minRecords ?? CALIBRATION_MIN_RECORDS;
  const floor = options.floor ?? CALIBRATION_FLOOR;
  const cuts = (options.bootstrap?.cuts ?? CALIBRATION_CUTS).filter((cut) => cut >= floor);
  const of = (s: CalibrationAnswerStratum): CalibrationAnswer[] => records.filter((r) => r.stratum === s);
  const block1 = of("block1");
  const onMenu = of("fullMenu");
  const external = of("external");

  const block1Cut =
    block1.length >= minRecords
      ? cumulativeThreshold(
          block1.filter((r) => r.top === "class"),
          options.classTarget ?? CALIBRATION_CLASS_TARGET,
          cuts,
        )
      : null;
  const fit: ResidualThresholdFit = {
    block1: block1Cut && { threshold: block1Cut.cut, lowerBound: block1Cut.lowerBound, n: block1.length },
    fullMenu: null,
    none: null,
    pi: null,
    noneRates: null,
  };
  if (onMenu.length < minRecords || external.length < minRecords || residual.answered < minRecords) return fit;

  const input = { onMenu, external, residual };
  const point = mixtureModel(input);
  const onMenuNoneRate = point.noneRates.onMenu;
  if (externalShare(point.noneRates.residual, onMenuNoneRate, point.noneRates.external) === null) return fit;
  const bounds = bootstrapLowerBounds(input, { ...options.bootstrap, cuts });
  const lowest = (byCut: Map<number, number>, target: number, n: number): StratumFit | null => {
    for (const cut of cuts) {
      const lowerBound = byCut.get(cut) ?? 0;
      if (lowerBound >= target) return { threshold: cut, lowerBound, n };
    }
    return null;
  };
  return {
    ...fit,
    fullMenu: lowest(bounds.classPrecision, options.classTarget ?? CALIBRATION_CLASS_TARGET, onMenu.length),
    none: lowest(bounds.nonePrecision, options.noneTarget ?? CALIBRATION_NONE_TARGET, external.length),
    pi: point.pi,
    noneRates: point.noneRates,
  };
}

/**
 * The stored calibration when every row was asked under the current model and
 * question fold; `null` otherwise — a calibration is all-or-nothing.
 */
export function validResidualCalibration(
  rows: readonly ResidualCalibrationRow[],
  current: { model: string; templateHash: string },
): readonly ResidualCalibrationRow[] | null {
  if (rows.length === 0) return null;
  return rows.every((r) => r.model === current.model && r.templateHash === current.templateHash) ? rows : null;
}
