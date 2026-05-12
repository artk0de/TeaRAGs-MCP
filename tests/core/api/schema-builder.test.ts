/**
 * SchemaBuilder tests — MCP schema generation via DIP
 *
 * SchemaBuilder generates dynamic Zod schemas from Reranker's public API,
 * eliminating hardcoded descriptor/preset imports in MCP layer.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SchemaBuilder } from "../../../src/core/api/internal/infra/schema-builder.js";
import type { Reranker } from "../../../src/core/domains/explore/reranker.js";

/**
 * Minimal mock implementing only the Reranker methods SchemaBuilder depends on:
 * - getDescriptorInfo(): { name, description }[]
 * - getPresetNames(tool): string[]
 */
function createMockReranker(overrides?: {
  descriptors?: { name: string; description: string }[];
  presets?: Record<string, string[]>;
  presetDescriptions?: Record<string, string>;
  presetWeights?: Record<string, Record<string, number>>;
}): Pick<Reranker, "getDescriptorInfo" | "getPresetNames" | "getPresetDescriptions" | "getPresetDetails"> {
  const descriptors = overrides?.descriptors ?? [
    { name: "recency", description: "Inverse of age" },
    { name: "similarity", description: "Semantic similarity score" },
    { name: "churn", description: "Commit frequency" },
  ];
  const presets = overrides?.presets ?? {
    semantic_search: ["relevance", "techDebt", "hotspots"],
    search_code: ["relevance", "recent", "stable"],
  };
  const descriptions = overrides?.presetDescriptions ?? {};

  return {
    getDescriptorInfo: () => descriptors,
    getPresetNames: (tool: string) => presets[tool] ?? [],
    getPresetDescriptions: (tool: string) =>
      (presets[tool] ?? []).map((name) => ({
        name,
        description: descriptions[name] ?? `${name} preset`,
      })),
    getPresetDetails: (tool: string) =>
      (presets[tool] ?? []).map((name) => ({
        name,
        description: descriptions[name] ?? `${name} preset`,
        weights: Object.keys(overrides?.presetWeights?.[name] ?? { similarity: 1 }),
        tools: Object.entries(presets)
          .filter(([, names]) => names.includes(name))
          .map(([t]) => t),
      })),
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

    it("does not include descriptions on weight fields", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildScoringWeightsSchema();
      const recencyField = schema.shape.recency;
      expect(recencyField.description).toBeUndefined();
    });

    it("handles empty descriptor list", () => {
      const builder = new SchemaBuilder(createMockReranker({ descriptors: [] }) as unknown as Reranker);
      const schema = builder.buildScoringWeightsSchema();
      const parsed = schema.parse({});
      expect(parsed).toEqual({});
    });
  });

  describe("buildPresetSchema", () => {
    it("accepts valid preset names for semantic_search", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildPresetSchema("semantic_search");

      expect(schema.parse("relevance")).toBe("relevance");
      expect(schema.parse("techDebt")).toBe("techDebt");
      expect(schema.parse("hotspots")).toBe("hotspots");
      expect(() => schema.parse("nonexistent")).toThrow();
    });

    it("accepts valid preset names for search_code", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      const schema = builder.buildPresetSchema("search_code");

      expect(schema.parse("relevance")).toBe("relevance");
      expect(schema.parse("recent")).toBe("recent");
      expect(schema.parse("stable")).toBe("stable");
      expect(() => schema.parse("techDebt")).toThrow();
    });

    it("returns z.enum for multiple presets (no per-value descriptions)", () => {
      const mock = createMockReranker({
        presets: { semantic_search: ["relevance", "techDebt"] },
      });
      const builder = new SchemaBuilder(mock as Reranker);
      const schema = builder.buildPresetSchema("semantic_search");

      expect(schema.parse("relevance")).toBe("relevance");
      expect(schema.parse("techDebt")).toBe("techDebt");
      expect(() => schema.parse("nonexistent")).toThrow();
      // Now uses ZodEnum instead of z.union(z.literal)
      expect(schema).toBeInstanceOf(z.ZodEnum);
    });

    it("returns z.literal for single preset (no description)", () => {
      const mock = createMockReranker({
        presets: { single_tool: ["only"] },
      });
      const builder = new SchemaBuilder(mock as Reranker);
      const schema = builder.buildPresetSchema("single_tool");

      expect(schema.parse("only")).toBe("only");
      expect(() => schema.parse("other")).toThrow();
    });

    it("throws when tool has no presets", () => {
      const builder = new SchemaBuilder(createMockReranker() as Reranker);
      expect(() => builder.buildPresetSchema("unknown_tool")).toThrow(
        /Invalid value "none" for configuration field "presets"/,
      );
    });
  });

  describe("getPresetDetails (via mock)", () => {
    it("returns preset details with weight keys and tools", () => {
      const mock = createMockReranker({
        presets: { semantic_search: ["relevance", "techDebt"] },
        presetDescriptions: {
          relevance: "Pure similarity",
          techDebt: "Legacy code finder",
        },
        presetWeights: {
          relevance: { similarity: 1 },
          techDebt: { age: 0.5, churn: 0.3, similarity: 0.2 },
        },
      });
      const details = mock.getPresetDetails("semantic_search");
      expect(details).toHaveLength(2);
      expect(details[0]).toEqual({
        name: "relevance",
        description: "Pure similarity",
        weights: ["similarity"],
        tools: ["semantic_search"],
      });
      expect(details[1].weights).toEqual(["age", "churn", "similarity"]);
    });
  });

  describe("collectionIdentifier", () => {
    it("returns a Zod object with collection, project, path as optional fields", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      expect(schema).toBeInstanceOf(z.ZodObject);

      const { shape } = schema;
      expect(shape).toHaveProperty("collection");
      expect(shape).toHaveProperty("project");
      expect(shape).toHaveProperty("path");
    });

    it("accepts empty object (all fields optional)", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      expect(schema.safeParse({}).success).toBe(true);
    });

    it("accepts valid project name matching ^[a-z0-9][a-z0-9_-]{0,63}$", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      expect(schema.safeParse({ project: "valid-name" }).success).toBe(true);
      expect(schema.safeParse({ project: "my_project_2" }).success).toBe(true);
      expect(schema.safeParse({ project: "a" }).success).toBe(true);
      expect(schema.safeParse({ project: "0abc" }).success).toBe(true);
    });

    it("rejects project name with uppercase letters", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      expect(schema.safeParse({ project: "BAD" }).success).toBe(false);
      expect(schema.safeParse({ project: "Mixed" }).success).toBe(false);
    });

    it("rejects project name starting with non-alphanumeric character", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      expect(schema.safeParse({ project: "-leading-dash" }).success).toBe(false);
      expect(schema.safeParse({ project: "_leading-underscore" }).success).toBe(false);
    });

    it("rejects project name with invalid characters", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      expect(schema.safeParse({ project: "has space" }).success).toBe(false);
      expect(schema.safeParse({ project: "has.dot" }).success).toBe(false);
      expect(schema.safeParse({ project: "has/slash" }).success).toBe(false);
    });

    it("rejects project name longer than 64 characters", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      const tooLong = `a${"b".repeat(64)}`; // 65 chars
      expect(schema.safeParse({ project: tooLong }).success).toBe(false);
      const justRight = `a${"b".repeat(63)}`; // 64 chars exactly
      expect(schema.safeParse({ project: justRight }).success).toBe(true);
    });

    it("accepts collection and path as plain optional strings", () => {
      const schema = SchemaBuilder.collectionIdentifier();
      expect(schema.safeParse({ collection: "code_abc123" }).success).toBe(true);
      expect(schema.safeParse({ path: "/some/path" }).success).toBe(true);
      expect(schema.safeParse({ collection: "code_abc", path: "/path", project: "name" }).success).toBe(true);
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
