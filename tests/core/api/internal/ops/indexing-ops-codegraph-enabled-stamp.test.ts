/**
 * IndexingOps stamps `codegraphEnabled` after a recompute rebuilt the
 * codegraph layer (bd tea-rags-mcp-5m8g3).
 *
 * The dedicated registry field is what a call-time replay reads to wire the
 * codegraph tools, and the pipeline stamps it only in `recordRegistryEntry` —
 * a path the enrichment recompute never reaches. A recompute that re-extracted
 * the graph is the same claim a full run makes, so it must stamp the field too;
 * this is what heals a legacy entry that predates the field. A git-only
 * recompute says nothing about the graph and must leave the flag alone.
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
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    ...overrides,
  };
}

function makeCodegraphStamper() {
  return { stampCodegraphEnabled: vi.fn() };
}

const collection = resolveCollectionName(process.cwd());

describe("IndexingOps — codegraphEnabled stamping", () => {
  it("stamps codegraphEnabled after a codegraph enrichment recompute", async () => {
    const codegraphEnabledStamper = makeCodegraphStamper();
    const ops = new IndexingOps(makeDeps({ codegraphEnabledStamper }));

    await ops.run(process.cwd(), { forceEnrichments: ["codegraph"] });

    expect(codegraphEnabledStamper.stampCodegraphEnabled).toHaveBeenCalledWith(collection);
  });

  it("stamps on a codegraph.* namespace selector — the same layer, narrower scope", async () => {
    const codegraphEnabledStamper = makeCodegraphStamper();
    const ops = new IndexingOps(makeDeps({ codegraphEnabledStamper }));

    await ops.run(process.cwd(), { forceEnrichments: ["codegraph.symbols"], languages: ["typescript"] });

    expect(codegraphEnabledStamper.stampCodegraphEnabled).toHaveBeenCalledWith(collection);
  });

  it("stamps on the `all` selector — it rebuilds the codegraph layer too", async () => {
    const codegraphEnabledStamper = makeCodegraphStamper();
    const ops = new IndexingOps(makeDeps({ codegraphEnabledStamper }));

    await ops.run(process.cwd(), { forceEnrichments: ["all"] });

    expect(codegraphEnabledStamper.stampCodegraphEnabled).toHaveBeenCalledWith(collection);
  });

  it("leaves the stamp alone after a git-only recompute — no graph was rebuilt", async () => {
    const codegraphEnabledStamper = makeCodegraphStamper();
    const ops = new IndexingOps(makeDeps({ codegraphEnabledStamper }));

    await ops.run(process.cwd(), { forceEnrichments: ["git"] });

    expect(codegraphEnabledStamper.stampCodegraphEnabled).not.toHaveBeenCalled();
  });

  it("runs without the stamper wired", async () => {
    const ops = new IndexingOps(makeDeps());

    await expect(ops.run(process.cwd(), { forceEnrichments: ["codegraph"] })).resolves.toBeDefined();
  });
});
