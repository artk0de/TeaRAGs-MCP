/**
 * Architecture diagnostics DTOs — `get_architecture_report` (bd tea-rags-mcp-94hd9).
 *
 * The report answers "is the code laid out correctly", not "is it dangerous to
 * touch" (that is risk-assessment's question). It is a list of typed
 * violations, each carrying the evidence that makes it one, plus root-cause
 * groups and the exclusion summary. Every finding names its `detector`:
 * `stableDependencies` (Stable Dependencies Principle) and
 * `leakingAbstraction` (A4, bd tea-rags-mcp-jetrd — imports past a facade the
 * module's importers adopted) and `silentCoupling` (A2, bd tea-rags-mcp-b4dcz —
 * files that change together with no structural link, judged over the
 * codegraph's temporal co-change sub-graph). Later boundary detectors (epic r8hme) extend the
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

/** One file edge carrying a component dependency. */
export interface ArchitectureFileEdge {
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  /** Confidence-weighted resolved calls across the edge; 0 for a call-free dependency. */
  callWeight: number;
}

/**
 * Why a component dependency violates Stable Dependencies (bd tea-rags-mcp-r8hme.7).
 * Coupling counts DISTINCT FILES across the component border (Martin counts classes).
 */
export interface StableDependencyViolationEvidence {
  /** Martin instability I = Ce / (Ca + Ce) of the source component. */
  sourceInstability: number;
  /** Martin instability of the target component. */
  targetInstability: number;
  /** `targetInstability − sourceInstability`, above the tolerance. The severity. */
  instabilityDelta: number;
  /** Ca: files outside the source component depending on it. */
  sourceAfferentCount: number;
  /** Ce: files inside the source component depending outward. */
  sourceEfferentCount: number;
  targetAfferentCount: number;
  targetEfferentCount: number;
  /** Confidence-weighted resolved calls across the carrying file edges. */
  callWeight: number;
  /** Where the target component's directory sits relative to the source's. */
  directoryRelation: ArchitectureDirectoryRelation;
  /** File edges carrying the dependency. */
  fileEdgeCount: number;
  /** The carrying file edges, heaviest call weight first, capped at 5. */
  fileEdges: ArchitectureFileEdge[];
}

/**
 * A stable component depending on a less stable one. A component is a module
 * whose facade the leaking-abstraction detector measured (its directory
 * subtree), or a plain directory; `""` is the repository root.
 */
