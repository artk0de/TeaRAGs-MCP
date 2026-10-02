import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../src/core/api/index.js";
import type { ExploreResponse } from "../../../src/core/api/public/dto/explore.js";
import { registerSearchTools } from "../../../src/mcp/tools/explore.js";
import { TYPED_FILTER_PARAM_NAMES } from "../../../src/mcp/tools/schemas.js";

type CapturedTool = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

function makeHarness(appOverrides: Record<string, unknown> = {}) {
  const captured: CapturedTool[] = [];
  const register = vi.fn((_server, name, config, handler) => {
    captured.push({ name, config, handler });
  });

  const emptyResponse: ExploreResponse = { results: [] };
  const app = {
    semanticSearch: vi.fn().mockResolvedValue(emptyResponse),
    hybridSearch: vi.fn().mockResolvedValue(emptyResponse),
    rankChunks: vi.fn().mockResolvedValue(emptyResponse),
    findSimilar: vi.fn().mockResolvedValue(emptyResponse),
    findSymbol: vi.fn().mockResolvedValue(emptyResponse),
    ...appOverrides,
  } as unknown as App;

  const schemaBuilder = {
    buildRerankSchema: vi.fn(() => z.any()),
    buildFilterSchema: vi.fn(() => z.any()),
    filterParamNames: vi.fn(() => [...TYPED_FILTER_PARAM_NAMES]),
  } as unknown as SchemaBuilder;

  const server = {} as Parameters<typeof registerSearchTools>[0];

  registerSearchTools(server, { app, schemaBuilder, register });

  return { captured, app, register };
}

describe("registerSearchTools", () => {
  it("registers exactly the five search tools in order", () => {
    const { captured } = makeHarness();
    expect(captured.map((t) => t.name)).toEqual([
      "semantic_search",
      "hybrid_search",
      "rank_chunks",
      "find_similar",
      "find_symbol",
    ]);
  });

  it("each tool has a non-empty title, description, inputSchema, outputSchema and readOnlyHint", () => {
    const { captured } = makeHarness();
    for (const tool of captured) {
      expect(tool.config.title).toBeTruthy();
      expect(typeof tool.config.description).toBe("string");
      expect((tool.config.description as string).length).toBeGreaterThan(20);
      expect(tool.config.inputSchema).toBeTruthy();
      expect(tool.config.outputSchema).toBeTruthy();
      expect(tool.config.annotations).toMatchObject({ readOnlyHint: true });
    }
  });

  it("titles match expected values", () => {
    const { captured } = makeHarness();
    const byName = new Map(captured.map((t) => [t.name, t.config.title]));
    expect(byName.get("semantic_search")).toBe("Semantic Search");
    expect(byName.get("hybrid_search")).toBe("Hybrid Search");
    expect(byName.get("rank_chunks")).toBe("Rank Chunks");
    expect(byName.get("find_similar")).toBe("Find Similar");
    expect(byName.get("find_symbol")).toBe("Find Symbol");
  });

  it.each([
    ["semantic_search", "semanticSearch"],
    ["hybrid_search", "hybridSearch"],
    ["rank_chunks", "rankChunks"],
    ["find_similar", "findSimilar"],
    ["find_symbol", "findSymbol"],
  ] as const)("%s handler delegates to app.%s", async (toolName, appMethod) => {
    const { captured, app } = makeHarness();
    const tool = captured.find((t) => t.name === toolName);
    expect(tool).toBeDefined();

    await tool!.handler({ path: "/x", query: "q", rerank: "relevance" }, {});

    const method = (app as unknown as Record<string, ReturnType<typeof vi.fn>>)[appMethod];
    expect(method).toHaveBeenCalledTimes(1);
    const call = method.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.path).toBe("/x");
    expect(call.query).toBe("q");
    expect(call.rerank).toBe("relevance");
  });

  it("passes the confidence envelope field through to structuredContent", async () => {
    const { captured } = makeHarness({
      semanticSearch: vi.fn().mockResolvedValue({
        results: [],
        confidence: { value: 0.23, label: "low" },
      }),
    });
    const tool = captured.find((t) => t.name === "semantic_search");

    const result = (await tool!.handler({ path: "/x", query: "q" }, {})) as {
      structuredContent: { confidence?: { value: number; label: string } };
    };

    expect(result.structuredContent.confidence).toEqual({ value: 0.23, label: "low" });
  });

  it("omits confidence from structuredContent when the operation does not report it", async () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "rank_chunks");

    const result = (await tool!.handler({ path: "/x", rerank: "techDebt" }, {})) as {
      structuredContent: Record<string, unknown>;
    };

    expect("confidence" in result.structuredContent).toBe(false);
  });

  it("handler returns structuredContent shape with results", async () => {
    const { captured } = makeHarness();
    const tool = captured[0];
    if (!tool) throw new Error("expected at least one registered tool");
    const result = (await tool.handler({ path: "/x", query: "q" }, {})) as {
      structuredContent: { results: unknown[] };
      content: unknown[];
    };
    expect(result.structuredContent).toBeDefined();
    expect(Array.isArray(result.structuredContent.results)).toBe(true);
    expect(result.content).toEqual([]);
  });
});

