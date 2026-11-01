import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { SchemaBuilder } from "../../../../src/core/api/index.js";
import {
  DEFAULT_META_ONLY_FIELDS,
  DEFAULT_SEARCH_FIELDS,
} from "../../../../src/core/api/public/dto/payload-projection.js";
import {
  CreateCollectionSchema,
  createSearchSchemas,
  IndexCodebaseSchema,
  TYPED_FILTER_PARAM_NAMES,
} from "../../../../src/core/api/tools/schemas.js";
import { buildOverview } from "../../../../src/mcp/resources/registry.js";

// Minimal mock SchemaBuilder — returns a simple string schema for rerank
// since we only care about coercion of number/boolean fields, not rerank shape.
const mockSchemaBuilder = {
  buildRerankSchema: () => z.string(),
  customWeightSignals: () => ["similarity"],
  buildFilterSchema: () => z.record(z.string(), z.any()),
  filterParamNames: () => [...TYPED_FILTER_PARAM_NAMES],
} as unknown as SchemaBuilder;

const { SearchCodeSchema, SemanticSearchSchema, HybridSearchSchema, RankChunksSchema } =
  createSearchSchemas(mockSchemaBuilder);

// ---------------------------------------------------------------------------
// Helpers: wrap plain schema objects into z.object() for parsing
// ---------------------------------------------------------------------------

const parseCreateCollection = (input: unknown) => z.object(CreateCollectionSchema).parse(input);
const parseIndexCodebase = (input: unknown) => z.object(IndexCodebaseSchema).parse(input);
const parseSearchCode = (input: unknown) => z.object(SearchCodeSchema).parse(input);
const parseSemanticSearch = (input: unknown) => z.object(SemanticSearchSchema).parse(input);
const parseHybridSearch = (input: unknown) => z.object(HybridSearchSchema).parse(input);

describe("migration search scope", () => {
  it("accepts an explicit migration scope on semantic and hybrid search", () => {
    expect(parseSemanticSearch({ query: "orders", scope: "migrations" })).toMatchObject({ scope: "migrations" });
    expect(parseHybridSearch({ query: "orders", scope: "migrations" })).toMatchObject({ scope: "migrations" });
  });
});
const parseRankChunks = (input: unknown) => z.object(RankChunksSchema).parse(input);

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

