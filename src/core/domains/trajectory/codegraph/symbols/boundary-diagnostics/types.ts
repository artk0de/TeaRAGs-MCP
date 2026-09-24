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
  /**
   * Judge an edge whose source is its target's sole importer
   * (`PRIVATE_COLLABORATOR_REASON`). Default `false`: such an edge is counted
   * under `StableDependenciesExclusionCounts.privateCollaborators` instead.
   */
  judgePrivateCollaborators?: boolean;
  /**
   * Picomatch glob (`compilePathPatternMatcher`): judge only edges whose SOURCE
   * matches. Instabilities, importer counts and root-cause cycles still read
   * the whole graph — a file's fan does not shrink because the reader looks at
   * one module. Empty or absent: every edge is in scope.
   */
  sourcePathPattern?: string;
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
  /**
   * An endpoint defines no symbol and calls nothing (`NO_SYMBOL_ENDPOINT_REASON`):
   * a re-export barrel, which is what the rule is for — but a type-only module
   * or a module whose code lives in an object literal matches it just the same.
   * `StableDependenciesReport.noSymbolEndpointFiles` names the files.
   */
  noSymbolEndpoints: number;
  /** An endpoint's connectionCount is below `minConnectionCount`. */
  lowConnectionCount: number;
  /**
   * The source is the target's sole importer (`PRIVATE_COLLABORATOR_REASON`):
   * the target's instability reaches no other dependent, so the SDP premise has
   * nobody to protect. Checked last, so it counts only edges that would
   * otherwise have been judged.
   */
  privateCollaborators: number;
}

/** Present when `StableDependenciesOptions.sourcePathPattern` scoped the run. */
export interface StableDependenciesScope {
  sourcePathPattern: string;
  /** Edges read whose source did not match — never judged, counted under no exclusion reason. */
  outOfScopeEdgeCount: number;
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
  scope?: StableDependenciesScope;
}

/** A file the no-symbol rule excluded, and how many edges it took out of judgement. */
export interface NoSymbolEndpointFile {
  relPath: RelPath;
  /** Edges not judged because this file is an endpoint (counted for both ends of a no-symbol → no-symbol edge). */
  excludedEdgeCount: number;
}

/**
 * Every violation into one unstable target, as one finding: a target with many
 * stable dependents is one defect showing up once per dependent.
 */
export interface StableDependencyRootCause {
  targetRelPath: RelPath;
  targetInstability: number;
  /** Violations whose target this is — the stable dependents affected. The severity. */
  violationCount: number;
  /** The largest `instabilityDelta` among them. */
  maxInstabilityDelta: number;
  /** Sources of those violations, by path. */
  sources: RelPath[];
  /**
   * The target has an edge back to at least one of its violating sources: its
   * instability comes, at least partly, from referencing its own dependents
   * (a base class naming its subclasses, a concern naming its includers).
   */
  cycleWithDependents: boolean;
}

export interface StableDependenciesReport {
  /** Most severe first: delta, then call weight, then path. */
  violations: StableDependencyViolation[];
  /** `violations` grouped by target: most violations first, then max delta, then path. */
  rootCauses: StableDependencyRootCause[];
  summary: StableDependenciesSummary;
  /**
   * Every file that took at least one edge out under `noSymbolEndpoints`, most
   * edges first, then path — what the rule actually caught, for a reader to
   * judge whether it caught only barrels.
   */
  noSymbolEndpointFiles: NoSymbolEndpointFile[];
}
