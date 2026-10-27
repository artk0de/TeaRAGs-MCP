import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../../src/core/api/index.js";
import type { ExploreResponse } from "../../../../src/core/api/public/dto/explore.js";
import { registerSearchTools } from "../../../../src/core/api/tools/explore.js";
import type { McpToolResult } from "../../../../src/core/api/tools/format.js";
import {
  enforceResponseBudget,
  type ResponseRowsPolicy,
  type ResponseTruncation,
} from "../../../../src/core/api/tools/response-budget.js";
import { TYPED_FILTER_PARAM_NAMES } from "../../../../src/core/api/tools/schemas.js";
import { recordsOf } from "../../../helpers/column-table.js";

type CapturedTool = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

function makeHarness(appOverrides: Record<string, unknown> = {}) {
  const captured: CapturedTool[] = [];
  const register = vi.fn((_server, name, config, handler) => {
    captured.push({ name, config, handler });
  });

  const emptyResponse: ExploreResponse = { results: [], driftWarning: null };
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
    customWeightSignals: () => ["similarity"],
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
      structuredContent: { results: unknown };
      content: unknown[];
    };
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent.results).toEqual([]);
    expect(result.content).toEqual([]);
  });

  it("emits a single result as a one-record list, not a one-row table", async () => {
    const record = { id: "a", score: 0.9, payload: { relativePath: "src/a.ts", git: { file: { ageDays: 3 } } } };
    const { captured } = makeHarness({ findSymbol: vi.fn().mockResolvedValue({ results: [record] }) });
    const tool = captured.find((t) => t.name === "find_symbol");

    const result = (await tool!.handler({ path: "/x", symbol: "A" }, {})) as {
      structuredContent: { results: unknown };
    };

    expect(result.structuredContent.results).toEqual([record]);
  });

  it("emits results as a column table, one row per result, envelope fields beside it", async () => {
    // A changed tree: a clean marker goes out compact (bd tea-rags-mcp-45kbu).
    const workingTree = { tree: "/x", changedFiles: 1, deletedFiles: 0, floors: [] };
    const { captured } = makeHarness({
      hybridSearch: vi.fn().mockResolvedValue({
        results: [
          { id: "a", score: 0.9, payload: { relativePath: "src/a.ts", symbolId: "A#run" } },
          { id: "b", score: 0.4, payload: { relativePath: "src/b.ts" } },
        ],
        driftWarning: "stale",
        workingTree,
      }),
    });
    const tool = captured.find((t) => t.name === "hybrid_search");

    const result = (await tool!.handler({ path: "/x", query: "q" }, {})) as {
      structuredContent: { results: unknown; driftWarning?: string; workingTree?: unknown };
    };

    expect(result.structuredContent.results).toEqual({
      columns: ["id", "score", "payload.relativePath", "payload.symbolId"],
      rows: [
        ["a", 0.9, "src/a.ts", "A#run"],
        ["b", 0.4, "src/b.ts", null],
      ],
    });
    expect(result.structuredContent.driftWarning).toBe("stale");
    expect(result.structuredContent.workingTree).toEqual(workingTree);
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

  // bd tea-rags-mcp-45kbu: a clean tree's marker goes out compact, and the
  // output schema the SDK validates every answer against accepts that shape.
  it.each(Object.keys(appMethods) as (keyof typeof appMethods)[])(
    "%s emits a clean marker as tree, project and changedFiles 0",
    async (toolName) => {
      const clean = { ...marker, changedFiles: 0, deletedFiles: 0, project: "proj" };
      const { captured } = makeHarness({
        [appMethods[toolName]]: vi.fn().mockResolvedValue({ results: [], workingTree: clean }),
      });
      const tool = captured.find((t) => t.name === toolName);

      const result = (await tool!.handler({ path: "/x", query: "q", symbol: "s" }, {})) as {
        structuredContent: { workingTree?: unknown };
      };

      expect(result.structuredContent.workingTree).toStrictEqual({
        tree: "/repo/wt",
        project: "proj",
        changedFiles: 0,
      });
      expect(() => z.object(tool!.config.outputSchema as z.ZodRawShape).parse(result.structuredContent)).not.toThrow();
    },
  );
});

// bd tea-rags-mcp-45kbu: Claude Code defers MCP tool schemas behind ToolSearch;
// the two tools an agent loads first ask to load upfront.
describe("registerSearchTools — anthropic/alwaysLoad", () => {
  it("marks exactly find_symbol and hybrid_search to load upfront", () => {
    const { captured } = makeHarness();

    const upfront = captured.filter((t) => t.config._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name);

    expect(upfront.sort()).toEqual(["find_symbol", "hybrid_search"]);
  });
});

