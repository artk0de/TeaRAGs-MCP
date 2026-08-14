/**
 * Codegraph graph value types — the persisted graph itself, independent of the
 * client that reads or writes it: the file node, its outgoing file / method /
 * inheritance edges, the edge-provenance vocabulary (`MethodEdgeKind`), the SCC
 * scope and cycle rows, the per-symbol signal triple, and the two run-level
 * aggregate rows (`EdgeKindCount`, `ResolveRunStatsRow`).
 *
 * Kept apart from `codegraph-storage.ts` on purpose: MCP tools and the
 * codegraph provider pass these shapes around constantly without ever naming
 * `GraphDbClient`. Re-exported verbatim by the `codegraph.ts` barrel.
 */

import type { InheritanceEdgeRow } from "./codegraph-hierarchy.js";
import type { RelPath, SymbolId } from "./codegraph-symbols.js";

/**
 * Per-symbol graph metrics read back for chunk-level enrichment: confidence-
 * weighted fanIn/fanOut over method edges + PageRank. The value shape of
 * `getChunkSignalsBulk`'s map (mirrors the three per-symbol getters it batches).
 */
export interface ChunkGraphSignals {
  fanIn: number;
  fanOut: number;
  pageRank: number;
}

/**
 * Per-FILE graph metrics read back for file-level enrichment: direct fanIn /
 * fanOut over import edges plus the depth-bounded reverse-reachability count.
 * The value shape of `getFileMetricsBulk`'s map (mirrors the three per-file
 * getters it batches).
 */
export interface FileGraphMetrics {
  fanIn: number;
  fanOut: number;
  transitiveImpact: number;
}

export type CycleScope = "file" | "method";

export interface CycleEntry {
  /** Numeric id assigned at recompute time; stable within a single recompute, NOT across recomputes. */
  cycleId: number;
  scope: CycleScope;
  /** Members in walk order (the order returned by Tarjan's pop sequence). */
  members: string[];
}

export interface GraphFileNode {
  relPath: RelPath;
  language: string;
  /**
   * SHA256 of the file's contents at extraction time, taken from the ingest
   * snapshot (no extra read). Lets a later run tell a graph row that is merely
   * PRESENT from one that is CURRENT, which is what the repair check diffs
   * against (bd tea-rags-mcp-6goqa). Undefined when the caller has no hash
   * (direct/test writes); that persists as NULL and makes the file re-extract.
   */
  contentHash?: string;
}

/**
 * Provenance of a method-call edge (bd tea-rags-mcp-2jet).
 *
 * - `exact`     — receiver/ancestor method pinned directly (the baseline).
 * - `cone`      — bounded CHA devirtualization: a polymorphic call fanned out
 *                 to overriding subtypes (|cone| ≤ K). Each cone edge carries
 *                 `confidence = 1/N` so N candidate targets share unit weight.
 * - `poly-base` — hub fan-out capped: one edge to the base declaration, full
 *                 subtype expansion deferred to query-time `getSubtypes`.
 * - `dynamic`   — dynamic-receiver short-name fan-out (bd tea-rags-mcp-wbj3): a
 *                 receiver with no static type (`arr.map`, `obj[k].call`) that
 *                 would otherwise drop is resolved by short-name lookup with a
 *                 confidence discount (`< 1`). Distinguishable from `cone` (which
 *                 has a static base type) so ranking can discount name-only edges.
 * - `registry`  — registry-literal dispatch fan-out (bd tea-rags-mcp-pq02v): a
 *                 `CONST[key].new.m` site whose `CONST` is a frozen hash/array of
 *                 value-classes. The candidate set is STATICALLY COMPLETE (every
 *                 value class is known from the literal) but the runtime key picks
 *                 one — distinct from `cone` (CHA descendants, possibly partial
 *                 across compilation units) and from `dynamic` (no type evidence).
 *                 `confidence = 1/N` over the N value classes; a static literal key
 *                 narrows to one entry and is emitted as `exact`/1.0 instead.
 */
export type MethodEdgeKind = "exact" | "cone" | "poly-base" | "dynamic" | "registry";

/** One row of the method-edge `edge_kind` count distribution (precision-confidence signal). */
export interface EdgeKindCount {
  edgeKind: MethodEdgeKind;
  count: number;
}

/**
 * One row of the per-receiver-kind resolve breakdown (bd tea-rags-mcp-j431),
 * persisted to `cg_run_stats` (overwritten each enrichment run) so the
 * daemon-readable proxy can surface it — worker stderr is not captured by the
 * MCP host. `receiverKind` mirrors the `ReceiverKind` union the provider emits.
 */
