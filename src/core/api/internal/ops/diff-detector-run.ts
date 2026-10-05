/**
 * The diff-scoped detector judgement layer (bd tea-rags-mcp-89k7k.1.3, F2):
 * `DiffDetectorRun#run` judges what ONE working-tree change introduces — the
 * overlay edges F1 (`ReviewEdgeOverlay`) read from the tree — against the
 * facts the whole-repo `get_architecture_report` already derived. All
 * report-derived knowledge arrives as DATA through the ports below
 * (components, facades, the instability band, co-change pairs); this layer
 * JUDGES DIFFERENTLY, it never re-derives — the adoption/Otsu/band machinery
 * stays in the report the wiring slice consumes. Pure by contract: no DuckDB,
 * no Qdrant, no filesystem — the wiring (F3, review_changes) owns building
 * the ports and any shared-primitive extraction from
 * `architecture-report-ops.ts` it needs; this slice defines its own ports.
 *
 * Shapes contract: findings carry the whole-repo report's detector kinds
 * (stableDependencies, leakingAbstraction, silentCoupling, mainSequence) plus
 * the `cycles` kind the `find_cycles` substrate exposes, the diff-native
 * `facadeContract` (bd tea-rags-mcp-89k7k.1.6 — no whole-repo-report
 * counterpart: the report judges the project's facades as they STAND, while
 * this family judges what the DIFF did to a facade's re-export surface against
 * the indexed demand), and `splitCandidates` (bd tea-rags-mcp-c3v6o, A5): the
 * diff judged against the phase-1 split/merge verdicts (`computeSplitMergeVerdicts`,
 * precomputed over the diff's components by the wiring and delivered through the
 * port below) — the diff working across a component whose history already
 * splits, or bridging two whose bundles move as one unit. Built when the
 * wiring passes the port; absent, the family answers `built: false` with the
 * wiring's dynamic reason — still silence-not-zero on absent data. The
 * layering map is the layering session's territory and is never judged here.
 *
 * Absence of data is NEVER a violation: every judgement's absent-fact path —
 * `componentOf` undefined, `facadeOf` undefined, no co-change partners, no
 * indexed edges — is a silent skip, so one missing fact neither throws nor
 * mutes the other detectors.
 *
 * Masking contract: the overlay is the source of truth for a changed file's
 * CURRENT out-edges; the indexed graph behind `DiffDetectorGraphReader` is
 * what the BFS and the reverse-direction checks read, and the cycle BFS never
 * EXPANDS a changed file's node (its stale rows are the overlay's to replace).
 * TWO predicates deliberately read a changed file's INDEXED out-edges — the
 * only places such rows are read at all: leakingAbstraction's facade evidence
 * ("the facade A already imports" is the pre-diff usage the diff did not add)
 * and the diff-added subtraction (bd tea-rags-mcp-89k7k.14), which drops from
 * stableDependencies' and mainSequence's edge set every (source, target) pair
 * the indexed graph already holds — those two families judge only what the
 * diff GENUINELY adds, so a one-line edit to a barrel never re-weighs its
 * pre-existing imports as new coupling. Absent graph port, or a changed file
 * with no indexed rows, subtracts nothing — a missing fact is never read as
 * "no edges added". Every per-edge detector iterates the overlay's unique
 * (source, target) pairs (stableDependencies and mainSequence: the diff-added
 * subset of them), so an edge pair is judged — and reported — once, never
 * again from a reverse or duplicated read.
 */

import {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  isDeclaredCompositionRoot,
  isDeclaredEntryPoint,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import type {
  SilentCouplingExclusionCounts,
  SilentCouplingViolation,
  SplitMergeVerdicts,
} from "../../../domains/trajectory/codegraph/temporal/index.js";
import type { ReviewEdgeOverlay } from "./review-edge-overlay.js";

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
      }
    | undefined;
  /** The component's facade (undefined = no facade / not adopted). */
  facadeOf: (componentName: string) => string | undefined;
  /** Instability judged markedly greater — the report's own band comparison as a predicate. */
  isMarkedlyLessStable: (leanOn: number, leanedOn: number) => boolean;
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
  violations: readonly Pick<SilentCouplingViolation, "relPathA" | "relPathB" | "support" | "strength">[];
  /** Pairs read but not judged, by the production taxonomy — verbatim. */
  excluded: SilentCouplingExclusionCounts;
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

