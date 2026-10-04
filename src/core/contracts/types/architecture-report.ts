/**
 * The boundary-diagnostics finding contract (bd tea-rags-mcp-0e4vf) — the
 * typed findings, root causes and summaries the architecture report is built
 * from, in one home. A new detector shape is added ONCE here: the public DTO
 * (`api/public/dto/architecture.ts`) re-exports this surface, and the
 * boundary-diagnostics domains source from it the vocabulary their detectors
 * share with the report (leak kinds, zones, file edges, keep costs), instead
 * of every surface hand-syncing its own copy.
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

import type { RelPath } from "./codegraph.js";
import type { WorkingTreeMarker } from "./working-tree.js";

/** How the layer map view picks its nodes (bd tea-rags-mcp-r8hme.26). */
export interface ArchitectureLayerMapOptions {
  /**
   * Picomatch glob: nodes whose path matches live inside the map; edges
   * crossing the boundary are kept as boundary findings naming the external
   * component and its GLOBAL level. Absent: the whole repository.
   */
  scopePathPattern?: string;
  /** `file` nodes are files; `directory` nodes are components (default). */
  granularity?: "directory" | "file";
  /**
   * With `directory`: collapse every directory DEEPER than this many segments
   * below the scope root into its ancestor — 0 collapses the whole scope into
   * one node.
   */
  directoryDepth?: number;
}

/** Where a dependency's target sits relative to its source, by directory. */
export type ArchitectureDirectoryRelation = "same" | "descendant" | "ancestor" | "disjoint";

