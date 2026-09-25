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
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
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
    },
    writes,
  };
}

function builder(source: TemporalCochangeHistorySource, sessionGapMinutes: number | null = null) {
  return new TemporalCochangeBuilder({
    windowMonths: 6,
    sessionGapMinutes,
    historySource: source,
    fileExists: () => true,
    now: () => NOW_MS,
  });
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
