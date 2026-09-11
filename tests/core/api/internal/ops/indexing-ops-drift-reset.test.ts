/**
 * IndexingOps — clearing the drift report's consumption after a run
 * (bd tea-rags-mcp-p0phi).
 *
 * `IndexDriftReporter` hands a search response the warning once per collection
 * per server session. The run that repairs the drift is therefore the only
 * thing that may re-arm it: without the reset, a long-lived MCP server would
 * stay silent about a SECOND drift appearing after the first was fixed.
 *
 * Every run path resets, including a plain incremental that stamps nothing —
 * re-checking is cheap and the monitors decide for themselves whether anything
 * still moved.
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
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    ...overrides,
  };
}

/** Records the collection names the run asked the reporter to re-arm. */
function makeDriftReporter() {
  const resetFor: string[] = [];
  return { resetFor, reset: (collectionName: string) => resetFor.push(collectionName) };
}

const collection = resolveCollectionName(process.cwd());

describe("IndexingOps — drift consumption reset", () => {
  it("re-arms the collection after a full reindex", async () => {
    const driftReporter = makeDriftReporter();
    const ops = new IndexingOps(makeDeps({ driftReporter }));

    await ops.run(process.cwd(), { forceReindex: true });

    expect(driftReporter.resetFor).toEqual([collection]);
  });

  it("re-arms the collection after a first index", async () => {
    const driftReporter = makeDriftReporter();
    const deps = makeDeps({
      driftReporter,
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(false),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      } as never,
    });

    await new IndexingOps(deps).run(process.cwd());

    expect(driftReporter.resetFor).toEqual([collection]);
  });

  it("re-arms the collection after a plain incremental", async () => {
    const driftReporter = makeDriftReporter();
    const ops = new IndexingOps(makeDeps({ driftReporter }));

    await ops.run(process.cwd());

    expect(driftReporter.resetFor).toEqual([collection]);
  });

  it("re-arms the collection after an enrichment recompute", async () => {
    const driftReporter = makeDriftReporter();
    const ops = new IndexingOps(makeDeps({ driftReporter }));

    await ops.run(process.cwd(), { forceEnrichments: ["codegraph"] });

    expect(driftReporter.resetFor).toEqual([collection]);
  });

  it("runs without a reporter wired", async () => {
    const ops = new IndexingOps(makeDeps());

    await expect(ops.run(process.cwd(), { forceReindex: true })).resolves.toBeDefined();
  });
});