export interface DiffDetectorRunDeps {
  /**
   * The indexed graph (see {@link DiffDetectorGraphReader}). Absent = every
   * indexed-graph predicate reads as "no evidence" — in particular the
   * diff-added subtraction judges every overlay pair (the pre-89k7k.14
   * behavior), never zero of them.
   */
  graph?: DiffDetectorGraphReader;
  catalog: DiffDetectorCatalog;
  /**
   * The production silent-coupling verdict (see
   * {@link DiffDetectorSilentCouplingFacts}). Absent = the family answers
   * silence (no findings, no excluded block) — never a zero-over-nothing
   * verdict; the wiring computes the facts whenever a co-change snapshot
   * exists, and from an empty graph otherwise (built:false summary).
   */
  silentCouplingFacts?: DiffDetectorSilentCouplingFacts;
  /** The facade-contract facts; absent = the family is unbuilt for this run. */
  contract?: DiffDetectorContractReader;
  /**
   * The phase-1 split/merge verdicts; absent = the family answers built:false.
   */
  splitMerge?: DiffDetectorSplitMergeReader;
  /**
   * Why the split/merge port is absent, when it is — the WIRING's dynamic
   * reason (which substrate was missing), passed through verbatim; this layer
   * never interprets it. Bare absent port and no reason reads as this layer's
   * own `noSplitMergeReader`.
   */
  splitMergeAbsentReason?: string;
  /**
   * The endpoint-class facts the silent-coupling family needs to apply the
   * production exclusion taxonomy (bd tea-rags-mcp-89k7k.1.10): the codegraph's
   * walked-file census and the documentation-path predicate — the same inputs
   * `detectSilentCoupling` receives. Excluded pairs are counted, never
   * reported, and surface on the silentCoupling status row's `excluded` block
   * (the production summary's vocabulary). Absent = every stored partner is
   * judged; the wiring passes the port whenever a co-change snapshot exists.
   */
  couplingExclusions?: {
    walkedFiles: ReadonlyMap<string, number>;
    isDocumentation?: (relPath: string) => boolean;
  };
  /** BFS hop cap for cycle traces (default 8 — the report's own trace depth). */
  maxTraceHops?: number;
  /**
   * Minimum component `connectionCount` the main-sequence family judges
   * (bd tea-rags-mcp-r8hme.45). Default `DEFAULT_SDP_MIN_CONNECTION_COUNT` —
   * the same floor the whole-repo detector excludes
   * `summary.mainSequence.excluded.lowConnectionCount` at, read from the
   * instability descriptor's confidence threshold rather than restated, so
   * the two cannot drift apart.
   */
  minConnectionCount?: number;
}

/**
 * The change to judge: the files the diff touches, as the scope reader (F0)
 * read them. `skippedFiles` says the read was TRUNCATED (bd
 * tea-rags-mcp-89k7k.1.9) — changed files fell past the reader's file cap, so
 * the overlay below carries no edge of theirs and a family's zero rests on
 * files it never saw.
 */
export interface DiffDetectorScope {
  changedFiles: readonly string[];
  /**
   * Changed files the reader's cap skipped; `0`/absent = the scope is whole.
   * When > 0 every built family's status is marked partial
   * (`scopeSkippedFiles`) — a clean pass is never claimed over a truncated
   * diff, because a cycle's or a leak's closing edge can live ONLY in a
   * skipped file.
   */
  skippedFiles?: number;
}

export interface DiffDetectorFinding {
  detector:
    | "stableDependencies"
    | "leakingAbstraction"
    | "cycles"
    | "mainSequence"
    | "silentCoupling"
    | "facadeContract"
    | "splitCandidates";
  /** What the judgement anchors on — an edge, a pair, a component delta. */
  subject: string; // e.g. "A -> B" | "a.ts ~ b.ts" | "component X"
  evidence: string[]; // trace path for cycles; the facade import for leakingAbstraction; deltas for mainSequence
  detail: string; // one sentence a reviewer reads
  /**
   * mainSequence only (bd tea-rags-mcp-r8hme.45): EVERY contributing edge of
   * this D-delta terminates inside a `contracts/` directory — the legal
   * foundation direction, the lowest layer, which everything above may depend
   * on. The distance still moved, so the finding stands; the annotation is
   * data for triage, never a suppression and never prose baked into a
   * formatter. Present only when true.
   */
  foundationTerminal?: true;
  /**
   * stableDependencies only (bd tea-rags-mcp-hbceb, parity with the
   * whole-repo detector's tea-rags-mcp-r8hme.51): the SOURCE component of the
   * judged edge is, or lives inside, a declared composition root
   * (`isDeclaredCompositionRoot` in the boundary-diagnostics domain — the
   * same declared list, never a re-stated one). The root's JOB is assembling
   * unstable concretes, so an uphill edge sourced from it is inherent to that
   * job. The finding still stands — this is triage data for the reader, never
   * a suppression (the `foundationTerminal` spirit). Present only when true.
   */
  compositionRoot?: true;
  /**
   * mainSequence only (bd tea-rags-mcp-zh3l0, parity with the whole-repo
   * detector's DECLARED_ENTRY_POINT_COMPONENTS): the touched component is, or
   * lives inside, a declared cli/mcp entry surface
   * (`isDeclaredEntryPoint` in the boundary-diagnostics domain — the same
   * declared list, never a re-stated one). Nothing imports an entry surface,
   * so its instability — and a diff-window delta on it — is placement, not
   * defect: the unstable end of the main sequence is where an entry BELONGS.
   * The finding still stands — triage data for the reader, never a
   * suppression (the `foundationTerminal` / `compositionRoot` spirit).
   * Present only when true.
   */
  entryPoint?: true;
}