/** One file edge carrying a component dependency. */
export interface ArchitectureFileEdge {
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  /**
   * Confidence-weighted resolved calls across the edge; 0 for a call-free
   * dependency — a constant, a type used as a value, a JSX element, or a
   * re-export. The two name lists below are what tells those apart.
   */
  callWeight: number;
  /**
   * Export names the source's imports of the target bind (unioned per edge, as
   * `FileEdgeExportNames` carries them) — present when the walker recorded
   * any. A list holding only types marks the edge type-as-value; a runtime
   * name beside them means the dependency loads.
   */
  importedExportNames?: string[];
  /** Export names the source re-exports from the target — a re-export edge is call-free by construction, not type-only. */
  reexportedExportNames?: string[];
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

/**
 * How a facade-leak violation's `kind` was decided (bd tea-rags-mcp-r8hme.43):
 * `names` = the edge and the facade both recorded export names and the kind
 * came from comparing them, `file-rule` = names were unavailable (absent on
 * either side, or the facade has no edge to the target at all) and the
 * file-level rule — `bypass` iff the facade has an edge to the target —
 * decided. A `file-rule` bypass is NOT certification that the facade already
 * exposes the imported names.
 */
export type FacadeLeakKindBasis = "names" | "file-rule";

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
  /**
   * How `kind` was decided (bd tea-rags-mcp-r8hme.43) — see
   * {@link FacadeLeakKindBasis}. Absent only where the detector ran before the
   * field existed.
   */
  kindBasis?: FacadeLeakKindBasis;
  /**
   * Whether the re-export recipe — export the leaked names from the module's
   * facade and point the violating importer at it — would close an import
   * cycle: the facade's own import graph already reaches the violating
   * importer, so the recipe's rewrite (source → facade) closes
   * source → facade →* source (bd tea-rags-mcp-89k7k.3, endpoint per bd
   * tea-rags-mcp-89k7k.17). Applied for real on the explore strategies, that
   * re-export broke 9 suites at collection with "Class extends value
   * undefined" (bd tea-rags-mcp-0qaht.31). Absent only where the detector ran
   * before the field existed.
   */
  reExportUnsafe?: boolean;
  /**
   * The first found facade→…→source import path, facade first — file evidence
   * for {@link reExportUnsafe}; present only when it is true, capped at 8
   * files (reachability deeper than the cap counts as absent).
   */
  reExportCyclePath?: RelPath[];
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
  /**
   * Only on a pair in `summary.silentCoupling.explainedPairs` (bd
   * tea-rags-mcp-r8hme.13): the shared neighbour both files import, or one
   * reaches the other through, and its weight ln(N / fanIn), 3 decimals. A
   * violation never carries it.
   */
  explainedBy?: { relPath: RelPath; weight: number };
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

/**
 * What a `layering` finding says (bd tea-rags-mcp-r8hme.22): `knot` — a
 * multi-component cycle, `backEdge` — the minority-weight direction inside
 * one, `abstractionBypass` — a consumer reaching a measured-concrete component
 * past the measured-abstract one beneath it; informational:
 * `compositionCycle` (a parent and its own nested directories cycling),
 * `island` (nothing depends on it, and it does not reach the top),
 * `layerSkip` (a dependency jumping two or more levels straight down).
 */
export type LayeringViolationKind =
  | "knot"
  | "backEdge"
  | "abstractionBypass"
  | "compositionCycle"
  | "island"
  | "layerSkip";

/** One edge the knot's feedback arc set removes, with the file edges that carry it. */
export interface LayeringFeedbackEdge {
  sourceComponent: string;
  targetComponent: string;
  /** Sum of the carried file edges' call weights — the weight the cut pays. */
  callWeight: number;
  /** The carrying file edges, heaviest call weight first, capped at 5. */
  fileEdges: ArchitectureFileEdge[];
}

/** Why these components form one knot. */
export interface LayeringKnotViolationEvidence {
  /**
   * The greedy weighted feedback arc set (Eades–Lin–Smyth) that dissolves the
   * knot — the first 10 by call weight; `cutEdgeCount` keeps the total.
   */
  feedbackArcSet: LayeringFeedbackEdge[];
  /** How many edges the feedback arc set holds. */
  cutEdgeCount: number;
  /** Distinct levels the members occupy once the feedback arc set is cut. */
  levelsAfterCut: number;
  /**
   * How many members the knot has — in scope only when scoped (the whole knot
   * is `memberCount + outOfScopeMemberCount`); `components` lists the first 20.
   */
  memberCount: number;
  /**
   * Max member instability minus min, 3 decimals (bd tea-rags-mcp-r8hme.32):
   * a spread above 0 is an SDP break inside the cycle — a stable member
   * leaning on volatile peers or the reverse; 0 is a tangle of alike members.
   * Knot findings rank by it.
   */
  instabilitySpread: number;
  /**
   * Members the pathPattern scope dropped (the knot lists only in-scope
   * members) — present only when scoped.
   */
  outOfScopeMemberCount?: number;
  /**
   * Feedback-arc-set edges no in-scope file carries, dropped from
   * `feedbackArcSet` — present only when scoped. `cutEdgeCount` and
   * `levelsAfterCut` still describe the whole knot.
   */
  outOfScopeFeedbackEdgeCount?: number;
  /** How to page this WHOLE knot — computed before the member cap and any scope projection. */
  drillDown: LayeringKnotDrillDown;
}

/** The handles that reach one whole knot (bd tea-rags-mcp-r8hme.38). */
export interface LayeringKnotDrillDown {
  /** The knot's first member by Ca — pass it as `knotOf`. */
  knotOf: string;
  /** Deepest common ancestor directory of every member plus `/**`; absent when that is the repository root. */
  pathPattern?: string;
  hint: string;
}

/**
 * The knot VIEW (bd tea-rags-mcp-r8hme.38), present only when the request
 * carried `knotOf`. Level and depth are whole-graph; the knot page follows the
 * request's `pathPattern` projection like the knot finding does.
 */
export interface ArchitectureKnotView {
  component: string;
  inKnot: boolean;
  level: number;
  depth: number;
  offset: number;
  limit: number;
  /** Present when `inKnot`. */
  knot?: ArchitectureKnotPage;
}

/**
 * One knot member and its Martin coupling on the layering (DOMAIN) partition
 * (bd tea-rags-mcp-r8hme.39) — the stable member a cycle drags in is the one
 * with the lowest instability.
 */
export interface ArchitectureKnotMember {
  component: string;
  /** Ce / (Ca + Ce), rounded to 3 decimals. */
  instability: number;
  /** Ca: distinct files outside the component with an edge into it. */
  afferentCount: number;
  /** Ce: distinct files inside the component with an edge out of it. */
  efferentCount: number;
}

/**
 * What keeping one cut edge costs (bd tea-rags-mcp-r8hme.40): the knot's
 * internal edges with every OTHER cut edge removed, priced on the whole knot
 * even when the page is a pathPattern projection.
 */
export interface LayeringKeepCost {
  /** Members that fall back into a cycle. 0 = the greedy cut includes this edge needlessly; it can stay. */
  recollapsedMemberCount: number;
  /** Distinct levels the members occupy, re-collapsed cycles condensed, components outside the knot at their levels. */
  levelsAfterKeep: number;
}

/** A cut edge on the knotOf page, with what keeping it would cost. */
export interface LayeringKnotPageFeedbackEdge extends LayeringFeedbackEdge {
  keepCost: LayeringKeepCost;
}

/** One page of a knot: members and cut edges both windowed at `[offset, offset + limit)`. */
export interface ArchitectureKnotPage {
  /** This page of the members, most depended-on (Ca) first, then path. */
  members: ArchitectureKnotMember[];
  /** Members before paging — in scope only when scoped. */
  memberCount: number;
  /** Whole-knot max − min member instability, rounded to 3 decimals — the knot finding's ranking key. */
  instabilitySpread: number;
  /** This page of the feedback arc set, heaviest call weight first, each with its keep cost. */
  feedbackArcSet: LayeringKnotPageFeedbackEdge[];
  /** Whole-knot cut size. */
  cutEdgeCount: number;
  levelsAfterCut: number;
  /** A composition cycle (a directory with its own nested ones), not a layering knot. */
  composition: boolean;
  /** Back-edge findings with both ends in the knot, report order, first `limit` (not paged by `offset`). */
  backEdges: LayeringBackEdgeArchitectureViolation[];
  /** Members the pathPattern scope dropped — present only when scoped. */
  outOfScopeMemberCount?: number;
  /** Cut edges no in-scope file carries — present only when scoped. */
  outOfScopeFeedbackEdgeCount?: number;
  /** The next page's `offset`; present while members or cut edges remain. */
  nextOffset?: number;
}

/** A multi-component strongly-connected set of the component graph. */
export interface LayeringKnotArchitectureViolation {
  detector: "layering";
  kind: "knot";
  /** Members, most depended-on (Ca) first, then path — the first 20; `evidence.memberCount` keeps the total. */
  components: string[];
  evidence: LayeringKnotViolationEvidence;
}

/** Why an edge inside a knot is the back-edge. */
export interface LayeringBackEdgeViolationEvidence {
  /** The back edge's weight — the minority direction. */
  callWeight: number;
  /** The majority direction's weight; equal weights are never judged. */
  counterFlowWeight: number;
  fileEdgeCount: number;
  /** The carrying file edges, heaviest call weight first, capped at 5. */
  fileEdges: ArchitectureFileEdge[];
}

/** The minority-weight direction inside a knot. */
export interface LayeringBackEdgeArchitectureViolation {
  detector: "layering";
  kind: "backEdge";
  sourceComponent: string;
  targetComponent: string;
  evidence: LayeringBackEdgeViolationEvidence;
}

/** Why a consumer→concrete edge is an abstraction bypass. */
export interface LayeringAbstractionBypassViolationEvidence {
  /** The measured-abstract component beneath, which the consumer never touches. */
  bypassedComponent: string;
  /** A of the concrete component, from the walker's type census, 3 decimals. */
  concreteAbstractness: number;
  /** A of the bypassed component, 3 decimals. */
  bypassedAbstractness: number;
  /** Confidence-weighted resolved calls across the consumer→concrete edge. */
  callWeight: number;
}

/** A consumer reaching a measured-concrete component that depends on a measured-abstract one below. */
export interface LayeringAbstractionBypassArchitectureViolation {
  detector: "layering";
  kind: "abstractionBypass";
  /** The consumer. */
  sourceComponent: string;
  /** The concrete component reached. */
  targetComponent: string;
  evidence: LayeringAbstractionBypassViolationEvidence;
}

/** Why a cycle is composition, not a layering defect. */
export interface LayeringCompositionCycleViolationEvidence {
  /**
   * The parent↔nested pairs inside the cycle, each named once — the first 10
   * by parent then nested path; `nestedPairCount` keeps the total.
   */
  nestedPairs: { parentComponent: string; nestedComponent: string }[];
  /** How many parent↔nested pairs the cycle holds. */
  nestedPairCount: number;
  /**
   * How many members the cycle has — in scope only when scoped (the whole
   * cycle is `memberCount + outOfScopeMemberCount`); `components` lists the first 20.
   */
  memberCount: number;
  /** Members the pathPattern scope dropped — present only when scoped. */
  outOfScopeMemberCount?: number;
}

/** A parent and its own nested directories cycling — informational. */
export interface LayeringCompositionCycleArchitectureViolation {
  detector: "layering";
  kind: "compositionCycle";
  /** Members, most depended-on (Ca) first, then path — the first 20; `evidence.memberCount` keeps the total. */
  components: string[];
  evidence: LayeringCompositionCycleViolationEvidence;
}

/** Why a component is a detached island. */
export interface LayeringIslandViolationEvidence {
  /** Longest dependency path from the sinks — a low height is no foundation. */
  height: number;
  /** Longest dependency path from the roots: 0 — nothing depends on it. */
  depth: number;
  afferentCount: number;
  instability: number;
}

/** A component nothing depends on that does not reach the top of the stack — informational. */
export interface LayeringIslandArchitectureViolation {
  detector: "layering";
  kind: "island";
  component: string;
  evidence: LayeringIslandViolationEvidence;
}

/** Why an edge is a layer skip. */
export interface LayeringLayerSkipViolationEvidence {
  sourceLevel: number;
  targetLevel: number;
  /** `sourceLevel − targetLevel`, at least 2. */
  skippedLevels: number;
  /** Confidence-weighted resolved calls across the edge. */
  callWeight: number;
}

/** A dependency jumping at least two levels straight to a lower one — informational. */
export interface LayeringLayerSkipArchitectureViolation {
  detector: "layering";
  kind: "layerSkip";
  sourceComponent: string;
  targetComponent: string;
  evidence: LayeringLayerSkipViolationEvidence;
}

export type LayeringArchitectureViolation =
  | LayeringKnotArchitectureViolation
  | LayeringBackEdgeArchitectureViolation
  | LayeringAbstractionBypassArchitectureViolation
  | LayeringCompositionCycleArchitectureViolation
  | LayeringIslandArchitectureViolation
  | LayeringLayerSkipArchitectureViolation;

/** Component and level counts of one partition the layering model was read off. */
export interface LayeringPartitionCounts {
  componentCount: number;
  levelCount: number;
}

/** The inferred layering of the whole graph, as the `layering` summary reports it. */
export interface LayeringReportSummary {
  componentCount: number;
  /** Component dependencies the model judged — every entry of the component graph. */
  componentEdgeCount: number;
  /** Number of distinct levels, 0-based; 0 when the graph holds no layering edge. */
  levelCount: number;
  /**
   * The counts the facade-adoption partition reports (bd tea-rags-mcp-r8hme.30)
   * — the pre-.30 default, kept alongside for comparison: a language vertical
   * with an unadopted facade is one domain component here but a directory per
   * subdirectory there, which is where the deeper level count comes from.
   */
  facadePartition: LayeringPartitionCounts;
  /** Share of components outside non-trivial SCCs, 3 decimals; 0 for an empty graph. */
  coverage: number;
  /** Spearman rank correlation of level vs instability, 3 decimals; 0 under two judged components. */
  coherence: number;
  knotCount: number;
  backEdgeCount: number;
  abstractionBypassCount: number;
  compositionCycleCount: number;
  islandCount: number;
  layerSkipCount: number;
  /** Every finding, violations and informational alike. */
  violationCount: number;
  /**
   * Findings no file matching `pathPattern` carries; present only when scoped.
   * Levels, coverage and coherence stay whole-graph under a scope.
   */
  outOfScopeFindingCount?: number;
}

export type ArchitectureViolation =
  | StableDependencyArchitectureViolation
  | LeakingAbstractionArchitectureViolation
  | SilentCouplingArchitectureViolation
  | MainSequenceArchitectureViolation
  | LayeringArchitectureViolation
  | NormArchitectureViolation;

/**
 * A file edge the project's own norms find precedent-less (bd
 * tea-rags-mcp-rpx0v): a MISFIT names the transit its roles normally follow,
 * a NEW_PATTERN names a pair the corpus has never seen between two roles it
 * knows well.
 */
export interface NormArchitectureViolation {
  detector: "norms";
  kind: "misfit" | "newPattern";
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  evidence: {
    roleSrc: string;
    roleDst: string;
    locality: ArchitectureNormFinding["locality"];
    callWeight: number;
    pairSupport: number;
    expectedPath?: ArchitectureNormExpectedPath;
  };
}

/**
 * The layer map VIEW (bd tea-rags-mcp-r8hme.26): levels per node inside a
 * scope, at directory or file granularity, with the boundary edges kept (not
 * dropped) and the move-candidate signal. Lives in the report response under
 * `layerMap`, present only when the request asked for one.
 */
export interface ArchitectureLayerMap {
  /** Present when the request scoped the map. */
  scope?: string;
  granularity: "directory" | "file";
  /** Number of distinct levels, 0-based; 0 when the scope holds no edge. */
  levelCount: number;
  /** By level, then node. */
  nodes: LayerMapNodeDto[];
  /** By member count, then members. */
  knots: LayerMapKnotDto[];
  /** By external component, then source node. */
  boundaryOut: LayerMapBoundaryEdgeDto[];
  /** By external component, then target node. */
  boundaryIn: LayerMapBoundaryEdgeDto[];
  moveCandidates: LayerMapMoveCandidateDto[];
  summary: {
    nodeCount: number;
    innerEdgeCount: number;
    boundaryOutEdgeCount: number;
    boundaryInEdgeCount: number;
  };
}

/** One node of the map with its position in the induced layer stack. */
export interface LayerMapNodeDto {
  /** A component directory, a collapsed directory prefix, or a file path. */
  node: string;
  /** Longest dependency path from the sinks of the induced graph: 0 = foundation. */
  level: number;
  /** Longest path from the roots: 0 = nothing inside depends on it. */
  depth: number;
  inKnot: boolean;
  innerAfferentCount: number;
  innerEfferentCount: number;
}

/** One edge crossing the scope boundary — kept, with the outside endpoint's global level. */
export interface LayerMapBoundaryEdgeDto {
  /** The inside node the edge leaves from (boundary-out). */
  sourceNode?: string;
  /** The inside node the edge enters (boundary-in). */
  targetNode?: string;
  externalComponent: string;
  externalLevel: number;
  callWeight: number;
}

/** An inside node nothing inside depends on whose outward edges point into one other domain. */
export interface LayerMapMoveCandidateDto {
  node: string;
  level: number;
  externalComponent: string;
  callWeight: number;
}

/** One multi-node cycle among the map's nodes, with the cut that levels them. */
export interface LayerMapKnotDto {
  components: string[];
  feedbackArcSet: {
    sourceComponent: string;
    targetComponent: string;
    callWeight: number;
    fileEdges: ArchitectureFileEdge[];
  }[];
  cutEdgeCount: number;
  levelsAfterCut: number;
}

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
  /**
   * Otsu's split over every candidate's heaviest shared-neighbour weight
   * ln(N / fanIn), 3 decimals (bd tea-rags-mcp-r8hme.13); absent under `none`.
   */
  sharedNeighbourThreshold?: number;
  /** `otsu` when ≥ 8 candidates share a neighbour and their weights split; `none` = no pair is explained. */
  sharedNeighbourThresholdMethod: "otsu" | "none";
  /** η of the shared-neighbour cut, 3 decimals; absent under `none`. */
  sharedNeighbourSeparability?: number;
  /** Pairs read but not judged, by the first reason that applied. */
  excluded: {
    testEndpoints: number;
    generatedEndpoints: number;
    documentationEndpoints: number;
    /** Neither file is walked by the codegraph. */
    unwalkedEndpoints: number;
    /** lift ≤ 1: no more co-change than independence predicts. */
    nonPositiveLift: number;
    /** Strong unlinked in-scope pairs a specific shared neighbour explains — see `exclusionReasons`. */
    explainedBySharedNeighbour: number;
  };
  /** Present only when a pair was explained. */
  exclusionReasons?: { explainedBySharedNeighbour: string };
  /** The explained pairs, strongest first, capped at `limit`, each with `evidence.explainedBy`; present only when any. */
  explainedPairs?: SilentCouplingArchitectureViolation[];
  /** Strong unlinked pairs with neither file matching `pathPattern`; present only when scoped. */
  outOfScopePairCount?: number;
}

