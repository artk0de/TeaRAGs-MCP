/**
 * bd tea-rags-mcp-82va1 — run-scoped commit-discovery matrix.
 *
 * ONE repo-wide `git log --since --numstat` per indexing run builds a
 * commitSha → changedFiles matrix; per-batch walks slice it in-memory and
 * consume ONE shared bugFixShaSet. A persistent store keyed (repoRoot, HEAD)
 * lets later runs skip the log entirely (exact-HEAD hit) or top up via
 * `git log oldHead..newHead` (prior-HEAD ancestor hit).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import type { CommitInfo } from "../../../../../../src/core/adapters/vcs/types.js";
import {
  GitCommitDiscovery,
  type GitCommitDiscoveryEntry,
  type GitCommitDiscoveryPersistence,
  type PersistedGitCommitDiscovery,
} from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";

// Enable cross-module spy interception for adapter functions.
vi.mock("../../../../../../src/core/adapters/vcs/git/git-cli/client.js", async (importOriginal) => importOriginal());

const HEAD = "h".repeat(40);
const PRIOR_HEAD = "g".repeat(40);

function commit(sha: string, body = "feat: change", parents: string[] = []): CommitInfo {
  return { sha, author: "Alice", authorEmail: "alice@ex.com", timestamp: 1000, body, parents };
}

function entry(sha: string, changedFiles: string[], body?: string, parents?: string[]): GitCommitDiscoveryEntry {
  return { commit: commit(sha, body, parents), changedFiles };
}

/** Fake in-memory persistence — every method is a vi.fn for call assertions. */
function fakeStore(overrides: Partial<GitCommitDiscoveryPersistence> = {}): {
  load: ReturnType<typeof vi.fn>;
  loadLatest: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn().mockReturnValue(null),
    loadLatest: vi.fn().mockReturnValue(null),
    save: vi.fn(),
    ...overrides,
  } as never;
}

function persisted(head: string, sinceIso: string, entries: GitCommitDiscoveryEntry[]): PersistedGitCommitDiscovery {
  return { version: 1, repoRoot: "/repo", head, sinceIso, entries };
}

/** The exact legacy window formula (walk-commits.ts:105-106). */
function legacySinceMs(maxAgeMonths: number): number {
  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  return Date.now() - effectiveMonths * 30 * 86400 * 1000;
}