/** One detector family's verdict for the run. */
export interface DiffDetectorStatus {
  detector: string;
  built: boolean;
  reason?: string;
  findingCount: number;
  /**
   * This family's findings past the slots the section's findings cap
   * allocated it (bd tea-rags-mcp-35v4v) — counted, not listed;
   * `findingCount` stays the family's FULL total. Stamped by the section's
   * cap (`architecture-section.ts`), not by the run.
   */
  truncated?: number;
  /**
   * Changed files the diff's file cap skipped while this family judged (bd
   * tea-rags-mcp-89k7k.1.9). Present = the verdict is PARTIAL: a zero
   * findingCount over files the run never saw is never a clean pass. Absent
   * on unbuilt rows — `built: false` + `reason` already denies the pass.
   */
  scopeSkippedFiles?: number;
  /**
   * mainSequence only (bd tea-rags-mcp-r8hme.45): touched components the
   * connection-count floor excluded — the small-N class whose instability
   * moves in steps of 1/n, one edge the whole scale. Present when > 0, so a
   * zero over below-floor components never reads as a clean pass; the
   * whole-repo report counts the same exclusions in
   * `summary.mainSequence.excluded.lowConnectionCount`.
   */
  excludedLowConnectionCount?: number;
  /**
   * Co-change pairs read but not judged, by the production exclusion
   * taxonomy's classes (bd tea-rags-mcp-89k7k.1.10) — the
   * `summary.silentCoupling.excluded` vocabulary. Stamped on the
   * silentCoupling row only, and only when the wiring passed
   * `silentCouplingFacts`.
   */
  excluded?: SilentCouplingExclusionCounts;
}

export interface DiffDetectorFindings {
  findings: readonly DiffDetectorFinding[];
  /** Per-family verdict — `splitCandidates` carries the wiring's reason when its port is absent. */
  detectors: readonly DiffDetectorStatus[];
}

/** One overlay edge the diff adds, as every per-edge detector judges it. */
interface OverlayEdge {
  readonly source: string;
  readonly target: string;
}

/** The whole-repo report's trace depth, reused as the cycle BFS hop cap. */
const DEFAULT_MAX_TRACE_HOPS = 8;
/** Below this |deltaD| a touched component's main-sequence move reads as no move. */
const MAIN_SEQUENCE_EPSILON = 0.001;
/**
 * Changed files listed per split-cluster / merge-side evidence line — exemplars
 * a reviewer can open, not the full census; the line's count ("N of M changed
 * files") keeps the total honest past the cap.
 */
const SPLIT_MERGE_EVIDENCE_FILE_CAP = 4;
/**
 * The split-candidate family's verdict when the wiring passed no port and no
 * reason of its own — the phase-1 DTO's camelCase reason style. Every other
 * absent reason is the wiring's dynamic string, passed through uninterpreted.
 */
const NO_SPLIT_MERGE_READER_REASON = "noSplitMergeReader";
/** The facade-contract family's verdict when no contract port was injected. */
const NO_CONTRACT_READER_REASON = "no contract reader";
/**
 * The whole-module import name (the `WHOLE_MODULE_EXPORT_NAME` precedent the
 * facade-leak classifier set): a consumer taking `*` re-imports whatever the
 * surface holds, so no single name drop can break it.
 */
const WHOLE_MODULE_EXPORT_NAME = "*";

/**
 * The path segment naming a codebase's pure-types foundation layer — the
 * direction every layer above it may legally depend on (bd
 * tea-rags-mcp-r8hme.45): `core/contracts` in this repo, `src/contracts`,
 * `app/contracts` elsewhere. Matched as a SEGMENT, never a substring, so
 * `contracts.ts` or `my-contracts/` is not the foundation.
 */
const FOUNDATION_CONTRACTS_PATH_SEGMENT = "contracts";

export class DiffDetectorRun {
  private readonly graph: DiffDetectorGraphReader | undefined;
  private readonly catalog: DiffDetectorCatalog;
  private readonly silentCouplingFacts: DiffDetectorSilentCouplingFacts | undefined;
  private readonly contract: DiffDetectorContractReader | undefined;
  private readonly splitMerge: DiffDetectorSplitMergeReader | undefined;
  private readonly splitMergeAbsentReason: string;
  private readonly maxTraceHops: number;
  private readonly minConnectionCount: number;

  constructor(deps: DiffDetectorRunDeps) {
    this.graph = deps.graph;
    this.catalog = deps.catalog;
    this.silentCouplingFacts = deps.silentCouplingFacts;
    this.contract = deps.contract;
    this.splitMerge = deps.splitMerge;
    this.splitMergeAbsentReason = deps.splitMergeAbsentReason ?? NO_SPLIT_MERGE_READER_REASON;
    this.maxTraceHops = deps.maxTraceHops ?? DEFAULT_MAX_TRACE_HOPS;
    this.minConnectionCount = deps.minConnectionCount ?? DEFAULT_SDP_MIN_CONNECTION_COUNT;
  }