/**
 * One component whose files cluster into two or more co-change groups (bd
 * tea-rags-mcp-c3v6o): history votes for a finer cut than the partition makes.
 */
export interface SplitMergeSplitCandidate {
  component: string;
  /** Co-change clusters the component's admitted internal pairs form. */
  clusters: number;
  /** Largest cluster's share of the component's admitted co-change weight, 3 decimals. */
  largestWeightShare: number;
  /** Per cluster its exemplar files (≤ 8 each, code-point order), heaviest cluster first. */
  files: readonly (readonly RelPath[])[];
}

/**
 * Two components whose admitted bundles overlap strongly enough that they
 * change as one unit: history votes for a coarser cut than the partition makes.
 */
export interface SplitMergeMergeCandidate {
  componentA: string;
  componentB: string;
  /** Admitted change bundles (commits, or author sessions) touching both components. */
  support: number;
  /**
   * The larger direction's 95% Wilson lower bound on support / changes —
   * `cochangeStrength` over the synthetic component edge, 3 decimals. The severity.
   */
  strength: number;
  /** Admitted bundles touching componentA. */
  changesA: number;
  /** Admitted bundles touching componentB. */
  changesB: number;
}

/** The verdicts over the report's component partition, with their one threshold. */
export interface SplitMergeVerdictsSummary {
  /** Worst first: most clusters, then smallest largest-cluster share, then path. */
  splitCandidates: SplitMergeSplitCandidate[];
  /** Strongest first: strength, then support, then paths. */
  mergeCandidates: SplitMergeMergeCandidate[];
  /**
   * The majority-floored Otsu cut over every judged strength — internal pair
   * strengths and component-pair strengths in ONE population (one history,
   * one draw); 0.5 under `majority`.
   */
  threshold: number;
  thresholdMethod: "otsu" | "majority";
  /** Stored pairs read but not judged, by the first reason that applied. */
  excluded: {
    /** A pair endpoint no component of the partition holds. */
    unpartitionedEndpoints: number;
    /** Endpoints in different components — MERGE's question is answered from bundles, not pairs. */
    crossComponentPairs: number;
  };
}

