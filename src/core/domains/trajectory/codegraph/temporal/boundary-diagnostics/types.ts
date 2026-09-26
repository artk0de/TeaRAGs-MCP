import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import type { DependencyDirectoryRelation } from "../../symbols/boundary-diagnostics/index.js";

export interface SilentCouplingOptions {
  /** Picomatch glob: a pair is judged when EITHER endpoint matches. The threshold is drawn over every pair. */
  sourcePathPattern?: string;
  /**
   * Whether a path is documentation. Injected, because the language table that
   * answers it belongs to ingest; without it no pair is excluded as documentation.
   */
  isDocumentation?: (relPath: RelPath) => boolean;
}

/**
 * How much of the pair the structural graph can see: `both-walked` = both files
 * were walked, so a missing edge is evidence; `one-walked` = the other endpoint
 * is not code the codegraph walks (a config, data or build file), so no edge
 * could ever join them and the pair's coupling is visible only in history.
 */
export type SilentCouplingStructuralVisibility = "both-walked" | "one-walked";

/** A pair that co-changes strongly with no structural link between its files. */
export interface SilentCouplingViolation {
  /** The lexicographically smaller path. */
  relPathA: RelPath;
  relPathB: RelPath;
  /** Change bundles touching both files. */
  support: number;
  /** P(B changes | A changes). */
  confidenceAB: number;
  /** P(A changes | B changes). */
  confidenceBA: number;
  /** Observed co-change over what independence predicts; > 1 always here. */
  lift: number;
  /**
   * The larger of the two directions' Wilson lower bounds (95%) on the
   * conditional co-change rate — how sure the history is that when one file
   * changes, the other changes too. The severity.
   */
  strength: number;
  /** Unix seconds of the latest bundle touching both. */
  lastCoChangeAt: number;
  /** A few shas that touched both, newest first. */
  sampleCommits: string[];
  structuralVisibility: SilentCouplingStructuralVisibility;
  /** Where `relPathB`'s directory sits relative to `relPathA`'s. */
  directoryRelation: DependencyDirectoryRelation;
}

/** A file silently coupled to several partners — its partners change with it for a reason the graph does not show. */
export interface SilentCouplingRootCause {
  relPath: RelPath;
  /** Silent partners, the severity. */
  violationCount: number;
  maxStrength: number;
  /** Partners, strongest first. */
  partners: RelPath[];
}

/** Pairs read but not judged, by the first reason that applied. */
export interface SilentCouplingExclusionCounts {
  /** An endpoint is a test file (the infra file classifier). */
  testEndpoints: number;
  /** An endpoint is generated or vendored code. */
  generatedEndpoints: number;
  /** An endpoint is documentation. */
  documentationEndpoints: number;
  /** Neither endpoint is walked by the codegraph: nothing structural to compare against. */
  unwalkedEndpoints: number;
  /** lift ≤ 1: the pair co-changes no more than independence predicts. */
  nonPositiveLift: number;
}

/** Provenance of the co-change build the report judged. */
export interface SilentCouplingBuildSummary {
  head: string;
  builtAt: number;
  windowSince: number;
  commitCount: number;
  admittedBundleCount: number;
  maxFilesPerBundle: number;
  minSupport: number;
  maxPartnersPerFile: number;
  sessionGapMinutes: number | null;
}

export interface SilentCouplingSummary {
  /** `false` when no co-change build exists yet — every count below is then 0. */
  built: boolean;
  build?: SilentCouplingBuildSummary;
  /** Every stored co-change pair read. */
  pairCount: number;
  /** Pairs that survived every exclusion — the population the threshold is drawn over. */
  candidateCount: number;
  /** Candidates whose strength clears the threshold, linked or not. */
  strongCount: number;
  /** Strong candidates the structural graph DOES link — coupling the code declares. */
  strongLinkedCount: number;
  /** Total violations (strong, unlinked, in scope). */
  violationCount: number;
  rootCauseCount: number;
  /** Otsu's cut over candidate strengths, or the 0.5 floor under `majority`. */
  strengthThreshold: number;
  strengthThresholdMethod: "otsu" | "majority";
  /** η of the Otsu cut; absent under `majority`. */
  strengthSeparability?: number;
  excluded: SilentCouplingExclusionCounts;
  /** Present only when scoped. */
  scope?: { sourcePathPattern: string; outOfScopePairCount: number };
}

export interface SilentCouplingReport {
  summary: SilentCouplingSummary;
  /** Strongest first. */
  violations: SilentCouplingViolation[];
  /** Most silent partners first. */
  rootCauses: SilentCouplingRootCause[];
}
