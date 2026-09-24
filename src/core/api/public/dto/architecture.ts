/**
 * Architecture diagnostics DTOs — `get_architecture_report` (bd tea-rags-mcp-94hd9).
 *
 * The report answers "is the code laid out correctly", not "is it dangerous to
 * touch" (that is risk-assessment's question). It is a list of typed
 * violations, each carrying the evidence that makes it one, plus root-cause
 * groups and the exclusion summary. Every finding names its `detector`:
 * `stableDependencies` (Stable Dependencies Principle) and
 * `leakingAbstraction` (A4, bd tea-rags-mcp-jetrd — imports past a facade the
 * module's importers adopted). Later boundary detectors (epic r8hme) extend the
 * `ArchitectureViolation` / `ArchitectureRootCause` unions and
 * `ArchitectureReportSummary`.
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
   * file matches. Instabilities and facade adoption are always computed over
   * the whole graph.
   */
  pathPattern?: string;
  /** Max violations and max root causes returned per detector (default 50); the summary keeps the totals. */
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

/**
 * How an edge into a module with an adopted facade leaks past it:
 * `bypass` = the facade itself imports the target (the importer could have
 * gone through it), `internal-reach` = the facade does not.
 */
export type FacadeLeakKind = "bypass" | "internal-reach";

/** Why an edge into a module is a leaking-abstraction violation. */
export interface FacadeLeakViolationEvidence {
  /** The innermost module with an active boundary the edge leaks past. */
  moduleDir: string;
  /** Its entry file (facade). */
  facadeRelPath: RelPath;
  /** facadeImporterCount / (facadeImporterCount + deepImporterCount). */
  adoption: number;
  /** Distinct external importers going only through the facade. */
  facadeImporterCount: number;
  /** Distinct external importers reaching a non-entry file (a file doing both counts here). */
  deepImporterCount: number;
  /** Confidence-weighted resolved calls across the edge; 0 for a call-free dependency. */
  callWeight: number;
  /**
   * Names the import takes from the target (`default`; `*` = whole module).
   * Present when the index recorded them — the kind is then decided by names.
   */
  importedNames?: string[];
  /** `internal-reach` decided by names: the imported names the facade does not expose. */
  nonExportedNames?: string[];
}

/** A file outside a module importing one of its non-entry files while its peers use the facade. */
export interface FacadeLeakArchitectureViolation {
  detector: "leakingAbstraction";
  kind: FacadeLeakKind;
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  evidence: FacadeLeakViolationEvidence;
}

/**
 * Which privacy convention a `conventionPrivacy` leak broke:
 * `python-underscore` = a `_name` member used from another package directory,
 * `ruby-send-private` = `send(:name)` into a private / protected method from
 * outside its class.
 */
export type ConventionPrivacyRule = "python-underscore" | "ruby-send-private";

/** Why a method edge is a convention-privacy leak (bd tea-rags-mcp-r8hme.1). */
export interface ConventionPrivacyViolationEvidence {
  sourceSymbolId: string;
  targetSymbolId: string;
  rule: ConventionPrivacyRule;
}

/** A member private only by convention, reached from where the convention forbids. */
export interface ConventionPrivacyArchitectureViolation {
  detector: "leakingAbstraction";
  kind: "conventionPrivacy";
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  evidence: ConventionPrivacyViolationEvidence;
}

export type LeakingAbstractionArchitectureViolation =
  | FacadeLeakArchitectureViolation
  | ConventionPrivacyArchitectureViolation;

export type ArchitectureViolation = StableDependencyArchitectureViolation | LeakingAbstractionArchitectureViolation;

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

/** Every leaking-abstraction violation of one module, as one finding. */
export interface LeakingAbstractionArchitectureRootCause {
  detector: "leakingAbstraction";
  moduleDir: string;
  facadeRelPath: RelPath;
  adoption: number;
  facadeImporterCount: number;
  deepImporterCount: number;
  violationCount: number;
  bypassCount: number;
  internalReachCount: number;
  /** Distinct violating sources, by path. */
  sources: RelPath[];
}

export type ArchitectureRootCause = StableDependencyArchitectureRootCause | LeakingAbstractionArchitectureRootCause;

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

/** Why a module's boundary is not judged by the leaking-abstraction detector. */
export type FacadeModuleExclusionReason = "facade-not-adopted" | "too-few-importers" | "language-enforced";

/** One module and its facade adoption. */
export interface FacadeModuleSummary {
  moduleDir: string;
  /** Entry file; `null` for a Go package. */
  facadeRelPath: RelPath | null;
  externalImporterCount: number;
  facadeImporterCount: number;
  deepImporterCount: number;
  adoption: number;
}

export interface LeakingAbstractionReportSummary {
  /**
   * The adaptive adoption threshold: Otsu's split over the adoption of every
   * module with enough importers, or 0.5 under `majority`. Either way a
   * boundary is judged only when adoption is also STRICTLY above 0.5.
   */
  adoptionThreshold: number;
  /** `otsu` when the population allowed a split (≥ 8 modules, ≥ 2 distinct values), else `majority`. */
  adoptionThresholdMethod: "otsu" | "majority";
  /** η = σ²between / σ²total of the Otsu cut, 3 decimals; absent under `majority`. Near 1 = clean split. */
  adoptionSeparability?: number;
  /** Minimum distinct external importers for a boundary to be judged (3). */
  minExternalImporters: number;
  /** Every file edge read. */
  edgeCount: number;
  /** In-scope edges entering an active module from outside it. */
  judgedEdgeCount: number;
  /** Total violations of both kinds (facade leaks + convention privacy), before `limit`. */
  violationCount: number;
  /** Total root causes (modules with a violation), before `limit`. */
  rootCauseCount: number;
  violationsByKind: { bypass: number; internalReach: number; conventionPrivacy: number };
  /** The convention-privacy half: method edges into non-public members of Python / Ruby. */
  conventionPrivacy: {
    /** Candidate method edges read (targets private / protected / `_`-named). */
    candidateEdgeCount: number;
    violationsByRule: { pythonUnderscore: number; rubySendPrivate: number };
  };
  /** Candidate modules: directories with an entry file, plus Go packages. */
  moduleCount: number;
  activeModuleCount: number;
  excludedModules: { facadeNotAdopted: number; tooFewImporters: number; languageEnforced: number };
  /** Human-readable meaning of each module exclusion. */
  exclusionReasons: Record<FacadeModuleExclusionReason, string>;
  /** The modules whose boundary is judged, by path; capped at `limit`. */
  activeModules: FacadeModuleSummary[];
  /** Modules excluded as `facade-not-adopted`, most importers first; capped at `limit`. */
  notAdoptedModules: FacadeModuleSummary[];
  /** Edges whose source did not match `pathPattern`; present only when scoped. */
  outOfScopeEdgeCount?: number;
}

export interface ArchitectureReportSummary {
  stableDependencies: StableDependenciesReportSummary;
  leakingAbstraction: LeakingAbstractionReportSummary;
}

export interface GetArchitectureReportResponse {
  /** The scope the report was judged under, echoed; absent = whole graph. */
  pathPattern?: string;
  summary: ArchitectureReportSummary;
  /**
   * Read these first. Per detector, `stableDependencies` then
   * `leakingAbstraction`, each capped at `limit` and ordered most violations first.
   */
  rootCauses: ArchitectureRootCause[];
  /** Per detector in the same order, each capped at `limit`, most severe first. */
  violations: ArchitectureViolation[];
}
