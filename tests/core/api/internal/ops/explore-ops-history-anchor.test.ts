/**
 * One history clock per request (bd tea-rags-mcp-zwu7m). A head-anchored index
 * (`TRAJECTORY_GIT_ANCHOR=head` stamped in its registry env) measured every
 * stored age from its HEAD commit; the read path must measure from the same
 * instant — the indexed commit's committer time — in the recency / age derived
 * signals, the typed `minAgeDays` / `maxAgeDays` filters and the filter-preset
 * age thresholds. A `now` (or unstamped) index keeps the wall clock.
 *
 * Observable surface: the Qdrant filter semanticSearch / rankChunks send and
 * the score a real Reranker gives `custom: { recency: 1 }`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
import { IndexHistoryAnchorResolver } from "../../../../../src/core/api/internal/infra/index-history-anchor.js";
import type { CollectionEntry } from "../../../../../src/core/contracts/types/registry.js";
import { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { GitTrajectory } from "../../../../../src/core/domains/trajectory/git.js";
import {
  GIT_FILTER_PRESETS,
  gitDerivedSignals,
  gitPayloadSignalDescriptors,
} from "../../../../../src/core/domains/trajectory/git/index.js";
import { TrajectoryRegistry } from "../../../../../src/core/domains/trajectory/index.js";

const DAY = 86_400;
const ALICE = { name: "Alice", email: "alice@example.com" };
/** The index was built at a commit ~2850 days old. */
const HEAD_SEC = Math.floor(Date.now() / 1000) - 2850 * DAY;

let repo: string;
let indexedCommit: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "explore-history-anchor-"));
  ({ head: indexedCommit } = importGitHistory(repo, [
    { label: "head", message: "head", author: ALICE, authorDate: HEAD_SEC * 1000, writes: { "a.ts": "a" } },
  ]));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A chunk last modified AT the indexed commit. */
const POINT = {
  id: "p1",
  score: 0.9,
  payload: {
    relativePath: "a.ts",
    language: "typescript",
    git: {
      file: { lastModifiedAt: HEAD_SEC, commitCount: 3 },
      chunk: { lastModifiedAt: HEAD_SEC, commitCount: 2 },
    },
  },
};

function entryWith(env: Record<string, string> | undefined, commit = indexedCommit): CollectionEntry {
  return {
    collectionName: "col",
    path: repo,
    name: null,
    embeddingModel: "m",
    embeddingDimensions: 3,
    qdrantUrl: "http://localhost",
    ...(env ? { env } : {}),
    git: { indexedBranch: "main", indexedCommit: commit, indexedDirty: false },
  } as CollectionEntry;
}

function makeFacade(entry: CollectionEntry) {
  const sentFilters: any[] = [];
  const qdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn(async (_c: string, _v: number[], _l: number, filter: unknown) => {
      sentFilters.push(filter);
      return [structuredClone(POINT)];
    }),
    queryGroups: vi.fn(async (_c: string, _v: number[], opts: { filter?: unknown }) => {
      sentFilters.push(opts.filter);
      return [];
    }),
    scrollOrdered: vi.fn(async (_c: string, _o: unknown, _l: number, filter: unknown) => {
      sentFilters.push(filter);
      return [];
    }),
    scrollFiltered: vi.fn(async () => []),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    ensurePayloadIndex: vi.fn(),
  } as any;
  const registry = new TrajectoryRegistry();
  registry.register(new GitTrajectory());
  registry.setFilterPresets(GIT_FILTER_PRESETS);
  const reranker = new Reranker([...gitDerivedSignals], [], gitPayloadSignalDescriptors);
  const facade = new ExploreFacade({
    qdrant,
    embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }) } as any,
    reranker,
    registry,
    payloadSignals: gitPayloadSignalDescriptors,
    historyAnchor: new IndexHistoryAnchorResolver({ collectionRegistry: { get: () => entry } }),
  });
  return { facade, sentFilters, reranker };
}

function rangeOf(filter: any, key: string): Record<string, number> | undefined {
  return (filter?.must ?? []).find((c: any) => c.key === key)?.range;
}

