import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VcsAdapterFactory } from "../../../../../../../src/core/adapters/vcs/factory.js";
import { BlameWorkerPool } from "../../../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js";

const TMP_BASE = realpathSync(tmpdir());
let repo: string;

function gitIn(cwd: string, args: string[]): void {
  if (!cwd.startsWith(TMP_BASE)) throw new Error(`refusing git outside temp: ${cwd}`);
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(TMP_BASE, "blame-pool-"));
  const g = (args: string[]): void => {
    gitIn(repo, args);
  };
  g(["init", "-q"]);
  writeFileSync(join(repo, "a.ts"), "const a = 1;\nconst b = 2;\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "c1"]);
  writeFileSync(join(repo, "a.ts"), "const a = 1;\nconst b = 3;\nconst c = 4;\n");
  writeFileSync(join(repo, "b.ts"), "export const x = 10;\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "c2"]);
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
