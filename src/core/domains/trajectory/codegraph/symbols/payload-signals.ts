/**
 * Codegraph symbols payload signal descriptors.
 *
 * File-level signals are computed by `CodegraphEnrichmentProvider.
 * buildFileSignals` from `cg_symbols_edges_file`; chunk-level signals
 * are computed by `buildChunkSignals` from `cg_symbols_edges_method`.
 * Slice 1 ships Tier 1 only (no `transitiveImpact` / `pageRank` /
 * `betweenness` — those land in Slice 2).
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
];
