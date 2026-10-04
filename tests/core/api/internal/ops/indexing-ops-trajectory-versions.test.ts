/**
 * IndexingOps — when the per-provider algorithm-version stamp advances
 * (bd tea-rags-mcp-xi2r9).
 *
 * The stamp claims a provider's payload was rebuilt for EVERY point by this
 * build's algorithm, so it advances only on a run that rebuilt the provider
 * collection-wide: a first index or force, or a recompute selecting the
 * provider with no language narrowing. A plain incremental rewrites only the
 * files that changed, and a language-narrowed recompute leaves the other
 * languages' points on the old values — neither may stamp, or the drift hint
 * would clear while stale values remain.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import { resolveCollectionName } from "../../../../../src/core/infra/collection-name.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const changeStats: ChangeStats = {
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 0,
  chunksDeleted: 0,
  durationMs: 5,
  status: "completed",
};

function makeDeps(overrides: Partial<IndexingOpsDeps> = {}): IndexingOpsDeps {
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      // The marker read a recompute makes for a pending worktree seed: none here.
      getPoint: vi.fn().mockResolvedValue(null),
      getPointOrThrow: vi.fn().mockResolvedValue(null),
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn().mockResolvedValue({ status: "completed" }) } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    enrichment: {
      providerKeys: ["git", "codegraph.symbols"],
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    trajectoryAlgorithmVersions: new Map([["git", 2]]),
    ...overrides,
  };
}

function makeRegistry() {
  return { stampTrajectoryVersions: vi.fn() };
}

const collection = resolveCollectionName(process.cwd());

describe("IndexingOps — trajectory algorithm version stamping", () => {
  it("stamps every provider after a full reindex", async () => {
    const trajectoryVersionStamper = makeRegistry();

    await new IndexingOps(makeDeps({ trajectoryVersionStamper })).run(process.cwd(), { forceReindex: true });

    expect(trajectoryVersionStamper.stampTrajectoryVersions).toHaveBeenCalledWith(collection, { git: 2 });
  });

  it("stamps every provider on a first index", async () => {
    const trajectoryVersionStamper = makeRegistry();
    const deps = makeDeps({
      trajectoryVersionStamper,
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(false),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      } as never,
    });

    await new IndexingOps(deps).run(process.cwd());

    expect(trajectoryVersionStamper.stampTrajectoryVersions).toHaveBeenCalledWith(collection, { git: 2 });
  });

  it.each([[["git"]], [["all"]], [["git", "codegraph"]]])(
    "stamps the git version after a recompute selecting %j",
    async (forceEnrichments) => {
      const trajectoryVersionStamper = makeRegistry();

      await new IndexingOps(makeDeps({ trajectoryVersionStamper })).run(process.cwd(), { forceEnrichments });

      expect(trajectoryVersionStamper.stampTrajectoryVersions).toHaveBeenCalledWith(collection, { git: 2 });
    },
  );

  it("leaves the stamp alone after a recompute that did not select the provider", async () => {
    const trajectoryVersionStamper = makeRegistry();

    await new IndexingOps(makeDeps({ trajectoryVersionStamper })).run(process.cwd(), {
      forceEnrichments: ["codegraph"],
    });

    expect(trajectoryVersionStamper.stampTrajectoryVersions).not.toHaveBeenCalled();
  });

  it("leaves the stamp alone after a language-narrowed recompute — other languages keep the old values", async () => {
    const trajectoryVersionStamper = makeRegistry();

    await new IndexingOps(makeDeps({ trajectoryVersionStamper })).run(process.cwd(), {
      forceEnrichments: ["git"],
      languages: ["typescript"],
    });

    expect(trajectoryVersionStamper.stampTrajectoryVersions).not.toHaveBeenCalled();
  });

  it("leaves the stamp alone on a plain incremental — only changed files were rewritten", async () => {
    const trajectoryVersionStamper = makeRegistry();

    await new IndexingOps(makeDeps({ trajectoryVersionStamper })).run(process.cwd());

    expect(trajectoryVersionStamper.stampTrajectoryVersions).not.toHaveBeenCalled();
  });

  it("runs without a stamper wired", async () => {
    await expect(new IndexingOps(makeDeps()).run(process.cwd(), { forceReindex: true })).resolves.toBeDefined();
  });
});
