import type { FileDependencyEdge, RelPath } from "../../../../../contracts/types/codegraph.js";

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
  /**
   * A module facade re-exporting the facade of a module nested inside it
   * (`FACADE_AGGREGATION_REASON`, bd tea-rags-mcp-r8hme.6): aggregation, not a
   * dependency.
   */
  facadeAggregations: number;
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
  /**
   * Names the deep import takes from the target (`default`, `*` = whole module),
   * when the walk recorded them (bd tea-rags-mcp-r8hme.2); absent otherwise.
   */
  importedNames?: string[];
  /** For a names-decided `internal-reach`: the imported names the facade does not expose. */
  nonExportedNames?: string[];
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

/**
 * How a component came to be (bd tea-rags-mcp-r8hme.7): `module` = a directory
 * whose facade the leaking-abstraction detector measured, owning its subtree;
 * `directory` = the fallback, a plain directory's own files.
 */
export type ArchitectureComponentKind = "module" | "directory";

/** One component of the partition and its Martin coupling, counted over files. */
export interface ArchitectureComponent {
  /** The component's directory, repo-relative; `""` for the repository root. */
  componentDir: string;
  kind: ArchitectureComponentKind;
  /** The module's entry file; `null` for a directory component. */
  facadeRelPath: RelPath | null;
  /** Walked files the component holds. */
  fileCount: number;
  /** Ca: distinct files outside the component with an edge into it. */
  afferentCount: number;
  /** Ce: distinct files inside the component with an edge out of it. */
  efferentCount: number;
  /** Ca + Ce — the support behind `instability`. */
  connectionCount: number;
  /** Ce / (Ca + Ce); 0 with no edge. */
  instability: number;
}

/** File edges from one component into another, as one dependency. */
export interface ComponentDependency {
  sourceComponent: string;
  targetComponent: string;
  /** `descendant` = the target is nested inside the source's directory (containment). */
  directoryRelation: DependencyDirectoryRelation;
  /** Sum of the carried file edges' call weights. */
  callWeight: number;
  /** The file edges that carry the dependency, in graph order. */
  fileEdges: FileDependencyEdge[];
}

/** File edges that never became a component dependency, by the first reason that applied. */
export interface ComponentGraphExclusionCounts {
  selfEdges: number;
  /** An endpoint the codegraph walk never extracted. */
  unwalkedEndpoints: number;
  /** Both endpoints in one component. */
  intraComponent: number;
  /** A module facade re-exporting a nested module's facade (`FACADE_AGGREGATION_REASON`). */
  facadeAggregations: number;
}

export interface ComponentGraph {
  /** Every component, by `componentDir`. */
  components: Map<string, ArchitectureComponent>;
  /** Walked file → the component holding it. */
  componentOf: Map<RelPath, string>;
  /** By source component, then target component. */
  dependencies: ComponentDependency[];
  excluded: ComponentGraphExclusionCounts;
  /** Every file edge read. */
  fileEdgeCount: number;
}

export interface ComponentStableDependenciesOptions {
  /** Flagged when `I(target) − I(source) > tolerance`. Default `DEFAULT_SDP_TOLERANCE`. */
  tolerance?: number;
  /** Minimum component `connectionCount` for BOTH ends. Default `DEFAULT_SDP_MIN_CONNECTION_COUNT`. */
  minConnectionCount?: number;
  /**
   * Picomatch glob: judge only component dependencies at least one of whose
   * file edges has a matching source. Coupling is always counted over the
   * whole graph.
   */
  sourcePathPattern?: string;
}

/** One file edge carrying a component dependency. */
export interface ComponentDependencyFileEdge {
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  callWeight: number;
}

/** A stable component depending on a less stable one. */
export interface ComponentStableDependencyViolation {
  sourceComponent: string;
  targetComponent: string;
  sourceInstability: number;
  targetInstability: number;
  /** `targetInstability − sourceInstability`, above the tolerance. The severity. */
  instabilityDelta: number;
  sourceAfferentCount: number;
  sourceEfferentCount: number;
  targetAfferentCount: number;
  targetEfferentCount: number;
  /** Sum of the carried file edges' call weights. */
  callWeight: number;
  directoryRelation: DependencyDirectoryRelation;
  /** How many file edges carry the dependency. */
  fileEdgeCount: number;
  /** The carrying file edges, heaviest call weight first, capped at `COMPONENT_EVIDENCE_FILE_EDGE_LIMIT`. */
  fileEdges: ComponentDependencyFileEdge[];
}

