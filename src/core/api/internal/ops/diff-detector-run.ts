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
 * what the reverse-direction checks read, and the cycle BFS expands a re-read
 * changed file through its OVERLAY edges, never its stale indexed rows (bd
 * tea-rags-mcp-ah66x).
 * THREE predicates deliberately read a changed file's INDEXED out-edges — the
 * only places such rows are read at all: mainSequence's index-ahead surplus
 * (bd tea-rags-mcp-aht0q — the fan the index already counts for a changed
 * file the base did not), leakingAbstraction's facade evidence
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

import { reexportBindingsField, unionReexportBindings } from "../../../contracts/reexport-bindings.js";
import type { ReviewFileEdge } from "../../../contracts/types/codegraph-storage.js";
import type { DiffDetectorFinding, DiffDetectorStatus } from "../../../contracts/types/diff-detector-finding.js";
import {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  isFacadeAggregationEdge,
  ReviewEdgeOverlay,
  type HubLikeDependencyReading,
  type LayeringReading,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  DIFF_FAMILY_DETECTORS,
  targetsBeforeChange,
  type DiffDetectorBaseEdgeReader,
  type DiffDetectorCatalog,
  type DiffDetectorContractReader,
  type DiffDetectorGraphReader,
  type DiffDetectorScope,
  type DiffDetectorSilentCouplingFacts,
  type DiffDetectorSplitMergeReader,
  type DiffEdgeEdit,
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
  ExportTableReader,
} from "./diff-families/index.js";
// The remedy pass over a run's findings (bd tea-rags-mcp-89k7k.1.19.6) — its
// consumers reach it where they reach the run and its `rejudge` seam.
export {
  DiffFindingRemedyResolver,
  stampDiffFindingRemedies,
  WHOLE_MODULE_EXPORT_NAME,
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
   * The whole-repo hub-like verdict over the catalog's component partition
   * (bd tea-rags-mcp-89k7k.1.19.4); absent = the hubLike family answers
   * built:false.
   */
  hubLike?: HubLikeDependencyReading;
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
  private readonly hubLike: HubLikeDependencyReading | undefined;
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
    this.hubLike = deps.hubLike;
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
    return {
      findings: Object.freeze(verdicts.flatMap((verdict) => verdict.findings)),
      detectors: Object.freeze(verdicts.map((verdict) => verdict.status)),
    };
  }

  /**
   * The what-if seam (bd tea-rags-mcp-89k7k.1.19.6): {@link run} over the
   * overlay with `edits` applied — same scope, same ports, same families. It
   * knows edges and export lines, never remedies (89k7k.1.7 and r8hme.21
   * reuse it); `overlay` itself is left as read. See
   * {@link editedReviewEdgeOverlay} for how each edit lands.
   */
  rejudge(scope: DiffDetectorScope, overlay: ReviewEdgeOverlay, edits: readonly DiffEdgeEdit[]): DiffDetectorFindings {
    return this.run(scope, editedReviewEdgeOverlay(overlay, edits));
  }

  /** The one context every family judges — the subtraction and `heldBeforeChange` computed here, once. */
  private familyContext(scope: DiffDetectorScope, overlay: ReviewEdgeOverlay): DiffFamilyDetectorContext {
    // Presence in the change (bd tea-rags-mcp-lxbrr) — never the capped set:
    // a past-cap or deleted file is still part of what the diff carries.
    const inChange = scope.touchedFiles ?? new Set(scope.changedFiles);
    const overlayEdges = uniqueOverlayEdges(scope.changedFiles, overlay);
    const heldBeforeChange = (edge: OverlayEdge): HeldBeforeChangeEvidence | undefined => this.heldBeforeChange(edge);
    const addedEdges = overlayEdges.filter((edge) => heldBeforeChange(edge) === undefined);
    return {
      scope,
      overlay,
      overlayEdges,
      // The subtraction (bd tea-rags-mcp-89k7k.14): only genuinely-new pairs
      // reach the two families that weigh "what the diff adds"; the per-edge
      // detectors whose predicate is about the edge AS READ (leakingAbstraction's
      // facade reach, cycles' closing edge) keep the overlay's own set.
      addedEdges,
      // Facade aggregation is no component dependency in the whole-repo graph
      // (bd tea-rags-mcp-e1bf2): the same predicate over the overlay's own
      // export names drops it here.
      addedDependencyEdges: addedEdges.filter((edge) => !isOverlayFacadeAggregation(overlay, edge)),
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
      hubLike: this.hubLike,
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
    return edgeHeldBeforeChange(edge, { baseEdges: this.baseEdges, graph: this.graph });
  }
}