/** Why a `splitMerge` block is not built: which substrate was absent. */
export type SplitMergeAbsentReason =
  /** No co-change build at all (git history off, or none since the feature landed). */
  | "noCochangeBuild"
  /** A build exists but persisted no bundle membership (pre-042 index, or nothing admitted). */
  | "noBundleMembership";

/**
 * The split/merge block (bd tea-rags-mcp-c3v6o), beside `silentCoupling` in
 * the summary: component partition vs the partition history votes for, judged
 * over the same temporal co-change sub-graph.
 */
export interface SplitMergeReportSummary {
  /**
   * `false` when no co-change build exists or the build persisted no bundle
   * membership — absence of verdicts, never zeros posing as clean ones.
   */
  built: boolean;
  /** Present only when not built: which substrate was absent. */
  reason?: SplitMergeAbsentReason;
  /** HEAD the co-change build read; present whenever a build exists. */
  head?: string;
  /** Unix seconds of the build; present whenever a build exists. */
  builtAt?: number;
  /** Author-session gap the build bundled commits over; `null` = per commit. */
  sessionGapMinutes?: number | null;
  /** Present when built. */
  verdicts?: SplitMergeVerdictsSummary;
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
  splitMerge: SplitMergeReportSummary;
  mainSequence: MainSequenceReportSummary;
  layering: LayeringReportSummary;
}

