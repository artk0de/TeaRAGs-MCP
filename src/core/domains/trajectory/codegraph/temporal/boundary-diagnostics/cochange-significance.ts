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
 * The counting unit is the author BURST, not the commit (bd tea-rags-mcp-3vg0x):
 * the build records each commit bundle's burst, and n_f, M, Qs and supports are
 * counted once per burst ({@link assessBurstCochangeSignificance}), so the null
 * stays calibrated on histories where one author re-commits the same files in
 * quick succession.
 *
 * Pure: inputs are the bundle memberships the co-change read already carries
 * (`TemporalCochangeGraph#bundles`, `#bundleBursts`), so the gate costs no extra query.
 * Supports come from the bundles, never from the stored pair table, which the
 * per-file partner cap truncates.
 */

import type { CochangeSignificanceSummary } from "../../../../../contracts/types/architecture-report.js";
import type { RelPath, TemporalCochangeGraph } from "../../../../../contracts/types/codegraph.js";
import {
  benjaminiHochbergRejectionCount,
  CONVENTIONAL_FDR_Q,
  poissonUpperTail,
} from "../../../../../primitives/math/index.js";
import { TEMPORAL_COCHANGE_MIN_SUPPORT } from "../cochange/index.js";

/** The false-discovery rate BH controls — the conventional 5% FDR. */
export const COCHANGE_SIGNIFICANCE_FDR_Q = CONVENTIONAL_FDR_Q;

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
  /**
   * λ for the pair (either order) — the co-change count the configuration null
   * predicts from the two files' change counts over the judged history. Shown
   * beside the observed support; 0 for a path the history never changed.
   */
  expectedSupport: (relPathA: RelPath, relPathB: RelPath) => number;
}

/** λ_pq = n_p·n_q·Qs/M² — the configuration null's expected co-change count. */
export function configurationNullRate(changesP: number, changesQ: number, totals: CochangeHistoryTotals): number {
  if (totals.membership <= 0) return 0;
  return (changesP * changesQ * totals.pairSlots) / (totals.membership * totals.membership);
}

// The Poisson tail and BH live in the foundation since bd tea-rags-mcp-xb669.8
// (the dependency norms test role pairs with them); re-exported so this gate's
// public surface is unchanged.
export { benjaminiHochbergRejectionCount, poissonUpperTail };

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
 * (the history H — already stripped of whatever must not count), each bundle
 * its own unit. {@link assessBurstCochangeSignificance} with one-commit bursts.
 */
export function assessCochangeSignificance(
  bundles: Iterable<readonly RelPath[]>,
  family: CochangeSignificanceFamily,
  options: CochangeSignificanceOptions = {},
): CochangeSignificance {
  return assessBurstCochangeSignificance(
    [...bundles].map((bundle) => [bundle]),
    family,
    options,
  );
}

/** One burst's counting unit: the files it touched and the pairs one of its commits held. */
interface BurstUnit {
  files: RelPath[];
  pairs: Map<string, { a: RelPath; b: RelPath }>;
}

/**
 * Judge every pair of `family` against the configuration null over author
 * BURSTS (bd tea-rags-mcp-3vg0x) — each burst the member commits' file lists.
 * A burst is one unit, so a WIP spray re-committing a pair five times is one
 * co-change: n_f = bursts touching f, M = Σ |files of the burst|, Qs = 2 ×
 * Σ (distinct pairs ONE member commit held) — never the clique of the burst's
 * union, which would pair files no commit held — and a pair's support is the
 * bursts holding it. The research's dedup mode, calibrated on a
 * burst-preserving null where per-commit counting was not.
 */
export function assessBurstCochangeSignificance(
  bursts: Iterable<readonly (readonly RelPath[])[]>,
  family: CochangeSignificanceFamily,
  options: CochangeSignificanceOptions = {},
): CochangeSignificance {
  const history: BurstUnit[] = [];
  for (const commits of bursts) {
    const files = new Set<RelPath>();
    const pairs = new Map<string, { a: RelPath; b: RelPath }>();
    for (const commit of commits) {
      const members = [...new Set(commit)];
      for (const relPath of members) files.add(relPath);
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          pairs.set(pairKey(members[i], members[j]), { a: members[i], b: members[j] });
        }
      }
    }
    history.push({ files: [...files], pairs });
  }
  const changes = new Map<RelPath, number>();
  let membership = 0;
  let pairSlots = 0;
  for (const unit of history) {
    membership += unit.files.length;
    pairSlots += 2 * unit.pairs.size;
    for (const relPath of unit.files) changes.set(relPath, (changes.get(relPath) ?? 0) + 1);
  }
  const totals: CochangeHistoryTotals = { membership, pairSlots };
  const exists = options.exists ?? (() => true);
  const f2 = new Set<RelPath>();
  for (const [relPath, n] of changes) if (n >= 2 && exists(relPath)) f2.add(relPath);

  const diff = family.kind === "query" ? new Set(family.diffFiles.filter((relPath) => f2.has(relPath))) : null;
  const familySize = diff ? queryCochangeFamilySize(diff.size, f2.size) : fullCochangeFamilySize(f2.size);

  // Observed supports of the family's pairs — each burst counts a pair once.
  const supports = new Map<string, { a: RelPath; b: RelPath; support: number }>();
  for (const unit of history) {
    if (diff && !unit.files.some((relPath) => diff.has(relPath))) continue;
    for (const [key, { a, b }] of unit.pairs) {
      if (!f2.has(a) || !f2.has(b)) continue;
      if (diff && !diff.has(a) && !diff.has(b)) continue;
      const entry = supports.get(key);
      if (entry) entry.support++;
      else supports.set(key, { a, b, support: 1 });
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
    expectedSupport: (relPathA, relPathB) =>
      configurationNullRate(changes.get(relPathA) ?? 0, changes.get(relPathB) ?? 0, totals),
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
  const diffCommits = new Set(family.kind === "query" ? (family.diffCommits ?? []) : []);
  const commitsOf = graph.bundleCommits;
  const bundleCommitsAvailable = commitsOf !== undefined && (graph.bundles.size === 0 || commitsOf.size > 0);
  // Bundles grouped into their author bursts; a bundle with no recorded burst
  // (a build predating bd tea-rags-mcp-3vg0x) is its own.
  const bursts = new Map<string, (readonly RelPath[])[]>();
  let excludedBundleCount = 0;
  for (const [bundleId, files] of graph.bundles) {
    const shas = commitsOf?.get(bundleId);
    if (diffCommits.size > 0 && shas?.some((sha) => diffCommits.has(sha))) {
      excludedBundleCount++;
      continue;
    }
    const burst = graph.bundleBursts?.get(bundleId);
    const key = burst === undefined ? `bundle:${bundleId}` : `burst:${burst}`;
    const members = bursts.get(key);
    if (members) members.push(files);
    else bursts.set(key, [files]);
  }
  const significance = assessBurstCochangeSignificance(bursts.values(), family, options);
  if (family.kind === "full") return significance;
  return {
    summary: { ...significance.summary, diffHistory: { excludedBundleCount, bundleCommitsAvailable } },
    admits: significance.admits,
    expectedSupport: significance.expectedSupport,
  };
}
