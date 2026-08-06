import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../src/core/api/index.js";
import type { ExploreResponse } from "../../../src/core/api/public/dto/explore.js";
import { registerSearchTools, type McpAutoUpdateTrigger } from "../../../src/mcp/tools/explore.js";

type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<{
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}>;

function makeHarness(autoUpdate?: McpAutoUpdateTrigger) {
  const captured = new Map<string, ToolHandler>();
  const register = vi.fn((_server, name: string, _config, handler: ToolHandler) => {
    captured.set(name, handler);
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
    buildFilterSchema: vi.fn(() => z.any()),
  } as unknown as SchemaBuilder;

  const server = {} as Parameters<typeof registerSearchTools>[0];
  registerSearchTools(server, {
    app,
    schemaBuilder,
    register: register as never,
    ...(autoUpdate !== undefined ? { autoUpdate } : {}),
  });
  return { captured };
}

describe("registerSearchTools — auto-update hint (hpg2)", () => {
  it("appends the hint as a text content entry, structuredContent intact", async () => {
    const hintFor = vi.fn().mockReturnValue("index updating in background");
    const { captured } = makeHarness({ hintFor });
    const result = await captured.get("semantic_search")!({ project: "tea-rags", query: "x" }, {});
    expect(result.structuredContent).toEqual({ results: [] });
    expect(result.content).toEqual([{ type: "text", text: "index updating in background" }]);
  });

  it("passes the raw request identifiers to hintFor", async () => {
    const hintFor = vi.fn().mockReturnValue(null);
    const { captured } = makeHarness({ hintFor });
    await captured.get("hybrid_search")!({ collection: "code_x", query: "y" }, {});
    expect(hintFor).toHaveBeenCalledWith(expect.objectContaining({ collection: "code_x" }));
  });

  it("null hint leaves the response byte-identical", async () => {
    const { captured } = makeHarness({ hintFor: () => null });
    const result = await captured.get("find_symbol")!({ symbol: "X" }, {});
    expect(result.content).toEqual([]);
  });

  it("absent trigger dep keeps today's behavior exactly", async () => {
    const { captured } = makeHarness();
    const result = await captured.get("semantic_search")!({ query: "x" }, {});
    expect(result.content).toEqual([]);
  });
});