// bd tea-rags-mcp-a43tr — find_symbol's optional codegraph hop was skipped
// (codegraph unavailable from this process). The notice rides the response
// next to driftWarning so the agent learns why a collapsed symbol is missing
// and how to repair it, instead of the whole call failing.
describe("registerSearchTools — codegraphWarning", () => {
  const warning =
    "find_symbol: codegraph fallback for collapsed symbols skipped [INFRA_CODEGRAPH_DAEMON_STALE_BUILD] — /mcp reconnect";

  it("find_symbol passes codegraphWarning through to structuredContent", async () => {
    const { captured } = makeHarness({
      findSymbol: vi.fn().mockResolvedValue({ results: [], codegraphWarning: warning }),
    });
    const tool = captured.find((t) => t.name === "find_symbol");

    const result = (await tool!.handler({ path: "/x", symbol: "Foo#bar" }, {})) as {
      structuredContent: { codegraphWarning?: string };
    };

    expect(result.structuredContent.codegraphWarning).toBe(warning);
  });

  it("omits codegraphWarning from structuredContent when the operation does not report it", async () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "find_symbol");

    const result = (await tool!.handler({ path: "/x", symbol: "Foo#bar" }, {})) as {
      structuredContent: Record<string, unknown>;
    };

    expect("codegraphWarning" in result.structuredContent).toBe(false);
  });
});

// bd tea-rags-mcp-0qfpi — a rerank preset's DEFAULT filter narrowed the set and
// the caller never wrote it. The notice rides the response next to driftWarning
// so an empty or thin answer is attributable without reading preset source.
describe("registerSearchTools — presetFilterNotice", () => {
  const notice = { preset: "techDebt", by: "production (isTest)", clearWith: "filter: {}" };

  it.each(["semantic_search", "hybrid_search", "rank_chunks", "find_similar"] as const)(
    "%s passes presetFilterNotice through to structuredContent",
    async (toolName) => {
      const appMethod = {
        semantic_search: "semanticSearch",
        hybrid_search: "hybridSearch",
        rank_chunks: "rankChunks",
        find_similar: "findSimilar",
      }[toolName];
      const { captured } = makeHarness({
        [appMethod]: vi.fn().mockResolvedValue({ results: [], presetFilterNotice: notice }),
      });
      const tool = captured.find((t) => t.name === toolName);

      const result = (await tool!.handler({ path: "/x", query: "q", rerank: "techDebt" }, {})) as {
        structuredContent: { presetFilterNotice?: typeof notice };
      };

      expect(result.structuredContent.presetFilterNotice).toEqual(notice);
    },
  );

  it("omits presetFilterNotice when the caller's own filter is what applied", async () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "semantic_search");

    const result = (await tool!.handler({ path: "/x", query: "q", filter: {} }, {})) as {
      structuredContent: Record<string, unknown>;
    };

    expect("presetFilterNotice" in result.structuredContent).toBe(false);
  });

  it("declares presetFilterNotice on the shared search output schema", () => {
    const { captured } = makeHarness();
    for (const tool of captured) {
      expect(tool.config.outputSchema).toHaveProperty("presetFilterNotice");
    }
  });
});