/** Every violation into one unstable target component, as one finding. */
export interface ComponentStableDependencyRootCause {
  targetComponent: string;
  targetInstability: number;
  violationCount: number;
  maxInstabilityDelta: number;
  /** Source components, by path. */
  sources: string[];
  /** The target depends back on one of its violating sources. */
  cycleWithDependents: boolean;
}

/** Edges read but not judged: file-edge reasons from the component graph, then component-edge reasons. */
export interface ComponentStableDependenciesExclusionCounts extends ComponentGraphExclusionCounts {
  /** Component dependencies on a component nested inside the source (`COMPONENT_CONTAINMENT_REASON`). */
  containment: number;
  /** Component dependencies with an end below `minConnectionCount`. */
  lowConnectionCount: number;
}

export interface ComponentStableDependenciesSummary {
  tolerance: number;
  minConnectionCount: number;
  /** Every file edge read. */
  edgeCount: number;
  componentCount: number;
  moduleComponentCount: number;
  directoryComponentCount: number;
  /** Component dependencies built from the file edges. */
  componentEdgeCount: number;
  /** In-scope component dependencies that survived every exclusion. */
  judgedEdgeCount: number;
  violationCount: number;
  excluded: ComponentStableDependenciesExclusionCounts;
  /** Present when scoped; `outOfScopeEdgeCount` counts COMPONENT dependencies. */
  scope?: StableDependenciesScope;
}

export interface ComponentStableDependenciesReport {
  /** Most severe first: delta, then call weight, then path. */
  violations: ComponentStableDependencyViolation[];
  /** Grouped by target: most violations first, then max delta, then path. */
  rootCauses: ComponentStableDependencyRootCause[];
  summary: ComponentStableDependenciesSummary;
}

/** Where a component far from the main sequence sits (bd tea-rags-mcp-r8hme.8). */
export type MainSequenceZone = "pain" | "uselessness";

export interface MainSequenceOptions {
  /** Connection floor on Ca + Ce; defaults to the SDP floor. */
  minConnectionCount?: number;
  /** Type floor on abstract + concrete; defaults to `DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT`. */
  minTypeCount?: number;
  /** Report only components holding a file matching this glob; every number is still whole-graph. */
  sourcePathPattern?: string;
  /**
   * How often each file changes (the report feeds `git.file.commitCount`),
   * keyed by path; a file without a reading is absent. Given with at least one
   * reading, a pain-zone component must also be VOLATILE to be reported (bd
   * tea-rags-mcp-r8hme.14); absent, the zone of pain is judged on D alone.
   */
  fileVolatility?: ReadonlyMap<RelPath, number>;
}

/** Whether a component changes often enough for the zone of pain to hurt. */
export type MainSequenceVolatilityLabel = "volatile" | "calm";

/** A component's volatility and the adaptive cut it was judged against. */
export interface MainSequenceComponentVolatility {
  /** Mean per-file volatility over the component's files that carry a reading. */
  value: number;
  /** Files of the component with a reading — the mean's denominator. */
  measuredFileCount: number;
  /** The cut `value` had to reach; it must also be strictly above the median file's reading. */
  threshold: number;
  label: MainSequenceVolatilityLabel;
}

/** How the volatility cut was drawn; present only when the gate ran. */
export interface MainSequenceVolatilitySummary {
  threshold: number;
  /**
   * `otsu` = Otsu's split over the judged components' LOG volatilities, floored at
   * the median file; `fileMedian` = too few components for Otsu, the floor alone.
   */
  thresholdMethod: "otsu" | "fileMedian";
  /** η of the Otsu cut; absent under `fileMedian`. */
  separability?: number;
  /** Median reading over the graph's files: a volatile component's mean must be strictly above it. */
  fileMedian: number;
  /** Judged components with at least one measured file — the Otsu population. */
  measuredComponentCount: number;
}

