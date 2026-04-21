import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../src/core/api/index.js";
import type { ExploreResponse } from "../../../src/core/api/public/dto/explore.js";
import { registerSearchTools } from "../../../src/mcp/tools/explore.js";

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

function makeHarness() {
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
  } as unknown as App;

  const schemaBuilder = {
    buildRerankSchema: vi.fn(() => z.any()),
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
