/**
 * The burst window W (bd tea-rags-mcp-3vg0x): how close two commits of one
 * author must be to count as one burst of work.
 *
 * Consecutive commits of one author share files far more than chance when they
 * are minutes apart — a WIP spray, an agent's commit-per-step loop — and that
 * excess decays with the gap. W is where it has HALVED: the excess file-set
 * overlap (mean Jaccard of consecutive same-author commits minus the overlap of
 * same-author commits a week or more apart) is measured per log-spaced gap
 * bin, and W is the upper edge of the first bin past the head whose excess is
 * at most half the head's. The upper edge, because dedup is calibrated only
 * when its window covers the burst (the burst-preserving null of the research
 * measured false discoveries whenever W fell short of the burst length), so a
 * bin-resolution answer errs long.
 *
 * Method port of the research script `gaps.mjs` (scratch
 * `~/.claude/jobs/ab640081/tmp/sessions/`): same bins, same baseline sampler.
 * Measured there: W ≈ 2–3 h on both taxdome and the tea-rags self-repo, with
 * no natural cut at 30 minutes.
 */

import type { CochangeBurstWindowMethod } from "../../../../../contracts/types/codegraph.js";
import { authorIdentityKey } from "../../../git/index.js";
import type { CochangeCommit } from "./commit-bundles.js";

/**
 * The window when the history cannot be measured. Not tuned on any repo's
 * answer here: it is the burst scale the research MEASURED on taxdome and
 * tea-rags (2–3 h), taken at its low end.
 */
export const BURST_WINDOW_FALLBACK_MINUTES = 120;

/**
 * Lower clamp: the 30-minute author-session gap the git trajectory and the old
 * session bundling used — a burst never ends inside what the project already
 * calls one sitting.
 */
export const BURST_WINDOW_MIN_MINUTES = 30;

/**
 * Upper clamp: half a day. Past it consecutive commits straddle a night or a
 * workday boundary, which is a new piece of work, not the same burst.
 */
export const BURST_WINDOW_MAX_MINUTES = 12 * 60;

/** The head: gaps under 15 minutes, the tightest edit-commit loop whose overlap the excess is measured against. */
const HEAD_GAP_MINUTES = 15;

/**
 * Commits of one author at least this far apart are the "unrelated" baseline:
 * a week spans every weekday cycle, so its overlap is the author's standing
 * file affinity rather than one piece of work.
 */
const BASELINE_MIN_GAP_MINUTES = 7 * 24 * 60;

/**
 * Fewest consecutive pairs a gap bin (and the head, and the baseline sample)
 * needs for its mean Jaccard to be read: 30 is the conventional point where a
 * mean of bounded values is approximately normal. A thinner bin is skipped,
 * never taken as the crossing; a thinner head or baseline means the history
 * cannot be measured and W falls back.
 */
export const BURST_WINDOW_MIN_PAIRS = 30;

/**
 * Upper edges of the log-spaced gap bins, in minutes (the research's bins, cut
 * at the upper clamp). The first bin past the head starts at 15.
 */
const GAP_BIN_UPPER_EDGES = [20, 30, 45, 60, 90, 120, 180, 240, 480, 720];

/** Baseline sampler: accepted pairs wanted and draws allowed (the research's 20 000 / 200 000). */
const BASELINE_SAMPLE_TARGET = 20_000;
const BASELINE_SAMPLE_DRAWS = 200_000;
/** Fixed PRNG seed, so the same history always yields the same W. */
const BASELINE_SAMPLE_SEED = 5;

export interface BurstWindowEstimate {
  minutes: number;
  method: CochangeBurstWindowMethod;
}

const FALLBACK: BurstWindowEstimate = { minutes: BURST_WINDOW_FALLBACK_MINUTES, method: "fallback" };