/** One component judged against the main sequence, far enough off it to report. */
export interface MainSequenceViolation {
  component: string;
  kind: ArchitectureComponentKind;
  facadeRelPath: RelPath | null;
  /** `pain` = A + I < 1 (stable and concrete); `uselessness` = A + I > 1 (unstable and abstract). */
  zone: MainSequenceZone;
  /** D = |A + I - 1|. */
  distance: number;
  /** A = abstract / (abstract + concrete). */
  abstractness: number;
  /** I = Ce / (Ca + Ce), from the component graph. */
  instability: number;
  abstractTypeCount: number;
  concreteTypeCount: number;
  afferentCount: number;
  efferentCount: number;
  fileCount: number;
  /** Files of the component the census never ran over (written before it existed). */
  unmeasuredFileCount: number;
  /** Present when the volatility gate ran and a file of the component carries a reading. */
  volatility?: MainSequenceComponentVolatility;
}

/** Components read but not judged, by the first reason that applied. */
export interface MainSequenceExclusionCounts {
  /** Ca + Ce below `minConnectionCount`: I is untrustworthy. */
  lowConnectionCount: number;
  /** No file of the component carries a census. */
  unmeasured: number;
  /** Fewer than `minTypeCount` types: one type moves A by more than the floor's margin. */
  fewTypes: number;
  /**
   * Its languages declare abstractions so rarely in this codebase that a
   * component of its size would not be expected to show one (expected abstract
   * types < 1): an A of 0 there is the language's idiom, not the component's.
   */
  unobservableAbstractness: number;
  /**
   * Judged, past the distance cut, in the zone of pain — but calm: its files
   * change no more than the volatility cut, so its rigidity costs nothing
   * (Martin's `String`). 0 when the volatility gate did not run.
   */
  stableConcreteCalm: number;
}

export interface MainSequenceScope {
  sourcePathPattern: string;
  /** Judged components with no file matching the pattern. */
  outOfScopeComponentCount: number;
}

export interface MainSequenceSummary {
  componentCount: number;
  judgedComponentCount: number;
  violationCount: number;
  painCount: number;
  uselessnessCount: number;
  /** Mean D over judged components — Martin's D-bar for the system; 0 when none is judged. */
  meanDistance: number;
  /** The cut D must reach; D must also be strictly above `MAIN_SEQUENCE_DISTANCE_FLOOR`. */
  distanceThreshold: number;
  distanceThresholdMethod: "otsu" | "majority";
  distanceSeparability?: number;
  minConnectionCount: number;
  minTypeCount: number;
  /** Abstract share of every measured type, per language — what `unobservableAbstractness` is judged against. */
  abstractTypeShareByLanguage: Record<string, number>;
  excluded: MainSequenceExclusionCounts;
  /** Present only when `fileVolatility` was given with at least one reading. */
  volatility?: MainSequenceVolatilitySummary;
  scope?: MainSequenceScope;
}

export interface MainSequenceReport {
  /** Farthest first, then component path. */
  violations: MainSequenceViolation[];
  summary: MainSequenceSummary;
}

/** Position of one component in the inferred layer stack (bd tea-rags-mcp-r8hme.22). */
export interface LayeringComponentPosition {
  /** Longest dependency path from the sinks of the condensed graph: 0 = foundation. */
  level: number;
  /** Longest dependency path from the roots: 0 = nothing depends on it. */
  depth: number;
  /** The component is a member of a multi-component knot (an SCC). */
  inKnot: boolean;
}

/** One edge the feedback arc set removes to dissolve a knot. */
export interface LayeringFeedbackEdge {
  sourceComponent: string;
  targetComponent: string;
  /** Sum of the carried file edges' call weights — the weight the cut pays. */
  callWeight: number;
  /** The carrying file edges, heaviest call weight first, capped at `COMPONENT_EVIDENCE_FILE_EDGE_LIMIT`. */
  fileEdges: FileDependencyEdge[];
}

/** One multi-component strongly-connected set of the component graph. */
export interface LayeringKnot {
  /** Members, most depended-on (Ca) first, then path. */
  components: string[];
  /** The greedy weighted feedback arc set (Eades–Lin–Smyth) that dissolves the knot. */
  feedbackArcSet: LayeringFeedbackEdge[];
  /** How many edges the feedback arc set holds. */
  cutEdgeCount: number;
  /** Distinct levels the members occupy once the feedback arc set is cut. */
  levelsAfterCut: number;
  /**
   * Every edge inside the set joins a directory to one nested inside it —
   * composition of a module with its own sub-parts, not a layering defect.
   */
  composition: boolean;
}

