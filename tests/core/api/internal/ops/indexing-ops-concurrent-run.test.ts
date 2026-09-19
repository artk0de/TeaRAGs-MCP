/**
 * IndexingOps — an index operation on a collection that is already being indexed
 * is REJECTED, never queued (bd tea-rags-mcp-62pgi).
 *
 * Two runs on one collection overwrite each other's `_run` pointer and terminal
 * markers, and on the worker pool one run's release evicts the provider state the
 * other is still reading. The overlap has two sources: an earlier operation in
 * THIS process whose background enrichment has not settled (MCP `index_codebase`
 * returns after embeddings), and a run in ANOTHER process, visible only through
 * the markers it keeps fresh.
 */

import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import { IndexingAlreadyInProgressError } from "../../../../../src/core/domains/ingest/errors.js";
import { resolveCollectionName } from "../../../../../src/core/infra/collection-name.js";
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

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

type MarkerPayloads = Record<string, Record<string, unknown>>;

function makeQdrant(markers: MarkerPayloads, collections: string[] = []) {
  const readPoint = async (collection: string) =>
    Promise.resolve(markers[collection] ? { payload: markers[collection] } : null);
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    aliases: { listAliases: vi.fn().mockResolvedValue([]) },
    listCollections: vi.fn(async () => Promise.resolve(collections)),
    getPoint: vi.fn(readPoint),
    getPointOrThrow: vi.fn(readPoint),
  };
}

function makeDeps(overrides: Partial<IndexingOpsDeps> = {}, markers: MarkerPayloads = {}): IndexingOpsDeps {
  return {
    qdrant: makeQdrant(markers) as never,
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
    snapshotDir: "/tmp/snap",
    ...overrides,
  };
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { open, opened };
}