export interface StableDependencyArchitectureViolation {
  detector: "stableDependencies";
  sourceComponent: string;
  targetComponent: string;
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

/**
 * How much of a silently coupled pair the structural graph can see:
 * `both-walked` = both files are walked code, so the missing edge is evidence;
 * `one-walked` = the other file is not walked (config, data, build script), so
 * no edge could ever join them.
 */
export type SilentCouplingStructuralVisibility = "both-walked" | "one-walked";

/** Why a co-change pair is a silent-coupling violation (bd tea-rags-mcp-b4dcz). */
export interface SilentCouplingViolationEvidence {
  /** Change bundles (commits, or author sessions when squash-aware) touching both files. */
  support: number;
  /** P(target changes | source changes). */
  confidenceAB: number;
  /** P(source changes | target changes). */
  confidenceBA: number;
  /** Observed co-change over what independence predicts; always > 1 here. */
  lift: number;
  /**
   * The larger direction's 95% Wilson lower bound on the conditional co-change
   * rate — how sure the history is that one file's change brings the other's.
   * The severity.
   */
  strength: number;
  /** Unix seconds of the latest bundle touching both. */
  lastCoChangeAt: number;
  /** A few shas that touched both, newest first. */
  sampleCommits: string[];
  structuralVisibility: SilentCouplingStructuralVisibility;
  /** Where the target's directory sits relative to the source's. */
  directoryRelation: ArchitectureDirectoryRelation;
}

/**
 * Two files that change together strongly while no import, re-export or
 * resolved call joins them. The pair is undirected: `sourceRelPath` is the
 * lexicographically smaller path.
 */
export interface SilentCouplingArchitectureViolation {
  detector: "silentCoupling";
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  evidence: SilentCouplingViolationEvidence;
}

/** Where a component far from the main sequence sits (bd tea-rags-mcp-r8hme.8). */
export type MainSequenceZone = "pain" | "uselessness";

/** Why a component is off the main sequence. */
export interface MainSequenceViolationEvidence {
  /** `pain` = A + I < 1: stable and concrete. `uselessness` = A + I > 1: unstable and abstract. */
  zone: MainSequenceZone;
  /** D = |A + I - 1| — the severity. */
  distance: number;
  /** A = abstract / (abstract + concrete) types. */
  abstractness: number;
  /** I = Ce / (Ca + Ce) of the component. */
  instability: number;
  abstractTypeCount: number;
  concreteTypeCount: number;
  afferentCount: number;
  efferentCount: number;
  fileCount: number;
  /** Files of the component the type census never ran over. */
  unmeasuredFileCount: number;
  /**
   * How often the component changes, judged against the adaptive volatility
   * cut (bd tea-rags-mcp-r8hme.14). Present when the gate ran and a file of
   * the component carries `git.file.commitCount`.
   */
  volatility?: MainSequenceComponentVolatilityEvidence;
}

/** A component's volatility: mean `git.file.commitCount` over its measured files. */
export interface MainSequenceComponentVolatilityEvidence {
  /** Mean commits per file over the git window, 3 decimals. */
  value: number;
  /** Files of the component carrying a commit count. */
  measuredFileCount: number;
  /** The cut `value` had to reach (and exceed the median file), 3 decimals. */
  threshold: number;
  /** `volatile` keeps a pain component reported; `calm` drops it into `excluded.stableConcreteCalm`. */
  label: "volatile" | "calm";
}

/**
 * A component far from Martin's main sequence A + I = 1 — the Stable
 * Abstractions Principle: the more a component is depended on, the more of it
 * should be abstract.
 */
export interface MainSequenceArchitectureViolation {
  detector: "mainSequence";
  component: string;
  componentKind: "module" | "directory";
  /** The module's entry file; `null` for a directory component. */
  facadeRelPath: RelPath | null;
  evidence: MainSequenceViolationEvidence;
}

export type ArchitectureViolation =
  | StableDependencyArchitectureViolation
  | LeakingAbstractionArchitectureViolation
  | SilentCouplingArchitectureViolation
  | MainSequenceArchitectureViolation;

/** Every Stable Dependencies violation into one unstable target component, as one finding. */
export interface StableDependencyArchitectureRootCause {
  detector: "stableDependencies";
  targetComponent: string;
  targetInstability: number;
  /** Stable dependent components affected — the severity. */
  violationCount: number;
  maxInstabilityDelta: number;
  /** Source components, by path. */
  sources: string[];
  /** The target depends back on one of its violating dependents: its instability is self-inflicted. */
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

/** A file silently coupled to two or more partners, as one finding. */
export interface SilentCouplingArchitectureRootCause {
  detector: "silentCoupling";
  relPath: RelPath;
  /** Silent partners — the severity. */
  violationCount: number;
  maxStrength: number;
  /** Partners, strongest first. */
  partners: RelPath[];
}

export type ArchitectureRootCause =
  | StableDependencyArchitectureRootCause
  | LeakingAbstractionArchitectureRootCause
  | SilentCouplingArchitectureRootCause;

/**
 * Edges read but not judged, by the first reason that applied: file edges that
 * never became a component dependency, then component dependencies not judged.
 */
export interface StableDependenciesExclusionSummary {
  /** File edges from a file to itself. */
  selfEdges: number;
  /** File edges with an endpoint the codegraph walk never extracted. */
  unwalkedEndpoints: number;
  /** File edges inside one component. */
  intraComponent: number;
  /** File edges: a module facade re-exporting a nested module's facade — see `exclusionReasons.facadeAggregations`. */
  facadeAggregations: number;
  /** Component dependencies on a component nested inside the source — see `exclusionReasons.containment`. */
  containment: number;
  /** Component dependencies with an end whose Ca + Ce is below `minConnectionCount`. */
  lowConnectionCount: number;
}

export interface StableDependenciesReportSummary {
  tolerance: number;
  /** Minimum component Ca + Ce for both ends of a judged dependency. */
  minConnectionCount: number;
  /** Every production file edge read. */
  edgeCount: number;
  componentCount: number;
  /** Components that are modules with a measured facade. */
  moduleComponentCount: number;
  /** Components that are plain directories. */
  directoryComponentCount: number;
  /** Component dependencies built from the file edges. */
  componentEdgeCount: number;
  /** In-scope component dependencies that survived every exclusion. */
  judgedEdgeCount: number;
  /** Total violations, before `limit`. */
  violationCount: number;
  /** Total root causes, before `limit`. */
  rootCauseCount: number;
  excluded: StableDependenciesExclusionSummary;
  /** Human-readable meaning of the exclusions a reader is most likely to question. */
  exclusionReasons: { facadeAggregations: string; containment: string };
  /** Component dependencies none of whose file edges has a source matching `pathPattern`; present only when scoped. */
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

/**
 * Development tooling (scripts, spikes, benchmarks, examples, fixtures) taken
 * out of the graph before any detector runs (bd tea-rags-mcp-r8hme.9). The
 * detectors' `edgeCount` counts the production graph.
 */
export interface NonProductionExclusionSummary {
  excludedFileCount: number;
  /** Edges with a non-production endpoint. */
  excludedEdgeCount: number;
  /** Human-readable meaning of the exclusion. */
  reason: string;
}

/** Provenance of the co-change build silent coupling was judged over. */
export interface SilentCouplingBuildSummary {
  /** HEAD the history was read at. */
  head: string;
  /** Unix seconds. */
  builtAt: number;
  /** Unix seconds: the oldest commit the window admitted. */
  windowSince: number;
  commitCount: number;
  /** Change bundles that survived the mass-change cut. */
  admittedBundleCount: number;
  /** The adaptive mass-change cut: bigger bundles were dropped as noise. */
  maxFilesPerBundle: number;
  /** Support floor a stored pair needed. */
  minSupport: number;
  /** Partners kept per file. */
  maxPartnersPerFile: number;
  /** Author-session gap bundles were merged over; `null` = per commit. */
  sessionGapMinutes: number | null;
}

export interface SilentCouplingReportSummary {
  /**
   * `false` when the codegraph has no co-change build yet (git trajectory off,
   * or no index run since the feature landed) — every count is then 0 and the
   * absence of violations says nothing.
   */
  built: boolean;
  build?: SilentCouplingBuildSummary;
  /** Every stored co-change pair read. */
  pairCount: number;
  /** Pairs that survived every exclusion — the population the threshold is drawn over. */
  candidateCount: number;
  /** Candidates whose strength clears the threshold, linked or not. */
  strongCount: number;
  /** Strong candidates the structural graph does link — coupling the code declares. */
  strongLinkedCount: number;
  /** Total violations, before `limit`. */
  violationCount: number;
  /** Total root causes (files with ≥ 2 silent partners), before `limit`. */
  rootCauseCount: number;
  /**
   * Otsu's split over candidate strengths, or 0.5 under `majority`; either way
   * a pair is strong only when its strength is also STRICTLY above 0.5.
   */
  strengthThreshold: number;
  /** `otsu` when the population allowed a split (≥ 8 candidates, ≥ 2 distinct values), else `majority`. */
  strengthThresholdMethod: "otsu" | "majority";
  /** η of the Otsu cut, 3 decimals; absent under `majority`. */
  strengthSeparability?: number;
  /** Pairs read but not judged, by the first reason that applied. */
  excluded: {
    testEndpoints: number;
    generatedEndpoints: number;
    documentationEndpoints: number;
    /** Neither file is walked by the codegraph. */
    unwalkedEndpoints: number;
    /** lift ≤ 1: no more co-change than independence predicts. */
    nonPositiveLift: number;
  };
  /** Strong unlinked pairs with neither file matching `pathPattern`; present only when scoped. */
  outOfScopePairCount?: number;
}

/** How the volatility cut on the zone of pain was drawn. */
export interface MainSequenceVolatilityReportSummary {
  /** The per-file reading a component's volatility averages. */
  signal: "git.file.commitCount";
  /** 3 decimals. */
  threshold: number;
  /** `otsu` = Otsu's split over judged components' log volatilities (cut reported back on the count scale), floored at `fileMedian`; `fileMedian` = the floor alone (too few components). */
  thresholdMethod: "otsu" | "fileMedian";
  /** η of the Otsu cut, 3 decimals; absent under `fileMedian`. */
  separability?: number;
  /** Median commit count over the judged graph's files — a volatile component's mean must be strictly above it. */
  fileMedian: number;
  /** Judged components with a measured file — the population the cut is drawn over. */
  measuredComponentCount: number;
}

export interface MainSequenceReportSummary {
  /** Components that survived every exclusion. */
  judgedComponentCount: number;
  /** Total violations, before `limit`. */
  violationCount: number;
  painCount: number;
  uselessnessCount: number;
  /** Mean D over judged components, 3 decimals; 0 when none is judged. */
  meanDistance: number;
  /** Otsu's split over judged distances, or the 0.5 floor under `majority`; D must also be STRICTLY above 0.5. */
  distanceThreshold: number;
  /** `otsu` when the population allowed a split (≥ 8 judged, ≥ 2 distinct distances), else `majority`. */
  distanceThresholdMethod: "otsu" | "majority";
  /** η of the Otsu cut, 3 decimals; absent under `majority`. */
  distanceSeparability?: number;
  /** Ca + Ce floor, the Stable Dependencies one. */
  minConnectionCount: number;
  /** Abstract + concrete type floor A is read from. */
  minTypeCount: number;
  /** Abstract share of every measured type per language, 3 decimals — what `unobservableAbstractness` is judged against. */
  abstractTypeShareByLanguage: Record<string, number>;
  /** Components read but not judged, by the first reason that applied. */
  excluded: {
    lowConnectionCount: number;
    /** No file carries a type census — the index predates it; a codegraph recompute fills it. */
    unmeasured: number;
    fewTypes: number;
    /** See `exclusionReasons.unobservableAbstractness`. */
    unobservableAbstractness: number;
    /**
     * Judged and past the distance cut in the zone of pain, but calm — see
     * `exclusionReasons.stableConcreteCalm`. 0 when `volatility` is absent.
     */
    stableConcreteCalm: number;
  };
  /** Human-readable meaning of the exclusions a reader is most likely to question. */
  exclusionReasons: { unobservableAbstractness: string; stableConcreteCalm: string };
  /**
   * The volatility gate on the zone of pain (bd tea-rags-mcp-r8hme.14); absent
   * when it did not run — no git trajectory data, or nothing in the zone of pain.
   */
  volatility?: MainSequenceVolatilityReportSummary;
  /** Judged components with no file matching `pathPattern`; present only when scoped. */
  outOfScopeComponentCount?: number;
}

export interface ArchitectureReportSummary {
  nonProduction: NonProductionExclusionSummary;
  stableDependencies: StableDependenciesReportSummary;
  leakingAbstraction: LeakingAbstractionReportSummary;
  silentCoupling: SilentCouplingReportSummary;
  mainSequence: MainSequenceReportSummary;
}

export interface GetArchitectureReportResponse {
  /** The scope the report was judged under, echoed; absent = whole graph. */
  pathPattern?: string;
  summary: ArchitectureReportSummary;
  /**
   * Read these first. Per detector, `stableDependencies`, then
   * `leakingAbstraction`, then `silentCoupling`, each capped at `limit` and
   * ordered most violations first.
   */
  rootCauses: ArchitectureRootCause[];
  /**
   * Per detector in the same order, then `mainSequence` (one finding per
   * component, no root cause), each capped at `limit`, most severe first.
   */
  violations: ArchitectureViolation[];
}
