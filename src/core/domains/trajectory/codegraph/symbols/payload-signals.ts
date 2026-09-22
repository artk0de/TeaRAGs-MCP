/**
 * Codegraph symbols payload signal descriptors.
 *
 * File-level signals are computed by `CodegraphEnrichmentProvider.
 * buildFileSignals` from `cg_symbols_edges_file`; chunk-level signals
 * are computed by `buildChunkSignals` from `cg_symbols_edges_method`.
 * Slice 1 shipped Tier 1 only; Slice 2 added `transitiveImpact` and
 * `pageRank`. Betweenness centrality was a Slice 2 candidate but cut
 * 2026-05-21 — see Slice 2 plan Task B4 for rationale.
 *
 * Every numeric descriptor declares `stats.labels` so collection-stats
 * computes percentiles at index time and both `get_index_metrics` and
 * the reranker's overlay label resolver can attach human-readable
 * tiers. Without labels here, IndexMetricsQuery silently skips the
 * signal (line 57 early-continue) and rankingOverlay shows raw numbers
 * with no interpretation. bd tea-rags-mcp-btl8.
 *
 * Chunk-level percentiles use `chunkTypeFilter: "function"` because
 * fanIn/fanOut/pageRank are only statistically meaningful on function
 * chunks — block/doc/class chunks would skew the distribution.
 */

import type { ChunkGraphSignals, FileGraphMetrics } from "../../../../contracts/types/codegraph.js";
import type { ChunkSignalOverlay, FileSignalOverlay } from "../../../../contracts/types/provider.js";
import type { PayloadSignalDescriptor } from "../../../../contracts/types/trajectory.js";

export const CODEGRAPH_SYMBOLS_FILE_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "codegraph.file.fanIn",
    type: "number",
    description: "Number of files importing this file",
    stats: { labels: { p25: "isolated", p50: "typical", p75: "popular", p95: "hub" }, dedupeByFile: true },
  },
  {
    key: "codegraph.file.fanOut",
    type: "number",
    description: "Number of files this file imports",
    stats: { labels: { p25: "minimal", p50: "typical", p75: "heavy", p95: "exhaustive" }, dedupeByFile: true },
  },
  {
    // Ratio fanOut / (fanIn + fanOut). At connectionCount=1 it swings
    // 0↔1 from a single edge — classic ratio-with-small-denominator
    // problem per `.claude/rules/signal-confidence.md`. Confidence block
    // declares `connectionCount` as support; score path dampens
    // contribution to ranking and label path clamps the overlay tier.
    key: "codegraph.file.instability",
    type: "number",
    description: "Martin instability = fanOut / (fanIn + fanOut), in [0,1]",
    stats: {
      labels: { p50: "stable", p75: "mixed", p95: "unstable" },
      // Filter preset references p90 of instability; labels declare p50/p75/p95,
      // so declare p90 here for index-time computation.
      percentilesToCompute: [90],
      dedupeByFile: true,
      confidence: {
        support: "connectionCount",
        score: { threshold: 5, adaptivePercentile: 25 },
        label: {
          rules: [
            { whenSupportAtOrBelow: "p10", fallback: 2, ceiling: "stable" },
            { whenSupportAtOrBelow: "p25", fallback: 5, ceiling: "mixed" },
          ],
        },
      },
    },
  },
  {
    // Support signal for `instability.confidence`. Derived inline in
    // `buildFileSignals` as `fanIn + fanOut` — no extra DB call. p10 is
    // declared in percentilesToCompute because the instability clamp
    // references "p10" but the labels map doesn't include it.
    key: "codegraph.file.connectionCount",
    type: "number",
    description: "Total file-graph edges = fanIn + fanOut (support signal for instability confidence)",
    stats: {
      labels: { p25: "sparse", p50: "typical", p75: "busy", p95: "highly-connected" },
      percentilesToCompute: [10],
      dedupeByFile: true,
    },
  },
  {
    key: "codegraph.file.isHub",
    type: "boolean",
    description: "True when fanIn exceeds the collection p95 (computed at rerank time)",
  },
  {
    key: "codegraph.file.isLeaf",
    type: "boolean",
    description: "True when fanOut == 0 and fanIn > 0",
  },
  {
    // Slice 2 / B1 — transitive blast radius. Distinct file count
    // reachable via reverse-BFS over the import graph from this file,
    // bounded by getTransitiveImpact's default depth (5). Captures
    // multi-hop dependencies — a utility imported by 3 files that are
    // each imported by 20 has transitiveImpact ≈ 60+, far higher than
    // its direct fanIn of 3.
    key: "codegraph.file.transitiveImpact",
    type: "number",
    description: "Distinct files transitively importing this file (reverse BFS, depth-capped)",
    stats: { labels: { p50: "local", p75: "regional", p95: "systemic" }, dedupeByFile: true },
  },
];

