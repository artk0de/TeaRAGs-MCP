/**
 * SchemaBuilder — dynamic MCP schema generation via Reranker API (DIP).
 *
 * MCP layer imports SchemaBuilder from api/, never touches domain/foundation directly.
 * All signal descriptors and preset names come from Reranker.getDescriptorInfo()
 * and Reranker.getPresetNames(), which aggregate data from registered trajectories.
 *
 * Descriptions are intentionally omitted from the generated schemas — detailed
 * documentation lives in MCP resources (tea-rags://schema/*).
 */

import { z } from "zod";

import type { Reranker } from "../../../domains/explore/reranker.js";

export class SchemaBuilder {
  constructor(private readonly reranker: Reranker) {}

  /**
   * Build Zod schema for custom scoring weights.
   * Each derived signal becomes an optional numeric field (no descriptions).
   */
  buildScoringWeightsSchema(): z.ZodObject<Record<string, z.ZodOptional<z.ZodNumber>>> {
    const shape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
    for (const d of this.reranker.getDescriptorInfo()) {
      shape[d.name] = z.number().optional();
    }
    return z.object(shape);
  }

  /**
   * Build Zod schema for preset names by tool.
   * Uses z.enum for compact JSON Schema output (no per-value descriptions).
   */
  buildPresetSchema(tool: string): z.ZodTypeAny {
    const names = this.reranker.getPresetNames(tool);
    if (names.length === 0) {
      throw new Error(`No presets registered for tool "${tool}"`);
    }
    if (names.length === 1) {
      return z.literal(names[0]);
    }
    const [first, second, ...rest] = names;
    return z.enum([first, second, ...rest]);
  }

  /**
   * Build the full rerank union schema: preset enum | { custom: weights }.
   */
  buildRerankSchema(tool: string) {
    const presetSchema = this.buildPresetSchema(tool);
    const weightsSchema = this.buildScoringWeightsSchema();
    return z.union([presetSchema, z.object({ custom: weightsSchema })]);
  }
}