/** The evidence ports the before-the-change predicates read; an absent port is no evidence. */
export interface DiffEdgeEvidencePorts {
  baseEdges?: DiffDetectorBaseEdgeReader;
  graph?: DiffDetectorGraphReader;
}

/**
 * {@link DiffDetectorRun}'s `heldBeforeChange` as a function of its ports: the
 * diff base decides whenever it answers for the source, else the indexed
 * graph; `undefined` = nothing held the pair.
 */
export function edgeHeldBeforeChange(
  edge: OverlayEdge,
  { baseEdges, graph }: DiffEdgeEvidencePorts,
): HeldBeforeChangeEvidence | undefined {
  const atBase = baseEdges?.targetsAtBase(edge.source);
  if (atBase !== undefined) return atBase.has(edge.target) ? "base" : undefined;
  return indexedGraphHolds(graph, edge) ? "index" : undefined;
}

/**
 * The (source, target) pairs the change ADDS (bd tea-rags-mcp-xb669.3): the
 * overlay's unique pairs of the changed files minus every pair held before
 * the change — the subtraction the run hands its families as `addedEdges`.
 */
export function diffAddedEdges(
  changedFiles: readonly string[],
  overlay: ReviewEdgeOverlay,
  ports: DiffEdgeEvidencePorts,
): readonly OverlayEdge[] {
  return uniqueOverlayEdges(changedFiles, overlay).filter((edge) => edgeHeldBeforeChange(edge, ports) === undefined);
}

/**
 * How many (source, target) pairs the change REMOVES (bd tea-rags-mcp-xb669.3):
 * per changed file whose tree read succeeded, the targets it held before the
 * change ({@link targetsBeforeChange}) its overlay no longer holds, plus every
 * pre-change out-edge of a deleted file. A skipped read (current edges
 * unknown) and a file no port answers for count nothing — a missing fact is
 * never a removal.
 */
export function diffRemovedEdgeCount(
  changedFiles: readonly string[],
  overlay: ReviewEdgeOverlay,
  ports: DiffEdgeEvidencePorts & { deletedFiles?: readonly string[] },
): number {
  const skipped = new Set(overlay.unsupported().map((skip) => skip.relPath));
  const removedFrom = (relPath: string, current: ReadonlySet<string>): number => {
    const before = targetsBeforeChange(relPath, ports.baseEdges, ports.graph);
    if (before === undefined) return 0;
    let count = 0;
    for (const target of before) if (target !== relPath && !current.has(target)) count++;
    return count;
  };
  let removed = 0;
  for (const relPath of new Set(changedFiles)) {
    if (skipped.has(relPath) || !overlay.masked.has(relPath)) continue;
    removed += removedFrom(relPath, new Set(overlay.edgesFrom(relPath).map((edge) => edge.targetRelPath)));
  }
  for (const relPath of new Set(ports.deletedFiles ?? [])) removed += removedFrom(relPath, new Set());
  return removed;
}

