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

import type { DiffDetectorFinding, DiffDetectorStatus } from "../../../contracts/types/diff-detector-finding.js";
import {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  type LayeringReading,
  type ReviewEdgeOverlay,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  DIFF_FAMILY_DETECTORS,
  type DiffDetectorBaseEdgeReader,
  type DiffDetectorCatalog,
  type DiffDetectorContractReader,
  type DiffDetectorGraphReader,
  type DiffDetectorScope,
  type DiffDetectorSilentCouplingFacts,
  type DiffDetectorSplitMergeReader,
  type DiffFamilyDetectorContext,
  type HeldBeforeChangeEvidence,
  type OverlayEdge,
} from "./diff-families/index.js";

// The ports moved beside the families that read them (bd tea-rags-mcp-89k7k.1.19.10);
// the run stays their import address for its consumers.
export type {
  DiffDetectorBaseEdgeReader,
  DiffDetectorCatalog,
  DiffDetectorContractReader,
  DiffDetectorGraphReader,
  DiffDetectorScope,
  DiffDetectorSilentCouplingFacts,
  DiffDetectorSplitMergeReader,
} from "./diff-families/index.js";

export interface DiffDetectorRunDeps {
  /**
   * The indexed graph (see {@link DiffDetectorGraphReader}). Absent = every
   * indexed-graph predicate reads as "no evidence" — in particular the
   * diff-added subtraction judges every overlay pair (the pre-89k7k.14
   * behavior), never zero of them.
   */
  graph?: DiffDetectorGraphReader;
  /**
   * The diff base's edges of the changed sources (see
   * {@link DiffDetectorBaseEdgeReader}). When it answers for a source, it —
   * not the indexed graph — decides the diff-added subtraction, the
   * `preExisting` stamp and leakingAbstraction's pre-diff facade evidence for
   * that source's edges. Absent, or `undefined` for a source = the indexed
   * graph decides (the pre-89k7k.1.16 behavior).
   */
  baseEdges?: DiffDetectorBaseEdgeReader;
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
   * The inferred layering over the catalog's component partition; absent =
   * the layeringBackEdge family answers built:false.
   */
  layering?: LayeringReading;
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
  /**
   * The whole-repo main-sequence distance threshold (the report's
   * `summary.distanceThreshold`) — what a mainSequence finding's
   * `distanceBefore` must already exceed to be `preExisting` (bd
   * tea-rags-mcp-89k7k.1.19.2). Absent = never attributed.
   */
  mainSequenceDistanceThreshold?: number;
}

export interface DiffDetectorFindings {
  findings: readonly DiffDetectorFinding[];
  /** Per-family verdict — `splitCandidates` carries the wiring's reason when its port is absent. */
  detectors: readonly DiffDetectorStatus[];
}

/** The whole-repo report's trace depth, reused as the cycle BFS hop cap. */
const DEFAULT_MAX_TRACE_HOPS = 8;
/**
 * The split-candidate family's verdict when the wiring passed no port and no
 * reason of its own — the phase-1 DTO's camelCase reason style. Every other
 * absent reason is the wiring's dynamic string, passed through uninterpreted.
 */
const NO_SPLIT_MERGE_READER_REASON = "noSplitMergeReader";

export class DiffDetectorRun {
  private readonly graph: DiffDetectorGraphReader | undefined;
  private readonly baseEdges: DiffDetectorBaseEdgeReader | undefined;
  private readonly catalog: DiffDetectorCatalog;
  private readonly silentCouplingFacts: DiffDetectorSilentCouplingFacts | undefined;
  private readonly contract: DiffDetectorContractReader | undefined;
  private readonly splitMerge: DiffDetectorSplitMergeReader | undefined;
  private readonly splitMergeAbsentReason: string;
  private readonly layering: LayeringReading | undefined;
  private readonly maxTraceHops: number;
  private readonly minConnectionCount: number;
  private readonly mainSequenceDistanceThreshold: number | undefined;

  constructor(deps: DiffDetectorRunDeps) {
    this.graph = deps.graph;
    this.baseEdges = deps.baseEdges;
    this.catalog = deps.catalog;
    this.silentCouplingFacts = deps.silentCouplingFacts;
    this.contract = deps.contract;
    this.splitMerge = deps.splitMerge;
    this.splitMergeAbsentReason = deps.splitMergeAbsentReason ?? NO_SPLIT_MERGE_READER_REASON;
    this.layering = deps.layering;
    this.maxTraceHops = deps.maxTraceHops ?? DEFAULT_MAX_TRACE_HOPS;
    this.minConnectionCount = deps.minConnectionCount ?? DEFAULT_SDP_MIN_CONNECTION_COUNT;
    this.mainSequenceDistanceThreshold = deps.mainSequenceDistanceThreshold;
  }

