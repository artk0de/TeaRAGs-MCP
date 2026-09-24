/**
 * Architecture diagnostics DTOs — `get_architecture_report` (bd tea-rags-mcp-94hd9).
 *
 * The report answers "is the code laid out correctly", not "is it dangerous to
 * touch" (that is risk-assessment's question). It is a list of typed
 * violations, each carrying the evidence that makes it one, plus root-cause
 * groups and the exclusion summary. Every finding names its `detector`: the
 * Stable Dependencies Principle is the only one today; later boundary
 * detectors (epic r8hme) extend the `ArchitectureViolation` /
 * `ArchitectureRootCause` unions and `ArchitectureReportSummary`.
 */

import type { RelPath } from "../../../contracts/types/codegraph.js";

export interface GetArchitectureReportRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /**
   * Picomatch glob scoping the judged edges: an edge counts when its SOURCE
   * file matches. Instabilities are always computed over the whole graph.
   */
  pathPattern?: string;
  /** Max violations and max root causes returned (default 50); the summary keeps the totals. */
  limit?: number;
}

/** Where a dependency's target sits relative to its source, by directory. */
export type ArchitectureDirectoryRelation = "same" | "descendant" | "ancestor" | "disjoint";

/** Why a Stable Dependencies edge is a violation. */
export interface StableDependencyViolationEvidence {
  /** Martin instability I = fanOut / (fanIn + fanOut) of the source file. */
  sourceInstability: number;
  /** Martin instability of the target file. */
  targetInstability: number;
  /** `targetInstability − sourceInstability`, above the tolerance. The severity. */
  instabilityDelta: number;
  /** Support behind the source's instability: fanIn + fanOut. */
  sourceConnectionCount: number;
  /** Support behind the target's instability: fanIn + fanOut. */
  targetConnectionCount: number;
  /** Confidence-weighted resolved calls across the edge; 0 for a call-free dependency. */
  callWeight: number;
  directoryRelation: ArchitectureDirectoryRelation;
}

/** A stable file depending on a less stable one. */
export interface StableDependencyArchitectureViolation {
  detector: "stableDependencies";
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  evidence: StableDependencyViolationEvidence;
}

export type ArchitectureViolation = StableDependencyArchitectureViolation;

/** Every Stable Dependencies violation into one unstable target, as one finding. */
export interface StableDependencyArchitectureRootCause {
  detector: "stableDependencies";
  targetRelPath: RelPath;
  targetInstability: number;
  /** Stable dependents affected — the severity. */
  violationCount: number;
  maxInstabilityDelta: number;
  sources: RelPath[];
  /** The target references one of its own violating dependents: its instability is self-inflicted. */
  cycleWithDependents: boolean;
}

export type ArchitectureRootCause = StableDependencyArchitectureRootCause;

/** Edges read but not judged, by the first reason that applied. */
export interface StableDependenciesExclusionSummary {
  selfEdges: number;
  unwalkedEndpoints: number;
  noSymbolEndpoints: number;
  lowConnectionCount: number;
  /** The source is the target's sole importer — see `exclusionReasons.privateCollaborators`. */
  privateCollaborators: number;
}

export interface StableDependenciesReportSummary {
  tolerance: number;
  minConnectionCount: number;
  /** Every file edge read. */
  edgeCount: number;
  /** Edges in scope that survived every exclusion. */
  judgedEdgeCount: number;
  /** Total violations, before `limit`. */
  violationCount: number;
  /** Total root causes, before `limit`. */
  rootCauseCount: number;
  excluded: StableDependenciesExclusionSummary;
  /** Human-readable meaning of the exclusions a reader is most likely to question. */
  exclusionReasons: { noSymbolEndpoints: string; privateCollaborators: string };
  /** Edges whose source did not match `pathPattern`; present only when scoped. */
  outOfScopeEdgeCount?: number;
}

export interface ArchitectureReportSummary {
  stableDependencies: StableDependenciesReportSummary;
}

export interface GetArchitectureReportResponse {
  /** The scope the report was judged under, echoed; absent = whole graph. */
  pathPattern?: string;
  summary: ArchitectureReportSummary;
  /** Read these first: most violations first, then largest delta. */
  rootCauses: ArchitectureRootCause[];
  /** Most severe first. */
  violations: ArchitectureViolation[];
}
