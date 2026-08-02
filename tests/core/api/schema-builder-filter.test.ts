/**
 * SchemaBuilder.buildFilterSchema tests — MCP `filter` param union + discovery.
 *
 * The `filter` param accepts EITHER a raw Qdrant filter object OR a
 * `{ presets: string }` named-filter-preset reference. The available
 * filter-preset names are surfaced in the param description for discovery.
 *
 * SchemaBuilder reads the names via Reranker.filterPresetNames() (a passthrough
 * wired from TrajectoryRegistry.filterPresetNames() at composition time).
 */

import { describe, expect, it } from "vitest";

import { SchemaBuilder } from "../../../src/core/api/internal/infra/schema-builder.js";
import type { Reranker } from "../../../src/core/domains/explore/reranker.js";

/**
 * Minimal mock implementing only the Reranker method buildFilterSchema needs.
 */
function createMockReranker(
  filterPresetNames: string[] = ["production", "coreLogic"],
): Pick<Reranker, "filterPresetNames"> {
  return {
    filterPresetNames: () => filterPresetNames,
  };
}

describe("SchemaBuilder.buildFilterSchema", () => {
  it("accepts a raw Qdrant filter object", () => {
    const builder = new SchemaBuilder(createMockReranker() as Reranker);
    const schema = builder.buildFilterSchema();

    const parsed = schema.safeParse({ must: [{ key: "x", match: { value: 1 } }] });
    expect(parsed.success).toBe(true);
  });

  it("accepts the { presets } arm", () => {
    const builder = new SchemaBuilder(createMockReranker() as Reranker);
    const schema = builder.buildFilterSchema();

    const parsed = schema.safeParse({ presets: "production" });
    expect(parsed.success).toBe(true);
  });

  it("recognizes a numeric presets value via the raw-filter arm (raw arm is permissive)", () => {
    // The union's raw arm is z.record(z.string(), z.any()), so { presets: 123 }
    // still validates against the raw arm — the union as a whole does NOT reject
    // it. This documents the permissiveness: the {presets} arm requires a string,
    // but the raw arm swallows anything object-shaped. Runtime resolution treats a
    // non-string `presets` as a raw filter key, not a preset reference.
    const builder = new SchemaBuilder(createMockReranker() as Reranker);
    const schema = builder.buildFilterSchema();

    const parsed = schema.safeParse({ presets: 123 });
    expect(parsed.success).toBe(true);
  });

  it("describes the available filter-preset names for discovery", () => {
    const builder = new SchemaBuilder(createMockReranker(["production", "coreLogic"]) as Reranker);
    const schema = builder.buildFilterSchema();

    expect(schema.description).toContain("production");
    expect(schema.description).toContain("coreLogic");
  });

  it("omits the named-presets hint when no filter presets are registered", () => {
    const builder = new SchemaBuilder(createMockReranker([]) as Reranker);
    const schema = builder.buildFilterSchema();

    // Still a valid union; description falls back to the raw-filter guidance.
    expect(schema.description).toContain("must/should/must_not");
    const parsed = schema.safeParse({ must: [{ key: "x", match: { value: 1 } }] });
    expect(parsed.success).toBe(true);
  });
});
