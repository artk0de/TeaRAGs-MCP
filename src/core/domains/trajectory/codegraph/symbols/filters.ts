/**
 * Codegraph filter descriptors — typed filter params backed by the codegraph
 * payload signals (Slice 1 + Slice 2 + connectionCount/instability confidence).
 *
 * Why the long Qdrant keys (`codegraph.symbols.${level}.codegraph.${level}.X`):
 * `EnrichmentApplier` writes codegraph signals via `batchSetPayload` with
 * `key: "codegraph.symbols.${level}"` (see
 * `src/core/domains/ingest/pipeline/enrichment/applier.ts:122-124`). Qdrant
 * interprets dotted keys as nested-path navigation, so on disk the payload
 * lives under `codegraph -> symbols -> ${level}`. The inner property names keep
 * their literal dotted form (`codegraph.${level}.fanIn`, …) — they were chosen
 * up-front to disambiguate file-scope vs chunk-scope siblings in the same
 * descriptor space, and that prefix survives the write. The full addressable
 * Qdrant path is therefore the outer nesting path concatenated with the inner
 * dotted key, which is the value passed as `key:` on each `toCondition`
 * result here.
 *
 * Users of typed filters never see the long form: they pass `minFanIn: 3`
 * and the descriptor below translates to the right Qdrant key per-level.
 * Documented in `tea-rags://schema/filters`. bd tea-rags-mcp-tr5k.
 */

import type { FilterDescriptor, FilterLevel } from "../../../../contracts/types/provider.js";

/** Build the nested Qdrant key for a level-aware codegraph payload signal. */
function levelKey(level: FilterLevel, suffix: string): string {
  return `codegraph.symbols.${level}.codegraph.${level}.${suffix}`;
}

/** Build the nested Qdrant key for a file-only codegraph payload signal. */
function fileKey(suffix: string): string {
  return `codegraph.symbols.file.codegraph.file.${suffix}`;
}

/** Build the nested Qdrant key for a chunk-only codegraph payload signal. */
function chunkKey(suffix: string): string {
  return `codegraph.symbols.chunk.codegraph.chunk.${suffix}`;
}

export const codegraphFilters: FilterDescriptor[] = [
  {
    param: "minFanIn",
    description:
      "Minimum fan-in (incoming references). Level-aware: file = files importing this file, chunk = call sites invoking this symbol. Default level: file.",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "file") => ({
      must: [{ key: levelKey(level, "fanIn"), range: { gte: value as number } }],
    }),
  },
  {
    param: "minFanOut",
    description:
      "Minimum fan-out (outgoing references). Level-aware: file = files this file imports, chunk = outgoing calls from this symbol. Default level: file.",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "file") => ({
      must: [{ key: levelKey(level, "fanOut"), range: { gte: value as number } }],
    }),
  },
  {
    param: "minPageRank",
    description: "Minimum chunk-level PageRank score over the method call graph (normalized to [0,1]).",
    type: "number",
    toCondition: (value: unknown) => ({
      must: [{ key: chunkKey("pageRank"), range: { gte: value as number } }],
    }),
  },
  {
    param: "minInstability",
    description: "Minimum Martin instability = fanOut / (fanIn + fanOut), in [0,1]. File-level only.",
    type: "number",
    toCondition: (value: unknown) => ({
      must: [{ key: fileKey("instability"), range: { gte: value as number } }],
    }),
  },
  {
    param: "minTransitiveImpact",
    description:
      "Minimum distinct files transitively importing this file (reverse BFS, depth-capped). File-level only.",
    type: "number",
    toCondition: (value: unknown) => ({
      must: [{ key: fileKey("transitiveImpact"), range: { gte: value as number } }],
    }),
  },
  {
    param: "minConnectionCount",
    description:
      "Minimum total file-graph edges (fanIn + fanOut). Useful for excluding low-confidence instability values. File-level only.",
    type: "number",
    toCondition: (value: unknown) => ({
      must: [{ key: fileKey("connectionCount"), range: { gte: value as number } }],
    }),
  },
  {
    param: "isHub",
    description: "Filter to files flagged as architectural hubs (fanIn above the collection p95). File-level only.",
    type: "boolean",
    toCondition: (value: unknown) => ({
      must: [{ key: fileKey("isHub"), match: { value: value as boolean } }],
    }),
  },
  {
    param: "isLeaf",
    description: "Filter to files flagged as leaves (fanOut == 0 and fanIn > 0). File-level only.",
    type: "boolean",
    toCondition: (value: unknown) => ({
      must: [{ key: fileKey("isLeaf"), match: { value: value as boolean } }],
    }),
  },
];
