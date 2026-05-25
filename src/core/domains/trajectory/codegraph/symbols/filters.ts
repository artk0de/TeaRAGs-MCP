/**
 * Codegraph filter descriptors — typed filter params backed by the codegraph
 * payload signals (Slice 1 + Slice 2 + connectionCount/instability confidence).
 *
 * Why the nested Qdrant keys (`codegraph.symbols.${level}.X`):
 * `EnrichmentApplier` writes codegraph signals via `batchSetPayload` with
 * `key: "codegraph.symbols.${level}"` (see
 * `src/core/domains/ingest/pipeline/enrichment/applier.ts:122-124`). Qdrant
 * interprets dotted keys as nested-path navigation, so on disk the payload
 * lives under `codegraph -> symbols -> ${level}`. The inner property names are
 * BARE (`fanIn`, `instability`, …) — buildFileSignals/buildChunkSignals write
 * them without a `codegraph.${level}.` prefix (tea-rags-mcp-k6xu), mirroring
 * git's `git.file.commitCount` bare-key shape. The full addressable Qdrant path
 * is therefore `codegraph.symbols.${level}.${suffix}` — a single prefix — which
 * Qdrant filters can resolve. (The pre-k6xu duplicated prefix produced a
 * literal dotted leaf that no filter path could reach: every codegraph filter
 * returned 0.)
 *
 * Users of typed filters never see the path: they pass `minFanIn: 3` and the
 * descriptor below translates to the right Qdrant key per-level.
 * Documented in `tea-rags://schema/filters`. bd tea-rags-mcp-tr5k + k6xu.
 */

import type { FilterDescriptor, FilterLevel } from "../../../../contracts/types/provider.js";

/** Build the nested Qdrant key for a level-aware codegraph payload signal. */
function levelKey(level: FilterLevel, suffix: string): string {
  return `codegraph.symbols.${level}.${suffix}`;
}

/** Build the nested Qdrant key for a file-only codegraph payload signal. */
function fileKey(suffix: string): string {
  return `codegraph.symbols.file.${suffix}`;
}

/** Build the nested Qdrant key for a chunk-only codegraph payload signal. */
function chunkKey(suffix: string): string {
  return `codegraph.symbols.chunk.${suffix}`;
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