/**
 * One edge crossing a domain's border (bd tea-rags-mcp-xb669.1), aggregated
 * per (inner component, external component) with call weights summed.
 */
export interface ArchitectureDomainBoundaryEdge {
  /** The domain component the edge leaves from (boundary-out). */
  innerComponent: string;
  /** The whole-graph component the edge enters on the outside (boundary-out). */
  externalComponent: string;
  /** The external component's level on the WHOLE-graph stack: 0 = foundation. */
  externalLevel: number;
  /** Confidence-weighted resolved calls carried by the aggregated file edges. */
  callWeight: number;
}

/**
 * The domain-mode block (bd tea-rags-mcp-xb669.1), present only when the
 * request carried `domain`: the domain's own layering counts (the same ones
 * `summary.layering` reports) plus its border against the rest of the system.
 */
export interface ArchitectureDomainReport {
  /** The requested domain root, echoed. */
  path: string;
  /** Components of the domain-internal partition. */
  componentCount: number;
  /** Levels of the domain-internal stack, 0-based. */
  levelCount: number;
  /** By call weight, heaviest first. */
  boundaryOut: ArchitectureDomainBoundaryEdge[];
  /** By call weight, heaviest first. */
  boundaryIn: ArchitectureDomainBoundaryEdge[];
}