// bd tea-rags-mcp-l2lix — `fields` is a payload allow-list applied server-side.
// It belongs on every tool that returns payload-bearing results, not on one of
// them, and a path that matched nothing is reported rather than silently
// producing empty payloads.
describe("registerSearchTools — fields projection", () => {
  const churnPath = "git.file.commitCount";

  it("every search tool accepts a fields param", () => {
    const { captured } = makeHarness();
    for (const tool of captured) {
      expect(tool.config.inputSchema).toHaveProperty("fields");
    }
  });

  it("forwards fields to the App method verbatim", async () => {
    const { captured, app } = makeHarness();
    const tool = captured.find((t) => t.name === "semantic_search");

    await tool!.handler({ path: "/x", query: "q", fields: [churnPath] }, {});

    const call = (app.semanticSearch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.fields).toEqual([churnPath]);
  });

  it("passes fieldsWarning through to structuredContent", async () => {
    const warning = `fields: no result carried "chunk.commitCount" — did you mean ${churnPath}?`;
    const { captured } = makeHarness({
      hybridSearch: vi.fn().mockResolvedValue({ results: [], fieldsWarning: warning }),
    });
    const tool = captured.find((t) => t.name === "hybrid_search");

    const result = (await tool!.handler({ path: "/x", query: "q", fields: ["chunk.commitCount"] }, {})) as {
      structuredContent: { fieldsWarning?: string };
    };

    expect(result.structuredContent.fieldsWarning).toBe(warning);
  });

  it("omits fieldsWarning when every requested path landed", async () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "hybrid_search");

    const result = (await tool!.handler({ path: "/x", query: "q", fields: ["relativePath"] }, {})) as {
      structuredContent: Record<string, unknown>;
    };

    expect("fieldsWarning" in result.structuredContent).toBe(false);
  });

  it("declares fieldsWarning on the shared search output schema", () => {
    const { captured } = makeHarness();
    for (const tool of captured) {
      expect(tool.config.outputSchema).toHaveProperty("fieldsWarning");
    }
  });
});

// bd tea-rags-mcp-xi2r9.1 — every read answer says which working tree it read
// and how far that tree is from the index. The marker rides structuredContent
// next to driftWarning, on every search tool.
describe("registerSearchTools — workingTree", () => {
  const marker = {
    tree: "/repo/wt",
    indexedCommit: "a".repeat(40),
    treeCommit: "b".repeat(40),
    indexedDirty: false,
    changedFiles: 3,
    deletedFiles: 1,
    floors: [],
  };
  const appMethods = {
    semantic_search: "semanticSearch",
    hybrid_search: "hybridSearch",
    rank_chunks: "rankChunks",
    find_similar: "findSimilar",
    find_symbol: "findSymbol",
  } as const;

  it.each(Object.keys(appMethods) as (keyof typeof appMethods)[])(
    "%s passes workingTree through to structuredContent",
    async (toolName) => {
      const { captured } = makeHarness({
        [appMethods[toolName]]: vi.fn().mockResolvedValue({ results: [], workingTree: marker }),
      });
      const tool = captured.find((t) => t.name === toolName);

      const result = (await tool!.handler({ path: "/x", query: "q", symbol: "s" }, {})) as {
        structuredContent: { workingTree?: unknown };
      };

      expect(result.structuredContent.workingTree).toEqual(marker);
    },
  );

  it("declares workingTree on the shared search output schema", () => {
    const { captured } = makeHarness();
    for (const tool of captured) {
      expect(tool.config.outputSchema).toHaveProperty("workingTree");
    }
  });
});