  /**
   * Judge one diff: the edges its changed files add (the overlay, minus the
   * pairs the indexed graph already holds for the families that weigh
   * diff-added coupling — see the masking contract) against the indexed graph
   * and the report-derived facts. Findings come out grouped in the detectors'
   * order, each detector's own findings in edge/scope order — deterministic
   * for a given overlay. Never throws on missing facts; see the module
   * docblock for the silence contract.
   */
  run(scope: DiffDetectorScope, overlay: ReviewEdgeOverlay): DiffDetectorFindings {
    const changed = new Set(scope.changedFiles);
    const overlayEdges = uniqueOverlayEdges(scope.changedFiles, overlay);
    // The subtraction (bd tea-rags-mcp-89k7k.14): only genuinely-new pairs
    // reach the two families that weigh "what the diff adds"; the per-edge
    // detectors whose predicate is about the edge AS READ (leakingAbstraction's
    // facade reach, cycles' closing edge) keep the overlay's own set.
    const diffAddedEdges = diffAddedOverlayEdges(overlayEdges, this.graph);
    const stableDependencies = this.judgeStableDependencies(diffAddedEdges);
    const leakingAbstraction = this.judgeLeakingAbstraction(overlayEdges);
    const cycles = this.judgeCycles(overlayEdges, changed);
    const mainSequence = this.judgeMainSequence(scope.changedFiles, diffAddedEdges);
    const silentCoupling = this.judgeSilentCoupling(scope.changedFiles, overlay, changed);
    const facadeContract = this.judgeFacadeContract(scope.changedFiles, overlay, changed);
    const splitCandidates = this.judgeSplitCandidates(scope.changedFiles);
    // Partial over a truncated diff (bd tea-rags-mcp-89k7k.1.9): stamped on
    // BUILT rows only — an unbuilt row's built:false + reason already denies
    // the clean pass.
    const skippedFiles = scope.skippedFiles ?? 0;
    const partial = (status: DiffDetectorStatus): DiffDetectorStatus =>
      skippedFiles > 0 ? Object.freeze({ ...status, scopeSkippedFiles: skippedFiles }) : status;
    return {
      findings: Object.freeze([
        ...stableDependencies,
        ...leakingAbstraction,
        ...cycles,
        ...mainSequence.findings,
        ...silentCoupling.findings,
        ...facadeContract,
        ...splitCandidates,
      ]),
      detectors: Object.freeze([
        partial(detectorStatus("stableDependencies", stableDependencies.length)),
        partial(detectorStatus("leakingAbstraction", leakingAbstraction.length)),
        partial(detectorStatus("cycles", cycles.length)),
        partial(
          mainSequence.excludedLowConnectionCount > 0
            ? Object.freeze({
                ...detectorStatus("mainSequence", mainSequence.findings.length),
                excludedLowConnectionCount: mainSequence.excludedLowConnectionCount,
              })
            : detectorStatus("mainSequence", mainSequence.findings.length),
        ),
        partial(
          Object.freeze({
            ...detectorStatus("silentCoupling", silentCoupling.findings.length),
            // The taxonomy's counters ride the silentCoupling row (bd
            // tea-rags-mcp-89k7k.1.10); absent facts stamp nothing — a zero
            // block over an unwired port would claim pairs were judged.
            ...(silentCoupling.excluded !== undefined ? { excluded: silentCoupling.excluded } : {}),
          }),
        ),
        ...(this.contract === undefined
          ? [
              Object.freeze({
                detector: "facadeContract",
                built: false,
                reason: NO_CONTRACT_READER_REASON,
                findingCount: 0,
              }) satisfies DiffDetectorStatus,
            ]
          : [partial(detectorStatus("facadeContract", facadeContract.length))]),
        this.splitMerge === undefined
          ? (Object.freeze({
              detector: "splitCandidates",
              built: false,
              reason: this.splitMergeAbsentReason,
              findingCount: 0,
            }) satisfies DiffDetectorStatus)
          : partial(detectorStatus("splitCandidates", splitCandidates.length)),
      ]),
    };
  }

