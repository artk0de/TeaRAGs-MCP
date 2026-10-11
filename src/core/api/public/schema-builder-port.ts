/**
 * The contract the MCP layer registers tool schemas against (bd
 * tea-rags-mcp-k7kmu C2). The implementation, `SchemaBuilder`, lives in
 * `api/internal/infra/schema-builder.ts` and derives every schema from the
 * Reranker's registered trajectories; the composition root hands it to mcp
 * typed as this port, so mcp never names the internal class.
 *
 * The member set is exactly what mcp calls. `SchemaBuilder.collectionIdentifier`
 * is a static on the class and therefore not part of an instance contract.
 */
import type { z } from "zod";

/** Zod shape of the `{ custom: weights }` arm of a rerank param. */
export type ScoringWeightsSchema = z.ZodObject<Record<string, z.ZodOptional<z.ZodNumber>>>;

/** Zod union of a rerank param: preset name | `{ custom: weights }`. */
export type RerankSchema = z.ZodUnion<[z.ZodTypeAny, z.ZodObject<{ custom: ScoringWeightsSchema }>]>;

export interface SchemaBuilderPort {
  /** Each derived signal as an optional numeric weight. */
  buildScoringWeightsSchema: () => ScoringWeightsSchema;
  /** Preset names a tool accepts, as a literal or enum schema. */
  buildPresetSchema: (tool: string) => z.ZodTypeAny;
  /** The full rerank param: preset enum | `{ custom: weights }`. */
  buildRerankSchema: (tool: string) => RerankSchema;
  /** Typed filter param names the registered trajectories apply. */
  filterParamNames: () => string[];
  /** The `filter` param: raw Qdrant filter | `{ presets }` reference. */
  buildFilterSchema: () => z.ZodTypeAny;
}