/**
 * Inferred layering of the component graph (bd tea-rags-mcp-r8hme.22) —
 * report-time, no indexing change. Every downstream consumer (the layer map,
 * restructuring proposals, what-if, the diff-scoped review) reads this model
 * through core, never through the MCP DTO.
 */
export interface LayeringModel {
  /** Position of every component; a component with no layering edge sits at level 0, depth 0. */
  positions: Map<string, LayeringComponentPosition>;
  /** Number of distinct levels, 0-based; 0 when the graph holds no layering edge. */
  levelCount: number;
  /** Knots first, then composition cycles, by member count then members. */
  knots: LayeringKnot[];
  /** Share of components outside non-trivial SCCs, over all components; 0 for an empty graph. */
  coverage: number;
  /** Spearman rank correlation of level vs instability over components with a layering edge; 0 under two. */
  coherence: number;
}

export type LayeringViolationKind =
  | "knot"
  | "backEdge"
  | "abstractionBypass"
  | "compositionCycle"
  | "island"
  | "layerSkip";

/** A knot: SCC members ranked by Ca, with the edges whose cut levels the members. */
export interface LayeringKnotViolation {
  kind: "knot";
  components: string[];
  feedbackArcSet: LayeringFeedbackEdge[];
  cutEdgeCount: number;
  levelsAfterCut: number;
}

/**
 * The minority-weight direction inside a knot, when the pair's weights
 * disagree; equal weights are ambiguous and never judged.
 */
export interface LayeringBackEdgeViolation {
  kind: "backEdge";
  sourceComponent: string;
  targetComponent: string;
  /** The back edge's weight — the minority direction. */
  callWeight: number;
  /** The majority direction's weight. */
  counterFlowWeight: number;
  fileEdgeCount: number;
  fileEdges: FileDependencyEdge[];
}

/** A consumer reaching a measured-concrete component that depends on a measured-abstract one below. */
export interface LayeringAbstractionBypassViolation {
  kind: "abstractionBypass";
  /** The consumer that reaches the concrete component directly. */
  sourceComponent: string;
  /** The concrete component reached. */
  targetComponent: string;
  /** The measured-abstract component beneath it the consumer never touches. */
  bypassedComponent: string;
  concreteAbstractness: number;
  bypassedAbstractness: number;
  callWeight: number;
}

/** A parent and its own nested directories cycling — composition, not a layering defect. */
export interface LayeringCompositionCycleViolation {
  kind: "compositionCycle";
  components: string[];
  nestedPairs: { parentComponent: string; nestedComponent: string }[];
}

/** A component nothing depends on that does not reach the top of the stack. */
export interface LayeringIslandViolation {
  kind: "island";
  component: string;
  height: number;
  depth: number;
  afferentCount: number;
  instability: number;
}

/** A dependency jumping at least two levels straight to a lower one. */
export interface LayeringLayerSkipViolation {
  kind: "layerSkip";
  sourceComponent: string;
  targetComponent: string;
  sourceLevel: number;
  targetLevel: number;
  skippedLevels: number;
  callWeight: number;
}

export type LayeringViolation =
  | LayeringKnotViolation
  | LayeringBackEdgeViolation
  | LayeringAbstractionBypassViolation
  | LayeringCompositionCycleViolation
  | LayeringIslandViolation
  | LayeringLayerSkipViolation;

export interface LayeringSummary {
  componentCount: number;
  /** Component dependencies the model judged — every entry of the component graph. */
  componentEdgeCount: number;
  levelCount: number;
  coverage: number;
  coherence: number;
  knotCount: number;
  backEdgeCount: number;
  abstractionBypassCount: number;
  compositionCycleCount: number;
  islandCount: number;
  layerSkipCount: number;
  /** Every finding, violations and informational alike. */
  violationCount: number;
  scope?: LayeringScope;
}

