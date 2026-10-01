/**
 * IndexingOps refuses an index run from a process whose loaded build is no
 * longer the build on disk (bd tea-rags-mcp-r4z09).
 *
 * A long-lived MCP server keeps executing the build it loaded, but its worker
 * pools (module-path DI) load whatever `build/` holds NOW. After a rebuild under
 * a live server the two halves of one run disagree on the build key: every
 * codegraph prefetch failed with `CodegraphDaemonBuildUnavailableError`, the run
 * still completed, and ~1900 changed files went without codegraph payload. The
 * refusal happens before ANY work — no lock, no delete, no chunking, no
 * registry write — so the only cost is the reconnect it asks for.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IndexingOps,
  type IndexingOpsDeps,
  type ProcessBuildFingerprintSource,
} from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import { IndexingProcessBuildStaleError } from "../../../../../src/core/domains/ingest/errors.js";
import { CollectionIndexingLock } from "../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const LOADED = "/old/build/core/adapters/duckdb/daemon|1.0.0|100";
const ON_DISK = "/old/build/core/adapters/duckdb/daemon|1.0.0|200";

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

describe("IndexingOps — refuses a run from a process whose build changed on disk", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "indexing-ops-stale-build-"));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function makeDeps(build: ProcessBuildFingerprintSource): IndexingOpsDeps {
    return {
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(true),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
        listCollections: vi.fn().mockResolvedValue([]),
        getPoint: vi.fn().mockResolvedValue(null),
        getPointOrThrow: vi.fn().mockResolvedValue(null),
      } as never,
      embeddings: {
        embed: vi.fn().mockResolvedValue([0]),
        resolveModelInfo: vi.fn().mockResolvedValue(undefined),
      } as never,
      config: { chunkSize: 1000, userSetChunkSize: false } as never,
      indexing: { indexCodebase: vi.fn() } as never,
      reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
      enrichment: {
        setEnrichmentProgress: vi.fn(),
        whenComplete: vi.fn().mockResolvedValue(undefined),
        whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
        runRecovery: vi.fn().mockResolvedValue(undefined),
        recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
      } as never,
      snapshotDir: lockDir,
      indexingLock: new CollectionIndexingLock({ lockDir }),
      languageVersionStamper: { stampLanguageVersions: vi.fn() },
      codegraphEnabledStamper: { stampCodegraphEnabled: vi.fn() },
      processBuildFingerprint: build,
    };
  }

  const staleBuild: ProcessBuildFingerprintSource = { loaded: () => LOADED, onDisk: () => ON_DISK };

  function expectNoWork(deps: IndexingOpsDeps): void {
    expect(deps.embeddings.embed).not.toHaveBeenCalled();
    expect(deps.qdrant.collectionExists).not.toHaveBeenCalled();
    expect(deps.qdrant.getPoint).not.toHaveBeenCalled();
    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
    expect(deps.reindex.reindexChanges).not.toHaveBeenCalled();
    expect(deps.enrichment.setEnrichmentProgress).not.toHaveBeenCalled();
    expect(deps.enrichment.runRecovery).not.toHaveBeenCalled();
    expect(deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
    expect(deps.languageVersionStamper?.stampLanguageVersions).not.toHaveBeenCalled();
    expect(deps.codegraphEnabledStamper?.stampCodegraphEnabled).not.toHaveBeenCalled();
    // No indexing lock was ever taken for the collection.
    expect(readdirSync(lockDir).filter((name) => name.endsWith(".indexing.lock"))).toEqual([]);
  }

  it("rejects an incremental run with IndexingProcessBuildStaleError before any work", async () => {
    const deps = makeDeps(staleBuild);
    const ops = new IndexingOps(deps);

    const run = ops.run("/repo");

    await expect(run).rejects.toBeInstanceOf(IndexingProcessBuildStaleError);
    await expect(run).rejects.toMatchObject({ code: "INGEST_PROCESS_BUILD_STALE" });
    expectNoWork(deps);
  });

  it("rejects a force reindex and an enrichment recompute the same way", async () => {
    const forceDeps = makeDeps(staleBuild);
    await expect(new IndexingOps(forceDeps).run("/repo", { forceReindex: true })).rejects.toBeInstanceOf(
      IndexingProcessBuildStaleError,
    );
    expectNoWork(forceDeps);

    const recomputeDeps = makeDeps(staleBuild);
    await expect(
      new IndexingOps(recomputeDeps).run("/repo", { forceEnrichments: ["codegraph"] }),
    ).rejects.toBeInstanceOf(IndexingProcessBuildStaleError);
    expectNoWork(recomputeDeps);
  });

  it("rejects the deprecated explicit reindex entry the same way", async () => {
    const deps = makeDeps(staleBuild);

    await expect(new IndexingOps(deps).reindexChanges("/repo")).rejects.toBeInstanceOf(IndexingProcessBuildStaleError);
    expectNoWork(deps);
  });

  it("names both builds and tells the caller to reconnect the MCP server or rerun the CLI", async () => {
    const error = await new IndexingOps(makeDeps(staleBuild)).run("/repo").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(IndexingProcessBuildStaleError);
    const stale = error as IndexingProcessBuildStaleError;
    expect(stale.message).toContain("build on disk changed since this process started");
    expect(stale.message).toContain(LOADED);
    expect(stale.message).toContain(ON_DISK);
    expect(stale.hint).toContain("/mcp reconnect");
    expect(stale.hint).toMatch(/CLI/);
  });

  it("proceeds as before when the loaded build matches the build on disk", async () => {
    const deps = makeDeps({ loaded: () => LOADED, onDisk: () => LOADED });

    await expect(new IndexingOps(deps).run("/repo")).resolves.toMatchObject({ status: "completed" });
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
  });

  it("proceeds as before when the build on disk cannot be read", async () => {
    const deps = makeDeps({ loaded: () => LOADED, onDisk: () => undefined });

    await expect(new IndexingOps(deps).run("/repo")).resolves.toMatchObject({ status: "completed" });
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
  });

  it("checks the build per run, so a rebuild between two runs refuses the second", async () => {
    let onDisk = LOADED;
    const deps = makeDeps({ loaded: () => LOADED, onDisk: () => onDisk });
    const ops = new IndexingOps(deps);

    await ops.run("/repo");
    await ops.whenEnrichmentComplete();
    onDisk = ON_DISK;

    await expect(ops.run("/repo")).rejects.toBeInstanceOf(IndexingProcessBuildStaleError);
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
  });
});
