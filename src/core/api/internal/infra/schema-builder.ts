/**
 * SchemaBuilder — dynamic MCP schema generation via Reranker API (DIP).
 *
 * MCP layer imports SchemaBuilder from api/, never touches domain/foundation directly.
 * All signal descriptors and preset names come from Reranker.getDescriptorInfo()
 * and Reranker.getPresetNames(), which aggregate data from registered trajectories.
 */

import { z } from "zod";

import type { Reranker } from "../../../domains/explore/reranker.js";

export class SchemaBuilder {
  constructor(private readonly reranker: Reranker) {}

  /**
   * Build Zod schema for custom scoring weights.
   * Each derived signal becomes an optional numeric field with its description.
   */
  buildScoringWeightsSchema(): z.ZodObject<Record<string, z.ZodOptional<z.ZodNumber>>> {
    const shape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
    for (const d of this.reranker.getDescriptorInfo()) {
      shape[d.name] = z.number().optional().describe(d.description);
    }
    return z.object(shape);
  }

  /**
   * Build Zod schema for preset names by tool.
   * Uses z.union(z.literal().describe()) so each preset value carries its
   * description in the MCP JSON Schema.
   */
  buildPresetSchema(tool: string): z.ZodTypeAny {
    const presets = this.reranker.getPresetDescriptions(tool);
    if (presets.length === 0) {
      throw new Error(`No presets registered for tool "${tool}"`);
    }
    if (presets.length === 1) {
      return z.literal(presets[0].name).describe(presets[0].description);
    }
    const [first, second, ...rest] = presets.map((p) => z.literal(p.name).describe(p.description));
    return z.union([first, second, ...rest]);
  }

  /**
   * Build the full rerank union schema: preset enum | { custom: weights }.
   * Used directly in SemanticSearchSchema, HybridSearchSchema, SearchCodeSchema.
   */
  buildRerankSchema(tool: string) {
    const presetSchema = this.buildPresetSchema(tool);
    const weightsSchema = this.buildScoringWeightsSchema();
    return z.union([presetSchema, z.object({ custom: weightsSchema })]);
  }
}
