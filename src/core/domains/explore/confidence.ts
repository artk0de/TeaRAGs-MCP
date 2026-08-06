/**
 * Search confidence — how much the SHAPE of a response looks like a find.
 *
 * The consumer of a search response is an LLM agent, and a raw score does not
 * tell it whether the project contains the thing it asked about: a nonsense
 * query returns a top score of ~0.55 while a legitimate reranked one returns
 * 0.36–0.46. Absolute magnitude is a property of the embedding model, so no
 * threshold is ever applied to a raw score here — the same reasoning that makes
 * `Reranker#computeAdaptiveBounds` normalise against the result batch rather
 * than against a constant.
 *
 * What is measured instead is the shape of the score distribution INSIDE one
 * response, over three scale-free components:
 *
 *   peak     — how far the leader stands out from its own tail
 *   spread   — coefficient of variation; a flat plateau is noise
 *   locality — how tightly the hits cluster in the directory tree
 *
 * `locality` carries deliberately the smallest weight: queries such as
 * "error handling" are legitimately scattered across the tree and would be
 * punished by it. It refines the verdict, it never decides it.
 *
 * Pure by construction — no Qdrant, no reranker, no payload readers — so the
 * corpus calibration in `scripts/search-confidence-corpus.ts` exercises exactly
 * the function the server runs. Design: `docs/superpowers/specs/
 * 2026-08-06-search-confidence-design.md`.
 */

import { resolveLabel } from "./label-resolver.js";

/** One result reduced to the two fields the shape statistics read. */
export interface SearchConfidenceInput {
  score: number;
  relativePath?: string;
}

/** Advisory match-quality verdict attached to a search response. */
export interface SearchConfidence {
  /** Shape score in [0,1], rounded to two decimals. */
  value: number;
  /** `high` | `medium` | `low` — resolved through the shared label resolver. */
  label: string;
}

/** Component weights. locality is intentionally the weakest of the three. */
const WEIGHT_PEAK = 0.4;
const WEIGHT_SPREAD = 0.4;
const WEIGHT_LOCALITY = 0.2;

/**
 * Coefficient of variation at which `spread` contributes exactly 0.5.
 * Saturating map `cv / (cv + k)` — no clipping, no hard ceiling.
 * Calibrated against the live-index corpus (see the design spec).
 */
const SPREAD_CV_HALF_POINT = 0.11;

/**
 * Label cut-points. Keys are the calibration-corpus percentile ranks the
 * cut-points were read off, mirroring the `{pNN: label}` + `{NN: threshold}`
 * contract every git signal already uses.
 *
 * `high` is the p90 of the nonsense corpus. `medium` is the p10 of the
 * legitimate corpus (0.19), raised to 0.21 so that perfect locality alone
 * (0.2 · 1) cannot lift a response out of `low` — the design's rule that
 * locality refines the verdict but never decides it. The two constraints
 * disagreeing by 0.02 is itself a symptom: see the calibration verdict in the
 * design spec.
 */
const CONFIDENCE_LABELS: Record<string, string> = { p0: "low", p50: "medium", p80: "high" };
const CONFIDENCE_CUT_POINTS: Record<number, number> = { 0: 0, 50: 0.21, 80: 0.63 };

/** Calibration seam — the corpus harness sweeps the constant it defaults to. */
export interface SearchConfidenceOptions {
  /** CV at which `spread` contributes 0.5. Defaults to {@link SPREAD_CV_HALF_POINT}. */
  spreadHalfPoint?: number;
}

/**
 * Confidence of a search response, from the shape of its own score
 * distribution. Never reads an absolute score threshold.
 */
export function computeSearchConfidence(
  results: readonly SearchConfidenceInput[],
  options: SearchConfidenceOptions = {},
): SearchConfidence {
  if (results.length === 0) return { value: 0, label: resolveLabel(0, CONFIDENCE_LABELS, CONFIDENCE_CUT_POINTS) };

  const scores = results.map((r) => r.score).sort((a, b) => b - a);
  const raw =
    WEIGHT_PEAK * computePeak(scores) +
    WEIGHT_SPREAD * computeSpread(scores, options.spreadHalfPoint ?? SPREAD_CV_HALF_POINT) +
    WEIGHT_LOCALITY * computeLocality(results);
  const value = Math.round(clamp01(raw) * 100) / 100;

  return { value, label: resolveLabel(value, CONFIDENCE_LABELS, CONFIDENCE_CUT_POINTS) };
}

/**
 * Leader separation: `(s1 - median(s2..sn)) / s1`. Dividing by the leader
 * removes the model's magnitude. Median rather than mean for the tail, so a
 * single genuine runner-up does not collapse the number.
 *
 * A lone result has no tail to separate from — by convention that counts as
 * full separation, not as zero.
 */
function computePeak(sortedScores: readonly number[]): number {
  if (sortedScores.length < 2) return 1;
  const leader = sortedScores[0];
  if (leader <= 0) return 0;
  return clamp01((leader - median(sortedScores.slice(1))) / leader);
}

/**
 * Dispersion as coefficient of variation, mapped through a saturating curve.
 * Scale-free: multiplying every score by a constant leaves it unchanged.
 */
function computeSpread(scores: readonly number[], halfPoint: number): number {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  if (mean <= 0) return 0;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const cv = Math.sqrt(variance) / mean;
  return cv / (cv + halfPoint);
}

/**
 * Directory clustering as normalised Shannon entropy: `1 - H / ln(n)`, where
 * the buckets are the parent directories of the result paths. All hits in one
 * directory gives 1; every hit in its own directory gives 0.
 *
 * Results without a path cannot be localised and are dropped from the sample.
 * A response carrying no paths at all scores 0 — unlocalisable, not clustered.
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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
