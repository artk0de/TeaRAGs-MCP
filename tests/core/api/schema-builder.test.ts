/**
 * SchemaBuilder tests — MCP schema generation via DIP
 *
 * SchemaBuilder generates dynamic Zod schemas from Reranker's public API,
 * eliminating hardcoded descriptor/preset imports in MCP layer.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SchemaBuilder } from "../../../src/core/api/internal/infra/schema-builder.js";
import type { Reranker } from "../../../src/core/explore/reranker.js";

/**
 * Minimal mock implementing only the Reranker methods SchemaBuilder depends on:
 * - getDescriptorInfo(): { name, description }[]
 * - getPresetNames(tool): string[]
 */
function createMockReranker(overrides?: {
  descriptors?: { name: string; description: string }[];
  presets?: Record<string, string[]>;
}): Pick<Reranker, "getDescriptorInfo" | "getPresetNames"> {
  const descriptors = overrides?.descriptors ?? [
    { name: "recency", description: "Inverse of age" },
    { name: "similarity", description: "Semantic similarity score" },
    { name: "churn", description: "Commit frequency" },
  ];
  const presets = overrides?.presets ?? {
    semantic_search: ["relevance", "techDebt", "hotspots"],
    search_code: ["relevance", "recent", "stable"],
  };

  return {
    getDescriptorInfo: () => descriptors,
    getPresetNames: (tool: string) => presets[tool] ?? [],
  };
}

describe("SchemaBuilder", () => {
  describe("buildScoringWeightsSchema", () => {
    it("produces a Zod object with all descriptor names as optional number keys", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildScoringWeightsSchema();

      // Should be a ZodObject
      expect(schema).toBeInstanceOf(z.ZodObject);

      const { shape } = schema;
      expect(shape).toHaveProperty("recency");
      expect(shape).toHaveProperty("similarity");
      expect(shape).toHaveProperty("churn");

      // Each field should accept a number
      const parsed = schema.parse({ recency: 0.5, similarity: 0.3 });
      expect(parsed).toEqual({ recency: 0.5, similarity: 0.3 });
    });

    it("fields are optional (empty object is valid)", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildScoringWeightsSchema();
      const parsed = schema.parse({});
      expect(parsed).toEqual({});
    });

    it("rejects non-numeric values", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildScoringWeightsSchema();
      expect(() => schema.parse({ recency: "high" })).toThrow();
    });

    it("includes description from descriptor", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildScoringWeightsSchema();
      // Access the inner ZodOptional -> ZodNumber to check description
      const recencyField = schema.shape.recency;
      expect(recencyField.description).toBe("Inverse of age");
    });

    it("handles empty descriptor list", () => {
      const builder = new SchemaBuilder(createMockReranker({ descriptors: [] }) as unknown as Reranker);
      const schema = builder.buildScoringWeightsSchema();
      const parsed = schema.parse({});
      expect(parsed).toEqual({});
    });
  });

  describe("buildPresetSchema", () => {
    it("returns ZodEnum for semantic_search presets", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildPresetSchema("semantic_search");

      expect(schema).toBeInstanceOf(z.ZodEnum);
      expect(schema.options).toEqual(["relevance", "techDebt", "hotspots"]);
    });

    it("returns ZodEnum for search_code presets", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildPresetSchema("search_code");

      expect(schema).toBeInstanceOf(z.ZodEnum);
      expect(schema.options).toEqual(["relevance", "recent", "stable"]);
    });

    it("validates preset values", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildPresetSchema("semantic_search");

      expect(schema.parse("relevance")).toBe("relevance");
      expect(schema.parse("techDebt")).toBe("techDebt");
      expect(() => schema.parse("nonexistent")).toThrow();
    });

    it("throws when tool has no presets", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      // z.enum requires at least one element
      expect(() => builder.buildPresetSchema("unknown_tool")).toThrow();
    });
  });

  describe("buildRerankSchema", () => {
    it("produces union of preset enum + custom object for semantic_search", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildRerankSchema("semantic_search");

      // Should accept preset strings
      expect(schema.parse("relevance")).toBe("relevance");
      expect(schema.parse("techDebt")).toBe("techDebt");

      // Should accept custom object
      const customResult = schema.parse({ custom: { recency: 0.7, similarity: 0.3 } });
      expect(customResult).toEqual({ custom: { recency: 0.7, similarity: 0.3 } });
    });

    it("produces union of preset enum + custom object for search_code", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildRerankSchema("search_code");

      expect(schema.parse("recent")).toBe("recent");
      expect(schema.parse("stable")).toBe("stable");
      expect(schema.parse({ custom: { churn: 0.5 } })).toEqual({ custom: { churn: 0.5 } });
    });

    it("rejects invalid preset names in union", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildRerankSchema("semantic_search");

      // "recent" is not a semantic_search preset — should fail
      expect(() => schema.parse("recent")).toThrow();
    });
  });
});
