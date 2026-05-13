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

import { ConfigValueInvalidError } from "../../../../bootstrap/errors.js";
import type { Reranker } from "../../../domains/explore/reranker.js";

/**
 * Zod schema for an optional project name. Mirrors the regex used by
 * CollectionRegistry (`src/core/infra/registry/collection-registry.ts`).
 */
const projectNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Project name must match ^[a-z0-9][a-z0-9_-]{0,63}$")
  .optional();

/**
 * Shared collection identifier schema: a DTO addressing a single collection
 * by either `collection` name, `project` alias, or `path`.
 * Resolution priority (in the resolver layer, not enforced here): collection > project > path.
 */
const collectionIdentifierSchema = z.object({
  collection: z.string().optional(),
  project: projectNameSchema,
  path: z.string().optional(),
});

export class SchemaBuilder {
  constructor(private readonly reranker: Reranker) {}

  /**
   * Static — does not depend on instance state.
   * Returns the shared Zod object schema for the CollectionIdentifier DTO mixin
   * (`src/core/api/public/dto/common.ts`).
   */
  static collectionIdentifier(): typeof collectionIdentifierSchema {
    return collectionIdentifierSchema;
  }

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
      throw new ConfigValueInvalidError("presets", "none", `at least one preset for tool "${tool}"`);
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