// Agent turn economy N6 (bd tea-rags-mcp-wrosj): the empty-answer reason reaches the MCP output.
describe("registerSearchTools — empty answer explanation", () => {
  it("semantic_search and hybrid_search carry empty in structuredContent", async () => {
    const empty = { reason: "filteredOut", message: "filters removed every match", suggestions: ["filter: {}"] };
    const { captured } = makeHarness({
      semanticSearch: vi.fn().mockResolvedValue({ results: [], driftWarning: null, empty }),
      hybridSearch: vi.fn().mockResolvedValue({ results: [], driftWarning: null, empty }),
    });

    for (const name of ["semantic_search", "hybrid_search"]) {
      const tool = captured.find((t) => t.name === name);
      const result = (await tool!.handler({ path: "/x", query: "q" }, {})) as {
        structuredContent: { empty?: unknown };
      };
      expect(result.structuredContent.empty).toEqual(empty);
    }
  });
});

// hybrid_search answered from BM25 alone because the embedding provider is down.
describe("registerSearchTools — denseUnavailable", () => {
  const reason = "No llama-server endpoint is reachable at http://127.0.0.1:9";

  it("hybrid_search carries denseUnavailable in structuredContent and says so in one text line", async () => {
    const { captured } = makeHarness({
      hybridSearch: vi.fn().mockResolvedValue({ results: [], driftWarning: null, denseUnavailable: { reason } }),
    });
    const tool = captured.find((t) => t.name === "hybrid_search");

    const result = (await tool!.handler({ path: "/x", query: "q" }, {})) as {
      structuredContent: { denseUnavailable?: { reason: string } };
      content: { type: string; text: string }[];
    };

    expect(result.structuredContent.denseUnavailable).toEqual({ reason });
    expect(result.content).toEqual([{ type: "text", text: `dense leg unavailable: ${reason} — ranked by BM25 only` }]);
  });

  it("omits both when the dense leg ran", async () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "hybrid_search");

    const result = (await tool!.handler({ path: "/x", query: "q" }, {})) as {
      structuredContent: Record<string, unknown>;
      content: unknown[];
    };

    expect("denseUnavailable" in result.structuredContent).toBe(false);
    expect(result.content).toEqual([]);
  });
});

// N5 (bd tea-rags-mcp-r4rl1): the answer's ready-made next calls reach the client.
describe("registerSearchTools — next", () => {
  it("hybrid_search passes next through to structuredContent", async () => {
    const next = [{ tool: "get_callers", args: { path: "/x", relativePath: "src/a.ts" }, why: "importers" }];
    const { captured } = makeHarness({
      hybridSearch: vi.fn().mockResolvedValue({ results: [], driftWarning: null, next }),
    });
    const tool = captured.find((t) => t.name === "hybrid_search");

    const result = (await tool!.handler({ path: "/x", query: "q" }, {})) as {
      structuredContent: Record<string, unknown>;
    };

    expect(result.structuredContent.next).toEqual(next);
  });
});

// q1g6s.15: a cut `symbols` batch named no continuation — the policy looked for
// a `request` column while the tabulated rows carry `payload.request`.
describe("registerSearchTools — find_symbol batch over the response budget", () => {
  it("continues with find_symbol(symbols: <the addresses whose rows were cut>), addressed to the tree", async () => {
    const row = (request: string) => ({
      id: request,
      score: 1,
      payload: { request, symbolId: request, relativePath: "src/a.ts", content: "x".repeat(400) },
    });
    const { captured } = makeHarness({
      findSymbol: vi.fn().mockResolvedValue({
        results: ["A#a", "B#b", "C#c", "D#d"].map(row),
        driftWarning: null,
        workingTree: { tree: "/x", project: "p" },
      }),
    });
    const tool = captured.find((t) => t.name === "find_symbol")!;
    const args = { project: "p", path: "/x", symbols: ["A#a", "B#b", "C#c", "D#d"] };
    const result = (await tool.handler(args, {})) as McpToolResult;

    const policy = (tool.config as { responseRows: ResponseRowsPolicy }).responseRows;
    const cut = enforceResponseBudget(result, "find_symbol", args, policy, 1200);
    const { truncated } = cut.structuredContent as { truncated: ResponseTruncation };

    expect(truncated.omitted).toBeGreaterThan(0);
    expect(truncated.next?.tool).toBe("find_symbol");
    expect(truncated.next?.args.symbols).toEqual(["A#a", "B#b", "C#c", "D#d"].slice(truncated.returned));
    expect(truncated.next?.args).toMatchObject({ project: "p", path: "/x" });
  });
});