/** W for `commits` (any order). See the module docblock. */
export function estimateBurstWindow(commits: readonly CochangeCommit[]): BurstWindowEstimate {
  const byAuthor = groupByAuthor(commits);

  let headSum = 0;
  let headCount = 0;
  const binSum = new Array<number>(GAP_BIN_UPPER_EDGES.length).fill(0);
  const binCount = new Array<number>(GAP_BIN_UPPER_EDGES.length).fill(0);
  for (const list of byAuthor) {
    for (let i = 1; i < list.length; i++) {
      const gapMinutes = (list[i].commit.timestamp - list[i - 1].commit.timestamp) / 60;
      if (gapMinutes < HEAD_GAP_MINUTES) {
        headSum += jaccard(list[i].files, list[i - 1].files);
        headCount++;
        continue;
      }
      const bin = GAP_BIN_UPPER_EDGES.findIndex((edge) => gapMinutes < edge);
      if (bin < 0) continue;
      binSum[bin] += jaccard(list[i].files, list[i - 1].files);
      binCount[bin]++;
    }
  }
  if (headCount < BURST_WINDOW_MIN_PAIRS) return FALLBACK;

  const baseline = sampleBaselineOverlap(byAuthor);
  if (baseline === undefined) return FALLBACK;
  const headExcess = headSum / headCount - baseline;
  if (!(headExcess > 0)) return FALLBACK;

  let measuredBins = 0;
  for (let bin = 0; bin < GAP_BIN_UPPER_EDGES.length; bin++) {
    if (binCount[bin] < BURST_WINDOW_MIN_PAIRS) continue;
    measuredBins++;
    if (binSum[bin] / binCount[bin] - baseline <= headExcess / 2) {
      return { minutes: clampWindow(GAP_BIN_UPPER_EDGES[bin]), method: "estimated" };
    }
  }
  // No bin past the head measured: nothing says how the overlap decays.
  if (measuredBins === 0) return FALLBACK;
  // The excess never halved where it was measured: the bursts are at least
  // that long, and dedup errs long, so the upper clamp.
  return { minutes: BURST_WINDOW_MAX_MINUTES, method: "estimated" };
}

function clampWindow(minutes: number): number {
  return Math.min(BURST_WINDOW_MAX_MINUTES, Math.max(BURST_WINDOW_MIN_MINUTES, minutes));
}

/** Each author identity's commits, oldest first; authors in first-seen order. */
function groupByAuthor(commits: readonly CochangeCommit[]): CochangeCommit[][] {
  const byKey = new Map<string, CochangeCommit[]>();
  for (const c of commits) {
    const key = authorIdentityKey(c.commit);
    const list = byKey.get(key);
    if (list) list.push(c);
    else byKey.set(key, [c]);
  }
  const lists = [...byKey.values()];
  for (const list of lists) list.sort((a, b) => a.commit.timestamp - b.commit.timestamp);
  return lists;
}

/**
 * Mean Jaccard of same-author commit pairs at least a week apart: draw a commit
 * uniformly, then a partner uniformly from its author's commits, keep the pair
 * when far enough apart. `undefined` when too few pairs qualify.
 */
function sampleBaselineOverlap(byAuthor: readonly CochangeCommit[][]): number | undefined {
  const flat: { list: CochangeCommit[]; commit: CochangeCommit }[] = [];
  for (const list of byAuthor) for (const commit of list) flat.push({ list, commit });
  if (flat.length === 0) return undefined;
  const random = mulberry32(BASELINE_SAMPLE_SEED);
  const minGapSeconds = BASELINE_MIN_GAP_MINUTES * 60;
  let sum = 0;
  let accepted = 0;
  for (let draw = 0; draw < BASELINE_SAMPLE_DRAWS && accepted < BASELINE_SAMPLE_TARGET; draw++) {
    const { list, commit } = flat[Math.floor(random() * flat.length)];
    const partner = list[Math.floor(random() * list.length)];
    if (Math.abs(commit.commit.timestamp - partner.commit.timestamp) < minGapSeconds) continue;
    sum += jaccard(commit.files, partner.files);
    accepted++;
  }
  return accepted < BURST_WINDOW_MIN_PAIRS ? undefined : sum / accepted;
}

/** |A ∩ B| / |A ∪ B| over two commits' (already distinct) file lists. */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  let shared = 0;
  for (const file of b) if (set.has(file)) shared++;
  const union = set.size + b.length - shared;
  return union === 0 ? 0 : shared / union;
}

/** Small deterministic PRNG (mulberry32), uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
