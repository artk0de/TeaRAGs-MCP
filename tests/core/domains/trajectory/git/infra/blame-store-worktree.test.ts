/**
 * GitBlameStore across linked worktrees — the namespace pin.
 *
 * Blame entries are OID-keyed and deliberately survive HEAD moves, so a linked
 * worktree and its main checkout (ONE object database, two working trees) must
 * share ONE cache namespace. Keying by working tree gave each worktree a cold
 * namespace: indexing a fresh worktree of an already-indexed monolith re-blamed
 * every file, including the ~half whose blob OID never changed.
 *
 * Pins: main-checkout save is visible to the worktree load; a cache written in
 * the pre-fix per-working-tree layout is still picked up (warm caches survive
 * the upgrade); unrelated repos stay isolated.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BlameLine } from "../../../../../../src/core/adapters/vcs/types.js";
import { GitBlameStore } from "../../../../../../src/core/domains/trajectory/git/infra/blame-store.js";

const TEST_TIMEOUT = 60000;
const SHA = "a".repeat(40);

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function fixtureFiles(): Map<string, { oid: string; lines: BlameLine[] }> {
  const line: BlameLine = {
    lineNumber: 1,
    sha: SHA,
    author: "Alice",
    authorEmail: "a@example.com",
    timestamp: 1700000001,
  };
  return new Map([["src/a.ts", { oid: "1".repeat(40), lines: [line] }]]);
}

describe("GitBlameStore across linked worktrees", () => {
  let root: string;
  let mainCheckout: string;
  let linkedWorktree: string;
  let otherRepo: string;
  let baseDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "blame-worktree-"));
    mainCheckout = join(root, "main");
    linkedWorktree = join(root, "wt");
    otherRepo = join(root, "other");

    for (const repo of [mainCheckout, otherRepo]) {
      mkdirSync(repo, { recursive: true });
      git(["init", "-b", "master"], repo);
      git(["config", "user.email", "test@example.com"], repo);
      git(["config", "user.name", "Test"], repo);
      writeFileSync(join(repo, "a.txt"), "one\n");
      git(["add", "-A"], repo);
      git(["commit", "-m", "first"], repo);
    }
    git(["worktree", "add", "--detach", linkedWorktree, "HEAD"], mainCheckout);
  }, TEST_TIMEOUT);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "blame-store-wt-"));
  });

  it("a blame map saved from the main checkout loads from its linked worktree", () => {
    const store = new GitBlameStore(baseDir);
    store.save(mainCheckout, fixtureFiles());

    const loaded = store.load(linkedWorktree);

    expect(loaded?.get("src/a.ts")).toEqual(fixtureFiles().get("src/a.ts"));
  });

  it("picks up a cache written in the pre-fix per-working-tree layout", () => {
    // Exactly what a pre-fix release persisted: sha256(workingTree) dir, and
    // the working tree recorded as the snapshot's repoRoot.
    const legacyDir = join(baseDir, createHash("sha256").update(linkedWorktree).digest("hex").slice(0, 16));
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "blame.json"),
      JSON.stringify({
        version: 1,
        repoRoot: linkedWorktree,
        commits: { [SHA]: { author: "Alice", authorEmail: "a@example.com", timestamp: 1700000001 } },
        files: { "src/a.ts": { oid: "1".repeat(40), lines: [[1, SHA]] } },
      }),
    );

    const loaded = new GitBlameStore(baseDir).load(linkedWorktree);

    expect(loaded?.get("src/a.ts")).toEqual(fixtureFiles().get("src/a.ts"));
  });

  it("keeps unrelated repositories isolated", () => {
    const store = new GitBlameStore(baseDir);
    store.save(mainCheckout, fixtureFiles());

    expect(store.load(otherRepo)).toBeNull();
  });
});
