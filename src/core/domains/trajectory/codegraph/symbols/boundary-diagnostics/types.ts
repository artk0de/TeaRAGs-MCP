import type { RelPath } from "../../../../../contracts/types/codegraph.js";

/**
 * Where a dependency's target sits relative to its source, by directory:
 *
 * - `same`       — both files in one directory.
 * - `descendant` — the target lives below the source's directory: a module
 *                  reaching into its own sub-parts.
 * - `ancestor`   — the source lives below the target's directory: a sub-part
 *                  reaching up into its enclosing module.
 * - `disjoint`   — neither directory contains the other: the edge crosses into
 *                  a sibling or cousin module, the case module borders are about.
 */
export type DependencyDirectoryRelation = "same" | "descendant" | "ancestor" | "disjoint";

export interface StableDependenciesOptions {
  /**
   * How much LESS stable than its source a target may be before the edge is a
   * violation: flagged when `I(target) − I(source) > tolerance`. Default
   * `DEFAULT_SDP_TOLERANCE` (0.2).
   */
  tolerance?: number;
  /**
   * Minimum `connectionCount` (fanIn + fanOut) BOTH endpoints need before their
   * instability is trusted; an edge with a thinner endpoint is not judged.
   * Default `DEFAULT_SDP_MIN_CONNECTION_COUNT` — the static confidence floor
   * `codegraph.file.instability` declares.
   */
  minConnectionCount?: number;
}

/** One dependency that runs from a more stable file to a less stable one. */
export interface StableDependencyViolation {
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  /** I(source), the value `codegraph.file.instability` carries for it. */
  sourceInstability: number;
  /** I(target), the value `codegraph.file.instability` carries for it. */
  targetInstability: number;
  /** `targetInstability − sourceInstability`, always above the tolerance. The severity. */
  instabilityDelta: number;
  sourceConnectionCount: number;
  targetConnectionCount: number;
  /** Confidence-weighted resolved calls across the edge; 0 for a call-free dependency. */
  callWeight: number;
  directoryRelation: DependencyDirectoryRelation;
}

/** Edges read but not judged, by the first reason that applied. */
export interface StableDependenciesExclusionCounts {
  /** Source and target are one file. */
  selfEdges: number;
  /** An endpoint the codegraph walk never extracted (outside the index, excluded from the graph, unresolved). */
  unwalkedEndpoints: number;
  /** An endpoint defines no symbol and calls nothing — a re-export barrel or a data-only module. */
  passThroughEndpoints: number;
  /** An endpoint's connectionCount is below `minConnectionCount`. */
  lowConnectionCount: number;
}

export interface StableDependenciesSummary {
  tolerance: number;
  minConnectionCount: number;
  /** Every file edge read. */
  edgeCount: number;
  /** Edges that survived every exclusion and were judged. */
  consideredEdgeCount: number;
  violationCount: number;
  excluded: StableDependenciesExclusionCounts;
}

export interface StableDependenciesReport {
  /** Most severe first: delta, then call weight, then path. */
  violations: StableDependencyViolation[];
  summary: StableDependenciesSummary;
}
