import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { SchemaBuilder } from "../../../src/core/api/index.js";
import { CreateCollectionSchema, createSearchSchemas, IndexCodebaseSchema } from "../../../src/mcp/tools/schemas.js";

// Minimal mock SchemaBuilder — returns a simple string schema for rerank
// since we only care about coercion of number/boolean fields, not rerank shape.
const mockSchemaBuilder = {
  buildRerankSchema: () => z.string(),
} as unknown as SchemaBuilder;

const { SearchCodeSchema, SemanticSearchSchema, HybridSearchSchema } = createSearchSchemas(mockSchemaBuilder);

// ---------------------------------------------------------------------------
// Helpers: wrap plain schema objects into z.object() for parsing
// ---------------------------------------------------------------------------

const parseCreateCollection = (input: unknown) => z.object(CreateCollectionSchema).parse(input);
const parseIndexCodebase = (input: unknown) => z.object(IndexCodebaseSchema).parse(input);
const parseSearchCode = (input: unknown) => z.object(SearchCodeSchema).parse(input);
const parseSemanticSearch = (input: unknown) => z.object(SemanticSearchSchema).parse(input);
const parseHybridSearch = (input: unknown) => z.object(HybridSearchSchema).parse(input);

// ---------------------------------------------------------------------------
// Static schemas
// ---------------------------------------------------------------------------

describe("CreateCollectionSchema coercion", () => {
  it("coerces enableHybrid string 'true' → boolean true", () => {
    const result = parseCreateCollection({ name: "test", enableHybrid: "true" });
    expect(result.enableHybrid).toBe(true);
  });

  it("coerces enableHybrid string 'false' → boolean false", () => {
    const result = parseCreateCollection({ name: "test", enableHybrid: "false" });
    expect(result.enableHybrid).toBe(false);
  });

  it("passes native boolean through", () => {
    const result = parseCreateCollection({ name: "test", enableHybrid: true });
    expect(result.enableHybrid).toBe(true);
  });
});

describe("IndexCodebaseSchema coercion", () => {
  it("coerces forceReindex string 'true' → boolean true", () => {
    const result = parseIndexCodebase({ path: "/tmp", forceReindex: "true" });
    expect(result.forceReindex).toBe(true);
  });

  it("coerces forceReindex string 'false' → boolean false", () => {
    const result = parseIndexCodebase({ path: "/tmp", forceReindex: "false" });
    expect(result.forceReindex).toBe(false);
  });

  it("passes native boolean through", () => {
    const result = parseIndexCodebase({ path: "/tmp", forceReindex: false });
    expect(result.forceReindex).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dynamic schemas — SearchCodeSchema
// ---------------------------------------------------------------------------

describe("SearchCodeSchema coercion", () => {
  const base = { path: "/tmp", query: "test" };

  describe("number fields", () => {
    it("coerces limit string '10' → number 10", () => {
      const result = parseSearchCode({ ...base, limit: "10" });
      expect(result.limit).toBe(10);
    });

    it("passes native number through for limit", () => {
      const result = parseSearchCode({ ...base, limit: 10 });
      expect(result.limit).toBe(10);
    });

    it("rejects non-numeric string for limit", () => {
      expect(() => parseSearchCode({ ...base, limit: "abc" })).toThrow();
    });

    it("coerces minAgeDays string '30' → number 30", () => {
      const result = parseSearchCode({ ...base, minAgeDays: "30" });
      expect(result.minAgeDays).toBe(30);
    });

    it("coerces maxAgeDays string '7' → number 7", () => {
      const result = parseSearchCode({ ...base, maxAgeDays: "7" });
      expect(result.maxAgeDays).toBe(7);
    });

    it("coerces minCommitCount string '5' → number 5", () => {
      const result = parseSearchCode({ ...base, minCommitCount: "5" });
      expect(result.minCommitCount).toBe(5);
    });
  });

  describe("documentation enum field", () => {
    it("accepts 'only' value", () => {
      const result = parseSearchCode({ ...base, documentation: "only" });
      expect(result.documentation).toBe("only");
    });

    it("accepts 'exclude' value", () => {
      const result = parseSearchCode({ ...base, documentation: "exclude" });
      expect(result.documentation).toBe("exclude");
    });

    it("accepts 'include' value", () => {
      const result = parseSearchCode({ ...base, documentation: "include" });
      expect(result.documentation).toBe("include");
    });

    it("rejects invalid value", () => {
      expect(() => parseSearchCode({ ...base, documentation: "invalid" })).toThrow();
    });
  });

  describe("fileExtension union field", () => {
    it("accepts single string", () => {
      const result = parseSearchCode({ ...base, fileExtension: ".ts" });
      expect(result.fileExtension).toBe(".ts");
    });

    it("accepts array of strings", () => {
      const result = parseSearchCode({ ...base, fileExtension: [".ts", ".py"] });
      expect(result.fileExtension).toEqual([".ts", ".py"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Dynamic schemas — SemanticSearchSchema
// ---------------------------------------------------------------------------

describe("SemanticSearchSchema coercion", () => {
  const base = { query: "test", path: "/tmp" };

  it("coerces limit string '5' → number 5", () => {
    const result = parseSemanticSearch({ ...base, limit: "5" });
    expect(result.limit).toBe(5);
  });

  it("coerces metaOnly string 'true' → boolean true", () => {
    const result = parseSemanticSearch({ ...base, metaOnly: "true" });
    expect(result.metaOnly).toBe(true);
  });

  it("coerces metaOnly string 'false' → boolean false", () => {
    const result = parseSemanticSearch({ ...base, metaOnly: "false" });
    expect(result.metaOnly).toBe(false);
  });

  it("passes native types through", () => {
    const result = parseSemanticSearch({ ...base, limit: 5, metaOnly: true });
    expect(result.limit).toBe(5);
    expect(result.metaOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dynamic schemas — HybridSearchSchema
// ---------------------------------------------------------------------------

describe("HybridSearchSchema coercion", () => {
  const base = { query: "test", path: "/tmp" };

  it("coerces limit string '5' → number 5", () => {
    const result = parseHybridSearch({ ...base, limit: "5" });
    expect(result.limit).toBe(5);
  });

  it("coerces metaOnly string 'true' → boolean true", () => {
    const result = parseHybridSearch({ ...base, metaOnly: "true" });
    expect(result.metaOnly).toBe(true);
  });

  it("passes native types through", () => {
    const result = parseHybridSearch({ ...base, limit: 5, metaOnly: false });
    expect(result.limit).toBe(5);
    expect(result.metaOnly).toBe(false);
  });
});
