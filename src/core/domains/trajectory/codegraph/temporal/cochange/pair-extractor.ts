/**
 * The co-change pair extractor (bd tea-rags-mcp-x4rpp): association rules over
 * admitted commit bundles.
 *
 * For files A and B over the N admitted bundles:
 *   support(A,B)    = bundles touching both
 *   confidence(A→B) = P(B | A) = support / count(A)
 *   lift(A,B)       = support · N / (count(A) · count(B))   — > 1 beats chance
 *
 * N counts single-file bundles too: a file changing alone is evidence against
 * every rule on it, and dropping those bundles inflates every confidence.
 *
 * Storage cap (spec open question 2 — the bead's answer is BOTH options): pairs
 * under `minSupport` are not stored, and a surviving pair is kept only when it
 * ranks in the top `maxPartnersPerFile` of at least one endpoint. Within one
 * file's list the rank is support — P(partner | file) shares the file's own
 * count as denominator, so it orders identically — then P(file | partner), the
 * partners that almost always bring the file along, then path. Keeping the pair
 * when EITHER endpoint ranks it is what stops a hub's many partners from
 * evicting a rarely-changed file's one strong partner.
 *
 * Memory: file paths are interned to integer ids and a pair is keyed by
 * `lo · 2^26 + hi` (exact in a double), so the counting pass holds two numeric
 * maps and no per-pair object. Sample SHAs are collected in a second pass over
 * the survivors only.
 */

import type { RelPath, TemporalCochangeEdge, TemporalCochangeFile } from "../../../../../contracts/types/codegraph.js";
import { compareCodePoints, type CochangeBundle } from "./commit-bundles.js";

export interface CochangeExtractionOptions {
  /** Pairs below this support are not stored. */
  minSupport: number;
  /** Per-file storage cap (top N by support, either endpoint). */
  maxPartnersPerFile: number;
  /** Bundles touching more distinct files than this are dropped whole. */
  maxFilesPerBundle: number;
}

export interface CochangeGraphExtraction {
  files: TemporalCochangeFile[];
  edges: TemporalCochangeEdge[];
  /** N — the admitted bundles every metric is counted over. */
  admittedBundleCount: number;
  /**
   * The admitted bundles' file memberships in extraction order (bundle id =
   * index). Component-level counts — `|bundles touching both|` and
   * `|bundles touching one|`, the split/merge verdicts' input (bd
   * tea-rags-mcp-c3v6o) — need the bundle, not the pair: the pair table is
   * capped and its pair-level support double-counts a multi-file bundle.
   * Memory: the paths are interned references the `paths` table already
   * holds; each inner array only adds one entry per file per bundle.
   */
  admittedBundles: readonly (readonly RelPath[])[];
}

/** Up to this many sample SHAs per stored pair. */
const SAMPLE_COMMITS_PER_EDGE = 3;
/** Pair-key radix; 2^26 ids × 2^26 stays below 2^53. */
const PAIR_KEY_RADIX = 2 ** 26;

