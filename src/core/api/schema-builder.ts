/**
 * SchemaBuilder — dynamic MCP schema generation via Reranker API (DIP).
 *
 * MCP layer imports SchemaBuilder from api/, never touches domain/foundation directly.
 * All signal descriptors and preset names come from Reranker.getDescriptorInfo()
 * and Reranker.getPresetNames(), which aggregate data from registered trajectories.
 */

import { z } from "zod";

import type { Reranker } from "../search/reranker.js";

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
   * Build Zod enum schema for preset names by tool.
   * Throws if the tool has no registered presets (z.enum requires >= 1 element).
   */
  buildPresetSchema(tool: string): z.ZodEnum<[string, ...string[]]> {
    const names = this.reranker.getPresetNames(tool);
    if (names.length === 0) {
      throw new Error(`No presets registered for tool "${tool}"`);
    }
    return z.enum(names as [string, ...string[]]);
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
