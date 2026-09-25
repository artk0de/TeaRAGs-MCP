/**
 * `index_codebase` scoped force (bd tea-rags-mcp-j4oww): the file filters reach
 * the run, a single `fileExtension` is accepted the way search accepts it, and
 * the response names how many files were re-chunked in place.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, IndexStats } from "../../../../src/core/api/public/index.js";
import { registerIndexTools } from "../../../../src/mcp/tools/code/register-index-tools.js";
import { IndexCodebaseSchema } from "../../../../src/mcp/tools/schemas.js";

type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<{ content: { type: "text"; text: string }[] }>;

function harness(stats: IndexStats) {
  const captured = new Map<string, ToolHandler>();
  const register = vi.fn((_server: unknown, name: string, _config: unknown, handler: ToolHandler) => {
    captured.set(name, handler);
  });
  const app = {
    indexCodebase: vi.fn().mockResolvedValue(stats),
    getIndexStatus: vi.fn().mockResolvedValue({ isIndexed: true, status: "indexed" }),
  } as unknown as App;
  registerIndexTools({} as never, { app, register: register as never });
  return { handler: captured.get("index_codebase")!, app };
}

const scopedRun: IndexStats = {
  filesScanned: 12,
  filesIndexed: 12,
  chunksCreated: 40,
  durationMs: 3100,
  status: "completed",
  changeDetails: {
    filesAdded: 0,
    filesModified: 12,
    filesDeleted: 0,
    filesNewlyIgnored: 0,
    filesNewlyUnignored: 0,
    chunksAdded: 40,
    chunksDeleted: 35,
    filesRetried: 0,
    filesRechunked: 12,
  },
};

const parse = (input: unknown) => z.object(IndexCodebaseSchema).parse(input);

describe("index_codebase — scoped force", () => {
  it("accepts the scope filters, a single fileExtension as a string", () => {
    const parsed = parse({
      path: "/repo",
      forceReindex: "true",
      languages: ["ruby"],
      testFile: "only",
      pathPattern: "spec/**",
      fileExtension: ".rb",
      files: ["spec/a_spec.rb"],
    });
    expect(parsed).toMatchObject({ testFile: "only", pathPattern: "spec/**", fileExtension: ".rb" });
  });

  it("refuses testFile include — it restricts nothing on a rechunk", () => {
    expect(() => parse({ path: "/repo", testFile: "include" })).toThrow();
  });

  it("forwards every filter to the run, fileExtension normalized to a list", async () => {
    const { handler, app } = harness(scopedRun);
    await handler(
      {
        path: "/repo",
        forceReindex: true,
        languages: ["ruby"],
        testFile: "only",
        pathPattern: "spec/**",
        fileExtension: ".rb",
        files: ["spec/a_spec.rb"],
      },
      {},
    );
    expect(app.indexCodebase).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        forceReindex: true,
        languages: ["ruby"],
        testFile: "only",
        pathPattern: "spec/**",
        fileExtensions: [".rb"],
        files: ["spec/a_spec.rb"],
      }),
      expect.any(Function),
    );
  });

  it("passes no scope keys when none were given", async () => {
    const { handler, app } = harness(scopedRun);
    await handler({ path: "/repo" }, {});
    const options = (app.indexCodebase as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    for (const key of ["languages", "testFile", "pathPattern", "fileExtensions", "files"]) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it("says how many files were re-chunked in place", async () => {
    const { handler } = harness(scopedRun);
    const [{ text }] = (await handler({ path: "/repo", forceReindex: true, testFile: "only" }, {})).content;
    expect(text).toContain("Re-chunked in place (scoped force): 12");
  });
});
