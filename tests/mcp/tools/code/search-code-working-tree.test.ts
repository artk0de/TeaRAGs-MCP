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

  /**
   * bd tea-rags-mcp-xi2r9 (live probe P2-5): search_code has no floor, so a
   * result of a file the tree changed or deleted shows the INDEX copy — and the
   * text said so nowhere but in two counts on the footer line.
   */
  describe("results of files the tree touched", () => {
    const hit = (relativePath: string, treeState?: "modified" | "deleted") => ({
      id: relativePath,
      score: 0.5,
      payload: { relativePath, startLine: 1, endLine: 3, language: "typescript", content: "x" },
      ...(treeState ? { treeState } : {}),
    });

    it("should tag each result of a modified or deleted file, and leave the others untagged", async () => {
      const text = await invoke({
        results: [hit("src/a.ts", "modified"), hit("src/b.ts"), hit("src/gone.ts", "deleted")],
        driftWarning: null,
        workingTree: { ...marker, changedFiles: 1, deletedFiles: 1 },
      });

      expect(text).toContain("File: src/a.ts:1-3 [modified in tree — index copy]");
      expect(text).toContain("File: src/b.ts:1-3\n");
      expect(text).toContain("File: src/gone.ts:1-3 [deleted in tree — index copy]");
    });

    it("should list the touched files of the answer once each in the footer", async () => {
      const text = await invoke({
        results: [hit("src/a.ts", "modified"), hit("src/a.ts", "modified"), hit("src/gone.ts", "deleted")],
        driftWarning: null,
        workingTree: { ...marker, changedFiles: 1, deletedFiles: 1 },
      });

      expect(text).toContain("Index copies of files the tree touched: src/a.ts (modified), src/gone.ts (deleted)");
    });

    it("should bound the footer list to ten files and count the rest", async () => {
      const results = Array.from({ length: 13 }, (_, i) => hit(`src/f${String(i)}.ts`, "modified"));
      const text = await invoke({ results, driftWarning: null, workingTree: { ...marker, changedFiles: 13 } });

      expect(text).toContain("src/f9.ts (modified) … 3 more");
      expect(text).not.toContain("src/f10.ts (modified)");
    });

    it("should print no footer list when no result belongs to a touched file", async () => {
      const text = await invoke({ results: [hit("src/b.ts")], driftWarning: null, workingTree: marker });

      expect(text).not.toContain("Index copies");
    });
  });
});
