/**
 * `TemporalCochangeBuilder` — the codegraph collection-completion hook that
 * (re)builds `cg_temporal_*` (bd tea-rags-mcp-x4rpp).
 *
 * Invariants under test:
 *   - a first build scopes history, bundles it, cuts mass changes adaptively and
 *     writes one wholesale snapshot whose meta records every choice it made;
 *   - a build at the same HEAD with the same parameters inside a day is skipped
 *     without reading history — finalize runs on every incremental index;
 *   - a moved HEAD or a changed parameter rebuilds.
 */

import { describe, expect, it, vi } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/vcs/types.js";
import type {
  TemporalCochangeBuildMeta,
  TemporalCochangeSnapshot,
  TemporalSymbolCommitBuffer,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  InMemoryTemporalSymbolCommitBuffer,
  TemporalCochangeBuilder,
  type TemporalCochangeHistorySource,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";
import type { GitCommitDiscoveryEntry } from "../../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";

const NOW_MS = 1_760_000_000_000;
const HOUR = 3600;

function entry(sha: string, author: string, timestamp: number, paths: string[]): GitCommitDiscoveryEntry {
  const commit: CommitInfo = { sha, author, authorEmail: `${author}@x`, timestamp, body: "feat: x", parents: ["p"] };
  return { commit, changedFiles: paths.map((path) => ({ path })) };
}

/** Newest first, like the discovery matrix. */
const HISTORY = [
  entry("s6", "bob", 6 * HOUR, ["docs.md"]),
  entry("s5", "alice", 5 * HOUR, ["a.ts", "b.ts"]),
  entry("s4", "alice", 4 * HOUR, ["a.ts", "c.yml"]),
  entry("s3", "alice", 3 * HOUR, ["a.ts", "c.yml"]),
  entry("s2", "alice", 2 * HOUR, ["a.ts", "b.ts"]),
  entry("s1", "alice", 1 * HOUR, ["a.ts", "b.ts"]),
];

function historySource(head: string): TemporalCochangeHistorySource & { entriesRead: () => number } {
  let reads = 0;
  return {
    open: async () => ({
      repoRoot: "/repo",
      head,
      worktreeDeletions: [],
      trackedPaths: async () => [...new Set(HISTORY.flatMap((e) => e.changedFiles.map((c) => c.path)))],
      entries: async () => {
        reads += 1;
        return HISTORY;
      },
    }),
    entriesRead: () => reads,
  };
}

function fakeGraphDb(initial: TemporalCochangeBuildMeta | null = null) {
  let meta = initial;
  const writes: TemporalCochangeSnapshot[] = [];
  return {
    graphDb: {
      readTemporalCochangeMeta: vi.fn(async () => meta),
      replaceTemporalCochange: vi.fn(async (snapshot: TemporalCochangeSnapshot) => {
        writes.push(snapshot);
        ({ meta } = snapshot);
      }),
      replaceTemporalSymbolCommits: vi.fn(async () => undefined),
      storedTemporalSymbolCommitFilePaths: vi.fn(async () => [] as string[]),
      deleteTemporalSymbolCommitFiles: vi.fn(async () => undefined),
    },
    writes,
  };
}

function builder(
  source: TemporalCochangeHistorySource,
  sessionGapMinutes: number | null = null,
  symbolCommits?: TemporalSymbolCommitBuffer,
) {
  return new TemporalCochangeBuilder(
    {
      windowMonths: 6,
      sessionGapMinutes,
      historySource: source,
      now: () => NOW_MS,
    },
    symbolCommits,
  );
}

describe("TemporalCochangeBuilder", () => {
  it("builds the co-change graph and records how it was measured", async () => {
    const { graphDb, writes } = fakeGraphDb();

    const outcome = await builder(historySource("h1")).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(outcome.status).toBe("built");
    expect(writes).toHaveLength(1);
    const [snapshot] = writes;
    expect(snapshot.meta).toMatchObject({
      head: "h1",
      builtAt: NOW_MS / 1000,
      windowSince: NOW_MS / 1000 - 6 * 30 * 86400,
      commitCount: 6,
      bundleCount: 6,
      admittedBundleCount: 6,
      maxFilesPerBundle: 2,
      minSupport: 2,
      sessionGapMinutes: null,
    });
    expect(snapshot.edges.map((e) => [e.relPathA, e.relPathB, e.support])).toEqual([
      ["a.ts", "b.ts", 3],
      ["a.ts", "c.yml", 2],
    ]);
  });

  it("skips a rebuild at the same HEAD and parameters without reading history", async () => {
    const source = historySource("h1");
    const { graphDb, writes } = fakeGraphDb();
    await builder(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    const outcome = await builder(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(outcome.status).toBe("fresh");
    expect(writes).toHaveLength(1);
    expect(source.entriesRead()).toBe(1);
  });

  it("rebuilds when HEAD moved or a parameter changed", async () => {
    const { graphDb, writes } = fakeGraphDb();
    await builder(historySource("h1")).onCollectionComplete({ projectRoot: "/repo", graphDb });

    await builder(historySource("h2")).onCollectionComplete({ projectRoot: "/repo", graphDb });
    await builder(historySource("h2"), 30).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(writes.map((w) => [w.meta.head, w.meta.sessionGapMinutes])).toEqual([
      ["h1", null],
      ["h2", null],
      ["h2", 30],
    ]);
    // Under 30-minute sessions alice's commits are an hour apart — still one bundle each.
    expect(writes[2].meta.bundleCount).toBe(6);
  });
});

/**
 * Dead links (bd tea-rags-mcp-x4rpp): the stored graph names only LIVE paths —
 * tracked by HEAD's tree and still in the working tree — and the skip rule
 * keeps a graph only while that set is the one it was built over.
 */
describe("TemporalCochangeBuilder — no pair outlives its endpoint", () => {
  interface RepoState {
    head: string;
    tracked: string[];
    deletions: string[];
    history: GitCommitDiscoveryEntry[];
  }

  function repo(initial: RepoState) {
    const state = { ...initial };
    let reads = 0;
    const source: TemporalCochangeHistorySource = {
      open: async () => ({
        repoRoot: "/repo",
        head: state.head,
        worktreeDeletions: [...state.deletions],
        trackedPaths: async () => [...state.tracked],
        entries: async () => {
          reads += 1;
          return state.history;
        },
      }),
    };
    return { state, source, reads: () => reads };
  }

  function build(source: TemporalCochangeHistorySource, nowMs = NOW_MS) {
    return new TemporalCochangeBuilder({
      windowMonths: 6,
      sessionGapMinutes: null,
      historySource: source,
      now: () => nowMs,
    });
  }

  const pairs = (snapshot: TemporalCochangeSnapshot) => snapshot.edges.map((e) => `${e.relPathA}~${e.relPathB}`);
  const paths = (snapshot: TemporalCochangeSnapshot) => [
    ...new Set([...snapshot.files.map((f) => f.relPath), ...snapshot.edges.flatMap((e) => [e.relPathA, e.relPathB])]),
  ];

  /** a.ts co-changes with gone.ts, b.ts and build/out.js, twice each. */
  const HISTORY_WITH_DEAD_PATHS = [
    entry("s6", "alice", 6 * HOUR, ["a.ts", "gone.ts"]),
    entry("s5", "alice", 5 * HOUR, ["a.ts", "gone.ts"]),
    entry("s4", "alice", 4 * HOUR, ["a.ts", "b.ts"]),
    entry("s3", "alice", 3 * HOUR, ["a.ts", "b.ts"]),
    entry("s2", "alice", 2 * HOUR, ["a.ts", "build/out.js"]),
    entry("s1", "alice", 1 * HOUR, ["a.ts", "build/out.js"]),
  ];

  it("keeps no path HEAD does not track, even when a file of that name sits on disk", async () => {
    // gone.ts: deleted at HEAD. build/out.js: once committed, now an ignored build artifact.
    const { source } = repo({ head: "h1", tracked: ["a.ts", "b.ts"], deletions: [], history: HISTORY_WITH_DEAD_PATHS });
    const { graphDb, writes } = fakeGraphDb();

    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(pairs(writes[0])).toEqual(["a.ts~b.ts"]);
    expect(paths(writes[0]).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("attributes a renamed file's history to its HEAD path and never stores the old one", async () => {
    const history = [
      { commit: entry("s3", "alice", 3 * HOUR, []).commit, changedFiles: [{ path: "b2.ts", previousPath: "b.ts" }] },
      entry("s2", "alice", 2 * HOUR, ["a.ts", "b.ts"]),
      entry("s1", "alice", 1 * HOUR, ["a.ts", "b.ts"]),
    ];
    const { source } = repo({ head: "h1", tracked: ["a.ts", "b2.ts"], deletions: [], history });
    const { graphDb, writes } = fakeGraphDb();

    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(pairs(writes[0])).toEqual(["a.ts~b2.ts"]);
  });

  it("rebuilds at the same HEAD when the working tree loses a file, and drops its pairs", async () => {
    const { state, source } = repo({
      head: "h1",
      tracked: ["a.ts", "b.ts", "gone.ts"],
      deletions: [],
      history: HISTORY_WITH_DEAD_PATHS,
    });
    const { graphDb, writes } = fakeGraphDb();
    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });
    expect(pairs(writes[0])).toEqual(["a.ts~b.ts", "a.ts~gone.ts"]);

    state.deletions = ["gone.ts"];
    const outcome = await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(outcome.status).toBe("built");
    expect(pairs(writes[1])).toEqual(["a.ts~b.ts"]);
  });

  it("rebuilds when a working-tree deletion is restored, bringing the pairs back", async () => {
    const { state, source } = repo({
      head: "h1",
      tracked: ["a.ts", "b.ts", "gone.ts"],
      deletions: ["gone.ts"],
      history: HISTORY_WITH_DEAD_PATHS,
    });
    const { graphDb, writes } = fakeGraphDb();
    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    state.deletions = [];
    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(writes.map(pairs)).toEqual([["a.ts~b.ts"], ["a.ts~b.ts", "a.ts~gone.ts"]]);
  });

  it("still skips while HEAD and the working tree's deletions stand still", async () => {
    const { source, reads } = repo({
      head: "h1",
      tracked: ["a.ts", "b.ts", "gone.ts"],
      deletions: ["gone.ts"],
      history: HISTORY_WITH_DEAD_PATHS,
    });
    const { graphDb, writes } = fakeGraphDb();
    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    const outcome = await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(outcome.status).toBe("fresh");
    expect(writes).toHaveLength(1);
    expect(reads()).toBe(1);
  });

  it("does not keep yesterday's rows when HEAD moves by a commit that deletes a file", async () => {
    const { state, source } = repo({
      head: "h1",
      tracked: ["a.ts", "b.ts", "gone.ts"],
      deletions: [],
      history: HISTORY_WITH_DEAD_PATHS,
    });
    const { graphDb, writes } = fakeGraphDb();
    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    state.head = "h2";
    state.tracked = ["a.ts", "b.ts"];
    state.history = [entry("s7", "alice", 7 * HOUR, ["gone.ts"]), ...HISTORY_WITH_DEAD_PATHS];
    await build(source, NOW_MS + 60_000).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(pairs(writes[1])).toEqual(["a.ts~b.ts"]);
  });

  it("rebuilds after a day at the same HEAD, dropping a pair the sliding window left behind", async () => {
    const { state, source } = repo({
      head: "h1",
      tracked: ["a.ts", "b.ts", "gone.ts"],
      deletions: [],
      history: HISTORY_WITH_DEAD_PATHS,
    });
    const { graphDb, writes } = fakeGraphDb();
    await build(source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    state.history = HISTORY_WITH_DEAD_PATHS.slice(0, 2); // s1–s4 slid out of the window
    await build(source, NOW_MS + 86_400_000).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(pairs(writes[1])).toEqual(["a.ts~gone.ts"]);
    expect(paths(writes[1]).sort()).toEqual(["a.ts", "gone.ts"]);
  });

  it("does not trust a seeded clone's copied meta row built over another working tree at the same HEAD", async () => {
    // The sibling built while gone.ts was deleted in ITS working tree.
    const sibling = repo({
      head: "h1",
      tracked: ["a.ts", "b.ts", "gone.ts"],
      deletions: ["gone.ts"],
      history: HISTORY_WITH_DEAD_PATHS,
    });
    const { graphDb, writes } = fakeGraphDb();
    await build(sibling.source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    // The clone's DB is a copy (same meta row); its own working tree has gone.ts.
    const clone = repo({ ...sibling.state, deletions: [] });
    const outcome = await build(clone.source).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(outcome.status).toBe("built");
    expect(pairs(writes[1])).toEqual(["a.ts~b.ts", "a.ts~gone.ts"]);
  });

  it("matches a subdirectory project's paths against the REPO-relative tracked set", async () => {
    const history = [
      entry("s2", "alice", 2 * HOUR, ["app/a.ts", "app/b.ts", "app/old.ts", "infra/x.tf"]),
      entry("s1", "alice", 1 * HOUR, ["app/a.ts", "app/b.ts", "app/old.ts", "infra/x.tf"]),
    ];
    const { source } = repo({ head: "h1", tracked: ["app/a.ts", "app/b.ts", "infra/x.tf"], deletions: [], history });
    const { graphDb, writes } = fakeGraphDb();

    await build(source).onCollectionComplete({ projectRoot: "/repo/app", graphDb });

    expect(pairs(writes[0])).toEqual(["a.ts~b.ts"]);
    expect(paths(writes[0]).sort()).toEqual(["a.ts", "b.ts"]);
  });
});

/**
 * The symbol-commit flush (bd tea-rags-mcp-3gz4f): every completion drains the
 * run-scoped buffer the git provider absorbed into and replaces those files'
 * rows; a build additionally prunes stored rows whose path left the live set,
 * a fresh path does not (the deletions fingerprint covers it).
 */
describe("TemporalCochangeBuilder — symbol-commit flush", () => {
  function absorb(buffer: InMemoryTemporalSymbolCommitBuffer): void {
    buffer.absorb("a.ts", new Map([["A#m", new Set(["s1", "s2"])]]));
    buffer.absorb("b.ts", new Map([["B#n", new Set(["s2"])]]));
    buffer.absorb("gone.ts", new Map([["G#p", new Set(["s1"])]]));
  }

  it("drains the buffer and replaces the absorbed files' rows on a FRESH completion, without pruning", async () => {
    const source = historySource("h1");
    const { graphDb } = fakeGraphDb();
    const first = builder(source);
    const buffer = new InMemoryTemporalSymbolCommitBuffer();
    // Prime the meta row so the next completion takes the fresh path.
    await first.onCollectionComplete({ projectRoot: "/repo", graphDb });
    absorb(buffer);

    await builder(source, null, buffer).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(graphDb.replaceTemporalSymbolCommits).toHaveBeenCalledWith([
      { relPath: "a.ts", symbols: [{ symbolId: "A#m", commitShas: ["s1", "s2"] }] },
      { relPath: "b.ts", symbols: [{ symbolId: "B#n", commitShas: ["s2"] }] },
      { relPath: "gone.ts", symbols: [{ symbolId: "G#p", commitShas: ["s1"] }] },
    ]);
    expect(graphDb.storedTemporalSymbolCommitFilePaths).not.toHaveBeenCalled();
    expect(graphDb.deleteTemporalSymbolCommitFiles).not.toHaveBeenCalled();
    // The flush DRAINS: a completion with nothing absorbed writes nothing.
    await builder(source, null, buffer).onCollectionComplete({ projectRoot: "/repo", graphDb });
    expect(graphDb.replaceTemporalSymbolCommits).toHaveBeenCalledTimes(2);
    expect(graphDb.replaceTemporalSymbolCommits).toHaveBeenLastCalledWith([]);
  });

  it("prunes stored rows whose path left the live set on a BUILT completion, under the project prefix", async () => {
    // projectRoot /repo/app ⇒ prefix "app/"; discovery rows and stored rows are
    // REPO-relative, the live set is too — the prune composes prefix + row.
    const source: TemporalCochangeHistorySource = {
      open: async () => ({
        repoRoot: "/repo",
        head: "h1",
        worktreeDeletions: [],
        trackedPaths: async () => ["app/a.ts", "app/b.ts"],
        entries: async () => [
          entry("s2", "alice", 2 * HOUR, ["app/a.ts", "app/b.ts"]),
          entry("s1", "alice", 1 * HOUR, ["app/a.ts", "app/gone.ts"]),
        ],
      }),
    };
    const { graphDb } = fakeGraphDb();
    vi.mocked(graphDb.storedTemporalSymbolCommitFilePaths).mockResolvedValue(["a.ts", "gone.ts"]);
    const buffer = new InMemoryTemporalSymbolCommitBuffer();
    absorb(buffer);

    const outcome = await builder(source, null, buffer).onCollectionComplete({ projectRoot: "/repo/app", graphDb });

    expect(outcome.status).toBe("built");
    expect(graphDb.replaceTemporalSymbolCommits).toHaveBeenCalled();
    expect(graphDb.deleteTemporalSymbolCommitFiles).toHaveBeenCalledWith(["gone.ts"]);
  });

  it("is a no-op without a buffer — the hook stays best-effort", async () => {
    const { graphDb } = fakeGraphDb();

    await builder(historySource("h1")).onCollectionComplete({ projectRoot: "/repo", graphDb });

    expect(graphDb.replaceTemporalSymbolCommits).not.toHaveBeenCalled();
    expect(graphDb.storedTemporalSymbolCommitFilePaths).not.toHaveBeenCalled();
    expect(graphDb.deleteTemporalSymbolCommitFiles).not.toHaveBeenCalled();
  });
});