describe("CreateCollectionSchema schema (typed collections)", () => {
  it("accepts a JSON Schema object and passes it through untouched", () => {
    const schema = { type: "object", properties: { helpful: { type: "number", default: 0 } } };
    const result = parseCreateCollection({ name: "memory", schema });
    expect(result.schema).toEqual(schema);
  });

  it("is optional — an untyped collection omits it", () => {
    expect(parseCreateCollection({ name: "plain" }).schema).toBeUndefined();
  });

  it("rejects a schema that is not an object", () => {
    expect(() => parseCreateCollection({ name: "memory", schema: "object" })).toThrow();
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

// ---------------------------------------------------------------------------
// project field — exposed on every project-aware tool (T21)
// ---------------------------------------------------------------------------

describe("SemanticSearchSchema / HybridSearchSchema — query variants", () => {
  const base = { path: "/tmp" };

  it("accepts a string query, including the 'a ||| b' spelling, unchanged", () => {
    expect(parseSemanticSearch({ ...base, query: "rate limit" }).query).toBe("rate limit");
    expect(parseHybridSearch({ ...base, query: "rate limit ||| retry after" }).query).toBe(
      "rate limit ||| retry after",
    );
  });

  it("accepts an array of 1..5 variants", () => {
    expect(parseSemanticSearch({ ...base, query: ["rate limit", "throttle"] }).query).toEqual([
      "rate limit",
      "throttle",
    ]);
    expect(parseHybridSearch({ ...base, query: ["a", "b", "c", "d", "e"] }).query).toHaveLength(5);
  });

  it("rejects an empty array and more than 5 variants", () => {
    expect(() => parseSemanticSearch({ ...base, query: [] })).toThrow();
    expect(() => parseHybridSearch({ ...base, query: ["a", "b", "c", "d", "e", "f"] })).toThrow();
  });
});

describe("SemanticSearchSchema — project field", () => {
  it("accepts optional project name", () => {
    const result = parseSemanticSearch({ query: "x", project: "alpha" });
    expect(result.project).toBe("alpha");
  });

  it("rejects invalid project name regex", () => {
    expect(() => parseSemanticSearch({ query: "x", project: "BAD!" })).toThrow();
  });

  it("accepts project with hyphens, underscores and digits", () => {
    const result = parseSemanticSearch({ query: "x", project: "my_project-123" });
    expect(result.project).toBe("my_project-123");
  });

  it("rejects project name starting with hyphen", () => {
    expect(() => parseSemanticSearch({ query: "x", project: "-bad" })).toThrow();
  });

  it("rejects empty project name", () => {
    expect(() => parseSemanticSearch({ query: "x", project: "" })).toThrow();
  });

  it("accepts missing project (still optional)", () => {
    const result = parseSemanticSearch({ query: "x" });
    expect(result.project).toBeUndefined();
  });
});

describe("HybridSearchSchema — project field", () => {
  it("accepts optional project name", () => {
    const result = parseHybridSearch({ query: "x", project: "alpha" });
    expect(result.project).toBe("alpha");
  });

  it("rejects invalid project name regex", () => {
    expect(() => parseHybridSearch({ query: "x", project: "Bad Name" })).toThrow();
  });
});

describe("SearchCodeSchema — project field", () => {
  it("accepts optional project name alongside path", () => {
    const result = parseSearchCode({ path: "/tmp", query: "x", project: "alpha" });
    expect(result.project).toBe("alpha");
  });

  it("rejects invalid project name regex", () => {
    expect(() => parseSearchCode({ path: "/tmp", query: "x", project: "BAD!" })).toThrow();
  });
});

describe("IndexCodebaseSchema — project field", () => {
  it("accepts optional project name alongside path", () => {
    const result = parseIndexCodebase({ path: "/tmp", project: "alpha" });
    expect(result.project).toBe("alpha");
  });

  it("rejects invalid project name regex", () => {
    expect(() => parseIndexCodebase({ path: "/tmp", project: "Bad!" })).toThrow();
  });

  it("accepts missing project (still optional)", () => {
    const result = parseIndexCodebase({ path: "/tmp" });
    expect(result.project).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Author filters (bd tea-rags-mcp-9mwny)
// ---------------------------------------------------------------------------

// `author` is the exact blame owner; "what did X work on" needs the commit
// side, `recentAuthor` (the file's dominant committer in the git log window).
// The git trajectory declares that filter, but a param the tool schema does not
// list is stripped by Zod before the handler runs — the search silently comes
// back unfiltered.
describe("recentAuthor typed filter", () => {
  it("survives semantic_search parsing", () => {
    const result = parseSemanticSearch({ query: "q", path: "/tmp", recentAuthor: "john@acme.com" });
    expect(result.recentAuthor).toBe("john@acme.com");
  });

  it("survives search_code parsing", () => {
    const result = parseSearchCode({ query: "q", path: "/tmp", recentAuthor: "John Doe" });
    expect(result.recentAuthor).toBe("John Doe");
  });
});

// `recentAuthor` matches only files where the person is the TOP recent
// committer. "Everything X touched" needs every file X committed to in the
// window — the `contributor` param (bd tea-rags-mcp-y1870). Same four tools
// as recentAuthor.
describe("contributor typed filter", () => {
  it("survives semantic_search parsing", () => {
    const result = parseSemanticSearch({ query: "q", path: "/tmp", contributor: "John Doe" });
    expect(result.contributor).toBe("John Doe");
  });

  it("survives hybrid_search parsing", () => {
    const result = parseHybridSearch({ query: "q", path: "/tmp", contributor: "john@acme.com" });
    expect(result.contributor).toBe("john@acme.com");
  });

  it("survives search_code parsing", () => {
    const result = parseSearchCode({ query: "q", path: "/tmp", contributor: "John Doe" });
    expect(result.contributor).toBe("John Doe");
  });

  it("survives rank_chunks parsing", () => {
    const result = parseRankChunks({ rerank: "ownership", path: "/tmp", contributor: "John Doe" });
    expect(result.contributor).toBe("John Doe");
  });

  it("stays optional — omitting it filters nothing", () => {
    const result = parseSemanticSearch({ query: "q", path: "/tmp" });
    expect(result.contributor).toBeUndefined();
  });
});

// The per-filter level defaults moved to tea-rags://guide/overview
// (bd tea-rags-mcp-ewg2s) — pinned in tests/mcp/resources/resources.test.ts.
// The inline hint keeps the one fact a caller must not miss: level also
// scopes the level-aware filters.
describe("fields hint names the search defaults (q1g6s.16)", () => {
  const { FindSimilarSchema, FindSymbolSchema } = createSearchSchemas(mockSchemaBuilder);
  const hintOf = (schema: Record<string, unknown>) => (schema.fields as z.ZodTypeAny).description ?? "";

  // bd tea-rags-mcp-d0z7b.5: the alwaysLoad hint is one clause; the two default
  // lists moved to the overview, still interpolated from the constants.
  it("every search tool's fields hint points at the signals guide; the overview states both default constants", () => {
    for (const schema of [SemanticSearchSchema, HybridSearchSchema, RankChunksSchema, FindSimilarSchema]) {
      expect(hintOf(schema)).toContain("tea-rags://guide/signals");
    }
    const overview = buildOverview();
    expect(overview).toContain(DEFAULT_SEARCH_FIELDS.join(", "));
    expect(overview).toContain(DEFAULT_META_ONLY_FIELDS.join(", "));
  });

  it("find_similar's example ids take the symbolId a default row carries", () => {
    expect((FindSimilarSchema.positiveIds as z.ZodTypeAny).description).toMatch(/symbolId/);
    expect((FindSimilarSchema.negativeIds as z.ZodTypeAny).description).toMatch(/symbolId/);
  });

  it("find_symbol keeps its own lean-default hint", () => {
    expect(hintOf(FindSymbolSchema)).not.toContain(DEFAULT_SEARCH_FIELDS.join(","));
  });
});

describe("level hint", () => {
  it("states that level scopes level-aware filters", () => {
    const description = (SemanticSearchSchema.level as z.ZodTypeAny).description ?? "";
    expect(description).toMatch(/level-aware filters/);
  });
});

// A typed filter whose trajectory is not registered has no FilterDescriptor:
// exposing it would accept the param and run the search unfiltered
// (bd tea-rags-mcp-86wsz). The schema exposes exactly the applied set.
describe("typed filter exposure follows the registered filter params", () => {
  const withoutCodegraph = createSearchSchemas({
    ...mockSchemaBuilder,
    buildRerankSchema: () => z.string(),
    customWeightSignals: () => ["similarity"],
    buildFilterSchema: () => z.record(z.string(), z.any()),
    filterParamNames: () => ["language", "author", "minAgeDays"],
  } as unknown as SchemaBuilder);

  it("drops a catalog filter the registry does not apply", () => {
    for (const schema of [
      withoutCodegraph.SemanticSearchSchema,
      withoutCodegraph.HybridSearchSchema,
      withoutCodegraph.SearchCodeSchema,
      withoutCodegraph.RankChunksSchema,
    ]) {
      expect(Object.keys(schema)).not.toContain("minFanIn");
      expect(Object.keys(schema)).toContain("author");
    }
  });

  it("strips a dropped filter from a request instead of failing it", () => {
    const parsed = z.object(withoutCodegraph.SemanticSearchSchema).parse({ query: "q", minFanIn: 3 });
    expect("minFanIn" in parsed).toBe(false);
  });
});

describe("FindSymbolSchema — symbols batch (N1)", () => {
  const parse = (input: unknown) => z.object(createSearchSchemas(mockSchemaBuilder).FindSymbolSchema).safeParse(input);

  it("accepts 1..20 addresses and rejects none or 21", () => {
    expect(parse({ symbols: ["Foo#bar"] }).success).toBe(true);
    expect(parse({ symbols: Array.from({ length: 20 }, (_, i) => `s${i}`) }).success).toBe(true);
    expect(parse({ symbols: [] }).success).toBe(false);
    expect(parse({ symbols: Array.from({ length: 21 }, (_, i) => `s${i}`) }).success).toBe(false);
  });

  it("says the batch takes file paths beside symbol ids (q1g6s.4)", () => {
    const hint = createSearchSchemas(mockSchemaBuilder).FindSymbolSchema.symbols.description ?? "";

    expect(hint).toMatch(/symbol ids/);
    expect(hint).toMatch(/file paths/);
  });
});
