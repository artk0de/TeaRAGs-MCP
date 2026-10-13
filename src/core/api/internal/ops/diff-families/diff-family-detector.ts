/**
 * The per-family contract of the diff-scoped detector judgement layer (bd
 * tea-rags-mcp-89k7k.1.19.10): every family `DiffDetectorRun#run` reports is a
 * `DiffFamilyDetector` that judges ONE shared `DiffFamilyDetectorContext` and
 * answers its findings plus its status row. The run builds the context once
 * (the diff-added subtraction, `heldBeforeChange`) and stamps scope partiality
 * on the rows; a family never re-derives either.
 *
 * The ports below are what the families read — the run's deps hand them over
 * unchanged. They live here, not beside the run, so the families never import
 * back into the run's module (an `api <-> diff-families` cycle); the run
 * re-exports them for its consumers. The silence and masking contracts that
 * govern every port are the run's module docblock.
 */

import type { CochangeSignificanceSummary } from "../../../../contracts/types/architecture-report.js";
import type {
  DiffDetectorFamily,
  DiffDetectorFinding,
  DiffDetectorStatus,
} from "../../../../contracts/types/diff-detector-finding.js";
import type { ReviewEdgeOverlay } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type {
  SilentCouplingExclusionCounts,
  SilentCouplingViolation,
  SplitMergeVerdicts,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";

/**
 * The indexed graph a detector may traverse, with the diff's own files
 * already meaningless here as traversal sources (see the masking contract
 * above) — and the TWO deliberate changed-source reads that contract names:
 * leakingAbstraction's facade evidence and the diff-added subtraction's
 * indexed pairs. Absent from the run's deps, every indexed-graph predicate
 * reads as "no evidence": the subtraction judges every overlay pair as
 * diff-added (never zero), the facade evidence and the cycle BFS find
 * nothing, and the reverse-edge check cannot suppress.
 */
export interface DiffDetectorGraphReader {
  /** Outgoing file edges of one relPath from the INDEXED graph (excluding type-only). */
  edgesFrom: (relPath: string) => readonly { source: string; target: string }[];
  /** Incoming file edges — cycles and coupling need the reverse direction. */
  edgesTo: (relPath: string) => readonly { source: string; target: string }[];
}

/**
 * The diff BASE's import edges of the changed sources (bd
 * tea-rags-mcp-89k7k.1.16) — what "held before the change" means. An edge is
 * diff-added iff it is absent at the base and present in the tree; the indexed
 * graph cannot answer that once the index sits anywhere but the base (an index
 * that caught up to a commit inside the diff range already holds the diff's own
 * edges; one older than the base lacks edges the base held).
 */
export interface DiffDetectorBaseEdgeReader {
  /**
   * The targets `relPath` imported at the diff base: an empty set when the
   * file is absent there or imports nothing; `undefined` when the base is
   * unknown for this file — the indexed graph then decides, as before.
   */
  targetsAtBase: (relPath: string) => ReadonlySet<string> | undefined;
}

/** Component/facade facts the whole-repo report already derived — consumed, never recomputed. */
export interface DiffDetectorCatalog {
  componentOf: (relPath: string) =>
    | {
        name: string;
        instability: number;
        distanceFromMainSequence: number;
        /** Ca + Ce of the component — what the small-N guard below reads. */
        connectionCount: number;
        /**
         * Ca: distinct files outside the component with an edge into it (bd
         * tea-rags-mcp-89k7k.19) — the report's own component fact, served
         * when the wiring holds it. Absent, mainSequence falls back to the
         * documented +1-per-edge step; a missing fact is never read as "no
         * afferent edges".
         */
        afferentCount?: number;
        /** Ce: distinct files inside the component with an edge out — see {@link afferentCount}. */
        efferentCount?: number;
        /**
         * The component holds a module facade nothing in the project imports
         * (the report's own `ArchitectureComponent.entryFacade`, bd
         * tea-rags-mcp-r8hme.52.4) — the measured composition root / entry
         * surface the SDP and mainSequence findings annotate. Absent otherwise.
         */
        entryFacade?: true;
      }
    | undefined;
  /** The component's facade (undefined = no facade / not adopted). */
  facadeOf: (componentName: string) => string | undefined;
  /** Instability judged markedly greater — the report's own band comparison as a predicate. */
  isMarkedlyLessStable: (leanOn: number, leanedOn: number) => boolean;
  /**
   * Whether the file belongs to the measured layering foundation (bd
   * tea-rags-mcp-89k7k.35.11) — the components the whole-repo layering
   * reports as its foundation (`measureLayeringFoundationComponents`: abstractness
   * 1 at L0). The diff run's `foundationTerminal` reads THIS, so both
   * pipelines name the same foundation; a file outside the graph is false.
   */
  isLayeringFoundation: (relPath: string) => boolean;
}

/**
 * The production silent-coupling verdict (bd tea-rags-mcp-89k7k.1.10): the
 * whole-repo detector's OUTPUT over the SAME co-change snapshot the report
 * judges — violations already past every gate (endpoint-class exclusions,
 * Wilson-strength cut, shared-neighbour explanation, linkage union), plus the
 * detector's own exclusion counters. The diff-scoped family CONSUMES this
 * verdict and intersects it with the diff; it never re-judges raw co-change
 * pairs, so the two paths cannot drift (one fact, one place).
 */
export interface DiffDetectorSilentCouplingFacts {
  /** Strong, unlinked, unexplained pairs — the production violation list. */
  violations: readonly Pick<
    SilentCouplingViolation,
    "relPathA" | "relPathB" | "support" | "strength" | "expectedSupport"
  >[];
  /** Pairs read but not judged, by the production taxonomy — verbatim. */
  excluded: SilentCouplingExclusionCounts;
  /** The pair admission gate's account (bd tea-rags-mcp-89k7k.1.14); absent on the lift fallback. */
  cochangeSignificance?: CochangeSignificanceSummary;
}

/**
 * The facade-contract facts (bd tea-rags-mcp-89k7k.1.6): which files ARE a
 * measured module's facade, and which indexed consumers outside that module
 * still import which names — the pre-diff DEMAND on a facade's export surface.
 * The supply side is the overlay's own (`reexportedExportNames` the tree read
 * recorded), so this port never reads the working tree. Absent port = the
 * family answers built:false, never a zero verdict.
 */
export interface DiffDetectorContractReader {
  /** The measured component whose facade this file is; undefined = not a facade. */
  facadeComponentOf: (relPath: string) => string | undefined;
  /** Distinct indexed consumers OUTSIDE the facade's component, imported names when recorded. */
  indexedConsumersOf: (facade: string) => readonly { source: string; importedNames?: string[] }[];
  /**
   * The facade's INDEXED re-export surface — the names its persisted edges
   * forward; undefined when none were recorded. A name is dropped only when
   * it leaves THIS surface: demand alone cannot tell a removed re-export from
   * one the walker never records (type-only `export type { X } from`), which
   * a consumer's inline `import { type X }` still names.
   */
  indexedSurfaceOf: (facade: string) => readonly string[] | undefined;
}

/**
 * The phase-1 split/merge verdict facts (bd tea-rags-mcp-c3v6o, A5): the
 * verdicts `computeSplitMergeVerdicts` already drew over the diff's components
 * — this layer JUDGES THE DIFF against them, it never re-draws thresholds or
 * re-clusters. Absent port = the family answers built:false, never a zero
 * verdict. The type crosses the api/ → domains edge as a type-only import,
 * the edge api/internal already holds for the report's split/merge summary.
 */
export interface DiffDetectorSplitMergeReader {
  /** The phase-1 verdicts, precomputed by the wiring for the diff's components. */
  verdicts: SplitMergeVerdicts;
  /** The partition the verdicts were computed over — the same map the catalog's componentOf answers. */
  componentOf: (relPath: string) => string | undefined;
}

/**
 * The change to judge: the files the diff touches, as the scope reader (F0)
 * read them. `skippedFiles` says the read was TRUNCATED (bd
 * tea-rags-mcp-89k7k.1.9) — changed files fell past the reader's file cap, so
 * the overlay below carries no edge of theirs and a family's zero rests on
 * files it never saw.
 */
export interface DiffDetectorScope {
  /** The scanned (capped) changed files — the sources every family judges. */
  changedFiles: readonly string[];
  /**
   * Every path the change touches, uncapped and deletions included (bd
   * tea-rags-mcp-lxbrr) — what "the diff also changes it" is asked of
   * (silentCoupling's partner, facadeContract's consumer). Absent =
   * `changedFiles` is the whole change.
   */
  touchedFiles?: ReadonlySet<string>;
  /**
   * Changed files the reader's cap skipped; `0`/absent = the scope is whole.
   * When > 0 every built family's status is marked partial
   * (`scopeSkippedFiles`) — a clean pass is never claimed over a truncated
   * diff, because a cycle's or a leak's closing edge can live ONLY in a
   * skipped file.
   */
  skippedFiles?: number;
}

/** One overlay edge the diff adds, as every per-edge detector judges it. */
export interface OverlayEdge {
  readonly source: string;
  readonly target: string;
}

/** Which evidence held an edge before the change — the parenthetical a `preExisting` detail cites. */
export type HeldBeforeChangeEvidence = "base" | "index";

/**
 * Everything a family judges, built once per run by `DiffDetectorRun#run`.
 * Optional ports keep their absence: a family answers silence (or
 * built:false) on an undefined port, never a zero verdict.
 */
export interface DiffFamilyDetectorContext {
  scope: DiffDetectorScope;
  overlay: ReviewEdgeOverlay;
  /** The overlay's unique (source, target) pairs of the changed files — the edge AS READ. */
  overlayEdges: readonly OverlayEdge[];
  /** Diff-added edges only (the 89k7k.14 subtraction), computed once. */
  addedEdges: readonly OverlayEdge[];
  /**
   * Presence in the change (bd tea-rags-mcp-lxbrr): `scope.touchedFiles`, else
   * the changed files — never the capped set alone.
   */
  inChange: ReadonlySet<string>;
  graph: DiffDetectorGraphReader | undefined;
  catalog: DiffDetectorCatalog;
  /** Which evidence held the pair before the change; undefined = the diff adds it. */
  heldBeforeChange: (edge: OverlayEdge) => HeldBeforeChangeEvidence | undefined;
  silentCouplingFacts: DiffDetectorSilentCouplingFacts | undefined;
  contract: DiffDetectorContractReader | undefined;
  splitMerge: DiffDetectorSplitMergeReader | undefined;
  /** The wiring's reason for an absent split/merge port, defaulted by the run. */
  splitMergeAbsentReason: string;
  /** BFS hop cap for cycle traces, defaulted by the run. */
  maxTraceHops: number;
  /** Minimum component `connectionCount` the main-sequence family judges, defaulted by the run. */
  minConnectionCount: number;
}

/** One detector family: judges the shared context, answers its findings and its (unstamped) status row. */
export interface DiffFamilyDetector {
  readonly family: DiffDetectorFamily;
  judge: (context: DiffFamilyDetectorContext) => {
    findings: readonly DiffDetectorFinding[];
    status: DiffDetectorStatus;
  };
}