/** The adaptive pair-support cut, rounded for the report. */
export interface ArchitectureNormsThreshold {
  method: "otsu" | "majority";
  threshold: number;
  separability?: number;
}

/** The frequent transit a MISFIT names as the path the edge should follow. */
export interface ArchitectureNormExpectedPath {
  via: string;
  support: number;
}

/** One precedent-less file edge, with the evidence that makes it one. */
export interface ArchitectureNormFinding {
  kind: "misfit" | "newPattern";
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  roleSrc: string;
  roleDst: string;
  locality: "sameDirectory" | "sameDomain" | "crossDomain";
  callWeight: number;
  pairSupport: number;
  expectedPath?: ArchitectureNormExpectedPath;
}

/**
 * The dependency-norms view (bd tea-rags-mcp-rpx0v), present only when the
 * request carried `norms`: the project's empirical ledgers per
 * (roleSrc, roleDst, locality) and the verdict for every precedent-less
 * edge between strongly-typed files.
 */
export interface ArchitectureNormsReport {
  summary: {
    roleFileCount: number;
    weakRoleFileCount: number;
    untypedFileCount: number;
    typedEdgeCount: number;
    judgedEdgeCount: number;
    violationCount: number;
    pairCount: number;
    /**
     * Findings the request's `pathPattern` scoped out by source — present only
     * when the request carried one (bd tea-rags-mcp-mv8yv).
     */
    outOfScopeFindingCount?: number;
    excluded: { lowRoleSupportEdgeCount: number };
  };
  threshold: ArchitectureNormsThreshold;
  /** MISFITs first, then by weight, then by path. */
  findings: ArchitectureNormFinding[];
}

export interface GetArchitectureReportResponse {
  /**
   * Which working tree the report was judged for (bd tea-rags-mcp-xi2r9,
   * WTO-7) — the same marker the other graph tools carry.
   */
  workingTree?: WorkingTreeMarker;
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
  /**
   * The layer map VIEW (bd tea-rags-mcp-r8hme.26), present only when the
   * request carried `layerMap` — levels per node, boundary edges with the
   * outside component's global level, move candidates.
   */
  layerMap?: ArchitectureLayerMap;
  /** The knot VIEW (bd tea-rags-mcp-r8hme.38), present only when the request carried `knotOf`. */
  knot?: ArchitectureKnotView;
  /** The domain-mode block (bd tea-rags-mcp-xb669.1), present only when the request carried `domain`. */
  domain?: ArchitectureDomainReport;
  /** The dependency-norms view (bd tea-rags-mcp-rpx0v), present only when the request carried `norms`. */
  norms?: ArchitectureNormsReport;
}