describe("head-anchored index: the request clock is the indexed commit's time", () => {
  const head = () => makeFacade(entryWith({ TRAJECTORY_GIT_ANCHOR: "head" }));

  it("recency reads a chunk modified at the indexed commit as fresh (age 0)", async () => {
    const { facade } = head();
    const res = await facade.semanticSearch({ collection: "col", query: "q", rerank: { custom: { recency: 1 } } });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].score).toBeCloseTo(1, 6);
  });

  it("minAgeDays / maxAgeDays select by HEAD-relative age", async () => {
    const { facade, sentFilters } = head();
    await facade.semanticSearch({ collection: "col", query: "q", minAgeDays: 30 });
    expect(rangeOf(sentFilters[0], "git.chunk.lastModifiedAt")).toEqual({ gt: 0, lte: HEAD_SEC - 30 * DAY });
    await facade.semanticSearch({ collection: "col", query: "q", maxAgeDays: 7, level: "file" });
    expect(rangeOf(sentFilters[1], "git.file.lastModifiedAt")).toEqual({ gt: HEAD_SEC - 8 * DAY });
  });

  it("a filter preset with an age threshold compiles against the indexed commit's time", async () => {
    const { facade, sentFilters } = head();
    await facade.semanticSearch({ collection: "col", query: "q", filter: { presets: "freshLegacyEdits" } });
    expect(rangeOf(sentFilters[0], "git.file.lastModifiedAt")).toEqual({ gt: 0, lte: HEAD_SEC - 60 * DAY });
    expect(rangeOf(sentFilters[0], "git.chunk.lastModifiedAt")).toEqual({ gte: HEAD_SEC - 7 * DAY });
  });

  it("find_symbol's rerank reads the same clock", async () => {
    const { facade, reranker } = head();
    const rerank = vi.spyOn(reranker, "rerank");
    await facade.findSymbol({ collection: "col", relativePath: "a.ts", rerank: { custom: { recency: 1 } } });
    expect(rerank).toHaveBeenCalledWith(expect.anything(), { custom: { recency: 1 } }, "semantic_search", {
      now: HEAD_SEC,
    });
  });

  it("rank_chunks age filters read the same clock", async () => {
    const { facade, sentFilters } = head();
    await facade.rankChunks({ collection: "col", rerank: { custom: { recency: 1 } }, minAgeDays: 30 });
    expect(sentFilters.length).toBeGreaterThan(0);
    for (const f of sentFilters) {
      expect(rangeOf(f, "git.chunk.lastModifiedAt")).toMatchObject({ lte: HEAD_SEC - 30 * DAY });
    }
  });
});

describe("now-anchored and unstamped indexes keep the wall clock", () => {
  for (const [label, env] of [
    ["stamped now", { TRAJECTORY_GIT_ANCHOR: "now" }],
    ["no anchor key", {}],
  ] as const) {
    it(`${label}: a 2850-day-old chunk reads old and filters measure from today`, async () => {
      const before = Math.floor(Date.now() / 1000);
      const { facade, sentFilters } = makeFacade(entryWith(env));
      const res = await facade.semanticSearch({
        collection: "col",
        query: "q",
        rerank: { custom: { recency: 1 } },
        minAgeDays: 30,
      });
      const after = Math.floor(Date.now() / 1000);
      expect(res.results[0].score).toBeCloseTo(0, 6);
      const lte = rangeOf(sentFilters[0], "git.chunk.lastModifiedAt")?.lte ?? 0;
      expect(lte).toBeGreaterThanOrEqual(before - 30 * DAY);
      expect(lte).toBeLessThanOrEqual(after - 30 * DAY);
    });
  }

  it("head-stamped but the indexed commit is unreadable → wall clock", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { facade, sentFilters } = makeFacade(
      entryWith({ TRAJECTORY_GIT_ANCHOR: "head" }, "0123456789abcdef0123456789abcdef01234567"),
    );
    const res = await facade.semanticSearch({
      collection: "col",
      query: "q",
      rerank: { custom: { recency: 1 } },
      minAgeDays: 30,
    });
    expect(res.results[0].score).toBeCloseTo(0, 6);
    expect(rangeOf(sentFilters[0], "git.chunk.lastModifiedAt")?.lte).toBeGreaterThanOrEqual(before - 30 * DAY);
  });
});
