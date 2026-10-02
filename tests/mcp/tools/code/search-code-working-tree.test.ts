import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../../src/core/api/index.js";
import type { ExploreResponse } from "../../../../src/core/api/public/dto/explore.js";
import { registerSearchTools } from "../../../../src/mcp/tools/code/register-search-tools.js";
import { TYPED_FILTER_PARAM_NAMES } from "../../../../src/mcp/tools/schemas.js";

/** search_code renders the `workingTree` marker as its text line (bd tea-rags-mcp-xi2r9.1). */
describe("search_code — workingTree line", () => {
  const marker = {
    tree: "/repo/wt",
    indexedCommit: "0123456789abcdef0123456789abcdef01234567",
    treeCommit: "0123456789abcdef0123456789abcdef01234567",
    indexedDirty: false,
    changedFiles: 0,
    deletedFiles: 0,
    floors: [],
  };
  const line = "workingTree: /repo/wt · index @0123456 · tree @0123456 · changed 0 · deleted 0 · floors none";

  const invoke = async (response: ExploreResponse): Promise<string> => {
    let handler: ((args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined;
    const register = vi.fn((_server, _name, _config, h) => {
      handler = h;
    });
    const schemaBuilder = {
      buildRerankSchema: vi.fn(() => z.any()),
      buildFilterSchema: vi.fn(() => z.any()),
      filterParamNames: vi.fn(() => [...TYPED_FILTER_PARAM_NAMES]),
    } as unknown as SchemaBuilder;
    const app = { searchCode: vi.fn().mockResolvedValue(response) } as unknown as App;
    registerSearchTools({} as never, { app, schemaBuilder, register });
    const result = await handler!({ path: "/x", query: "q" });
    return result.content.map((c) => c.text).join("\n");
  };

  it("should append the marker line to a result listing", async () => {
    const text = await invoke({
      results: [{ id: "1", score: 0.9, payload: { relativePath: "a.ts", content: "x" } }],
      driftWarning: null,
      workingTree: marker,
    });

    expect(text).toContain(line);
  });

  it("should append the marker line to an empty answer", async () => {
    const text = await invoke({ results: [], driftWarning: null, workingTree: marker });

    expect(text).toContain("No results found");
    expect(text).toContain(line);
  });
});