describe("GitCommitDiscovery (bd tea-rags-mcp-82va1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the matrix from ONE repo-wide log and slices per file set preserving log order", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    const sinceSpy = vi
      .spyOn(gitClient, "getCommitsSince")
      .mockResolvedValue([entry("sha3", ["a.ts"]), entry("sha2", ["b.ts", "a.ts"]), entry("sha1", ["a.ts"])]);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000 });

    const forA = await discovery.commitsForFiles(["a.ts"]);
    expect(forA.map((e) => e.commit.sha)).toEqual(["sha3", "sha2", "sha1"]);
    // Rows carry FULL changedFiles — the walk filters.
    expect(forA[1].changedFiles).toEqual(["b.ts", "a.ts"]);

    const forB = await discovery.commitsForFiles(["b.ts"]);
    expect(forB.map((e) => e.commit.sha)).toEqual(["sha2"]);

    expect(await discovery.commitsForFiles(["unknown.ts"])).toEqual([]);
    // ONE repo-wide log for all three slices.
    expect(sinceSpy).toHaveBeenCalledTimes(1);
    expect(sinceSpy).toHaveBeenCalledWith("/repo", expect.any(Date), 5000);
  });

  it("single-flights concurrent first calls (getCommitsSince called once across Promise.all)", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    const sinceSpy = vi.spyOn(gitClient, "getCommitsSince").mockResolvedValue([entry("sha1", ["a.ts"])]);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000 });

    await Promise.all([discovery.commitsForFiles(["a.ts"]), discovery.getBugFixShas()]);

    expect(sinceSpy).toHaveBeenCalledTimes(1);
  });

  it("builds the bugFixShaSet over ALL matrix commits (superset semantics)", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    vi.spyOn(gitClient, "getCommitsSince").mockResolvedValue([
      entry("mergesha", ["merged.ts"], "Merge branch 'fix/crash'", ["sha1", "sha2"]),
      entry("sha2", ["b.ts"], "restore ordering", ["sha1"]),
      entry("sha1", ["a.ts"], "feat: base", []),
      entry("sha0", ["c.ts"], "feat: unrelated", []),
    ]);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000 });

    const shas = await discovery.getBugFixShas();

    expect(shas.has("sha2")).toBe(true);
    expect(shas.has("sha0")).toBe(false);
    expect(shas.has("mergesha")).toBe(false);
  });

  it("exact-HEAD store hit skips the log entirely and does NOT re-save", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    const sinceSpy = vi.spyOn(gitClient, "getCommitsSince").mockResolvedValue([]);
    const freshIso = new Date(legacySinceMs(6)).toISOString();
    const store = fakeStore({
      load: vi.fn().mockReturnValue(persisted(HEAD, freshIso, [entry("sha1", ["a.ts"])])),
    } as never);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000, store });

    const forA = await discovery.commitsForFiles(["a.ts"]);

    expect(forA.map((e) => e.commit.sha)).toEqual(["sha1"]);
    expect(store.load).toHaveBeenCalledWith("/repo", HEAD);
    expect(sinceSpy).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("tops up from a prior-HEAD ancestor snapshot via getCommitsInRange (no full log)", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    const sinceSpy = vi.spyOn(gitClient, "getCommitsSince").mockResolvedValue([]);
    const ancestorSpy = vi.spyOn(gitClient, "isAncestor").mockResolvedValue(true);
    const rangeSpy = vi.spyOn(gitClient, "getCommitsInRange").mockResolvedValue([entry("freshsha", ["a.ts"])]);
    const priorIso = new Date(legacySinceMs(6)).toISOString();
    const priorEntries = [entry("oldsha", ["a.ts"])];
    const store = fakeStore({
      loadLatest: vi.fn().mockReturnValue(persisted(PRIOR_HEAD, priorIso, priorEntries)),
    } as never);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000, store });

    const forA = await discovery.commitsForFiles(["a.ts"]);

    // Merged newest→oldest: fresh range commits first, then the prior matrix.
    expect(forA.map((e) => e.commit.sha)).toEqual(["freshsha", "oldsha"]);
    expect(ancestorSpy).toHaveBeenCalledWith("/repo", PRIOR_HEAD, HEAD);
    expect(rangeSpy).toHaveBeenCalledTimes(1);
    expect(rangeSpy).toHaveBeenCalledWith("/repo", PRIOR_HEAD, HEAD, expect.any(Date), 5000);
    expect(sinceSpy).not.toHaveBeenCalled();
    // Window inherited from the prior snapshot.
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith("/repo", HEAD, priorIso, [
      expect.objectContaining({ commit: expect.objectContaining({ sha: "freshsha" }) }),
      expect.objectContaining({ commit: expect.objectContaining({ sha: "oldsha" }) }),
    ]);
  });

  it("rebuilds fully when the prior snapshot HEAD is not an ancestor", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    const sinceSpy = vi.spyOn(gitClient, "getCommitsSince").mockResolvedValue([entry("sha1", ["a.ts"])]);
    vi.spyOn(gitClient, "isAncestor").mockResolvedValue(false);
    const rangeSpy = vi.spyOn(gitClient, "getCommitsInRange").mockResolvedValue([]);
    const priorIso = new Date(legacySinceMs(6)).toISOString();
    const store = fakeStore({
      loadLatest: vi.fn().mockReturnValue(persisted(PRIOR_HEAD, priorIso, [entry("oldsha", ["a.ts"])])),
    } as never);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000, store });

    const forA = await discovery.commitsForFiles(["a.ts"]);

    expect(forA.map((e) => e.commit.sha)).toEqual(["sha1"]);
    expect(rangeSpy).not.toHaveBeenCalled();
    expect(sinceSpy).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith("/repo", HEAD, expect.any(String), [
      expect.objectContaining({ commit: expect.objectContaining({ sha: "sha1" }) }),
    ]);
  });

  it("rebuilds fully when the cached window drifted beyond the 24h tolerance", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    const sinceSpy = vi.spyOn(gitClient, "getCommitsSince").mockResolvedValue([entry("sha1", ["a.ts"])]);
    const rangeSpy = vi.spyOn(gitClient, "getCommitsInRange").mockResolvedValue([]);
    // 40 days older than the wanted window — far beyond the 24h tolerance.
    const driftedIso = new Date(legacySinceMs(6) - 40 * 86400 * 1000).toISOString();
    const store = fakeStore({
      load: vi.fn().mockReturnValue(persisted(HEAD, driftedIso, [entry("stale", ["a.ts"])])),
      loadLatest: vi.fn().mockReturnValue(persisted(HEAD, driftedIso, [entry("stale", ["a.ts"])])),
    } as never);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000, store });

    const forA = await discovery.commitsForFiles(["a.ts"]);

    expect(forA.map((e) => e.commit.sha)).toEqual(["sha1"]);
    expect(rangeSpy).not.toHaveBeenCalled();
    expect(sinceSpy).toHaveBeenCalledTimes(1);
  });

  it("works without a store — plain single discovery", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue(HEAD);
    const sinceSpy = vi.spyOn(gitClient, "getCommitsSince").mockResolvedValue([entry("sha1", ["a.ts"])]);
    const discovery = new GitCommitDiscovery("/repo", { maxAgeMonths: 6, timeoutMs: 5000 });

    expect((await discovery.commitsForFiles(["a.ts"])).map((e) => e.commit.sha)).toEqual(["sha1"]);
    expect(await discovery.commitsForFiles(["a.ts"])).toHaveLength(1);
    expect(sinceSpy).toHaveBeenCalledTimes(1);
  });
});
