/**
 * The co-change pair extractor (bd tea-rags-mcp-x4rpp): association rules over
 * admitted commit bundles, counted once per author burst (bd tea-rags-mcp-3vg0x).
 *
 * For files A and B over the N author bursts holding an admitted commit:
 *   count(A)        = bursts with an admitted commit touching A
 *   support(A,B)    = bursts with an admitted commit touching BOTH — one commit
 *                     must hold the pair; two commits of a burst that touched
 *                     A and B separately do not pair them
 *   confidence(A→B) = P(B | A) = support / count(A)
 *   lift(A,B)       = support · N / (count(A) · count(B))   — > 1 beats chance
 *
 * Admission is per commit (the mass-change cut), BEFORE bursts are counted: an
 * oversized commit drops out, its burst's other commits stay. N counts
 * single-file commits' bursts too: a file changing alone is evidence against
 * every rule on it, and dropping those inflates every confidence. `lastChangedAt`
 * / `lastCoChangeAt` are commit timestamps — recency is not a count.
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
 * maps and no per-pair object; a burst's dedup sets live only while that burst
 * is counted. Sample SHAs are collected in a second pass over the survivors only.
 */

import type {
  CochangeFileLineCounts,
  RelPath,
  TemporalCochangeEdge,
  TemporalCochangeFile,
} from "../../../../../contracts/types/codegraph.js";
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
  /** Admitted commit bundles. */
  admittedBundleCount: number;
  /** N — the author bursts holding an admitted bundle, the universe every metric is counted over. */
  admittedBurstCount: number;
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
  /** Each admitted bundle's member commit SHAs, aligned with `admittedBundles` (bd tea-rags-mcp-89k7k.1.14). */
  admittedBundleCommits: readonly (readonly string[])[];
  /**
   * Each admitted bundle's author burst, aligned with `admittedBundles`,
   * renumbered densely from 0 in extraction order (bd tea-rags-mcp-3vg0x).
   */
  admittedBundleBursts: readonly number[];
  /** Each admitted bundle's commit-message task ids, aligned with `admittedBundles`; `[]` = none (bd tea-rags-mcp-09c4m). */
  admittedBundleTaskIds: readonly (readonly string[])[];
  /**
   * Each admitted bundle's per-file +/- line counts, aligned with
   * `admittedBundles` and with each bundle's files; `null` = no count was read
   * for that file (bd tea-rags-mcp-dm61n).
   */
  admittedBundleFileLines: readonly (readonly (CochangeFileLineCounts | null)[])[];
  /** Each admitted bundle's commit time (unix seconds), aligned with `admittedBundles` (bd tea-rags-mcp-zf9yz). */
  admittedBundleTimestamps: readonly number[];
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

  // Dense burst ids in extraction order, and each burst's member bundles.
  const denseBurst = new Map<number, number>();
  const bundleBursts = admitted.map((bundle) => {
    let id = denseBurst.get(bundle.burst);
    if (id === undefined) {
      id = denseBurst.size;
      denseBurst.set(bundle.burst, id);
    }
    return id;
  });
  const n = denseBurst.size;
  const burstMembers: number[][] = Array.from({ length: n }, () => []);
  bundleBursts.forEach((burst, index) => burstMembers[burst].push(index));

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
  // Recency, per commit. Bundles arrive newest first, so the first sighting is the newest.
  admitted.forEach((bundle, index) => {
    for (const id of bundleIds[index]) {
      if (lastChanged[id] < 0) lastChanged[id] = bundle.timestamp;
    }
    forEachPair(bundleIds[index], (key) => {
      if (!lastCoChange.has(key)) lastCoChange.set(key, bundle.timestamp);
    });
  });

  // Counts, per burst: a file or a pair counts once however many of the burst's commits repeat it.
  for (const members of burstMembers) {
    const files = new Set<number>();
    const pairs = new Set<number>();
    for (const index of members) {
      for (const id of bundleIds[index]) files.add(id);
      forEachPair(bundleIds[index], (key) => pairs.add(key));
    }
    for (const id of files) counts[id] += 1;
    for (const key of pairs) support.set(key, (support.get(key) ?? 0) + 1);
  }

  const kept = capPartners(support, counts, paths, options);

  // One sample per burst — the burst's newest commit holding the pair — newest burst first.
  const samples = new Map<number, { shas: string[]; bursts: number[] }>();
  for (const key of kept) samples.set(key, { shas: [], bursts: [] });
  admitted.forEach((bundle, index) => {
    const newestSha = bundle.shas[bundle.shas.length - 1];
    const burst = bundleBursts[index];
    forEachPair(bundleIds[index], (key) => {
      const sample = samples.get(key);
      if (!sample || sample.shas.length >= SAMPLE_COMMITS_PER_EDGE || sample.bursts.includes(burst)) return;
      sample.shas.push(newestSha);
      sample.bursts.push(burst);
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
      sampleCommits: (samples.get(key) as { shas: string[] }).shas,
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
    admittedBundleCount: admitted.length,
    admittedBurstCount: n,
    admittedBundles: bundleIds.map((ids) => ids.map((id) => paths[id])),
    admittedBundleCommits: admitted.map((bundle) => bundle.shas),
    admittedBundleBursts: bundleBursts,
    admittedBundleTaskIds: admitted.map((bundle) => bundle.taskIds ?? []),
    admittedBundleFileLines: admitted.map((bundle) => bundle.files.map((file) => bundle.fileLines?.get(file) ?? null)),
    admittedBundleTimestamps: admitted.map((bundle) => bundle.timestamp),
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