// bd tea-rags-mcp-e6es3: a row carries the import COUNT, not the import list;
// numbers go out at 2 significant digits. Presentation only — ranking untouched.
describe("registerSearchTools — compact result rows", () => {
  const imports = ["./a.js", "./b.js", "zod"];
  const rankedRows = () => [
    {
      id: "a",
      score: 0.912345,
      payload: { relativePath: "src/a.ts", imports, codegraph: { symbols: { chunk: { pageRank: 0.0000522414 } } } },
      rankingOverlay: { preset: "hotspots", file: { imports, commitCount: { value: 12, label: "high" } } },
    },
    {
      id: "b",
      score: 0.4,
      payload: { relativePath: "src/b.ts", imports: ["./c.js"], startLine: 10, endLine: 42 },
      rankingOverlay: { preset: "hotspots", file: { imports: ["./c.js"], commitCount: { value: 2, label: "low" } } },
    },
  ];
  const hybridHarness = () => {
    const harness = makeHarness({
      hybridSearch: vi.fn().mockImplementation(async () => ({ results: rankedRows(), driftWarning: null })),
    });
    return { ...harness, tool: harness.captured.find((t) => t.name === "hybrid_search")! };
  };
  type CompactRecord = {
    id: string;
    score: number;
    payload: Record<string, unknown>;
    rankingOverlay: { file: Record<string, unknown> };
  };
  const recordsFrom = async (tool: CapturedTool, args: Record<string, unknown>): Promise<CompactRecord[]> => {
    const result = (await tool.handler({ path: "/x", query: "q", ...args }, {})) as {
      structuredContent: { results: Parameters<typeof recordsOf>[0] };
    };
    return recordsOf(result.structuredContent.results) as unknown as CompactRecord[];
  };

  it("emits the payload imports and the overlay file imports as their count by default", async () => {
    const { tool } = hybridHarness();
    const [a, b] = await recordsFrom(tool, {});

    expect(a.payload.imports).toBe(3);
    expect(b.payload.imports).toBe(1);
    expect(a.rankingOverlay.file.imports).toBe(3);
  });

  it("keeps the overlay label of a labelled imports entry while its value becomes the count", async () => {
    const { captured } = makeHarness({
      findSymbol: vi.fn().mockResolvedValue({
        results: [
          { id: "a", score: 1, rankingOverlay: { preset: "x", chunk: { imports: { value: imports, label: "many" } } } },
        ],
      }),
    });
    const tool = captured.find((t) => t.name === "find_symbol")!;
    const result = (await tool.handler({ path: "/x", symbol: "A" }, {})) as {
      structuredContent: { results: { rankingOverlay: { chunk: Record<string, unknown> } }[] };
    };

    expect(result.structuredContent.results[0].rankingOverlay.chunk.imports).toEqual({ value: 3, label: "many" });
  });

  it("includeImports=true restores the import lists, and is not forwarded to the App", async () => {
    const { tool, app } = hybridHarness();
    const [a] = await recordsFrom(tool, { includeImports: true });

    expect(a.payload.imports).toEqual(imports);
    expect(a.rankingOverlay.file.imports).toEqual(imports);
    const call = (app.hybridSearch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("includeImports" in call).toBe(false);
  });

  it("every payload-bearing search tool accepts includeImports", () => {
    const { captured } = makeHarness();
    for (const tool of captured) {
      expect(tool.config.inputSchema).toHaveProperty("includeImports");
    }
  });

  it("ranks identically with and without includeImports: same order, same scores", async () => {
    const { tool } = hybridHarness();
    const lean = await recordsFrom(tool, {});
    const full = await recordsFrom(tool, { includeImports: true });

    expect(lean.map((r) => r.id)).toEqual(["a", "b"]);
    expect(lean.map((r) => [r.id, r.score])).toEqual(full.map((r) => [r.id, r.score]));
    expect(lean.map((r) => r.payload.imports)).not.toEqual(full.map((r) => r.payload.imports));
  });

  it("rounds non-integer numbers to 2 significant digits and passes integers through", async () => {
    const { tool } = hybridHarness();
    const [a, b] = await recordsFrom(tool, {});

    expect(a.score).toBe(0.91);
    expect((a.payload.codegraph as { symbols: { chunk: { pageRank: number } } }).symbols.chunk.pageRank).toBe(0.000052);
    expect(b.score).toBe(0.4);
    expect([b.payload.startLine, b.payload.endLine]).toEqual([10, 42]);
    expect(a.rankingOverlay.file.commitCount).toEqual({ value: 12, label: "high" });
    expect(a.id).toBe("a");
  });

  it("drops a column that is null in every row, e.g. the overlay of a non-reranked call", async () => {
    const { captured } = makeHarness({
      hybridSearch: vi.fn().mockResolvedValue({
        results: [
          { id: "a", score: 0.5, payload: { relativePath: "src/a.ts" }, rankingOverlay: undefined },
          { id: "b", score: 0.25, payload: { relativePath: "src/b.ts" }, rankingOverlay: undefined },
        ],
      }),
    });
    const tool = captured.find((t) => t.name === "hybrid_search")!;
    const result = (await tool.handler({ path: "/x", query: "q" }, {})) as {
      structuredContent: { results: { columns: string[] } };
    };

    expect(result.structuredContent.results.columns).toEqual(["id", "score", "payload.relativePath"]);
  });
});