  /**
   * Stable Dependencies over what the diff GENUINELY adds: an edge A -> B
   * whose target end is markedly less stable than its source end. The edge
   * set is the subtraction's output (bd tea-rags-mcp-89k7k.14) — a pair the
   * indexed graph already holds is the diff NOT adding it. Both ends must map
   * to report components — the band predicate is the report's own, injected;
   * an end without component facts is a silent skip, not a clean verdict.
   */
  private judgeStableDependencies(edges: readonly OverlayEdge[]): DiffDetectorFinding[] {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of edges) {
      const sourceComponent = this.catalog.componentOf(edge.source);
      const targetComponent = this.catalog.componentOf(edge.target);
      if (sourceComponent === undefined || targetComponent === undefined) continue;
      if (!this.catalog.isMarkedlyLessStable(targetComponent.instability, sourceComponent.instability)) continue;
      findings.push({
        detector: "stableDependencies",
        subject: `${edge.source} -> ${edge.target}`,
        evidence: [
          `${edge.source} in ${sourceComponent.name}: instability ${format3(sourceComponent.instability)}`,
          `${edge.target} in ${targetComponent.name}: instability ${format3(targetComponent.instability)}`,
        ],
        detail:
          `the diff leans on the markedly-less-stable side: ${edge.target}'s component ${targetComponent.name} ` +
          `(I=${format3(targetComponent.instability)}) is markedly less stable than ${edge.source}'s ` +
          `${sourceComponent.name} (I=${format3(sourceComponent.instability)})`,
        // The root assembling unstable concretes is the root's job (see
        // DECLARED_COMPOSITION_ROOT_COMPONENTS): annotated, still reported.
        ...(isDeclaredCompositionRoot(sourceComponent.name) ? { compositionRoot: true as const } : {}),
      });
    }
    return findings;
  }

  /**
   * The most diff-native leak: the diff adds A -> B internal to a component
   * whose facade A ALREADY imports (the indexed A -> facade edge is the
   * evidence — the pre-diff usage; see the masking contract in the module
   * docblock). B being the facade itself is the adoption the report wants,
   * never a finding.
   */
  private judgeLeakingAbstraction(edges: readonly OverlayEdge[]): DiffDetectorFinding[] {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of edges) {
      const targetComponent = this.catalog.componentOf(edge.target);
      if (targetComponent === undefined) continue;
      const facade = this.catalog.facadeOf(targetComponent.name);
      if (facade === undefined || facade === edge.target) continue;
      // Absent graph = no indexed facade evidence — absence is silence.
      const viaFacade = this.graph?.edgesFrom(edge.source).some((indexed) => indexed.target === facade) ?? false;
      if (!viaFacade) continue;
      findings.push({
        detector: "leakingAbstraction",
        subject: `${edge.source} -> ${edge.target}`,
        evidence: [`pre-existing ${edge.source} -> ${facade}`],
        detail:
          `the diff reached past the facade ${edge.source} already uses: ${edge.target} is internal to ` +
          `${targetComponent.name}, whose facade ${facade} ${edge.source} imports`,
      });
    }
    return findings;
  }

  /**
   * A cycle per NEW edge that closes one: BFS from the edge's target over the
   * indexed graph seeking its source, within the hop cap. Changed files'
   * nodes are never expanded (their stale rows are the overlay's to replace),
   * though the source remains reachable as the closing hop; the overlay
   * itself is never traversed. Each edge pair reports at most once — the
   * unique-pair iteration below is the dedupe.
   */
  private judgeCycles(edges: readonly OverlayEdge[], changed: ReadonlySet<string>): DiffDetectorFinding[] {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of edges) {
      const cyclePath = this.traceBackTo(edge.target, edge.source, changed);
      if (cyclePath === undefined) continue;
      findings.push({
        detector: "cycles",
        subject: `${edge.source} -> ${edge.target}`,
        evidence: [cyclePath.join(" -> ")],
        detail:
          `the diff closes a cycle: the new edge ${edge.source} -> ${edge.target} plus the indexed path ` +
          `back to ${edge.source}`,
      });
    }
    return findings;
  }

  /**
   * BFS `from` → `goal` over indexed out-edges; returns the closed cycle path
   * `[goal, from, ..., goal]`, undefined when unreachable within the hop cap.
   */
  private traceBackTo(from: string, goal: string, changed: ReadonlySet<string>): readonly string[] | undefined {
    // No indexed graph = no path back; a changed node's stale rows are never traversed.
    if (this.graph === undefined || changed.has(from)) return undefined;
    const visited = new Set<string>([from]);
    const queue: { node: string; path: readonly string[]; depth: number }[] = [{ node: from, path: [from], depth: 0 }];
    while (queue.length > 0) {
      const frame = queue.shift();
      if (frame === undefined) break;
      for (const indexed of this.graph.edgesFrom(frame.node)) {
        if (frame.depth + 1 > this.maxTraceHops) break; // every remaining edge of this frame is one hop too far
        if (indexed.target === goal) return [goal, ...frame.path, goal];
        if (changed.has(indexed.target) || visited.has(indexed.target)) continue;
        visited.add(indexed.target);
        queue.push({ node: indexed.target, path: [...frame.path, indexed.target], depth: frame.depth + 1 });
      }
    }
    return undefined;
  }

  /**
   * Main-sequence DELTAS for the components of changed files only — untouched
   * components never appear, and a touched component that does not move does
   * not either.
   *
   * SMALL-N GUARD (bd tea-rags-mcp-r8hme.45): a touched component whose
   * `connectionCount` is below `minConnectionCount` — the same SDP floor the
   * whole-repo detector excludes at — is not judged, only counted on the
   * family's status row. At connectionCount n a component's instability moves
   * in steps of 1/n, so one new edge on a one-or-two-edge component is a
   * half-to-full-scale move — the small-N false positive every facade/refactor
   * diff drew on components whose legal fanOut is one contracts edge. The
   * guard reads `connectionCount`, which the recompute below never moves (k
   * lands on top of the fan, not inside it), so it composes with both paths.
   *
   * EXACT RECOMPUTE (bd tea-rags-mcp-89k7k.19): when the catalog serves the
   * component's fan counts (Ca/Ce — the same `ArchitectureComponent` facts
   * the whole-repo report derives), k genuinely-new outgoing edges move the
   * SOURCE's component's instability to exactly I' = (Ce + k)/(Ca + Ce + k) —
   * the whole-repo detector's own instability arithmetic re-applied to the
   * post-diff fan. One new edge on a 24-connection component moves I by ~1/25,
   * never the full-scale step that saturated such a component to I=1.000 and
   * D 0.946 from a single facade import (the 89k7k.14 replay residual: the
   * +1-per-edge step had no access to the fan counts through the diff ports).
   * The edge set is the subtraction's output (bd tea-rags-mcp-89k7k.14: a
   * pair the indexed graph already holds never moves anything).
   *
   * FALLBACK (the 89k7k.14 absence rule, documented per spec): a catalog that
   * serves no fan counts keeps the +1-per-edge step — one full step per
   * diff-added edge clamped at I=1 — because the fan counts are not reachable
   * through that port, and a missing fact is never read as "no edges", so the
   * step judges ALL k edges, never zero of them. Abstractness A is held
   * constant at the +D solution of D = |A + I - 1| (A = 1 - I + D): which side
   * of the main sequence the component sits on is not exposed by the catalog
   * either, and on that solution the deltaD equals the I increment — the
   * worst case (distance grows), which is what a diff review wants flagged.
   *
   * FOUNDATION-TERMINAL ANNOTATION (bd tea-rags-mcp-r8hme.45): a finding
   * whose contributing edges ALL terminate inside a `contracts/` directory
   * carries `foundationTerminal: true` — the legal foundation direction
   * (everything may depend on the lowest layer). Contributing edges are the
   * DIFF-ADDED ones (post-subtraction): pre-existing imports do not dilute
   * the annotation. The D still moved, so the finding stands, annotated as
   * data for triage; one non-contracts diff-added edge is enough to leave it
   * unannotated.
   */
  private judgeMainSequence(
    changedFiles: readonly string[],
    edges: readonly OverlayEdge[],
  ): { findings: DiffDetectorFinding[]; excludedLowConnectionCount: number } {
    const touched = new Map<
      string,
      { instability: number; distanceFromMainSequence: number; afferentCount?: number; efferentCount?: number }
    >();
    const judgedComponents = new Set<string>();
    let excludedLowConnectionCount = 0;
    for (const relPath of changedFiles) {
      const component = this.catalog.componentOf(relPath);
      if (component === undefined || judgedComponents.has(component.name)) continue;
      judgedComponents.add(component.name);
      if (component.connectionCount < this.minConnectionCount) {
        excludedLowConnectionCount++;
        continue;
      }
      touched.set(component.name, {
        instability: component.instability,
        distanceFromMainSequence: component.distanceFromMainSequence,
        afferentCount: component.afferentCount,
        efferentCount: component.efferentCount,
      });
    }
    const crossingEdges = new Map<string, OverlayEdge[]>();
    for (const edge of edges) {
      const sourceComponent = this.catalog.componentOf(edge.source);
      const targetComponent = this.catalog.componentOf(edge.target);
      if (sourceComponent === undefined || targetComponent === undefined) continue;
      if (sourceComponent.name === targetComponent.name || !touched.has(sourceComponent.name)) continue;
      const componentEdges = crossingEdges.get(sourceComponent.name);
      if (componentEdges === undefined) crossingEdges.set(sourceComponent.name, [edge]);
      else componentEdges.push(edge);
    }

    const findings: DiffDetectorFinding[] = [];
    for (const [name, fact] of touched) {
      const edgesOut = crossingEdges.get(name);
      if (edgesOut === undefined) continue;
      const newEdgeCount = edgesOut.length;
      // Both counts or neither: one alone cannot feed the exact recompute, and
      // a half-served fan is the same absent fact as none (the 89k7k.14 rule).
      const fans =
        fact.afferentCount !== undefined && fact.efferentCount !== undefined
          ? { afferentCount: fact.afferentCount, efferentCount: fact.efferentCount }
          : undefined;
      const newInstability =
        fans !== undefined
          ? (fans.efferentCount + newEdgeCount) / (fans.afferentCount + fans.efferentCount + newEdgeCount)
          : Math.min(1, fact.instability + newEdgeCount);
      const instabilityDelta = newInstability - fact.instability;
      if (Math.abs(instabilityDelta) <= MAIN_SEQUENCE_EPSILON) continue;
      const abstractness = 1 - fact.instability + fact.distanceFromMainSequence;
      const newDistance = Math.abs(abstractness + newInstability - 1);
      const foundationTerminal = edgesOut.every((edge) => terminatesAtFoundationContracts(edge.target));
      // The exact-recompute clause names the arithmetic only when its inputs were served.
      const recomputeClause = fans !== undefined ? ` — I' = (Ce+k)/(Ca+Ce+k) over the report's fan counts` : "";
      findings.push({
        detector: "mainSequence",
        subject: name,
        evidence: [
          `D ${format3(fact.distanceFromMainSequence)} -> ${format3(newDistance)}`,
          ...(fans !== undefined
            ? [
                `I ${format3(fact.instability)} -> ${format3(newInstability)} = ` +
                  `(${fans.efferentCount}+${newEdgeCount})/(${fans.afferentCount}+${fans.efferentCount}+${newEdgeCount})`,
              ]
            : []),
          ...edgesOut.map((edge) => `${edge.source} -> ${edge.target}`),
        ],
        detail: `the diff moves ${name} off its main-sequence distance: ${newEdgeCount} cross-component outgoing edge(s) raise instability ${format3(fact.instability)} -> ${format3(newInstability)} with abstractness held${recomputeClause}`,
        ...(foundationTerminal ? { foundationTerminal: true as const } : {}),
        // The unstable end of the main sequence is where an entry component
        // belongs (see DECLARED_ENTRY_POINT_COMPONENTS): annotated, still
        // reported.
        ...(isDeclaredEntryPoint(name) ? { entryPoint: true as const } : {}),
      });
    }
    return { findings, excludedLowConnectionCount };
  }

  /**
   * Silent coupling pairs involving a changed file — CONSUMED from the
   * production verdict (bd tea-rags-mcp-89k7k.1.10): the whole-repo detector
   * already applied the endpoint-class exclusions (test/generated/
   * documentation/unwalked/lift), the Wilson-strength cut and the
   * shared-neighbour explanation over the same snapshot; this family only
   * intersects the violation list with the diff. Re-judging raw partner rows
   * here is what let 19–98 historical src~test and CLAUDE.md~code pairs per
   * diff bury the diff-relevant findings.
   *
   * A violation is skipped when the diff itself answers it: the overlay adds
   * the pair's structural edge in either direction, or a pre-existing edge
   * stands in the indexed graph's reverse direction (a partner -> file edge —
   * without that check the "no structural edge" sentence below could be
   * false). Both sides in the diff is the review's own business, not a
   * finding (bd tea-rags-mcp-3kykc owns the partner-missing question).
   */
  private judgeSilentCoupling(
    changedFiles: readonly string[],
    overlay: ReviewEdgeOverlay,
    changed: ReadonlySet<string>,
  ): { findings: DiffDetectorFinding[]; excluded: SilentCouplingExclusionCounts | undefined } {
    const facts = this.silentCouplingFacts;
    if (facts === undefined) return { findings: [], excluded: undefined };
    const findings: DiffDetectorFinding[] = [];
    const reported = new Set<string>();
    for (const relPath of changedFiles) {
      for (const violation of facts.violations) {
        if (violation.relPathA !== relPath && violation.relPathB !== relPath) continue;
        const partner = violation.relPathA === relPath ? violation.relPathB : violation.relPathA;
        if (changed.has(partner)) continue;
        const subject = `${relPath} ~ ${partner}`;
        if (reported.has(subject)) continue;
        reported.add(subject);
        const explainedByOverlay =
          overlay.edgesFrom(relPath).some((edge) => edge.targetRelPath === partner) ||
          overlay.edgesFrom(partner).some((edge) => edge.targetRelPath === relPath);
        if (explainedByOverlay) continue;
        // Absent graph reads as no indexed reverse edge — same as an empty
        // one: the check exists to suppress, and what cannot be confirmed
        // cannot suppress.
        const structurallyVisible = this.graph?.edgesTo(relPath).some((indexed) => indexed.source === partner) ?? false;
        if (structurallyVisible) continue;
        findings.push({
          detector: "silentCoupling",
          subject,
          evidence: [`co-change support ${format3(violation.support)}`, `strength ${format3(violation.strength)}`],
          detail:
            `strong co-change with no structural edge and the diff does not add one: ${subject} ` +
            `(support ${format3(violation.support)}, strength ${format3(violation.strength)})`,
        });
      }
    }
    return { findings, excluded: facts.excluded };
  }

  /**
   * Facade-contract breaks: a changed file that IS a measured module's facade
   * stops re-exporting names indexed consumers outside the module still
   * import — the SUPPLY side of the export surface (the demand side, a new
   * deep import past a facade, is leakingAbstraction's). The tree's re-export
   * surface is the overlay's own recorded names; the pre-diff demand is the
   * indexed graph's. Judged only when the tree recorded a re-export surface
   * at all — "not recorded" must never read as "exports nothing" (the same
   * guard `classifyFacadeLeak`'s `facadeNamesRecorded` makes on the report
   * side). A consumer the diff also changes is skipped: its indexed row is
   * stale, the diff judges its own read.
   */
  private judgeFacadeContract(
    changedFiles: readonly string[],
    overlay: ReviewEdgeOverlay,
    changed: ReadonlySet<string>,
  ): DiffDetectorFinding[] {
    if (this.contract === undefined) return [];
    const findings: DiffDetectorFinding[] = [];
    for (const relPath of changedFiles) {
      const componentDir = this.contract.facadeComponentOf(relPath);
      if (componentDir === undefined) continue;
      const treeExposed = new Set<string>();
      let reexportsRecorded = false;
      for (const edge of overlay.edgesFrom(relPath)) {
        if (edge.reexportedExportNames === undefined) continue;
        reexportsRecorded = true;
        for (const name of edge.reexportedExportNames) treeExposed.add(name);
      }
      if (!reexportsRecorded) continue;
      const indexedSurface = this.contract.indexedSurfaceOf(relPath);
      if (indexedSurface === undefined || indexedSurface.length === 0) continue;
      const dropped = new Set(indexedSurface.filter((name) => !treeExposed.has(name)));
      if (dropped.size === 0) continue;

      const consumersByDroppedName = new Map<string, Set<string>>();
      for (const consumer of this.contract.indexedConsumersOf(relPath)) {
        if (changed.has(consumer.source)) continue;
        if (consumer.importedNames === undefined) continue;
        if (consumer.importedNames.includes(WHOLE_MODULE_EXPORT_NAME)) continue;
        for (const name of consumer.importedNames) {
          if (!dropped.has(name)) continue;
          const sources = consumersByDroppedName.get(name);
          if (sources === undefined) consumersByDroppedName.set(name, new Set([consumer.source]));
          else sources.add(consumer.source);
        }
      }
      if (consumersByDroppedName.size === 0) continue;

      const droppedNames = [...consumersByDroppedName.keys()].sort();
      findings.push({
        detector: "facadeContract",
        subject: relPath,
        evidence: droppedNames.map((name) => {
          const sources = [...(consumersByDroppedName.get(name) ?? [])].sort();
          return `${name}: consumed by ${sources.join(", ")}`;
        }),
        detail:
          `the diff stops re-exporting names the module's consumers still import: ` +
          `${droppedNames.join(", ")} left ${relPath}'s re-export surface while indexed files outside ` +
          `${componentDir} still import them`,
      });
    }
    return findings;
  }

  /**
   * The diff judged against the phase-1 split/merge verdicts — never a
   * re-draw. SPLIT: changed files land in ≥ 2 clusters of one split candidate,
   * so the change works across the seam history already draws inside that
   * component; one cluster touched is the history's own grouping, never a
   * finding. Cluster membership is the verdict's own per-cluster file list,
   * so "N of M" counts against that list. MERGE: changed files on both sides
   * of a merge candidate — the diff bridges two components whose bundles
   * already move as one. A changed file the partition does not hold is
   * silence, never a verdict.
   */
  private judgeSplitCandidates(changedFiles: readonly string[]): DiffDetectorFinding[] {
    if (this.splitMerge === undefined) return [];
    const { verdicts, componentOf } = this.splitMerge;
    const changedInOrder = [...new Set(changedFiles)];
    const findings: DiffDetectorFinding[] = [];
    for (const candidate of verdicts.splitCandidates) {
      const touched = candidate.files
        .map((files, index) => {
          const members = new Set(files);
          return { index, size: files.length, hit: changedInOrder.filter((relPath) => members.has(relPath)) };
        })
        .filter((cluster) => cluster.hit.length > 0);
      if (touched.length < 2) continue;
      findings.push({
        detector: "splitCandidates",
        subject: candidate.component,
        evidence: touched.map(
          (cluster) =>
            `cluster ${cluster.index + 1}: ${cluster.hit.length} of ${cluster.size} changed files — ` +
            `${cluster.hit.slice(0, SPLIT_MERGE_EVIDENCE_FILE_CAP).join(", ")}`,
        ),
        detail:
          `the diff works across the seam of ${candidate.component}, a component whose history already splits ` +
          `into ${candidate.clusters} co-change groups`,
      });
    }

    const changedByComponent = new Map<string, string[]>();
    for (const relPath of changedInOrder) {
      const component = componentOf(relPath);
      if (component !== undefined) pushTo(changedByComponent, component, relPath);
    }
    for (const candidate of verdicts.mergeCandidates) {
      const sideA = changedByComponent.get(candidate.componentA);
      const sideB = changedByComponent.get(candidate.componentB);
      if (sideA === undefined || sideB === undefined) continue;
      findings.push({
        detector: "splitCandidates",
        subject: `${candidate.componentA} ~ ${candidate.componentB}`,
        evidence: [
          `strength ${format3(candidate.strength)}`,
          `${candidate.componentA}: ${cappedFileList(sideA)}`,
          `${candidate.componentB}: ${cappedFileList(sideB)}`,
        ],
        detail:
          `the diff bridges ${candidate.componentA} and ${candidate.componentB}, two components whose admitted ` +
          `bundles already move them as one unit`,
      });
    }
    return findings;
  }
}

