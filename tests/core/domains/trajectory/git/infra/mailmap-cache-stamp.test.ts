/**
 * bd tea-rags-mcp-nsxzh — every persisted cache that holds author identities
 * is valid only for the `.mailmap` it was written under. A snapshot written
 * with no mailmap stays valid while the tree has none; adding or editing the
 * mailmap turns it into a miss (silent rebuild), so a new mapping reaches
 * unchanged files too.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BlameLine, CommitInfo } from "../../../../../../src/core/adapters/vcs/types.js";
import { GitBlameStore } from "../../../../../../src/core/domains/trajectory/git/infra/blame-store.js";
import { GitCommitDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery-store.js";
import { FileChurnDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery-store.js";

const HEAD = "a".repeat(40);
const SINCE_ISO = "2026-01-04T00:00:00.000Z";
const COMMIT: CommitInfo = {
  sha: "c".repeat(40),
  author: "Arthur",
  authorEmail: "art@example.com",
  timestamp: 1_700_000_000,
  body: "feat: x",
  parents: [],
};
const LINE: BlameLine = {
  lineNumber: 1,
  sha: COMMIT.sha,
  author: "Arthur",
  authorEmail: "art@example.com",
  timestamp: 1,
};

describe("author caches are stamped with the tree's .mailmap", () => {
  let repo: string;
  let data: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mailmap-stamp-repo-"));
    data = mkdtempSync(join(tmpdir(), "mailmap-stamp-data-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  const stores = () => ({
    commits: new GitCommitDiscoveryStore(join(data, "git-discovery")),
    churn: new FileChurnDiscoveryStore(join(data, "file-churn-discovery")),
    blame: new GitBlameStore(join(data, "git-blame")),
  });

  function saveAll(): void {
    const { commits, churn, blame } = stores();
    commits.save(repo, HEAD, SINCE_ISO, [{ commit: COMMIT, changedFiles: [{ path: "a.ts" }] }]);
    churn.save(repo, HEAD, SINCE_ISO, [{ commit: COMMIT, committerTimestamp: 1_700_000_000, files: [] }]);
    blame.save(repo, new Map([["a.ts", { oid: "o".repeat(40), lines: [LINE] }]]));
  }

  function loadAll(): unknown[] {
    const { commits, churn, blame } = stores();
    return [commits.load(repo, HEAD), commits.loadLatest(repo), churn.load(repo, HEAD), blame.load(repo)];
  }

  it("a snapshot written without a mailmap is still valid while the tree has none", () => {
    saveAll();
    for (const hit of loadAll()) expect(hit).not.toBeNull();
  });

  it("adding a .mailmap invalidates every snapshot written without one", () => {
    saveAll();
    writeFileSync(join(repo, ".mailmap"), "Arthur <art@example.com> <old@example.com>\n");
    for (const hit of loadAll()) expect(hit).toBeNull();
  });

  it("a snapshot written under a mailmap is valid for that mailmap and invalid after an edit", () => {
    writeFileSync(join(repo, ".mailmap"), "Arthur <art@example.com> <old@example.com>\n");
    saveAll();
    for (const hit of loadAll()) expect(hit).not.toBeNull();
    writeFileSync(join(repo, ".mailmap"), "Arthur <art@example.com> <other@example.com>\n");
    for (const hit of loadAll()) expect(hit).toBeNull();
  });
});
