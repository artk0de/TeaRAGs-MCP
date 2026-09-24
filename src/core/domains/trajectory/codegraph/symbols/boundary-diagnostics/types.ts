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

/**
 * How an edge into an active module leaks its abstraction (bd tea-rags-mcp-jetrd):
 *
 * - `bypass`         — the facade itself imports the target (re-exports it): the
 *                      importer could have gone through the facade and did not.
 * - `internal-reach` — the facade does not import the target: the importer
 *                      reaches something the module never offered.
 */
export type FacadeLeakKind = "bypass" | "internal-reach";

/**
 * Why a module's boundary is not judged:
 *
 * - `facade-not-adopted` — adoption not admitted by the adaptive threshold
 *   (`resolveFacadeAdoptionThreshold`): the importers themselves do not treat
 *   the entry file as the module's surface.
 * - `too-few-importers`  — fewer than `FACADE_MIN_EXTERNAL_IMPORTERS` external
 *   importers: adoption over so few files says nothing.
 * - `language-enforced`  — a Go package: the compiler already enforces the
 *   package boundary, so nothing can leak past it at file level.
 */
export type FacadeModuleExclusionReason = "facade-not-adopted" | "too-few-importers" | "language-enforced";

export type FacadeModuleStatus = "active" | FacadeModuleExclusionReason;

/** A module's facade adoption, counted over DISTINCT external importing files. */
export interface FacadeAdoption {
  /** `facadeImporterCount / (facadeImporterCount + deepImporterCount)`; 0 with no importer. */
  adoption: number;
  /** External importers whose every edge into the module targets its entry file. */
  facadeImporterCount: number;
  /** External importers with at least one edge to a non-entry file (a file doing both counts here). */
  deepImporterCount: number;
}

/** One candidate module and whether its boundary is judged. */
export interface FacadeModuleAssessment extends FacadeAdoption {
  /** The module directory, repo-relative; `""` for the repository root. */
  moduleDir: string;
  /** The entry file (facade); `null` for a Go package, which has none. */
  facadeRelPath: RelPath | null;
  /** Distinct files outside the module with a file edge into it. */
  externalImporterCount: number;
  status: FacadeModuleStatus;
}

/** One edge from outside an active module into one of its non-entry files. */
export interface FacadeLeakViolation extends FacadeAdoption {
  kind: FacadeLeakKind;
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  /** The innermost active module the edge leaks past. */
  moduleDir: string;
  facadeRelPath: RelPath;
  /** Confidence-weighted resolved calls across the edge; 0 for a call-free dependency. */
  callWeight: number;
}

export interface LeakingAbstractionOptions {
  /**
   * Picomatch glob: judge only edges whose SOURCE matches. Adoption is always
   * counted over the whole graph — a module's importers do not shrink because
   * the reader looks at one area.
   */
  sourcePathPattern?: string;
}

export interface LeakingAbstractionSummary {
  /** The adaptive cut: Otsu's split over the population, or 0.5 under `majority`. */
  adoptionThreshold: number;
  /** How `adoptionThreshold` was drawn; either way adoption must also be > 0.5. */
  adoptionThresholdMethod: "otsu" | "majority";
  /** η of the Otsu cut (σ²between / σ²total); present only under `otsu`. */
  adoptionSeparability?: number;
  minExternalImporters: number;
  /** Every file edge read. */
  edgeCount: number;
  /** In-scope edges entering an active module from outside it — the edges judged. */
  judgedEdgeCount: number;
  violationCount: number;
  violationsByKind: { bypass: number; internalReach: number };
  /** Candidate modules: directories with an entry file, plus Go package directories. */
  moduleCount: number;
  activeModuleCount: number;
  excludedModules: { facadeNotAdopted: number; tooFewImporters: number; languageEnforced: number };
  /** Present when `sourcePathPattern` scoped the run (same shape as the SDP scope). */
  scope?: StableDependenciesScope;
}

/** Every violation of one module, as one finding: the module's leak profile. */
export interface FacadeLeakRootCause extends FacadeAdoption {
  moduleDir: string;
  facadeRelPath: RelPath;
  violationCount: number;
  bypassCount: number;
  internalReachCount: number;
  /** Distinct violating sources, by path. */
  sources: RelPath[];
}

export interface LeakingAbstractionReport {
  /** `internal-reach` first, then call weight, then path. */
  violations: FacadeLeakViolation[];
  /** `violations` grouped by module: most violations first, then `moduleDir`. */
  rootCauses: FacadeLeakRootCause[];
  /** Every candidate module, by `moduleDir`. */
  modules: FacadeModuleAssessment[];
  summary: LeakingAbstractionSummary;
}

/**
 * Which convention a convention-privacy leak broke (bd tea-rags-mcp-r8hme.1):
 * `python-underscore` — a `_name` member used from another package directory;
 * `ruby-send-private` — `send(:name)` into a private / protected method from
 * outside its class.
 */
export type ConventionPrivacyRule = "python-underscore" | "ruby-send-private";

export interface ConventionPrivacyOptions {
  /** Picomatch glob: judge only edges whose SOURCE file matches. */
  sourcePathPattern?: string;
}

/** One method edge that reaches a convention-private member from outside. */
export interface ConventionPrivacyViolation {
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  sourceSymbolId: string;
  targetSymbolId: string;
  rule: ConventionPrivacyRule;
}

export interface ConventionPrivacySummary {
  /** Candidate edges read (method edges into non-public members). */
  candidateEdgeCount: number;
  violationCount: number;
  violationsByRule: { pythonUnderscore: number; rubySendPrivate: number };
  scope?: StableDependenciesScope;
}

export interface ConventionPrivacyReport {
  /** By source file, source symbol, then target. */
  violations: ConventionPrivacyViolation[];
  summary: ConventionPrivacySummary;
}
