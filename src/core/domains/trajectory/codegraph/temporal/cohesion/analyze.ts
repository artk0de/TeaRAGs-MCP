/**
 * `analyzeFileCohesion` — the A3 behavioral-cohesion core (bd
 * tea-rags-mcp-tzy8r), read side of the intra-file symbol co-change data
 * (bd tea-rags-mcp-3gz4f, `cg_temporal_symbol_commits`).
 *
 * One file's stored rows → the mass-commit fence → pair statistics →
 * weight-threshold clusters → a cohesion score and a split verdict with the
 * evidence attached. Classical cohesion (LCOM) counts methods sharing fields;
 * this counts what changed together — two methods sharing a field can be
 * logically unrelated, two methods that always change in the same commits are
 * not. Low cohesion plus two disjoint clusters inside one file is a split
 * CANDIDATE with evidence, never an opinion; the consumer decides.
 *
 * Pure and file-local: rows in, report out, no git, no DuckDB, no Qdrant —
 * the storage read and the file scoping belong to the caller. `null` means no
 * analysis exists (fewer than two fenced symbols — an oversized file, a
 * file the walk never reached, or one symbol left after the fence): absence,
 * never a zero score.
 *
 * Stated limits, carried in the report: the window is the chunk walk's
 * `chunkMaxAgeMonths`, not full history; squash-aware session bundling shaped
 * the commit sets exactly as it shapes `git.chunk.*`.
 */

import type { TemporalSymbolCommitFileSnapshot } from "../../../../../contracts/types/codegraph.js";
import { weightThresholdComponents } from "../../../../../infra/graph/index.js";
import { compareCodePoints, TEMPORAL_COCHANGE_MIN_SUPPORT } from "../cochange/index.js";
import { fenceMassCommits } from "./mass-commit-fence.js";

/**
 * A pair must clear BOTH gates: a repeat is not one shared commit
 * (definitional, mirrors the file level), and a pair one endpoint barely
 * follows is not cohesion — the hub symbol touched by half the file's commits
 * would otherwise weld unrelated clusters together.
 */
export const TEMPORAL_COHESION_MIN_CONFIDENCE = 0.3;

/**
 * Split verdict: with every cluster at least this share of the admitted
 * co-change weight there is no candidate — the file hangs together. Below it,
 * two or more clusters ARE the candidate. Starting value, subject to corpus
 * measurement like every other band in this codebase.
 */
export const TEMPORAL_COHESION_SPLIT_MAX_SHARE = 0.7;

/** Top pairs kept per cluster as evidence. */
const TOP_PAIRS_PER_CLUSTER = 3;

export interface CohesionAnalysisOptions {
  /** Pair support floor; default `TEMPORAL_COCHANGE_MIN_SUPPORT` (2). */
  minSupport?: number;
  /** Both directions must reach this; default `TEMPORAL_COHESION_MIN_CONFIDENCE`. */
  minConfidence?: number;
  /** Largest-cluster share at or above which there is no split; default `TEMPORAL_COHESION_SPLIT_MAX_SHARE`. */
  splitMaxLargestShare?: number;
  /** The window the rows were walked over — reported, a stated limit. */
  windowMonths?: number;
}

export interface TemporalCohesionPair {
  readonly a: string;
  readonly b: string;
  readonly support: number;
  /** min(confidence(A→B), confidence(B→A)) — the weaker direction. */
  readonly confidence: number;
}

export interface TemporalCohesionCluster {
  readonly symbols: readonly string[];
  /** Total admitted pair weight inside the cluster. */
  readonly support: number;
  /** Strongest pairs inside, evidence a reader can check against the commits. */
  readonly topPairs: readonly TemporalCohesionPair[];
}

export interface TemporalCohesionReport {
  readonly file: string;
  /** Symbols that survived the fence with at least one commit. */
  readonly analyzedSymbols: number;
  /** Distinct commits the fenced sets still hold. */
  readonly analyzedCommits: number;
  /** Commits the fence removed — the formatter runs, reported, not silent. */
  readonly massCommitsDropped: number;
  /** Pairs clearing both gates. */
  readonly pairCount: number;
  /** Largest internal weight first; every cluster holds at least one pair. */
  readonly clusters: readonly TemporalCohesionCluster[];
  /** Analyzed symbols in no cluster — they co-change with nothing above the gates. */
  readonly unclusteredSymbols: readonly string[];
  /** Largest cluster's share of admitted pair weight in [0,1]; 1 when no pair. */
  readonly cohesion: number;
  readonly splitCandidate: boolean;
  /** The chunk walk's window — a stated limit of every number above. */
  readonly windowMonths?: number;
}

export function analyzeFileCohesion(
  rows: TemporalSymbolCommitFileSnapshot,
  options?: CohesionAnalysisOptions,
): TemporalCohesionReport | null {
  const minSupport = options?.minSupport ?? TEMPORAL_COCHANGE_MIN_SUPPORT;
  const minConfidence = options?.minConfidence ?? TEMPORAL_COHESION_MIN_CONFIDENCE;
  const splitMaxLargestShare = options?.splitMaxLargestShare ?? TEMPORAL_COHESION_SPLIT_MAX_SHARE;

  const fenced = fenceMassCommits(rows);
  const symbols = [...fenced.symbols.keys()].sort(compareCodePoints);
  if (symbols.length < 2) return null;
  const commitSetOf = new Map([...fenced.symbols].map(([id, shas]) => [id, shas]));

  const pairs: TemporalCohesionPair[] = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i];
      const b = symbols[j];
      const shasA = commitSetOf.get(a) as ReadonlySet<string>;
      const shasB = commitSetOf.get(b) as ReadonlySet<string>;
      let support = 0;
      for (const sha of shasA) if (shasB.has(sha)) support += 1;
      if (support < minSupport) continue;
      const confidence = Math.min(support / shasA.size, support / shasB.size);
      if (confidence < minConfidence) continue;
      pairs.push({ a, b, support, confidence });
    }
  }

  const analysis = weightThresholdComponents(
    pairs.map((pair) => ({ a: pair.a, b: pair.b, weight: pair.support })),
    { minWeight: 1 },
  );
  const clusterOf = new Map<string, number>();
  analysis.components.forEach((component, index) => {
    for (const symbol of component.nodes) clusterOf.set(symbol, index);
  });

  const clusters = analysis.components.map((component, index) => {
    const inside = pairs.filter((pair) => clusterOf.get(pair.a) === index);
    const topPairs = [...inside]
      .sort((x, y) => y.support - x.support || y.confidence - x.confidence || compareCodePoints(x.a, y.a))
      .slice(0, TOP_PAIRS_PER_CLUSTER);
    return { symbols: component.nodes, support: component.internalWeight, topPairs };
  });

  const analyzedCommits = new Set<string>();
  for (const shas of fenced.symbols.values()) for (const sha of shas) analyzedCommits.add(sha);

  return {
    file: rows.relPath,
    analyzedSymbols: symbols.length,
    analyzedCommits: analyzedCommits.size,
    massCommitsDropped: fenced.droppedCommits,
    pairCount: pairs.length,
    clusters,
    unclusteredSymbols: symbols.filter((symbol) => !clusterOf.has(symbol)),
    cohesion: analysis.largestWeightShare,
    splitCandidate: analysis.components.length >= 2 && analysis.largestWeightShare < splitMaxLargestShare,
    ...(options?.windowMonths !== undefined ? { windowMonths: options.windowMonths } : {}),
  };
}
