/**
 * Codegraph symbols payload signal descriptors.
 *
 * File-level signals are computed by `CodegraphEnrichmentProvider.
 * buildFileSignals` from `cg_symbols_edges_file`; chunk-level signals
 * are computed by `buildChunkSignals` from `cg_symbols_edges_method`.
 * Slice 1 ships Tier 1 only; Slice 2 adds `transitiveImpact` and
 * `pageRank`. Betweenness centrality was a Slice 2 candidate but cut
 * 2026-05-21 — see Slice 2 plan Task B4 for rationale.
 */

import type { PayloadSignalDescriptor } from "../../../../contracts/types/trajectory.js";

export const CODEGRAPH_SYMBOLS_FILE_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "codegraph.file.fanIn",
    type: "number",
    description: "Number of files importing this file",
  },
  {
    key: "codegraph.file.fanOut",
    type: "number",
    description: "Number of files this file imports",
  },
  {
    key: "codegraph.file.instability",
    type: "number",
    description: "Martin instability = fanOut / (fanIn + fanOut), in [0,1]",
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
  },
  {
    key: "codegraph.chunk.fanOut",
    type: "number",
    description: "Number of outgoing calls from this symbol",
  },
  {
    // Slice 2 / B3 — PageRank over the method call graph. Captures
    // "central symbol everyone transitively calls" — a utility called
    // by many high-rank methods inherits weight even when its direct
    // fanIn is modest. damping = 0.85, eps = 1e-6, max 50 iters.
    key: "codegraph.chunk.pageRank",
    type: "number",
    description: "PageRank score over the method call graph (damping 0.85, normalized to [0,1])",
  },
];
