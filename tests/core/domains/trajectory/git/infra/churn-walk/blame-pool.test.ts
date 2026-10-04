import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importGitHistory } from "../../../../../__helpers__/git-history-import.js";
import { VcsAdapterFactory } from "../../../../../../../src/core/adapters/vcs/factory.js";
import { BlameWorkerPool } from "../../../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js";
import { GitEnrichmentProvider } from "../../../../../../../src/core/domains/trajectory/git/provider.js";

const TMP_BASE = realpathSync(tmpdir());
let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(TMP_BASE, "blame-pool-"));
  if (!repo.startsWith(TMP_BASE)) throw new Error(`refusing git outside temp: ${repo}`);
  // ONE fast-import instead of 5 init/add/commit spawns (bd tea-rags-mcp-1r3e5).
  const test = { name: "Test", email: "test@example.com" };
  const now = new Date();
  importGitHistory(repo, [
    { message: "c1", author: test, authorDate: now, writes: { "a.ts": "const a = 1;\nconst b = 2;\n" } },
    {
      message: "c2",
      author: test,
      authorDate: now,
      writes: { "a.ts": "const a = 1;\nconst b = 3;\nconst c = 4;\n", "b.ts": "export const x = 10;\n" },
    },
  ]);
}, 30000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("BlameWorkerPool", () => {
  it("computes blame off-thread equal to the inline es-git oracle", async () => {
    const oracle = await VcsAdapterFactory.create("es-git", repo);
    const expectedA = await oracle.blameFile("a.ts", 60000, 2);
    const expectedB = await oracle.blameFile("b.ts", 60000, 1);

    const pool = new BlameWorkerPool(2);
    try {
      const result = await pool.blame(
        repo,
        "es-git",
        [
          { relPath: "a.ts", historyDepthHint: 2 },
          { relPath: "b.ts", historyDepthHint: 1 },
        ],
        60000,
      );
      expect(result.get("a.ts")).toEqual(expectedA);
      expect(result.get("b.ts")).toEqual(expectedB);
    } finally {
      await pool.close();
    }
  }, 30000);

  it("returns an empty map for zero files without spawning a worker", async () => {
    const pool = new BlameWorkerPool(2);
    const result = await pool.blame(repo, "es-git", [], 60000);
    expect(result.size).toBe(0);
    await pool.close();
  });
});

describe("GitEnrichmentProvider file-phase blame through the real pool", () => {
  it("enriches a batch end-to-end via off-thread es-git workers, then finalizes clean", async () => {
    // Integration counterpart to the unit equivalence above: drive the REAL
    // provider file phase (not mocked) so shallow files blame in actual
    // worker_threads, and confirm the wiring spawns, blames, and tears down.
    const provider = new GitEnrichmentProvider({ vcsAdapter: "es-git" });
    try {
      const overlays = await provider.streamFileBatch(repo, ["a.ts", "b.ts"]);
      expect(overlays.size).toBe(2);
      expect(overlays.has("a.ts")).toBe(true);
      expect(overlays.has("b.ts")).toBe(true);
    } finally {
      await provider.finalizeSignals();
    }
  }, 30000);
});