/**
 * A merge side's changed files capped at {@link SPLIT_MERGE_EVIDENCE_FILE_CAP}
 * exemplars; a merge line carries no "N of M" count, so the overflow is
 * counted here instead of silently dropped.
 */
function cappedFileList(files: readonly string[]): string {
  const shown = files.slice(0, SPLIT_MERGE_EVIDENCE_FILE_CAP).join(", ");
  const overflow = files.length - SPLIT_MERGE_EVIDENCE_FILE_CAP;
  return overflow > 0 ? `${shown} (+${overflow} more)` : shown;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * The overlay's unique pairs minus the pairs the indexed graph already holds
 * — the edges the diff GENUINELY adds (bd tea-rags-mcp-89k7k.14): a changed
 * file's tree read re-serves every import it still holds, and judging that
 * whole set read a one-line barrel edit as 23 new dependencies saturating
 * the barrel's component to I=1.000. The masking contract's SECOND deliberate
 * read of a changed source's indexed rows. Absent port, or a source with no
 * indexed rows, subtracts nothing — a missing fact is never "no edges added".
 */
function diffAddedOverlayEdges(
  overlayEdges: readonly OverlayEdge[],
  graph: DiffDetectorGraphReader | undefined,
): readonly OverlayEdge[] {
  if (graph === undefined) return overlayEdges;
  const added: OverlayEdge[] = [];
  for (const edge of overlayEdges) {
    if (graph.edgesFrom(edge.source).some((indexed) => indexed.target === edge.target)) continue;
    added.push(edge);
  }
  return added;
}

/**
 * The diff's own edges as unique (source, target) pairs: one read per changed
 * file, self-edges dropped (the overlay's builder already drops them; the
 * guard keeps the judgement total), duplicates collapsed — a scope that lists
 * a file twice judges its edges once.
 */
function uniqueOverlayEdges(changedFiles: readonly string[], overlay: ReviewEdgeOverlay): readonly OverlayEdge[] {
  const seen = new Set<string>();
  const edges: OverlayEdge[] = [];
  for (const relPath of changedFiles) {
    for (const edge of overlay.edgesFrom(relPath)) {
      if (edge.targetRelPath === relPath) continue;
      const key = `${relPath} -> ${edge.targetRelPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: relPath, target: edge.targetRelPath });
    }
  }
  return edges;
}

/** A built detector family's verdict row. */
function detectorStatus(detector: DiffDetectorFinding["detector"], findingCount: number): DiffDetectorStatus {
  return Object.freeze({ detector, built: true, findingCount });
}

/** Three decimals — the whole-repo report's evidence formatting. */
function format3(value: number): string {
  return value.toFixed(3);
}

/** The edge's target lives inside a `contracts/` directory — the foundation everything may depend on. */
function terminatesAtFoundationContracts(relPath: string): boolean {
  return relPath.split("/").includes(FOUNDATION_CONTRACTS_PATH_SEGMENT);
}