/**
 * The overlay after `edits`, rebuilt from its own reads (masked set, deleted set and
 * unsupported reads unchanged — an edit never widens what the review read):
 *
 * - `replace` points `source`'s edge to `from` at `to`, names kept; when
 *   `source` already holds an edge to `to`, the two merge into one edge with
 *   both edges' names unioned (one row per target, as the reader builds it).
 * - `addExport` is one re-export line on a facade. Its names join the facade's
 *   re-export surface on a SELF-edge (facade → facade): the line adds supply,
 *   and the dependency it would add (facade → declarer) stays inside the
 *   facade's own module — so the self-edge, which `uniqueOverlayEdges` drops
 *   before any per-edge family, changes only what facadeContract reads. A
 *   facade the review did not read is a no-op: its indexed surface is no
 *   family's input, and masking it would hide its indexed edges.
 */
function editedReviewEdgeOverlay(overlay: ReviewEdgeOverlay, edits: readonly DiffEdgeEdit[]): ReviewEdgeOverlay {
  const edgesBySource = new Map([...overlay.masked].map((relPath) => [relPath, [...overlay.edgesFrom(relPath)]]));
  for (const { replace, addExport } of edits) {
    if (replace !== undefined) {
      const edges = edgesBySource.get(replace.source);
      if (edges !== undefined) edgesBySource.set(replace.source, retargetedEdges(edges, replace.from, replace.to));
    }
    if (addExport !== undefined) {
      const { facadeRelPath, names } = addExport;
      edgesBySource
        .get(facadeRelPath)
        ?.push({ sourceRelPath: facadeRelPath, targetRelPath: facadeRelPath, reexportedExportNames: [...names] });
    }
  }
  const skips = new Map(overlay.unsupported().map(({ relPath, ...skip }) => [relPath, skip]));
  return new ReviewEdgeOverlay(
    [...edgesBySource].map(([relPath, edges]) => {
      const skip = skips.get(relPath);
      return { relPath, edges, ...(skip !== undefined ? { skip } : {}) };
    }),
    { deleted: overlay.deleted },
  );
}

/** `edges` with the edge to `from` now pointing at `to`, merged into an existing edge to `to`. */
function retargetedEdges(edges: readonly ReviewFileEdge[], from: string, to: string): ReviewFileEdge[] {
  const moved = edges.find((edge) => edge.targetRelPath === from);
  if (moved === undefined) return [...edges];
  const kept = edges.filter((edge) => edge !== moved);
  const into = kept.find((edge) => edge.targetRelPath === to);
  if (into === undefined) return [...kept, { ...moved, targetRelPath: to }];
  return kept.map((edge) => (edge === into ? mergedEdge(into, moved) : edge));
}

/** One edge carrying both edges' recorded names; a list stays absent only when neither recorded it. */
function mergedEdge(into: ReviewFileEdge, moved: ReviewFileEdge): ReviewFileEdge {
  const union = (a?: readonly string[], b?: readonly string[]) =>
    a === undefined && b === undefined ? undefined : [...new Set([...(a ?? []), ...(b ?? [])])];
  const imported = union(into.importedExportNames, moved.importedExportNames);
  const reexported = union(into.reexportedExportNames, moved.reexportedExportNames);
  return {
    sourceRelPath: into.sourceRelPath,
    targetRelPath: into.targetRelPath,
    ...(imported !== undefined ? { importedExportNames: imported } : {}),
    ...(reexported !== undefined ? { reexportedExportNames: reexported } : {}),
    ...reexportBindingsField(unionReexportBindings(into, moved)),
  };
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
/**
 * The overlay read of `edge` is facade aggregation by the whole-repo rule
 * (`isFacadeAggregationEdge`): one of its statements forwards the nested
 * facade's exports as the parent facade's own.
 */
function isOverlayFacadeAggregation(overlay: ReviewEdgeOverlay, edge: OverlayEdge): boolean {
  return overlay
    .edgesFrom(edge.source)
    .some((read) => read.targetRelPath === edge.target && isFacadeAggregationEdge(read));
}

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
