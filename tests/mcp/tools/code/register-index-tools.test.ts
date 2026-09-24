/**
 * `index_codebase` and the worktree seed (bd tea-rags-mcp-k8gac): the opt-out
 * parameter reaches the run, and the response says whether — and from which
 * sibling — the first index was seeded.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, IndexStats, WorktreeSeedReport } from "../../../../src/core/api/public/index.js";
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

const SEEDED: WorktreeSeedReport = {
  status: "seeded",
  source: { collectionName: "code_main", project: "tea-rags", path: "/repo/main" },
  filesCopied: 1200,
  filesIndexed: 34,
  filesRemoved: 2,
  gitRefresh: "background",
  rejected: [],
};

const seededRun: IndexStats = {
  filesScanned: 36,
  filesIndexed: 34,
  chunksCreated: 90,
  durationMs: 4200,
  status: "completed",
  changeDetails: {
    filesAdded: 10,
    filesModified: 24,
    filesDeleted: 2,
    filesNewlyIgnored: 0,
    filesNewlyUnignored: 0,
    chunksAdded: 90,
    chunksDeleted: 70,
    filesRetried: 0,
  },
  worktreeSeed: SEEDED,
};

describe("index_codebase — worktree seed", () => {
  it("accepts seedFromWorktree, coercing the string forms MCP clients send", () => {
    expect(z.object(IndexCodebaseSchema).parse({ path: "/repo", seedFromWorktree: "false" }).seedFromWorktree).toBe(
      false,
    );
  });

  it("forwards the opt-out to the run", async () => {
    const { handler, app } = harness(seededRun);
    await handler({ path: "/repo/wt", seedFromWorktree: false }, {});
    expect(app.indexCodebase).toHaveBeenCalledWith(
      "/repo/wt",
      expect.objectContaining({ seedFromWorktree: false }),
      expect.any(Function),
    );
  });

  it("opens the response with the seed: which sibling, how many files copied vs embedded", async () => {
    const { handler } = harness(seededRun);
    const [{ text }] = (await handler({ path: "/repo/wt" }, {})).content;
    expect(text.startsWith("Worktree seed:\n  seeded from tea-rags (/repo/main): 1200 files copied, 34 embedded")).toBe(
      true,
    );
    expect(text).toContain("git signals: rebuilding against this worktree's history (background)");
  });

  it("says nothing about seeding for a run that was no first index", async () => {
    const { handler } = harness({ ...seededRun, worktreeSeed: undefined });
    const [{ text }] = (await handler({ path: "/repo/wt" }, {})).content;
    expect(text).not.toContain("Worktree seed");
  });
});

describe("index_codebase — partial incremental run (bd tea-rags-mcp-6l1w6)", () => {
  const cleanRun: IndexStats = { ...seededRun, worktreeSeed: undefined };

  it("warns how many files kept stale chunks, and that the next reindex retries them", async () => {
    const { handler } = harness({
      ...cleanRun,
      status: "partial",
      errors: [],
      changeDetails: { ...cleanRun.changeDetails!, filesSkippedDueToDeleteFailure: 3, filesFailedToDelete: 1 },
    });
    const [{ text }] = (await handler({ path: "/repo" }, {})).content;

    expect(text).toContain(
      "Warning: partial run — old chunks could not be deleted for 4 file(s) " +
        "(1 removed, 3 modified not re-indexed); the next reindex retries them.",
    );
    // No empty "Warnings:" block when the run carries no error strings.
    expect(text).not.toContain("Warnings:");
  });

  it("names only the counter that is set", async () => {
    const { handler } = harness({
      ...cleanRun,
      status: "partial",
      changeDetails: { ...cleanRun.changeDetails!, filesFailedToDelete: 2 },
    });
    const [{ text }] = (await handler({ path: "/repo" }, {})).content;

    expect(text).toContain("old chunks could not be deleted for 2 file(s) (2 removed);");
  });

  it("prints no warning for a completed run", async () => {
    const { handler } = harness(cleanRun);
    const [{ text }] = (await handler({ path: "/repo" }, {})).content;
    expect(text).not.toContain("Warning");
  });
});
