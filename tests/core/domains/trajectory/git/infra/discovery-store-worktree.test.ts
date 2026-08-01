/**
 * Commit-discovery + file-churn-discovery stores across linked worktrees.
 *
 * A linked worktree and its main checkout share ONE object database, so they
 * must share ONE discovery namespace: at equal HEAD the worktree then gets an
 * exact hit instead of a full repo-wide `git log --numstat` (taxdome: 104 MB /
 * 123 s), and at a divergent HEAD it can top up from the neighbour's matrix.
 *
 * Sharing the namespace also means several HEADs legitimately coexist in one
 * directory, which is why `save` retains the newest few snapshots rather than
 * dropping every other file — otherwise each checkout would evict the other's
 * matrix and both would fall back to a full rebuild on every run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../src/core/adapters/vcs/types.js";
import { GitCommitDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery-store.js";
import type { GitCommitDiscoveryEntry } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";
import { FileChurnDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery-store.js";
import type { CommitFileNumstat } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";

const TEST_TIMEOUT = 60000;
const SINCE_ISO = "2026-01-04T00:00:00.000Z";
const head = (c: string): string => c.repeat(40);

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function commit(sha: string): CommitInfo {
  return { sha, author: "Alice", authorEmail: "alice@ex.com", timestamp: 1000, body: "feat: x", parents: [] };
}

const commitEntries = (): GitCommitDiscoveryEntry[] => [{ commit: commit(head("c")), changedFiles: ["a.ts", "b.ts"] }];

const churnEntries = (): CommitFileNumstat[] => [
  { commit: commit(head("c")), committerTimestamp: 1000, files: [{ path: "a.ts", added: 3, deleted: 1 }] },
];

/** Both stores share a save/load/loadLatest shape; drive them through one seam. */
type StoreDriver = {
  name: string;
  save: (baseDir: string, repoRoot: string, headSha: string) => void;
  loadLatestHead: (baseDir: string, repoRoot: string) => string | undefined;
};

const DRIVERS: StoreDriver[] = [
  {
    name: "GitCommitDiscoveryStore",
    save: (baseDir, repoRoot, headSha) => {
      new GitCommitDiscoveryStore(baseDir).save(repoRoot, headSha, SINCE_ISO, commitEntries());
    },
    loadLatestHead: (baseDir, repoRoot) => new GitCommitDiscoveryStore(baseDir).loadLatest(repoRoot)?.head,
  },
  {
    name: "FileChurnDiscoveryStore",
    save: (baseDir, repoRoot, headSha) => {
      new FileChurnDiscoveryStore(baseDir).save(repoRoot, headSha, SINCE_ISO, churnEntries());
    },
    loadLatestHead: (baseDir, repoRoot) => new FileChurnDiscoveryStore(baseDir).loadLatest(repoRoot)?.head,
  },
];

describe.each(DRIVERS)("$name across linked worktrees", (driver) => {
  let root: string;
  let mainCheckout: string;
  let linkedWorktree: string;
  let baseDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "discovery-worktree-"));
    mainCheckout = join(root, "main");
    linkedWorktree = join(root, "wt");
    mkdirSync(mainCheckout, { recursive: true });

    git(["init", "-b", "master"], mainCheckout);
    git(["config", "user.email", "test@example.com"], mainCheckout);
    git(["config", "user.name", "Test"], mainCheckout);
    writeFileSync(join(mainCheckout, "a.txt"), "one\n");
    git(["add", "-A"], mainCheckout);
    git(["commit", "-m", "first"], mainCheckout);
    git(["worktree", "add", "--detach", linkedWorktree, "HEAD"], mainCheckout);
  }, TEST_TIMEOUT);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "discovery-store-wt-"));
  });

  it("a matrix saved from the main checkout is visible to its linked worktree", () => {
    driver.save(baseDir, mainCheckout, head("a"));

    expect(driver.loadLatestHead(baseDir, linkedWorktree)).toBe(head("a"));
  });

  it("a worktree save does NOT evict the main checkout's matrix", () => {
    driver.save(baseDir, mainCheckout, head("a"));
    driver.save(baseDir, linkedWorktree, head("b"));

    // Both snapshots survive — each checkout keeps a top-up base for its HEAD.
    expect(driver.loadLatestHead(baseDir, mainCheckout)).toBe(head("b"));
    expect(existsSync(join(repoDirOf(baseDir), `${head("a")}.json`))).toBe(true);
  });

  it("retains only the newest few snapshots so the directory cannot grow without bound", () => {
    const shas = ["a", "b", "c", "d"].map(head);
    shas.forEach((sha, i) => {
      driver.save(baseDir, mainCheckout, sha);
      // Force a distinct, increasing mtime — retention orders by it.
      const t = new Date(1_700_000_000_000 + i * 60_000);
      utimesSync(join(repoDirOf(baseDir), `${sha}.json`), t, t);
    });

    const survivors = shas.filter((sha) => existsSync(join(repoDirOf(baseDir), `${sha}.json`)));
    expect(survivors).toEqual(shas.slice(1));
  });

  /** Resolve the on-disk namespace dir — one per repo, whichever tree wrote it. */
  function repoDirOf(base: string): string {
    // Single repo per test → exactly one namespace dir under baseDir.
    const [only] = readdirSync(base);
    return join(base, only);
  }
});
