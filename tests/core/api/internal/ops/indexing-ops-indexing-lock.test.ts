/**
 * IndexingOps claims a collection with an exclusive on-disk lock BEFORE any
 * indexing work (bd tea-rags-mcp-39xca.13).
 *
 * The 62pgi check it sits in front of reads what a run has already published to
 * Qdrant. An incremental run publishes nothing until `beginRun` writes `_run`, so
 * from the claim until then a second process saw an idle collection and both
 * proceeded. The lock file is written at claim time and is visible to every
 * process on the machine; these tests pin when it is taken, who it refuses, when
 * it is taken over, and that every exit path gives it back.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { IndexOptions } from "../../../../../src/core/api/public/dto/ingest.js";
import { IndexingAlreadyInProgressError } from "../../../../../src/core/domains/ingest/errors.js";
import {
  CollectionIndexingLock,
  type CollectionIndexingLockOptions,
  type IndexingLockRecord,
} from "../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import { STALE_INDEXING_THRESHOLD_MS } from "../../../../../src/core/domains/ingest/pipeline/indexing-marker-codec.js";
import { resolveCollectionName } from "../../../../../src/core/infra/collection-name.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const ALIAS = resolveCollectionName(resolve("/repo"));
const FOREIGN_PID = 4242;

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

type MarkerPayloads = Record<string, Record<string, unknown>>;

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { open, opened };
}

describe("IndexingOps — claims the collection with an exclusive indexing lock", () => {
  let lockDir: string;
  const lockFile = (): string => join(lockDir, `${ALIAS}.indexing.lock`);
  const readLock = (): IndexingLockRecord => JSON.parse(readFileSync(lockFile(), "utf8")) as IndexingLockRecord;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "indexing-ops-lock-"));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function makeLock(over: Partial<CollectionIndexingLockOptions> = {}): CollectionIndexingLock {
    return new CollectionIndexingLock({ lockDir, ...over });
  }

  function makeDeps(lock: CollectionIndexingLock, markers: MarkerPayloads = {}): IndexingOpsDeps {
    const readPoint = async (collection: string) =>
      Promise.resolve(markers[collection] ? { payload: markers[collection] } : null);
    return {
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(true),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
        listCollections: vi.fn().mockResolvedValue([]),
        getPoint: vi.fn(readPoint),
        getPointOrThrow: vi.fn(readPoint),
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
      indexingLock: lock,
    };
  }

  function writeLockOfAnotherRun(record: Partial<IndexingLockRecord> = {}): void {
    const now = new Date().toISOString();
    writeFileSync(
      lockFile(),
      JSON.stringify({
        pid: FOREIGN_PID,
        hostname: hostname(),
        startedAt: now,
        heartbeatAt: now,
        operation: "index-codebase",
        ...record,
      }),
    );
  }

  it("holds the lock from before any indexing work until the operation's background enrichment settles", async () => {
    const enrichmentSettles = gate();
    const deps = makeDeps(makeLock());
    let lockDuringReindex: IndexingLockRecord | undefined;
    vi.mocked(deps.reindex.reindexChanges).mockImplementation(async () => {
      lockDuringReindex = readLock();
      return Promise.resolve(changeStats);
    });
    vi.mocked(deps.enrichment.whenCompletionsSettled).mockReturnValue(enrichmentSettles.opened);
    const ops = new IndexingOps(deps);

    await ops.run("/repo");

    expect(lockDuringReindex).toMatchObject({ pid: process.pid, hostname: hostname(), operation: "index-codebase" });
    expect(existsSync(lockFile())).toBe(true);

    enrichmentSettles.open();
    await ops.whenEnrichmentComplete();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("rejects an operation from another IndexingOps in this process while the lock is held, and admits it once released", async () => {
    const held = gate();
    const firstDeps = makeDeps(makeLock());
    vi.mocked(firstDeps.reindex.reindexChanges).mockImplementation(async () => {
      await held.opened;
      return changeStats;
    });
    const first = new IndexingOps(firstDeps);
    const secondDeps = makeDeps(makeLock());
    const second = new IndexingOps(secondDeps);

    const running = first.run("/repo");
    await vi.waitFor(() => {
      expect(firstDeps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
    });

    await expect(second.run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
    expect(secondDeps.reindex.reindexChanges).not.toHaveBeenCalled();

    held.open();
    await running;
    await first.whenEnrichmentComplete();
    await expect(second.run("/repo")).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects while a live process on this host holds the lock, leaving that lock untouched", async () => {
    writeLockOfAnotherRun();
    const deps = makeDeps(makeLock({ isProcessAlive: () => true }));
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);

    expect(deps.reindex.reindexChanges).not.toHaveBeenCalled();
    expect(readLock().pid).toBe(FOREIGN_PID);
  });

  it("takes over a lock left by a dead process on this host and runs", async () => {
    writeLockOfAnotherRun();
    const deps = makeDeps(makeLock({ isProcessAlive: (pid) => pid !== FOREIGN_PID }));
    let lockDuringReindex: IndexingLockRecord | undefined;
    vi.mocked(deps.reindex.reindexChanges).mockImplementation(async () => {
      lockDuringReindex = readLock();
      return Promise.resolve(changeStats);
    });

    await expect(new IndexingOps(deps).run("/repo")).resolves.toMatchObject({ status: "completed" });
    expect(lockDuringReindex?.pid).toBe(process.pid);
  });

  it("takes over a lock whose heartbeat went stale and runs", async () => {
    const agedOut = new Date(Date.now() - STALE_INDEXING_THRESHOLD_MS - 60_000).toISOString();
    writeLockOfAnotherRun({ hostname: "another-machine", startedAt: agedOut, heartbeatAt: agedOut });
    const deps = makeDeps(makeLock());

    await expect(new IndexingOps(deps).run("/repo")).resolves.toMatchObject({ status: "completed" });
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
  });

  it("gives its lock back when the claim is refused after taking it — another session's fresh indexing marker", async () => {
    const fresh = new Date().toISOString();
    const deps = makeDeps(makeLock(), {
      [ALIAS]: { indexingComplete: false, startedAt: fresh, lastHeartbeat: fresh },
    });

    await expect(new IndexingOps(deps).run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);

    expect(existsSync(lockFile())).toBe(false);
  });

  it("gives its lock back when the operation fails, so a retry is admitted", async () => {
    const deps = makeDeps(makeLock());
    vi.mocked(deps.reindex.reindexChanges).mockRejectedValueOnce(new Error("embedding endpoint down"));
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo")).rejects.toThrow("embedding endpoint down");
    expect(existsSync(lockFile())).toBe(false);

    await expect(ops.run("/repo")).resolves.toMatchObject({ status: "completed" });
  });

  it.each<[string, IndexOptions, string]>([
    ["a force reindex", { forceReindex: true }, "force-reindex"],
    ["an enrichment recompute", { forceEnrichments: ["git"] }, "force-enrichments"],
  ])("names %s as the lock's operation", async (_label, options, operation) => {
    const deps = makeDeps(makeLock());
    let recorded: string | undefined;
    const capture = async (): Promise<ChangeStats> => {
      recorded = readLock().operation;
      return Promise.resolve(changeStats);
    };
    vi.mocked(deps.reindex.reindexChanges).mockImplementation(capture);
    vi.mocked(deps.indexing.indexCodebase).mockImplementation(capture as never);

    await new IndexingOps(deps).run("/repo", options);

    expect(recorded).toBe(operation);
  });
});
