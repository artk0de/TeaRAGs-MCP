import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import {
  skippedResidualReport,
  type ResidualResolvePort,
} from "../../../../../src/core/api/internal/ops/residual-resolve-port.js";
import { IndexingAlreadyInProgressError } from "../../../../../src/core/domains/ingest/errors/index.js";
import { CollectionIndexingLock } from "../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import { resolveCollectionName } from "../../../../../src/core/primitives/ids/collection-identity.js";

const ALIAS = resolveCollectionName(resolve("/repo"));

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

describe("IndexingOps#resolveResidual", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "indexing-ops-residual-"));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function makeOps(
    residualResolution?: ResidualResolvePort,
    codegraphHeal?: IndexingOpsDeps["codegraphHeal"],
  ): IndexingOps {
    const deps: IndexingOpsDeps = {
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(true),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
        listCollections: vi.fn().mockResolvedValue([]),
        getPoint: vi.fn().mockResolvedValue(null),
        getPointOrThrow: vi.fn().mockResolvedValue(null),
      } as never,
      embeddings: { embed: vi.fn(), resolveModelInfo: vi.fn() } as never,
      config: { chunkSize: 1000, userSetChunkSize: false } as never,
      indexing: { indexCodebase: vi.fn() } as never,
      reindex: { reindexChanges: vi.fn() } as never,
      enrichment: {
        setEnrichmentProgress: vi.fn(),
        whenComplete: vi.fn().mockResolvedValue(undefined),
        whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      } as never,
      snapshotDir: lockDir,
      indexingLock: new CollectionIndexingLock({ lockDir }),
      ...(residualResolution ? { residualResolution } : {}),
      ...(codegraphHeal ? { codegraphHeal } : {}),
    };
    return new IndexingOps(deps);
  }

  it("holds the collection for the pass — an index run meanwhile is refused", async () => {
    const held = gate();
    const resolveFn = vi.fn(async () => {
      await held.opened;
      return { ...skippedResidualReport("x", "ask"), outcome: "completed" as const, edgesApplied: 3 };
    });
    const ops = makeOps({ resolve: resolveFn });

    const pending = ops.resolveResidual("/repo", "kev");
    await vi.waitFor(() => {
      expect(resolveFn).toHaveBeenCalledTimes(1);
    });
    await expect(ops.run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);

    held.open();
    await expect(pending).resolves.toMatchObject({ outcome: "completed", edgesApplied: 3 });
    expect(resolveFn).toHaveBeenCalledWith(
      expect.objectContaining({ logicalName: ALIAS, physicalCollectionName: ALIAS, model: "kev", mode: "ask" }),
    );
  });

  it("releases the collection when the pass throws", async () => {
    const resolveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(skippedResidualReport("x", "ask"));
    const ops = makeOps({ resolve: resolveFn });

    await expect(ops.resolveResidual("/repo", "kev")).rejects.toThrow("boom");
    await expect(ops.resolveResidual("/repo", "kev")).resolves.toMatchObject({ outcome: "skipped" });
  });

  it("passes cacheOnly mode and the progress callback through", async () => {
    const resolveFn = vi.fn().mockResolvedValue(skippedResidualReport("x", "cacheOnly"));
    const onProgress = vi.fn();

    await makeOps({ resolve: resolveFn }).resolveResidual("/repo", "kev", { mode: "cacheOnly", onProgress });

    expect(resolveFn).toHaveBeenCalledWith(expect.objectContaining({ mode: "cacheOnly", onProgress }));
  });

  it("heals the payload signals of the physical collection when the pass changed the model edges", async () => {
    const changed = { ...skippedResidualReport("x", "ask"), outcome: "completed" as const, derived: "stale" as const };
    const heal = vi.fn().mockResolvedValue({ pointsRewritten: 4, filesTouched: 1 });

    const report = await makeOps({ resolve: vi.fn().mockResolvedValue(changed) }, { run: heal }).resolveResidual(
      "/repo",
      "kev",
    );

    expect(heal).toHaveBeenCalledWith(ALIAS, new Set());
    expect(report.payloadHeal).toEqual({ pointsRewritten: 4, filesTouched: 1 });
  });

  it("keeps the pass's report when the heal fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const changed = { ...skippedResidualReport("x", "ask"), derived: "recomputed" as const };
    const heal = vi.fn().mockRejectedValue(new Error("qdrant down"));

    const report = await makeOps({ resolve: vi.fn().mockResolvedValue(changed) }, { run: heal }).resolveResidual(
      "/repo",
      "kev",
    );

    expect(report).toEqual(changed);
  });

  it("does not heal when the pass left the model edges as they were", async () => {
    const heal = vi.fn();

    await makeOps(
      { resolve: vi.fn().mockResolvedValue(skippedResidualReport("x", "ask")) },
      { run: heal },
    ).resolveResidual("/repo", "kev");

    expect(heal).not.toHaveBeenCalled();
  });

  it("reports skipped when codegraph is not wired", async () => {
    await expect(makeOps().resolveResidual("/repo", "kev")).resolves.toMatchObject({
      outcome: "skipped",
      reason: "codegraph is disabled (CODEGRAPH_ENABLED=false)",
    });
  });
});
