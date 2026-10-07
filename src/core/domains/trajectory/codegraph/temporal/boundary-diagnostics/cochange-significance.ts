/**
 * Co-change pair significance (bd tea-rags-mcp-89k7k.1.14): the admission
 * gate both temporal detectors — silent coupling and the review's
 * `incompleteChange` — apply before their strength cuts.
 *
 * A pair's support is judged against the CONFIGURATION null over the admitted
 * bundle history: every file keeps its change count n_f and every bundle its
 * size k_b, files are otherwise placed at random, and the expected number of
 * bundles holding both p and q is the Chung–Lu rate
 * λ_pq = n_p·n_q·Qs/M² (M = Σ k_b, Qs = Σ k_b(k_b−1)). The p-value is the
 * Poisson upper tail P(X ≥ s_pq). A file in every bundle — a version manifest,
 * a key-addressed locale file — has a huge n_f, so its pairs' λ absorbs their
 * support and no file-level hub concept is needed: the conditioning on n_f IS
 * the hub correction (file-level cuts are dead — confidence asymmetry is n_f/n_p
 * algebraically, bd comment 2026-10-07).
 *
 * Multiplicity: Benjamini–Hochberg at {@link COCHANGE_SIGNIFICANCE_FDR_Q} over
 * an A-PRIORI family, never over the pairs that happened to be observed or
 * stored — a family sized by supports would let the data pick its own
 * denominator. Repo-wide the family is every pair of F₂ (files changed in ≥ 2
 * bundles); a review's family is every pair with at least one end in the
 * diff's F₂ files. A pair is admitted when BH rejects it AND its support
 * reaches the build's minimum support — one co-change is never coupling.
 *
 * Pure: inputs are the bundle memberships the co-change read already carries
 * (`TemporalCochangeGraph#bundles`), so the gate costs no extra query.
 * Supports come from the bundles, never from the stored pair table, which the
 * per-file partner cap truncates.
 */

import type { CochangeSignificanceSummary } from "../../../../../contracts/types/architecture-report.js";
import type { RelPath, TemporalCochangeGraph } from "../../../../../contracts/types/codegraph.js";
import { TEMPORAL_COCHANGE_MIN_SUPPORT } from "../cochange/index.js";

/** The false-discovery rate BH controls — the conventional 5% FDR. */
export const COCHANGE_SIGNIFICANCE_FDR_Q = 0.05;

/** Bundle-size totals of the history the null is conditioned on. */
export interface CochangeHistoryTotals {
  /** M = Σ k_b — file memberships over every bundle. */
  membership: number;
  /** Qs = Σ k_b(k_b − 1) — ordered pair slots over every bundle. */
  pairSlots: number;
}

/** Which pairs one judgement tests: all of F₂, or those touching a review's diff. */
export type CochangeSignificanceFamily =
  | { kind: "full" }
  | {
      kind: "query";
      /** The diff's files; those changed in fewer than 2 history bundles test nothing. */
      diffFiles: readonly RelPath[];
      /**
       * The diff's own commits (merge-base..HEAD). A bundle holding any of them
       * leaves the history, so the change cannot confirm itself.
       */
      diffCommits?: readonly string[];
    };

export interface CochangeSignificanceOptions {
  /**
   * Whether a path exists in the tree being judged; a path that does not is
   * outside F₂ — a renamed-away or deleted path would otherwise inflate the
   * family. Absent = every history path exists.
   */
  exists?: (relPath: RelPath) => boolean;
}

/** One significance judgement: the admitted pairs and how they were chosen. */
export interface CochangeSignificance {
  summary: CochangeSignificanceSummary;
  /** Whether the pair (either order) is admitted. A pair outside the family is not. */
  admits: (relPathA: RelPath, relPathB: RelPath) => boolean;
}

/** λ_pq = n_p·n_q·Qs/M² — the configuration null's expected co-change count. */
export function configurationNullRate(changesP: number, changesQ: number, totals: CochangeHistoryTotals): number {
  if (totals.membership <= 0) return 0;
  return (changesP * changesQ * totals.pairSlots) / (totals.membership * totals.membership);
}

/** Lanczos (g = 7, n = 9) log Γ(x), x > 0. */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  const z = x - 1;
  let sum = c[0];
  for (let i = 1; i < 9; i++) sum += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Ample for any λ the bundle history produces; the series terminate far earlier. */
const POISSON_SERIES_TERM_CAP = 1_000_000;

/**
 * P(X ≥ s), X ~ Poisson(λ). The smaller side is summed in log space so a far
 * tail is resolved rather than rounded to 0, and a near-certain tail is not
 * computed as 1 minus a sum that has lost its digits: s > λ sums the upper
 * terms from s upward; s ≤ λ sums the lower terms from s − 1 downward and
 * subtracts.
 */
export function poissonUpperTail(support: number, lambda: number): number {
  if (support <= 0) return 1;
  if (!(lambda > 0)) return 0;
  if (support === 1) return -Math.expm1(-lambda);
  if (support > lambda) {
    const logFirst = -lambda + support * Math.log(lambda) - logGamma(support + 1);
    let sum = 1;
    let term = 1;
    for (let k = support; k < support + POISSON_SERIES_TERM_CAP; k++) {
      term *= lambda / (k + 1);
      sum += term;
      if (term < sum * Number.EPSILON) break;
    }
    return Math.min(1, Math.exp(logFirst + Math.log(sum)));
  }
  const logLast = -lambda + (support - 1) * Math.log(lambda) - logGamma(support);
  let sum = 1;
  let term = 1;
  for (let k = support - 1; k > 0; k--) {
    term *= k / lambda;
    sum += term;
    if (term < sum * Number.EPSILON) break;
  }
  return Math.max(0, -Math.expm1(logLast + Math.log(sum)));
}

