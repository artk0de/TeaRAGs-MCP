/**
 * bd tea-rags-mcp file-signal commit-cache — incremental delta-merge +
 * window-eviction commit cache aggregating per-file `FileChurnData`.
 *
 * The FILE analogue of `GitCommitDiscovery`: same exact-HEAD / prior-ancestor
 * top-up / full-rebuild resolve+staleness logic over `readCommitFileNumstat`,
 * PLUS two steps the chunk path lacks — evict commits below the window lower
 * bound (epoch-seconds compare) and aggregate into `Map<string, FileChurnData>`.
 * The windowed-equality test is the guard: warm-cache incremental MUST equal a
 * cold full recompute for the same HEAD+window.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import type { CommitFileNumstat, CommitInfo } from "../../../../../../src/core/adapters/vcs/types.js";
import {
  FileChurnDiscovery,
  type FileChurnDiscoveryPersistence,
  type PersistedFileChurnDiscovery,
} from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";

const HEAD = "h".repeat(40);
const PRIOR_HEAD = "g".repeat(40);
const NOW_SEC = Math.floor(Date.now() / 1000);

function commit(sha: string, timestamp = NOW_SEC - 1000): CommitInfo {
  return { sha, author: "Alice", authorEmail: "alice@ex.com", timestamp, body: "feat: change", parents: [] };
}

function fileEntry(
  sha: string,
  files: { path: string; added: number; deleted: number }[],
  timestamp?: number,
): CommitFileNumstat {
  return { commit: commit(sha, timestamp), files };
}

/** The exact legacy window formula (mirrors walk-commits.ts). */
function legacySinceMs(maxAgeMonths: number): number {
  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  return Date.now() - effectiveMonths * 30 * 86400 * 1000;
}

function persisted(head: string, sinceIso: string, entries: CommitFileNumstat[]): PersistedFileChurnDiscovery {
  return { version: 1, repoRoot: "/repo", head, sinceIso, entries };
}

