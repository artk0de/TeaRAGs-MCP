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
import { PROJECT_NAME_RE } from "../../../domains/maintenance/registry/constants.js";
import { ConfigValueInvalidError } from "../../../infra/errors.js";

/**
 * Zod schema for an optional project name. Sourced from PROJECT_NAME_RE
 * (`src/core/domains/maintenance/registry/constants.ts`) — the single source of truth.
 */
const projectNameSchema = z
  .string()
  .regex(PROJECT_NAME_RE, `Project name must match ${PROJECT_NAME_RE.source}`)
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

  /**
   * Typed filter param names the registered trajectories apply. The MCP layer
   * exposes a typed filter field only when its name is here — a field without a
   * FilterDescriptor would be accepted and silently ignored (bd tea-rags-mcp-86wsz).
   */
  filterParamNames(): string[] {
    return this.reranker.filterParamNames();
  }

  /**
   * Build the `filter` param union schema: a raw Qdrant filter object OR a
   * `{ presets }` named-filter-preset reference.
   *
   * The raw arm (`z.record(z.string(), z.any())`) is intentionally permissive —
   * it matches the legacy `filter` param shape, so existing callers passing raw
   * Qdrant filters still validate (backward compatible). The `{ presets }` arm
   * requires `presets` to be a string; resolution priority and the CSV split
   * happen at search-stage filter compilation, not here.
   *
   * Available filter-preset names are appended to the description for discovery,
   * pulled from `Reranker.filterPresetNames()` (a passthrough wired from the
   * TrajectoryRegistry at composition time). Mirrors how rerank preset names are
   * surfaced via the schema enum rather than a dynamic MCP resource.
   */
  buildFilterSchema(): z.ZodTypeAny {
    const rawFilterSchema = z.record(z.string(), z.any());
    const presetsSchema = z.object({ presets: z.string() });

    // Inline hint only; the default-resolution rules (auto-skip, notice) live
    // in tea-rags://schema/overview (bd tea-rags-mcp-ewg2s).
    const names = this.reranker.filterPresetNames();
    let description =
      'Raw Qdrant filter (must/should/must_not) or { presets: "a,b" }. ' +
      "Omitted → preset default filter; {} clears. tea-rags://schema/overview.";
    if (names.length > 0) {
      description += ` Presets: ${names.join(", ")}.`;
    }

    return z.union([rawFilterSchema, presetsSchema]).describe(description);
  }
}
