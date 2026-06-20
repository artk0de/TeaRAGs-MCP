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

import type { PayloadSignalDescriptor } from "../../../../contracts/types/trajectory.js";

export const CODEGRAPH_SYMBOLS_FILE_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "codegraph.file.fanIn",
    type: "number",
    description: "Number of files importing this file",
    stats: { labels: { p25: "isolated", p50: "typical", p75: "popular", p95: "hub" } },
  },
  {
    key: "codegraph.file.fanOut",
    type: "number",
    description: "Number of files this file imports",
    stats: { labels: { p25: "minimal", p50: "typical", p75: "heavy", p95: "exhaustive" } },
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
      confidence: {
        support: "connectionCount",
        score: { threshold: 5, adaptivePercentile: 25 },
        label: {
          rules: [
            { whenSupportBelow: "p10", fallback: 2, ceiling: "stable" },
            { whenSupportBelow: "p25", fallback: 5, ceiling: "mixed" },
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
    stats: { labels: { p50: "local", p75: "regional", p95: "systemic" } },
  },
];

export const CODEGRAPH_SYMBOLS_CHUNK_SIGNALS: PayloadSignalDescriptor[] = [
  {
    // Method-level fan-in: incoming edges in the call graph. Named to
    // match knowledge-base methodology (Henry & Kafura: fan-in/fan-out
    // apply at method, class, and namespace levels).
    key: "codegraph.chunk.fanIn",
    type: "number",
    description: "Number of distinct call sites invoking this symbol",
    stats: {
      labels: { p25: "unused", p50: "typical", p75: "frequent", p95: "central" },
      chunkTypeFilter: "function",
    },
  },
  {
    key: "codegraph.chunk.fanOut",
    type: "number",
    description: "Number of outgoing calls from this symbol",
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
