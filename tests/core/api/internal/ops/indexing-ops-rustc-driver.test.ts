/**
 * An index run carries the rustc driver status on its stats only when the
 * codegraph pass of THIS run recorded it (bd s3i8m): the enrichment worker
 * persists it with the run's resolve tally, so a record older than the run's
 * start belongs to an earlier run — reporting it as this run's outcome would
 * be a lie, and a run whose enrichment detached has not resolved Rust yet.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { RustcDriverStatusRecord } from "../../../../../src/core/contracts/rustc-driver-status.js";
import { CollectionIndexingLock } from "../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const changeStats: ChangeStats = {
  filesAdded: 1,
  filesModified: 0,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 3,
  chunksDeleted: 0,
  durationMs: 5,
  status: "completed",
};

describe("IndexingOps — rustc driver status on the run stats", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "indexing-ops-rustc-driver-"));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function makeDeps(record: () => RustcDriverStatusRecord | null): IndexingOpsDeps {
    return {
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(true),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
        listCollections: vi.fn().mockResolvedValue([]),
        getPoint: vi.fn().mockResolvedValue(null),
        getPointOrThrow: vi.fn().mockResolvedValue(null),
        getAliasTarget: vi.fn().mockResolvedValue(undefined),
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
      codegraphPool: {
        listCollectionDbNames: () => ["code_repo_v1"],
        acquireReader: async () => ({
          graphDb: { getRustcDriverStatus: async () => record(), close: async () => undefined },
        }),
        removeCollection: vi.fn(),
      } as never,
    };
  }

  it("carries the status the run's own codegraph pass recorded", async () => {
    const stats = await new IndexingOps(
      makeDeps(() => ({ status: { outcome: "indexed", cacheHit: true, units: 4 }, recordedAtMs: Date.now() + 1 })),
    ).run("/repo");

    expect(stats.rustcDriver).toEqual({ outcome: "indexed", cacheHit: true, units: 4 });
  });

  it("carries nothing when the record predates the run", async () => {
    const stats = await new IndexingOps(
      makeDeps(() => ({ status: { outcome: "off" }, recordedAtMs: Date.now() - 60_000 })),
    ).run("/repo");

    expect(stats.status).toBe("completed");
    expect(stats).not.toHaveProperty("rustcDriver");
  });

  it("carries nothing when no Rust resolve pass recorded a status", async () => {
    const stats = await new IndexingOps(makeDeps(() => null)).run("/repo");

    expect(stats).not.toHaveProperty("rustcDriver");
  });

  it("still completes the run when the read throws", async () => {
    const stats = await new IndexingOps(
      makeDeps(() => {
        throw new Error("daemon gone");
      }),
    ).run("/repo");

    expect(stats.status).toBe("completed");
    expect(stats).not.toHaveProperty("rustcDriver");
  });
});
