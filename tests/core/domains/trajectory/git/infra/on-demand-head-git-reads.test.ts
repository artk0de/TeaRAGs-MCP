/**
 * bd tea-rags-mcp-89k7k.35.23 / 89k7k.35.24 — `OnDemandHeadGitReadMemo`: the
 * whole-repository reads an on-demand computation needs that depend on nothing
 * but (repository, HEAD) — the lifetime walk and the HEAD commit time — read
 * once per HEAD, with `GitEnrichmentProvider#getRunLifetime`'s shape: the
 * PROMISE is memoized (concurrent callers share one read), a failed read is
 * not, and a new HEAD replaces the entry. Handing the memoized reads to
 * `buildOnDemandGitSignals` changes no signal — including the stamps an
 * untracked file at a deleted path inherits from that path's history (ingest
 * folds lifetime stamps by path, `foldFileLifetimeStamps`).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../../__helpers__/git-working-tree-fixture.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { CommitPathChanges, VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/index.js";
import { OnDemandHeadGitReadMemo } from "../../../../../../src/core/domains/trajectory/git/infra/on-demand-head-git-reads.js";
import {
  buildOnDemandGitSignals,
  type OnDemandGitSignalOptions,
  type OnDemandGitSignalTarget,
} from "../../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js";

vi.setConfig({ testTimeout: 60_000 });

const PATH_LOG: CommitPathChanges[] = [
  { sha: "b".repeat(40), timestamp: 2_000, changedFiles: [{ path: "src/a.ts" }] },
  { sha: "a".repeat(40), timestamp: 1_000, changedFiles: [{ path: "src/a.ts" }] },
];

interface FakeHeadReads {
  adapter: VcsGitAdapter;
  readCommitPathChanges: ReturnType<typeof vi.fn>;
  readHeadCommitTime: ReturnType<typeof vi.fn>;
}

function fakeAdapter(repoRoot = "/repo"): FakeHeadReads {
  const readCommitPathChanges = vi.fn(async () => PATH_LOG);
  const readHeadCommitTime = vi.fn(async () => 1_700_000_000);
  return {
    adapter: { repoRoot, readCommitPathChanges, readHeadCommitTime } as unknown as VcsGitAdapter,
    readCommitPathChanges,
    readHeadCommitTime,
  };
}

describe("OnDemandHeadGitReadMemo", () => {
  it("reads the lifetime walk once per (repository, HEAD), concurrent callers included", async () => {
    const { adapter, readCommitPathChanges } = fakeAdapter();
    const memo = new OnDemandHeadGitReadMemo();

    const [first, second] = await Promise.all([
      memo.fileLifetimeStamps(adapter, "h1", 1_000),
      memo.fileLifetimeStamps(adapter, "h1", 1_000),
    ]);
    const third = await memo.fileLifetimeStamps(adapter, "h1", 1_000);

    expect(readCommitPathChanges).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.get("src/a.ts")).toMatchObject({ firstCreatedAt: 1_000, lastModifiedAt: 2_000 });
  });

  it("a new HEAD replaces the entry; a separate repository keeps its own", async () => {
    const one = fakeAdapter("/one");
    const two = fakeAdapter("/two");
    const memo = new OnDemandHeadGitReadMemo();

    await memo.fileLifetimeStamps(one.adapter, "h1", 1_000);
    await memo.fileLifetimeStamps(two.adapter, "h1", 1_000);
    await memo.fileLifetimeStamps(one.adapter, "h2", 1_000);
    await memo.fileLifetimeStamps(one.adapter, "h1", 1_000);
    await memo.fileLifetimeStamps(two.adapter, "h1", 1_000);

    expect(one.readCommitPathChanges).toHaveBeenCalledTimes(3);
    expect(two.readCommitPathChanges).toHaveBeenCalledTimes(1);
  });

  it("a failed lifetime read rejects its callers and is read again by the next one", async () => {
    const { adapter, readCommitPathChanges } = fakeAdapter();
    readCommitPathChanges.mockRejectedValueOnce(new Error("stalled"));
    const memo = new OnDemandHeadGitReadMemo();

    await expect(memo.fileLifetimeStamps(adapter, "h1", 1_000)).rejects.toThrow("stalled");
    const retried = await memo.fileLifetimeStamps(adapter, "h1", 1_000);

    expect(readCommitPathChanges).toHaveBeenCalledTimes(2);
    expect(retried.has("src/a.ts")).toBe(true);
  });

  it("reads the HEAD commit time once per (repository, HEAD); an unreadable one is read again", async () => {
    const { adapter, readHeadCommitTime } = fakeAdapter();
    readHeadCommitTime.mockRejectedValueOnce(new Error("gone"));
    const memo = new OnDemandHeadGitReadMemo();

    expect(await memo.historyAnchorSec(adapter, "h1", 1_000)).toBeUndefined();
    const [a, b] = await Promise.all([
      memo.historyAnchorSec(adapter, "h1", 1_000),
      memo.historyAnchorSec(adapter, "h1", 1_000),
    ]);
    await memo.historyAnchorSec(adapter, "h1", 1_000);
    await memo.historyAnchorSec(adapter, "h2", 1_000);

    expect(a).toBe(1_700_000_000);
    expect(b).toBe(1_700_000_000);
    expect(readHeadCommitTime).toHaveBeenCalledTimes(3);
  });

  it("the lifetime and anchor reads of one HEAD live in one entry: a new HEAD drops both", async () => {
    const { adapter, readCommitPathChanges, readHeadCommitTime } = fakeAdapter();
    const memo = new OnDemandHeadGitReadMemo();

    await memo.fileLifetimeStamps(adapter, "h1", 1_000);
    await memo.historyAnchorSec(adapter, "h1", 1_000);
    await memo.historyAnchorSec(adapter, "h2", 1_000);
    await memo.fileLifetimeStamps(adapter, "h1", 1_000);

    expect(readCommitPathChanges).toHaveBeenCalledTimes(2);
    expect(readHeadCommitTime).toHaveBeenCalledTimes(2);
  });
});

describe("buildOnDemandGitSignals with memoized HEAD reads — result equivalence", () => {
  let fixture: GitWorkingTreeFixture;
  let repo: string;
  let deletionSha: string;

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    repo = fixture.mainRoot;
    // A path created and deleted long before the file window: an untracked
    // file written there later has no commit in the window, so its age
    // stamps come from the lifetime walk — keyed by path, as ingest folds them.
    vi.stubEnv("GIT_AUTHOR_DATE", "2015-01-01T00:00:00Z");
    vi.stubEnv("GIT_COMMITTER_DATE", "2015-01-01T00:00:00Z");
    fixture.commit(repo, { "src/gone.ts": "export const gone = 1;\n" }, "add gone");
    vi.stubEnv("GIT_AUTHOR_DATE", "2015-02-01T00:00:00Z");
    vi.stubEnv("GIT_COMMITTER_DATE", "2015-02-01T00:00:00Z");
    fixture.git(repo, "rm", "-q", "src/gone.ts");
    fixture.git(repo, "commit", "-q", "-m", "drop gone");
    deletionSha = fixture.git(repo, "rev-parse", "HEAD").trim();
    vi.unstubAllEnvs();
    fixture.commit(repo, { "src/kept.ts": "export const kept = 1;\n" }, "add kept");
    writeFileSync(join(repo, "src/gone.ts"), "export const gone = 2;\n");
    writeFileSync(join(repo, "src/fresh.ts"), "export const fresh = 1;\n");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  const targets: OnDemandGitSignalTarget[] = ["src/gone.ts", "src/fresh.ts", "src/kept.ts"].map((relPath, i) => ({
    relPath,
    lineCount: 1,
    fileSignals: true,
    workingContent: relPath === "src/gone.ts" ? "export const gone = 2;\n" : `export const x${i} = 1;\n`,
    chunks: [{ chunkId: `${relPath}#r`, startLine: 1, endLine: 1 }],
  }));
  const options: OnDemandGitSignalOptions = {
    timeoutMs: 30_000,
    file: { maxAgeMonths: 12 },
    chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
    anchor: "head",
  };

  it("signals with the memoized reads deep-equal signals without them, inherited stamps included", async () => {
    const adapter = new GitCliAdapter(repo);
    const head = await adapter.getHead();
    const memo = new OnDemandHeadGitReadMemo();
    const memoized = async () => {
      const historyAnchorSec = await memo.historyAnchorSec(adapter, head, options.timeoutMs);
      return buildOnDemandGitSignals(adapter, targets, {
        ...options,
        head,
        ...(historyAnchorSec !== undefined ? { historyAnchorSec } : {}),
        fileLifetimeStamps: async () => memo.fileLifetimeStamps(adapter, head, options.timeoutMs),
      });
    };

    const plain = await buildOnDemandGitSignals(adapter, targets, options);
    const cold = await memoized();
    const warm = await memoized();

    expect(cold).toEqual(plain);
    expect(warm).toEqual(plain);
    expect(plain.get("src/gone.ts")?.file).toMatchObject({
      firstCreatedAt: Date.parse("2015-01-01T00:00:00Z") / 1000,
      lastModifiedAt: Date.parse("2015-02-01T00:00:00Z") / 1000,
      lastCommitHash: deletionSha,
    });
    expect(plain.has("src/fresh.ts")).toBe(true);
    expect(plain.get("src/fresh.ts")?.file).toBeUndefined();
  });
});