export interface ResolveRunStatsRow {
  /**
   * tea-rags-mcp-cnqrg — the code language of the call-sites this row tallies
   * (`extraction.language`: `typescript`, `ruby`, `python`, …). The persisted
   * grain is per-(language, receiverKind) so `get_index_status` can break
   * `resolveSuccessRate` down per language to locate the resolver gap. Defaults
   * to `""` for pre-cnqrg rows / direct-mode runs without a language.
   */
  language: string;
  receiverKind: string;
  attempted: number;
  resolved: number;
  /**
   * tea-rags-mcp-ykj7 — of the `attempted − resolved` misses in this bucket, how
   * many the resolver classified as external-library / runtime targets
   * (`Math.max`, `fs.readFile`, `Net::HTTP.get`). Excluded from the
   * resolveSuccessRate denominator so the rate measures PROJECT-INTERNAL
   * resolver capability. Defaults to 0 for pre-ykj7 rows / languages without an
   * external classifier.
   */
  externalSkipped: number;
  /**
   * bd cai0 — of the `attempted − resolved` misses in this bucket, how many were
   * statically UNDETERMINABLE (dynamic `send(var)`), not resolver failures. Like
   * `externalSkipped`, excluded from the resolveSuccessRate denominator. Defaults
   * to 0 for pre-cai0 rows / languages without dynamic-send tagging.
   */
  unresolvable: number;
  /**
   * Of the `attempted − resolved` misses in this bucket, how many have NO
   * in-project definition for their member short-name (gem/core/runtime-
   * generated/dynamic targets). Excluded from the inProjectEdgeRecall
   * denominator so recall measures graph completeness over calls that COULD
   * resolve to a project symbol. Defaults to 0 for rows persisted before the
   * column was added (the recall then collapses to raw capability).
   */
  noInProjectDef?: number;
  /**
   * bd tea-rags-mcp-83cl7 — of the `attempted − resolved` misses in this bucket,
   * how many are CORE HOMONYMS: a core/runtime member (`each`, `to_s`, `first`)
   * on an UNTYPED receiver, whose in-project def of the same short name is a
   * coincidence. Excluded from the inProjectEdgeRecall denominator alongside
   * `noInProjectDef`. Defaults to 0 for rows persisted before the column was
   * added (recall then reads its pre-83cl7 value).
   */
  coreAmbiguous?: number;
  /**
   * bd tea-rags-mcp-f2jsb / j0pki — of the `attempted − resolved` misses in
   * this bucket, how many the dispatch kernel judged over-cap AMBIGUOUS
   * (survivors > corpus-adaptive fan-out cap) and recorded as an aggregate
   * instead of m edges. Its own bucket: NOT a genuine miss, NOT external.
   * Strict recall keeps it in the denominator; coveredRecall counts it as
   * coverage. Defaults to 0 for rows persisted before the column was added.
   */
  ambiguousFanout?: number;
}

export interface GraphEdges {
  fileEdges: { targetRelPath: RelPath; importText: string | null }[];
  methodEdges: {
    sourceSymbolId: SymbolId;
    targetSymbolId: SymbolId | null;
    targetRelPath: RelPath;
    callExpression: string;
    /** Edge provenance (bd 2jet). Omitted ⇒ persisted as `exact`. */
    edgeKind?: MethodEdgeKind;
    /** CHA fan-out dampening in (0,1]. Omitted ⇒ persisted as `1.0`. */
    confidence?: number;
  }[];
  /** Resolved inheritance edges for this file's source classes
   *  (bd tea-rags-mcp-f10y). Persisted to cg_symbols_inheritance via upsertFile;
   *  source_rel_path is taken from the accompanying GraphFileNode. */
  inheritance?: InheritanceEdgeRow[];
  /** Over-cap ambiguous dispatch fan-outs for this file's call sites
   *  (bd tea-rags-mcp-f2jsb / j0pki). One aggregate record per suppressed
   *  fan-out — persisted to cg_ambiguous_fanout via upsertFile (per-file
   *  DELETE+INSERT lifecycle, source_rel_path from the accompanying
   *  GraphFileNode) INSTEAD of m noise edges. Present only when non-empty,
   *  mirroring `inheritance`. */
  ambiguousFanouts?: {
    sourceSymbolId: SymbolId;
    callExpression: string;
    member: string;
    candidateCount: number;
  }[];
}

export interface CallerEdge {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
  /** Edge kind from `cg_symbols_edges_method.edge_kind` (xlnub Task 5). */
  edgeKind?: MethodEdgeKind;
  /** Dispatch confidence in (0,1] from `cg_symbols_edges_method.confidence` (xlnub Task 5). */
  confidence?: number;
}

/**
 * One `cg_ambiguous_fanout` aggregate row surfaced by
 * `getAmbiguousCallersByMember` (bd tea-rags-mcp-f2jsb A4): an over-cap
 * dispatch site whose member matches the queried target. The call MAY reach
 * the target among `candidateCount` candidates — it is NOT a materialized
 * edge (`CallerEdge`), so no edgeKind/confidence provenance applies.
 */
export interface AmbiguousCallerSite {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
  /** Size of the suppressed candidate set the target plausibly belongs to. */
  candidateCount: number;
}

export interface CalleeEdge {
  targetSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  callExpression: string;
  /** Edge kind from `cg_symbols_edges_method.edge_kind` (xlnub Task 5). */
  edgeKind?: MethodEdgeKind;
  /** Dispatch confidence in (0,1] from `cg_symbols_edges_method.confidence` (xlnub Task 5). */
  confidence?: number;
}

/** Minimal chunk preview returned by graph MCP tools (`get_callers`,
 *  `get_callees`) alongside each edge so callers can display the source
 *  line of the call site without a follow-up `find_symbol` round-trip. */
export interface GraphChunkPreview {
  symbolId: SymbolId;
  relPath: RelPath;
  startLine: number;
  endLine: number;
  preview: string;
}
