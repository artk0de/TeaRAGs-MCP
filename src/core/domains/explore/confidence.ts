/**
 * Search confidence — does this project contain what was asked for?
 *
 * A raw score cannot answer that question on its own: 0.55 means whatever the
 * embedding model decides it means, and on this index a nonsense query returns
 * a higher raw top score than a legitimate reranked one. The answer is not to
 * discard magnitude — measurement says magnitude is almost the whole signal
 * (mean-score AUC 0.997 on the calibration corpus) — but to read it against the
 * collection's OWN similarity scale rather than against a constant.
 *
 * That scale is `ScoreBackground`: the cosine between random pairs of stored
 * vectors, sampled at index time. A result set is scored as a z-score against
 * it, so an embedding-model swap moves scores and background together and the
 * calibration survives. Same principle as `Reranker#computeAdaptiveBounds`,
 * one level up.
 *
 * Two components:
 *   magnitude — z-score of the mean result score against the collection
 *               background, mapped into [0,1]. AUC 0.997 (dense) / 1.000
 *               (find_similar) on the corpus.
 *   locality  — normalised Shannon entropy over result directories. AUC 0.862 /
 *               0.819. Refines the verdict; magnitude decides it.
 *
 * Distribution SHAPE — leader peak, coefficient of variation — was measured and
 * removed: AUC 0.517 and 0.518, indistinguishable from coin flips, and 0.482
 * (below chance) on RRF-fused hybrid scores. The negative result is recorded in
 * `docs/superpowers/specs/2026-08-06-search-confidence-design.md`; read it
 * before reintroducing anything shape-based.
 *
 * Pure by construction — no Qdrant, no reranker — so the corpus harness
 * exercises exactly the function the server runs.
 */

import type { ScoreBackground } from "../../contracts/types/trajectory.js";
import { resolveLabel } from "./label-resolver.js";

/** One result reduced to the two fields confidence reads. */
export interface SearchConfidenceInput {
  score: number;
  relativePath?: string;
}

/** Advisory match-quality verdict attached to a search response. */
export interface SearchConfidence {
  /** Confidence in [0,1], rounded to two decimals. */
  value: number;
  /** `high` | `medium` | `low` — resolved through the shared label resolver. */
  label: string;
}

/** Calibration seam — the corpus harness sweeps the bounds it defaults to. */
export interface SearchConfidenceOptions {
  /** z below which magnitude reads 0. Defaults to {@link Z_FLOOR}. */
  zFloor?: number;
  /** z at which magnitude saturates at 1. Defaults to {@link Z_CEILING}. */
  zCeiling?: number;
}

/**
 * Component weights. Magnitude dominates because the corpus says it carries the
 * discrimination; locality is not decoration either — 0.862 AUC is real signal,
 * and it earns a weight that can move a verdict by one label, not overturn one.
 */
const WEIGHT_MAGNITUDE = 0.75;
const WEIGHT_LOCALITY = 0.25;

/**
 * Magnitude bounds in units of the collection's own similarity stddev. Fitted
 * on the calibration corpus: nonsense queries land near z ≈ 1.4, legitimate
 * ones near z ≈ 2.5.
 */
const Z_FLOOR = 1;
const Z_CEILING = 3;

/** A background measured on fewer pairs than this describes the sample, not the collection. */
const MIN_BACKGROUND_PAIRS = 50;

/**
 * Label cut-points. Keys are the calibration-corpus percentile ranks the
 * cut-points were read off, mirroring the `{pNN: label}` + `{NN: threshold}`
 * contract every git signal already uses.
 */
const CONFIDENCE_LABELS: Record<string, string> = { p0: "low", p50: "medium", p80: "high" };
const CONFIDENCE_CUT_POINTS: Record<number, number> = { 0: 0, 50: 0.35, 80: 0.55 };

/**
 * Confidence of a search response.
 *
 * Returns undefined when the collection's similarity scale is unknown — an
 * index built before the background was introduced, or one too small to
 * describe a distribution. Callers must omit the field rather than substitute a
 * number, because there is nothing to normalise against.
 */
export function computeSearchConfidence(
  results: readonly SearchConfidenceInput[],
  background: ScoreBackground | undefined,
  options: SearchConfidenceOptions = {},
): SearchConfidence | undefined {
  // Nothing found is a definitive answer and needs no scale to interpret.
  if (results.length === 0) return { value: 0, label: resolveLabel(0, CONFIDENCE_LABELS, CONFIDENCE_CUT_POINTS) };
  if (!isUsable(background)) return undefined;

  const raw =
    WEIGHT_MAGNITUDE * computeMagnitude(results, background, options) + WEIGHT_LOCALITY * computeLocality(results);
  const value = Math.round(clamp01(raw) * 100) / 100;

  return { value, label: resolveLabel(value, CONFIDENCE_LABELS, CONFIDENCE_CUT_POINTS) };
}

function isUsable(background: ScoreBackground | undefined): background is ScoreBackground {
  return background !== undefined && background.stddev > 0 && background.sampleCount >= MIN_BACKGROUND_PAIRS;
}

/**
 * How far above the collection's background similarity the result set sits,
 * in units of that collection's own dispersion, mapped into [0,1].
 *
 * The mean over the returned results rather than the top score alone: measured
 * AUC 0.997 against 0.990, and a mean is harder to move with one lucky hit.
 */
function computeMagnitude(
  results: readonly SearchConfidenceInput[],
  background: ScoreBackground,
  options: SearchConfidenceOptions,
): number {
  const floor = options.zFloor ?? Z_FLOOR;
  const ceiling = options.zCeiling ?? Z_CEILING;
  if (ceiling <= floor) return 0;

  const meanScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const z = (meanScore - background.mean) / background.stddev;

  return clamp01((z - floor) / (ceiling - floor));
}

/**
 * Directory clustering as normalised Shannon entropy: `1 - H / ln(n)` over the
 * parent directories of the result paths. All hits in one directory gives 1;
 * every hit in its own directory gives 0.
 *
 * Results without a path cannot be localised and are dropped from the sample. A
 * response carrying no paths scores 0 — unlocalisable, not clustered.
 */
function computeLocality(results: readonly SearchConfidenceInput[]): number {
  const buckets = new Map<string, number>();
  let counted = 0;
  for (const { relativePath } of results) {
    if (!relativePath) continue;
    const dir = directoryOf(relativePath);
    buckets.set(dir, (buckets.get(dir) ?? 0) + 1);
    counted += 1;
  }

  if (counted === 0) return 0;
  if (counted === 1) return 1;

  let entropy = 0;
  for (const count of buckets.values()) {
    const p = count / counted;
    entropy -= p * Math.log(p);
  }
  return clamp01(1 - entropy / Math.log(counted));
}

function directoryOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf("/");
  return cut === -1 ? "" : relativePath.slice(0, cut);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
