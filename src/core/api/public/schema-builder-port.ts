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

/** Zod shape of the `{ custom: weights }` arm of a rerank param: an open `{<signal>: number}` map. */
export type ScoringWeightsSchema = z.ZodRecord<z.ZodString, z.ZodNumber>;

/** Zod union of a rerank param: preset name | `{ custom: weights }`. */
export type RerankSchema = z.ZodUnion<[z.ZodTypeAny, z.ZodObject<{ custom: ScoringWeightsSchema }>]>;

export interface SchemaBuilderPort {
  /** Open `{<signal>: number}` weight map; keys checked against `customWeightSignals`. */
  buildScoringWeightsSchema: () => ScoringWeightsSchema;
  /** Derived-signal names a custom rerank weight may key. */
  customWeightSignals: () => string[];
  /** Preset names a tool accepts, as a literal or enum schema. */
  buildPresetSchema: (tool: string) => z.ZodTypeAny;
  /** The full rerank param: preset enum | `{ custom: weights }`. */
  buildRerankSchema: (tool: string) => RerankSchema;
  /** Typed filter param names the registered trajectories apply. */
  filterParamNames: () => string[];
  /** The `filter` param: raw Qdrant filter | `{ presets }` reference. */
  buildFilterSchema: () => z.ZodTypeAny;
}