/**
 * Present when `LayeringOptions.sourcePathPattern` scoped the run. Levels,
 * knots, coverage and coherence stay whole-graph — only findings are scoped.
 */
export interface LayeringScope {
  sourcePathPattern: string;
  /** Findings the model produced whose source matched no file — dropped, not counted above. */
  outOfScopeFindingCount: number;
}

export interface LayeringOptions {
  /**
   * Keep only findings a matching file carries: a dependency finding (back-edge,
   * bypass, layer skip) by its carrying source files, a component finding
   * (island) by the component's files, a knot or composition cycle by any
   * member's files.
   */
  sourcePathPattern?: string;
}

export interface LayeringReport {
  /** Knots, back-edges and bypasses first, informational findings last; each group deterministic. */
  violations: LayeringViolation[];
  summary: LayeringSummary;
}

/**
 * Layer map options (bd tea-rags-mcp-r8hme.26): a VIEW over the layering
 * model. The scope picks the domain, the granularity picks the node.
 */
export interface LayerMapOptions {
  /**
   * Picomatch glob: nodes whose path matches live inside the map; edges
   * crossing the boundary are kept as boundary-out / boundary-in findings
   * naming the EXTERNAL component and its global level. Absent: the whole
   * repository, no boundary findings.
   */
  scopePathPattern?: string;
  /** `file` nodes are files; `directory` nodes are components (default). */
  granularity?: "directory" | "file";
  /**
   * With `directory`: collapse every directory DEEPER than this many segments
   * below the scope root into its ancestor — `0` collapses the whole scope
   * into one node. The same mapping r8hme.30's domain partition reuses.
   */
  directoryDepth?: number;
}

/** One node of the map with its position in the induced layer stack. */
export interface LayerMapNode {
  /** A component directory, a collapsed directory prefix, or a file path. */
  node: string;
  level: number;
  /** Longest path from the roots of the induced graph: 0 = nothing inside depends on it. */
  depth: number;
  inKnot: boolean;
  /** Dependencies (or file edges) from inside the scope into the node. */
  innerAfferentCount: number;
  /** Dependencies (or file edges) from the node to inside the scope. */
  innerEfferentCount: number;
}

/** One edge crossing the scope boundary, kept — not dropped — by the map. */
export interface LayerMapBoundaryEdge {
  /** The inside node the edge leaves from (boundary-out) / enters (boundary-in). */
  sourceNode?: string;
  targetNode?: string;
  /** The component outside the scope the edge reaches / comes from. */
  externalComponent: string;
  /** That component's level in the WHOLE-repository stack. */
  externalLevel: number;
  /** Sum of the carrying file edges' call weights. */
  callWeight: number;
}

/** An inner node with no inner afferents whose outward edges point into one other domain. */
export interface LayerMapMoveCandidate {
  node: string;
  level: number;
  externalComponent: string;
  callWeight: number;
}

/** One multi-node cycle among the map's nodes, with the cut that levels them. */
export interface LayerMapKnot {
  components: string[];
  feedbackArcSet: {
    sourceComponent: string;
    targetComponent: string;
    callWeight: number;
    fileEdges: { sourceRelPath: string; targetRelPath: string; callWeight: number }[];
  }[];
  cutEdgeCount: number;
  levelsAfterCut: number;
  /**
   * Every edge inside the set joins a directory to one nested inside it —
   * composition of a module with its own sub-parts, the same verdict the
   * layering summary reports these cycles under (`compositionCycle`, not
   * `knot`), so the map's knot count reconciles with the summary's
   * `knotCount` + `compositionCycleCount`.
   */
  composition: boolean;
}

export interface LayerMap {
  scope?: string;
  granularity: "directory" | "file";
  levelCount: number;
  /** By level, then node. */
  nodes: LayerMapNode[];
  /** By member count, then members. */
  knots: LayerMapKnot[];
  /** By external component, then source node. */
  boundaryOut: LayerMapBoundaryEdge[];
  /** By external component, then target node. */
  boundaryIn: LayerMapBoundaryEdge[];
  /** By external component, then node. */
  moveCandidates: LayerMapMoveCandidate[];
  summary: {
    nodeCount: number;
    innerEdgeCount: number;
    boundaryOutEdgeCount: number;
    boundaryInEdgeCount: number;
  };
}
