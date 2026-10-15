import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import { ResidualResolutionOps } from "../../../../../src/core/api/internal/ops/residual-resolution-ops.js";
import type { ResidualPassReport } from "../../../../../src/core/contracts/types/codegraph-residual.js";
import { StatusModule } from "../../../../../src/core/domains/ingest/pipeline/status-module.js";
import { resolveCollectionName } from "../../../../../src/core/primitives/ids/collection-identity.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const ALIAS = resolveCollectionName(resolve("/repo"));

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

const REPORT: ResidualPassReport = {
  outcome: "skipped",
  reason: "provider kev unavailable: connect ECONNREFUSED",
  mode: "ask",
  sites: 3,
  menuOverflow: 0,
  cacheHits: 1,
  groups: 2,
  asked: 0,
  answered: 0,
  tooLong: 0,
  failedGroups: 0,
  abortedGroups: 0,
  belowThreshold: 0,
  edgesApplied: 1,
  durations: { readMs: 1, askMs: 0, applyMs: 1, totalMs: 2 },
};

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { open, opened };
}

function makeDeps(overrides: Partial<IndexingOpsDeps>, settled: Promise<void>, order: string[]): IndexingOpsDeps {
  const readPoint = async () => Promise.resolve(null);
  return {
    qdrant: {
      url: "http://qdrant",
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      listCollections: vi.fn().mockResolvedValue([]),
      getPoint: vi.fn(readPoint),
      getPointOrThrow: vi.fn(readPoint),
      getServerVersion: vi.fn().mockResolvedValue("1.0.0"),
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
      checkHealth: vi.fn().mockResolvedValue(true),
      getProviderName: () => "fake",
      getModel: () => "fake-model",
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn() } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn(async () => {
        await settled;
        order.push("enrichment-settled");
      }),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    codegraphPool: {} as never,
    ...overrides,
  };
}

describe("IndexingOps — residual resolution after enrichment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the residual pass only after codegraph enrichment settled, still holding the collection", async () => {
    const settled = gate();
    const order: string[] = [];
    const progress = vi.fn();
    const resolveAfterIndex = vi.fn(async () => {
      order.push("residual");
      return REPORT;
    });
    const ops = new IndexingOps(
      makeDeps({ residualResolution: { resolve: vi.fn(), resolveAfterIndex } }, settled.opened, order),
    );

    await ops.run("/repo", { resolveResidual: "kev" }, progress);
    expect(order).toEqual([]);

    settled.open();
    await ops.whenEnrichmentComplete();

    expect(order).toEqual(["enrichment-settled", "residual"]);
    expect(resolveAfterIndex).toHaveBeenCalledWith({
      logicalName: ALIAS,
      physicalCollectionName: ALIAS,
      projectRoot: resolve("/repo"),
      model: "kev",
      onProgress: progress,
    });
  });

  it("hands a run without --resolve-residual to the residual ops with no model, so they decide on stored verdicts", async () => {
    const settled = gate();
    settled.open();
    const resolveAfterIndex = vi.fn(async () => undefined);
    const ops = new IndexingOps(
      makeDeps({ residualResolution: { resolve: vi.fn(), resolveAfterIndex } }, settled.opened, []),
    );

    await ops.run("/repo");
    await ops.whenEnrichmentComplete();

    expect(resolveAfterIndex).toHaveBeenCalledWith({
      logicalName: ALIAS,
      physicalCollectionName: ALIAS,
      projectRoot: resolve("/repo"),
    });
  });

  it("never runs the pass when codegraph is off for the run", async () => {
    const settled = gate();
    settled.open();
    const resolveAfterIndex = vi.fn(async () => REPORT);
    const ops = new IndexingOps(
      makeDeps(
        { residualResolution: { resolve: vi.fn(), resolveAfterIndex }, codegraphPool: undefined },
        settled.opened,
        [],
      ),
    );

    await ops.run("/repo", { resolveResidual: "kev" });
    await ops.whenEnrichmentComplete();

    expect(resolveAfterIndex).not.toHaveBeenCalled();
  });

  it("releases the collection even when the pass rejects", async () => {
    const settled = gate();
    settled.open();
    const resolveAfterIndex = vi.fn(async () => {
      throw new Error("duckdb gone");
    });
    const ops = new IndexingOps(
      makeDeps({ residualResolution: { resolve: vi.fn(), resolveAfterIndex } }, settled.opened, []),
    );

    await ops.run("/repo", { resolveResidual: "kev" });
    await expect(ops.whenEnrichmentComplete()).resolves.toBeUndefined();

    await expect(ops.run("/repo")).resolves.toBeDefined();
  });

  it("reports the collection's last residual pass on its status", async () => {
    vi.spyOn(StatusModule.prototype, "getIndexStatus").mockResolvedValue({ isIndexed: true, status: "indexed" });
    const settled = gate();
    settled.open();
    const ops = new IndexingOps(
      makeDeps(
        {
          residualResolution: { resolve: vi.fn(), resolveAfterIndex: vi.fn(async () => REPORT) },
          qdrant: {
            url: "http://qdrant",
            collectionExists: vi.fn().mockResolvedValue(false),
            aliases: { listAliases: vi.fn().mockResolvedValue([]) },
            listCollections: vi.fn().mockResolvedValue([]),
            getPoint: vi.fn().mockResolvedValue(null),
            getPointOrThrow: vi.fn().mockResolvedValue(null),
            getServerVersion: vi.fn().mockResolvedValue("1.0.0"),
          } as never,
        },
        settled.opened,
        [],
      ),
    );

    await expect(ops.getStatus("/repo")).resolves.not.toHaveProperty("residualResolution");
    await ops.run("/repo", { resolveResidual: "kev" });
    await ops.whenEnrichmentComplete();

    await expect(ops.getStatus("/repo")).resolves.toMatchObject({ residualResolution: REPORT });
  });

  it("runs `resolve-codegraph-residual` through the residual ops to the model and the graph", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "indexing-ops-residual-"));
    const applied: string[] = [];
    const residualResolution = new ResidualResolutionOps({
      rootDir,
      codegraphPool: {
        acquireWrite: async () => ({
          graphDb: {
            readResidualCallSites: async () => [],
            applyModelEdges: async (model: string) => {
              applied.push(model);
            },
            markDerivedStale: async () => undefined,
          },
        }),
      } as never,
      config: { kevThreshold: 0.7, concurrency: 1, menuLimit: 40, retentionDays: 180 },
      createProvider: (model) => ({
        id: model,
        threshold: 0.7,
        version: async () => "fake@1",
        health: async () => ({ ok: true }),
        resolveGroup: async () => [],
      }),
    });
    const settled = gate();
    settled.open();
    const ops = new IndexingOps(makeDeps({ residualResolution }, settled.opened, []));

    try {
      await expect(ops.resolveResidual("/repo", "kev")).resolves.toMatchObject({ outcome: "completed", mode: "ask" });
      expect(applied).toEqual(["kev"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