describe("IndexingOps — rejects an index operation while the same collection is indexing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a second run while the first is still running, telling the client to retry later", async () => {
    const held = gate();
    const reindexChanges = vi.fn(async () => {
      await held.opened;
      return changeStats;
    });
    const ops = new IndexingOps(makeDeps({ reindex: { reindexChanges } as never }));

    const first = ops.run("/repo");
    await vi.waitFor(() => {
      expect(reindexChanges).toHaveBeenCalledTimes(1);
    });

    const second = ops.run("/repo");
    await expect(second).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
    await expect(second).rejects.toThrow(/already running — in the background or in another session/);
    await expect(second).rejects.toThrow(/Retry after it finishes/);
    await expect(second).rejects.toThrow(/get_index_status/);

    held.open();
    await first;
    expect(reindexChanges).toHaveBeenCalledTimes(1);
  });

  it("does not let a rejected call clobber the running operation's progress sink", async () => {
    const held = gate();
    const reindexChanges = vi.fn(async () => {
      await held.opened;
      return changeStats;
    });
    const deps = makeDeps({ reindex: { reindexChanges } as never });
    const ops = new IndexingOps(deps);
    const sink = vi.fn();

    const first = ops.run("/repo", undefined, undefined, sink);
    await vi.waitFor(() => {
      expect(reindexChanges).toHaveBeenCalledTimes(1);
    });
    await expect(ops.run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);

    expect(deps.enrichment.setEnrichmentProgress).toHaveBeenCalledTimes(1);
    expect(deps.enrichment.setEnrichmentProgress).toHaveBeenLastCalledWith(sink);
    held.open();
    await first;
  });

  it("rejects while the previous run's background enrichment has not settled, and admits once it has", async () => {
    const enrichmentSettles = gate();
    const deps = makeDeps();
    vi.mocked(deps.enrichment.whenCompletionsSettled).mockReturnValueOnce(enrichmentSettles.opened);
    const ops = new IndexingOps(deps);

    await ops.run("/repo");
    await expect(ops.run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);

    enrichmentSettles.open();
    await vi.waitFor(async () => {
      await expect(ops.run("/repo")).resolves.toMatchObject({ status: "completed" });
    });
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(2);
  });

  it("waits on the completions of the collection the run actually wrote — the alias target", async () => {
    const deps = makeDeps();
    vi.mocked((deps.qdrant as unknown as ReturnType<typeof makeQdrant>).aliases.listAliases).mockResolvedValue([
      { aliasName: ALIAS, collectionName: `${ALIAS}_v4` },
    ]);
    const ops = new IndexingOps(deps);

    await ops.run("/repo");

    await vi.waitFor(() => {
      expect(deps.enrichment.whenCompletionsSettled).toHaveBeenCalledWith(`${ALIAS}_v4`);
    });
  });

  it("rejects when another session holds a fresh indexing marker on the collection", async () => {
    const deps = makeDeps(
      {},
      { [ALIAS]: { indexingComplete: false, startedAt: minutesAgo(3), lastHeartbeat: minutesAgo(0.5) } },
    );
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
    expect(deps.reindex.reindexChanges).not.toHaveBeenCalled();
    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
  });

  it("rejects when another session is building a new version of the collection off to the side", async () => {
    const markers: MarkerPayloads = {
      [ALIAS]: { indexingComplete: true, completedAt: minutesAgo(60) },
      [`${ALIAS}_v8`]: { indexingComplete: false, startedAt: minutesAgo(2), lastHeartbeat: minutesAgo(0.5) },
    };
    const deps = makeDeps({ qdrant: makeQdrant(markers, [`${ALIAS}_v7`, `${ALIAS}_v8`]) as never });
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo", { forceReindex: true })).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
  });

  it("rejects when another session's enrichment run is still live (no terminal markers, fresh progress)", async () => {
    const deps = makeDeps(
      {},
      {
        [ALIAS]: {
          indexingComplete: true,
          enrichment: {
            _run: { runId: "r1", startedAt: minutesAgo(1), lastProgressAt: minutesAgo(0.5), providers: ["git"] },
            git: { file: { runId: "r1", status: "completed" } },
          },
        },
      },
    );
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo", { forceEnrichments: ["git"] })).rejects.toBeInstanceOf(
      IndexingAlreadyInProgressError,
    );
    expect(deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
  });

  it("admits a run when the other session's evidence went stale — a crashed run must not lock the project", async () => {
    const deps = makeDeps(
      {},
      {
        [ALIAS]: {
          indexingComplete: false,
          startedAt: minutesAgo(40),
          lastHeartbeat: minutesAgo(11),
          enrichment: {
            _run: { runId: "r1", startedAt: minutesAgo(40), lastProgressAt: minutesAgo(3), providers: ["git"] },
          },
        },
      },
    );
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo")).resolves.toMatchObject({ status: "completed" });
  });

  it("admits a run when the last enrichment run reached its terminal markers", async () => {
    const deps = makeDeps(
      {},
      {
        [ALIAS]: {
          indexingComplete: true,
          enrichment: {
            _run: { runId: "r1", startedAt: minutesAgo(1), lastProgressAt: minutesAgo(0.2), providers: ["git"] },
            git: { file: { runId: "r1", status: "completed" }, chunk: { runId: "r1", status: "degraded" } },
          },
        },
      },
    );
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo")).resolves.toMatchObject({ status: "completed" });
  });

  it("runs the --force-enrichments sync leg and then the recompute inside ONE operation without self-rejecting", async () => {
    // The sync leg detaches its enrichment; the recompute then runs on the same
    // operation while that completion (and this run's own `_run` pointer) is live.
    const syncLegSettles = gate();
    const markers: MarkerPayloads = {};
    const deps = makeDeps({}, markers);
    vi.mocked(deps.reindex.reindexChanges).mockImplementation(async () => {
      markers[ALIAS] = {
        indexingComplete: true,
        enrichment: {
          _run: { runId: "sync", startedAt: new Date().toISOString(), lastProgressAt: new Date().toISOString() },
        },
      };
      return Promise.resolve(changeStats);
    });
    vi.mocked(deps.enrichment.whenCompletionsSettled).mockReturnValue(syncLegSettles.opened);
    const ops = new IndexingOps(deps);

    const result = await ops.run("/repo", { forceEnrichments: ["codegraph"] });

    expect(result.status).toBe("completed");
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
    expect(deps.enrichment.recomputeEnrichments).toHaveBeenCalledTimes(1);
    syncLegSettles.open();
  });

  it("does not reject a retry after this process's own run failed, though its markers are still fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
    const markers: MarkerPayloads = {};
    const deps = makeDeps({}, markers);
    vi.mocked(deps.reindex.reindexChanges).mockImplementationOnce(async () => {
      const now = new Date().toISOString();
      markers[ALIAS] = {
        indexingComplete: false,
        startedAt: now,
        lastHeartbeat: now,
        enrichment: { _run: { runId: "mine", startedAt: now, lastProgressAt: now, providers: ["git"] } },
      };
      return Promise.reject(new Error("embedding endpoint down"));
    });
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo")).rejects.toThrow("embedding endpoint down");
    vi.setSystemTime(new Date("2026-09-15T10:00:05.000Z"));

    await expect(ops.run("/repo")).resolves.toMatchObject({ status: "completed" });
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(2);
  });

  it("still rejects evidence another session wrote AFTER this process's own run ended", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
    const markers: MarkerPayloads = {};
    const deps = makeDeps({}, markers);
    const ops = new IndexingOps(deps);

    await ops.run("/repo");
    await vi.waitFor(() => {
      expect(deps.enrichment.whenCompletionsSettled).toHaveBeenCalled();
    });
    vi.setSystemTime(new Date("2026-09-15T10:00:30.000Z"));
    const later = new Date().toISOString();
    markers[ALIAS] = { indexingComplete: false, startedAt: later, lastHeartbeat: later };

    await expect(ops.run("/repo")).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
  });
});