/** Fake in-memory persistence — every method is a vi.fn for call assertions. */
function fakeStore(overrides: Partial<FileChurnDiscoveryPersistence> = {}): {
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

interface FakeGitAdapter {
  repoRoot: string;
  getHead: ReturnType<typeof vi.fn>;
  isAncestor: ReturnType<typeof vi.fn>;
  readCommitFileNumstat: ReturnType<typeof vi.fn>;
}

/** Minimal VcsGitAdapter stub exposing only what FileChurnDiscovery consumes. */
function fakeAdapter(opts: {
  head?: string;
  isAncestor?: boolean;
  readCommitFileNumstat?: (
    sinceDate?: Date,
    range?: { fromSha: string; toSha: string },
    timeoutMs?: number,
  ) => Promise<CommitFileNumstat[]>;
}): FakeGitAdapter {
  return {
    repoRoot: "/repo",
    getHead: vi.fn().mockResolvedValue(opts.head ?? HEAD),
    isAncestor: vi.fn().mockResolvedValue(opts.isAncestor ?? false),
    readCommitFileNumstat: vi.fn(opts.readCommitFileNumstat ?? (async () => [])),
  };
}

function asAdapter(fake: FakeGitAdapter): VcsGitAdapter {
  return fake as unknown as VcsGitAdapter;
}

describe("FileChurnDiscovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warm-cache incremental == cold full recompute (windowed equality)", async () => {
    // Window W at HEAD c3 over three commits, multi-file so aggregation is exercised.
    const c3 = fileEntry("3".repeat(40), [
      { path: "a.ts", added: 10, deleted: 2 },
      { path: "b.ts", added: 3, deleted: 0 },
    ]);
    const c2 = fileEntry("2".repeat(40), [{ path: "a.ts", added: 5, deleted: 1 }]);
    const c1 = fileEntry("1".repeat(40), [
      { path: "a.ts", added: 1, deleted: 0 },
      { path: "c.ts", added: 7, deleted: 7 },
    ]);

    // Cold: no store — one full read returns the whole window newest→oldest.
    const coldAdapter = fakeAdapter({
      head: HEAD,
      readCommitFileNumstat: async (_since, range) => (range ? [] : [c3, c2, c1]),
    });
    const cold = await new FileChurnDiscovery(asAdapter(coldAdapter), {
      maxAgeMonths: 12,
      timeoutMs: 30000,
    }).fileChurn();

    // Warm: store already holds c2, c1 up to PRIOR_HEAD (ancestor of HEAD); only
    // c3 is fetched fresh via the range top-up + merged [fresh, ...prior].
    const freshIso = new Date(legacySinceMs(12)).toISOString();
    const store = fakeStore({
      loadLatest: vi.fn().mockReturnValue(persisted(PRIOR_HEAD, freshIso, [c2, c1])),
    } as never);
    const warmAdapter = fakeAdapter({
      head: HEAD,
      isAncestor: true,
      readCommitFileNumstat: async (_since, range) => (range ? [c3] : []),
    });
    const warm = await new FileChurnDiscovery(asAdapter(warmAdapter), {
      maxAgeMonths: 12,
      timeoutMs: 30000,
      store,
    }).fileChurn();

    // Same FileChurnData per file: commits[], linesAdded, linesDeleted.
    expect(warm).toEqual(cold);
    // Warm never did a full read — only the range top-up.
    expect(warmAdapter.readCommitFileNumstat).toHaveBeenCalledTimes(1);
    expect(warmAdapter.readCommitFileNumstat.mock.calls[0][1]).toEqual({ fromSha: PRIOR_HEAD, toSha: HEAD });
    expect(store.save).toHaveBeenCalledWith("/repo", HEAD, freshIso, [c3, c2, c1]);
  });

  it("evicts commits older than the window lower bound", async () => {
    const agedOutSha = "0".repeat(40);
    const within = fileEntry("1".repeat(40), [{ path: "a.ts", added: 30, deleted: 5 }], NOW_SEC - 1000);
    // 40 days old — below the 1-month window lower bound.
    const aged = fileEntry(agedOutSha, [{ path: "a.ts", added: 999, deleted: 111 }], NOW_SEC - 40 * 86400);
    const freshIso = new Date(legacySinceMs(1)).toISOString();
    const store = fakeStore({
      load: vi.fn().mockReturnValue(persisted(HEAD, freshIso, [within, aged])),
    } as never);
    const adapter = fakeAdapter({ head: HEAD });

    const churn = await new FileChurnDiscovery(asAdapter(adapter), {
      maxAgeMonths: 1,
      timeoutMs: 30000,
      store,
    }).fileChurn();

    const f = churn.get("a.ts")!;
    expect(f.commits.map((c) => c.sha)).not.toContain(agedOutSha);
    expect(f.linesAdded).toBe(30);
    expect(f.linesDeleted).toBe(5);
  });

  it("staleness → full recompute: non-ancestor prior.head", async () => {
    const freshIso = new Date(legacySinceMs(12)).toISOString();
    const store = fakeStore({
      loadLatest: vi
        .fn()
        .mockReturnValue(
          persisted(PRIOR_HEAD, freshIso, [fileEntry("2".repeat(40), [{ path: "a.ts", added: 1, deleted: 0 }])]),
        ),
    } as never);
    const adapter = fakeAdapter({
      head: HEAD,
      isAncestor: false, // rewrite — prior.head is NOT an ancestor of head
      readCommitFileNumstat: async () => [fileEntry("3".repeat(40), [{ path: "a.ts", added: 2, deleted: 0 }])],
    });

    await new FileChurnDiscovery(asAdapter(adapter), { maxAgeMonths: 12, timeoutMs: 30000, store }).fileChurn();

    // Last call is a whole-repo (no range) full read, not a range top-up.
    expect(adapter.readCommitFileNumstat).toHaveBeenCalledTimes(1);
    expect(adapter.readCommitFileNumstat.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it("staleness → full recompute: window (maxAgeMonths) changed beyond tolerance", async () => {
    // prior.sinceIso 40 days older than the wanted window — beyond 24h tolerance.
    const driftedIso = new Date(legacySinceMs(12) - 40 * 86400 * 1000).toISOString();
    const stale = [fileEntry("s".repeat(40), [{ path: "a.ts", added: 9, deleted: 9 }])];
    const store = fakeStore({
      load: vi.fn().mockReturnValue(persisted(HEAD, driftedIso, stale)),
      loadLatest: vi.fn().mockReturnValue(persisted(HEAD, driftedIso, stale)),
    } as never);
    const adapter = fakeAdapter({
      head: HEAD,
      readCommitFileNumstat: async () => [fileEntry("3".repeat(40), [{ path: "a.ts", added: 2, deleted: 0 }])],
    });

    await new FileChurnDiscovery(asAdapter(adapter), { maxAgeMonths: 12, timeoutMs: 30000, store }).fileChurn();

    expect(adapter.readCommitFileNumstat).toHaveBeenCalledTimes(1);
    expect(adapter.readCommitFileNumstat.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it("no store ⇒ single full read", async () => {
    const adapter = fakeAdapter({
      head: HEAD,
      readCommitFileNumstat: async () => [fileEntry("3".repeat(40), [{ path: "a.ts", added: 2, deleted: 0 }])],
    });

    await new FileChurnDiscovery(asAdapter(adapter), { maxAgeMonths: 12, timeoutMs: 30000 }).fileChurn();

    expect(adapter.readCommitFileNumstat).toHaveBeenCalledTimes(1);
    expect(adapter.readCommitFileNumstat.mock.calls[0][1]).toBeUndefined();
  });
});