export const CODEGRAPH_SYMBOLS_CHUNK_SIGNALS: PayloadSignalDescriptor[] = [
  {
    // Method-level fan-in: incoming edges in the call graph. Named to
    // match knowledge-base methodology (Henry & Kafura: fan-in/fan-out
    // apply at method, class, and namespace levels).
    // Confidence-weighted (bd tea-rags-mcp-s5ato): each edge contributes its
    // dispatch confidence, not 1 — an m-way dynamic/cone fan-out at 1/m adds
    // ~1 in total, so fan-out targets no longer inflate into fake hubs. May
    // be FRACTIONAL (e.g. 1.25); exact edges keep integer counts.
    key: "codegraph.chunk.fanIn",
    type: "number",
    description:
      "Confidence-weighted sum of call sites invoking this symbol (exact edge = 1, dynamic fan-out edge = its dispatch confidence)",
    stats: {
      labels: { p25: "unused", p50: "typical", p75: "frequent", p95: "central" },
      chunkTypeFilter: "function",
    },
  },
  {
    // Confidence-weighted like chunk.fanIn: a whole m-way fan-out counts as
    // ONE outgoing call (m edges × 1/m), not m. May be fractional.
    key: "codegraph.chunk.fanOut",
    type: "number",
    description: "Confidence-weighted sum of outgoing calls from this symbol (a dynamic fan-out counts as one call)",
    stats: {
      labels: { p25: "leaf", p50: "typical", p75: "orchestrator", p95: "god-method" },
      chunkTypeFilter: "function",
    },
  },
  {
    // Slice 2 / B3 — PageRank over the method call graph. Captures
    // "central symbol everyone transitively calls" — a utility called
    // by many high-rank methods inherits weight even when its direct
    // fanIn is modest. damping = 0.85, eps = 1e-6, max 50 iters.
    key: "codegraph.chunk.pageRank",
    type: "number",
    description: "PageRank score over the method call graph (damping 0.85, normalized to [0,1])",
    stats: {
      labels: { p50: "peripheral", p75: "important", p95: "critical" },
      chunkTypeFilter: "function",
      // Normalized [0,1] over thousands of nodes → meaningful percentiles sit at
      // 1e-4..1e-1 and round to "≤0" on the raw scale. Render as percentages so
      // prime thresholds stay legible (p50≈0.03% / p75≈0.04% / p95≈0.12%).
      format: "percent",
    },
  },
];

/**
 * Turn one file's raw graph metrics into the payload written under
 * `codegraph.symbols.file` — bare inner keys, the level prefix comes from the
 * applier's `op.key`.
 *
 * `fanInP95` is the collection-wide p95 over the FULL file universe, not the
 * batch: read it once per pass (`getFanInP95`) and hand the same value to every
 * file, or an incremental subset misclassifies its own biggest file as a hub.
 *
 * This lives here, next to the descriptors it fills in, because it has TWO
 * callers that must agree byte for byte: `CodegraphEnrichmentProvider`'s
 * finalize read-back, and `CodegraphPayloadHealer`, which rewrites the same
 * keys for files the run's chunk map never touched (bd tea-rags-mcp-a2ddb).
 * A second copy of this arithmetic would let the two drift with nothing failing.
 */
export function buildCodegraphFileSignals(metrics: FileGraphMetrics, fanInP95: number): FileSignalOverlay {
  const { fanIn, fanOut, transitiveImpact } = metrics;
  const { instability, connectionCount } = computeMartinInstability(fanIn, fanOut);
  return {
    fanIn,
    fanOut,
    instability,
    connectionCount,
    isHub: fanIn > fanInP95,
    isLeaf: fanOut === 0 && fanIn > 0,
    transitiveImpact,
  };
}

/** `codegraph.file.instability` and its confidence support, `connectionCount`. */
export interface MartinInstability {
  instability: number;
  connectionCount: number;
}

/**
 * Martin instability I = fanOut / (fanIn + fanOut) and its support. The ONE
 * copy of this arithmetic: {@link buildCodegraphFileSignals} writes it to the
 * payload, and the boundary diagnostics judge dependency edges by it
 * (`boundary-diagnostics/file-instability.ts`) — a detector computing its own
 * variant would flag edges by a number no payload carries.
 */
export function computeMartinInstability(fanIn: number, fanOut: number): MartinInstability {
  const connectionCount = fanIn + fanOut;
  // The zero-edge case is pinned to 0 rather than NaN — a NaN here reaches
  // Qdrant and every range filter over it stops matching.
  return { instability: connectionCount === 0 ? 0 : fanOut / connectionCount, connectionCount };
}

/**
 * Turn one symbol's graph signals into the payload written under
 * `codegraph.symbols.chunk`. A symbol the graph knows nothing about reads as
 * all-zero — identical to what the per-symbol point getters return on no rows,
 * so a chunk whose symbol was never resolved is not distinguishable from one
 * with genuinely no calls. Same two callers, same reason, as
 * {@link buildCodegraphFileSignals}.
 */
export function buildCodegraphChunkSignals(signals: ChunkGraphSignals | undefined): ChunkSignalOverlay {
  return {
    fanIn: signals?.fanIn ?? 0,
    fanOut: signals?.fanOut ?? 0,
    pageRank: signals?.pageRank ?? 0,
  };
}