/**
 * Benjamini–Hochberg: the largest k with p_(k) ≤ q·k/m, 0 when none. The
 * p-values are the family's TESTED members ascending; the rest of the family
 * (unobserved pairs, p = 1) still counts in `familySize`.
 */
export function benjaminiHochbergRejectionCount(
  ascendingPValues: readonly number[],
  familySize: number,
  q: number = COCHANGE_SIGNIFICANCE_FDR_Q,
): number {
  if (familySize <= 0) return 0;
  let rejected = 0;
  for (let rank = 1; rank <= ascendingPValues.length; rank++) {
    if (ascendingPValues[rank - 1] <= (q * rank) / familySize) rejected = rank;
  }
  return rejected;
}

/** C(|F₂|, 2) — every pair of files changed in ≥ 2 bundles. */
export function fullCochangeFamilySize(f2: number): number {
  return f2 < 2 ? 0 : (f2 * (f2 - 1)) / 2;
}

/** |D*|·(|F₂| − 1) − C(|D*|, 2) — every F₂ pair touching D*, a pair with both ends in D* once. */
export function queryCochangeFamilySize(diffFileCount: number, f2: number): number {
  if (diffFileCount <= 0 || f2 < 2) return 0;
  return diffFileCount * (f2 - 1) - (diffFileCount * (diffFileCount - 1)) / 2;
}

/** Unordered pair key; NUL never occurs in a path. */
function pairKey(a: RelPath, b: RelPath): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

/**
 * Judge every pair of `family` against the configuration null over `bundles`
 * (the history H — already stripped of whatever must not count).
 */
export function assessCochangeSignificance(
  bundles: Iterable<readonly RelPath[]>,
  family: CochangeSignificanceFamily,
  options: CochangeSignificanceOptions = {},
): CochangeSignificance {
  const history = [...bundles].map((b) => [...new Set(b)]);
  const changes = new Map<RelPath, number>();
  let membership = 0;
  let pairSlots = 0;
  for (const bundle of history) {
    membership += bundle.length;
    pairSlots += bundle.length * (bundle.length - 1);
    for (const relPath of bundle) changes.set(relPath, (changes.get(relPath) ?? 0) + 1);
  }
  const totals: CochangeHistoryTotals = { membership, pairSlots };
  const exists = options.exists ?? (() => true);
  const f2 = new Set<RelPath>();
  for (const [relPath, n] of changes) if (n >= 2 && exists(relPath)) f2.add(relPath);

  const diff = family.kind === "query" ? new Set(family.diffFiles.filter((relPath) => f2.has(relPath))) : null;
  const familySize = diff ? queryCochangeFamilySize(diff.size, f2.size) : fullCochangeFamilySize(f2.size);

  // Observed supports of the family's pairs — each bundle counts a pair once.
  const supports = new Map<string, { a: RelPath; b: RelPath; support: number }>();
  for (const bundle of history) {
    const members = bundle.filter((relPath) => f2.has(relPath));
    if (diff && !members.some((relPath) => diff.has(relPath))) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (diff && !diff.has(a) && !diff.has(b)) continue;
        const key = pairKey(a, b);
        const entry = supports.get(key);
        if (entry) entry.support++;
        else supports.set(key, { a, b, support: 1 });
      }
    }
  }

  const tested = [...supports].map(([key, { a, b, support }]) => ({
    key,
    support,
    p: poissonUpperTail(support, configurationNullRate(changes.get(a) ?? 0, changes.get(b) ?? 0, totals)),
  }));
  tested.sort((x, y) => x.p - y.p || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const rejected = benjaminiHochbergRejectionCount(
    tested.map((t) => t.p),
    familySize,
  );
  const admitted = new Set<string>();
  for (let i = 0; i < rejected; i++) {
    if (tested[i].support >= TEMPORAL_COCHANGE_MIN_SUPPORT) admitted.add(tested[i].key);
  }

  return {
    summary: {
      method: "poissonConfigurationNull",
      family: family.kind,
      q: COCHANGE_SIGNIFICANCE_FDR_Q,
      familySize,
      testedPairCount: tested.length,
      admittedPairCount: admitted.size,
    },
    admits: (relPathA, relPathB) => admitted.has(pairKey(relPathA, relPathB)),
  };
}

/**
 * {@link assessCochangeSignificance} over a co-change read: its bundle
 * memberships are the history, minus — for a review — every bundle holding one
 * of the diff's own commits. `undefined` when the read carries no bundle
 * membership (a fixture, or a daemon older than the table): there is no
 * history to judge against, and the caller says so rather than inventing one.
 */
export function assessGraphCochangeSignificance(
  graph: TemporalCochangeGraph,
  family: CochangeSignificanceFamily,
  options: CochangeSignificanceOptions = {},
): CochangeSignificance | undefined {
  if (graph.bundles === undefined) return undefined;
  if (family.kind === "full") return assessCochangeSignificance(graph.bundles.values(), family, options);
  const diffCommits = new Set(family.diffCommits ?? []);
  const commitsOf = graph.bundleCommits;
  const bundleCommitsAvailable = commitsOf !== undefined && (graph.bundles.size === 0 || commitsOf.size > 0);
  const history: (readonly RelPath[])[] = [];
  let excludedBundleCount = 0;
  for (const [bundleId, files] of graph.bundles) {
    const shas = commitsOf?.get(bundleId);
    if (diffCommits.size > 0 && shas?.some((sha) => diffCommits.has(sha))) {
      excludedBundleCount++;
      continue;
    }
    history.push(files);
  }
  const significance = assessCochangeSignificance(history, family, options);
  return {
    summary: { ...significance.summary, diffHistory: { excludedBundleCount, bundleCommitsAvailable } },
    admits: significance.admits,
  };
}