  /**
   * Judge one diff: the edges its changed files add (the overlay, minus the
   * pairs held before the change — at the diff base, else in the indexed
   * graph; see `heldBeforeChange` — for the families that weigh
   * diff-added coupling — see the masking contract) against the indexed graph
   * and the report-derived facts. Findings come out grouped in the detectors'
   * order — `DIFF_FAMILY_DETECTORS`' registry order — each detector's own
   * findings in edge/scope order — deterministic for a given overlay. Never
   * throws on missing facts; see the module docblock for the silence contract.
   */
  run(scope: DiffDetectorScope, overlay: ReviewEdgeOverlay): DiffDetectorFindings {
    const verdicts = DIFF_FAMILY_DETECTORS.map((detector) => detector.judge(this.familyContext(scope, overlay)));
    // Partial over a truncated diff (bd tea-rags-mcp-89k7k.1.9): stamped on
    // BUILT rows only — an unbuilt row's built:false + reason already denies
    // the clean pass.
    const skippedFiles = scope.skippedFiles ?? 0;
    const partial = (status: DiffDetectorStatus): DiffDetectorStatus =>
      skippedFiles > 0 && status.built ? Object.freeze({ ...status, scopeSkippedFiles: skippedFiles }) : status;
    return {
      findings: Object.freeze(verdicts.flatMap((verdict) => verdict.findings)),
      detectors: Object.freeze(verdicts.map((verdict) => partial(verdict.status))),
    };
  }

  /** The one context every family judges — the subtraction and `heldBeforeChange` computed here, once. */
  private familyContext(scope: DiffDetectorScope, overlay: ReviewEdgeOverlay): DiffFamilyDetectorContext {
    // Presence in the change (bd tea-rags-mcp-lxbrr) — never the capped set:
    // a past-cap or deleted file is still part of what the diff carries.
    const inChange = scope.touchedFiles ?? new Set(scope.changedFiles);
    const overlayEdges = uniqueOverlayEdges(scope.changedFiles, overlay);
    const heldBeforeChange = (edge: OverlayEdge): HeldBeforeChangeEvidence | undefined => this.heldBeforeChange(edge);
    return {
      scope,
      overlay,
      overlayEdges,
      // The subtraction (bd tea-rags-mcp-89k7k.14): only genuinely-new pairs
      // reach the two families that weigh "what the diff adds"; the per-edge
      // detectors whose predicate is about the edge AS READ (leakingAbstraction's
      // facade reach, cycles' closing edge) keep the overlay's own set.
      addedEdges: overlayEdges.filter((edge) => heldBeforeChange(edge) === undefined),
      inChange,
      graph: this.graph,
      baseEdges: this.baseEdges,
      catalog: this.catalog,
      heldBeforeChange,
      silentCouplingFacts: this.silentCouplingFacts,
      contract: this.contract,
      splitMerge: this.splitMerge,
      splitMergeAbsentReason: this.splitMergeAbsentReason,
      layering: this.layering,
      maxTraceHops: this.maxTraceHops,
      minConnectionCount: this.minConnectionCount,
      mainSequenceDistanceThreshold: this.mainSequenceDistanceThreshold,
    };
  }

  /**
   * Which evidence held the (source, target) pair BEFORE the change, or
   * `undefined` when nothing did — the ONE predicate behind the diff-added
   * subtraction (bd tea-rags-mcp-89k7k.14: a changed file's tree read
   * re-serves every import it still holds, and judging that whole set read a
   * one-line barrel edit as 23 new dependencies), the `preExisting`
   * attribution of cycles / leakingAbstraction (bd tea-rags-mcp-89k7k.1.13)
   * and leakingAbstraction's pre-diff facade evidence.
   *
   * The diff BASE decides whenever it answers for the source (bd
   * tea-rags-mcp-89k7k.1.16): "added by this change" means absent at the
   * merge-base and present in the tree, wherever the index sits. Only a
   * source the base port cannot answer falls back to the indexed rows — the
   * masking contract's deliberate changed-source read — and an absent port
   * there answers `undefined`: a missing fact is never "already held".
   */
  private heldBeforeChange(edge: OverlayEdge): HeldBeforeChangeEvidence | undefined {
    const atBase = this.baseEdges?.targetsAtBase(edge.source);
    if (atBase !== undefined) return atBase.has(edge.target) ? "base" : undefined;
    return indexedGraphHolds(this.graph, edge) ? "index" : undefined;
  }
}

/**
 * Whether the indexed graph holds the (source, target) pair — the fallback
 * evidence of {@link DiffDetectorRun}'s `heldBeforeChange` for a source the
 * base port does not answer. Absent port answers false: absence is an empty
 * graph, never "already indexed".
 */
function indexedGraphHolds(graph: DiffDetectorGraphReader | undefined, edge: OverlayEdge): boolean {
  return graph?.edgesFrom(edge.source).some((indexed) => indexed.target === edge.target) ?? false;
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