export function extractCochangeGraph(
  bundles: readonly CochangeBundle[],
  options: CochangeExtractionOptions,
): CochangeGraphExtraction {
  const admitted = bundles
    .filter((b) => b.files.length > 0 && b.files.length <= options.maxFilesPerBundle)
    .sort((a, b) => b.timestamp - a.timestamp);
  const n = admitted.length;

  const ids = new Map<RelPath, number>();
  const paths: RelPath[] = [];
  const counts: number[] = [];
  const lastChanged: number[] = [];
  const idOf = (path: RelPath): number => {
    let id = ids.get(path);
    if (id === undefined) {
      id = paths.length;
      ids.set(path, id);
      paths.push(path);
      counts.push(0);
      lastChanged.push(-1);
    }
    return id;
  };

  const bundleIds = admitted.map((b) => b.files.map(idOf));
  const support = new Map<number, number>();
  const lastCoChange = new Map<number, number>();
  admitted.forEach((bundle, index) => {
    const fileIds = bundleIds[index];
    for (const id of fileIds) {
      counts[id] += 1;
      // Bundles arrive newest first, so the first sighting is the newest.
      if (lastChanged[id] < 0) lastChanged[id] = bundle.timestamp;
    }
    forEachPair(fileIds, (key) => {
      support.set(key, (support.get(key) ?? 0) + 1);
      if (!lastCoChange.has(key)) lastCoChange.set(key, bundle.timestamp);
    });
  });

  const kept = capPartners(support, counts, paths, options);

  const samples = new Map<number, string[]>();
  for (const key of kept) samples.set(key, []);
  admitted.forEach((bundle, index) => {
    const newestSha = bundle.shas[bundle.shas.length - 1];
    forEachPair(bundleIds[index], (key) => {
      const list = samples.get(key);
      if (list && list.length < SAMPLE_COMMITS_PER_EDGE) list.push(newestSha);
    });
  });

  const partnerCounts = new Array<number>(paths.length).fill(0);
  const edges: TemporalCochangeEdge[] = [];
  for (const key of kept) {
    const [lo, hi] = splitPairKey(key);
    partnerCounts[lo] += 1;
    partnerCounts[hi] += 1;
    const s = support.get(key) as number;
    const [a, b] = compareCodePoints(paths[lo], paths[hi]) < 0 ? [lo, hi] : [hi, lo];
    edges.push({
      relPathA: paths[a],
      relPathB: paths[b],
      support: s,
      confidenceAB: s / counts[a],
      confidenceBA: s / counts[b],
      lift: (s * n) / (counts[a] * counts[b]),
      lastCoChangeAt: lastCoChange.get(key) as number,
      sampleCommits: samples.get(key) as string[],
    });
  }
  edges.sort((x, y) => compareCodePoints(x.relPathA, y.relPathA) || compareCodePoints(x.relPathB, y.relPathB));

  const files: TemporalCochangeFile[] = paths
    .map((relPath, id) => ({
      relPath,
      bundleCount: counts[id],
      partnerCount: partnerCounts[id],
      lastChangedAt: lastChanged[id],
    }))
    .sort((x, y) => compareCodePoints(x.relPath, y.relPath));

  return {
    files,
    edges,
    admittedBundleCount: n,
    admittedBundles: bundleIds.map((ids) => ids.map((id) => paths[id])),
  };
}

function forEachPair(fileIds: readonly number[], visit: (key: number) => void): void {
  for (let i = 0; i < fileIds.length; i++) {
    for (let j = i + 1; j < fileIds.length; j++) {
      const x = fileIds[i];
      const y = fileIds[j];
      visit(x < y ? x * PAIR_KEY_RADIX + y : y * PAIR_KEY_RADIX + x);
    }
  }
}

function splitPairKey(key: number): [number, number] {
  const lo = Math.floor(key / PAIR_KEY_RADIX);
  return [lo, key - lo * PAIR_KEY_RADIX];
}

/** The pair keys that clear the support floor and rank in the top N of either endpoint. */
function capPartners(
  support: ReadonlyMap<number, number>,
  counts: readonly number[],
  paths: readonly RelPath[],
  options: CochangeExtractionOptions,
): Set<number> {
  const partners = new Map<number, { partner: number; key: number; support: number }[]>();
  const add = (file: number, partner: number, key: number, s: number): void => {
    const list = partners.get(file);
    if (list) list.push({ partner, key, support: s });
    else partners.set(file, [{ partner, key, support: s }]);
  };
  for (const [key, s] of support) {
    if (s < options.minSupport) continue;
    const [lo, hi] = splitPairKey(key);
    add(lo, hi, key, s);
    add(hi, lo, key, s);
  }
  const kept = new Set<number>();
  for (const list of partners.values()) {
    list.sort(
      (x, y) =>
        y.support - x.support ||
        y.support / counts[y.partner] - x.support / counts[x.partner] ||
        compareCodePoints(paths[x.partner], paths[y.partner]),
    );
    for (const entry of list.slice(0, options.maxPartnersPerFile)) kept.add(entry.key);
  }
  return kept;
}
