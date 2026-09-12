/**
 * IndexingOps — clearing the drift report's consumption after a run
 * (bd tea-rags-mcp-p0phi).
 *
 * `IndexDriftReporter` hands a search response each distinct report once per
 * collection per server session. The run that repairs the drift is therefore
 * the only thing that may re-arm a report it already showed: without the reset,
 * a long-lived MCP server would stay silent about drift that survived the run.
 *
 * Every run path resets, including a plain incremental that stamps nothing —
 * re-checking is cheap and the monitors decide for themselves whether anything
 * still moved.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
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

const languageCodeVersions = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 }],
]);

/**
 * One recorder for BOTH mutations, so the assertion pins their ORDER and not
 * just their presence.
 *
 * The reset must come AFTER the stamp: it re-arms the reader, and a reader
 * re-armed before the stamp lands can re-check against the OLD stamp and be
 * told the drift is still there. Two separate spies cannot see that inversion.
 */
function makeRun() {
  const calls: string[] = [];
  return {
    calls,
    collectionRegistry: { stampLanguageVersions: (name: string) => calls.push(`stamp:${name}`) },
    driftReporter: { reset: (name: string) => calls.push(`reset:${name}`) },
  };
}

/** Reset names only — for the paths that stamp nothing. */
function resetsOf(calls: readonly string[]): string[] {
  return calls.filter((c) => c.startsWith("reset:")).map((c) => c.slice("reset:".length));
}

const collection = resolveCollectionName(process.cwd());

describe("IndexingOps — drift consumption reset", () => {
  it("re-arms the collection AFTER the stamp on a full reindex", async () => {
    const run = makeRun();
    const ops = new IndexingOps(
      makeDeps({
        driftReporter: run.driftReporter,
        collectionRegistry: run.collectionRegistry as never,
        languageCodeVersions,
      }),
    );

    await ops.run(process.cwd(), { forceReindex: true });

    expect(run.calls).toEqual([`stamp:${collection}`, `reset:${collection}`]);
  });

  it("re-arms the collection AFTER the stamp on a first index", async () => {
    const run = makeRun();
    const deps = makeDeps({
      driftReporter: run.driftReporter,
      collectionRegistry: run.collectionRegistry as never,
      languageCodeVersions,
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(false),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      } as never,
    });

    await new IndexingOps(deps).run(process.cwd());

    expect(run.calls).toEqual([`stamp:${collection}`, `reset:${collection}`]);
  });

  it("re-arms the collection AFTER the stamp on an enrichment recompute", async () => {
    const run = makeRun();
    const ops = new IndexingOps(
      makeDeps({
        driftReporter: run.driftReporter,
        collectionRegistry: run.collectionRegistry as never,
        languageCodeVersions,
      }),
    );

    await ops.run(process.cwd(), { forceEnrichments: ["codegraph"] });

    expect(run.calls).toEqual([`stamp:${collection}`, `reset:${collection}`]);
  });

  it("re-arms the collection on a plain incremental, which stamps nothing", async () => {
    const run = makeRun();
    const ops = new IndexingOps(
      makeDeps({
        driftReporter: run.driftReporter,
        collectionRegistry: run.collectionRegistry as never,
        languageCodeVersions,
      }),
    );

    await ops.run(process.cwd());

    expect(run.calls).toEqual([`reset:${collection}`]);
    expect(resetsOf(run.calls)).toEqual([collection]);
  });

  it("runs without a reporter wired", async () => {
    const ops = new IndexingOps(makeDeps());

    await expect(ops.run(process.cwd(), { forceReindex: true })).resolves.toBeDefined();
  });

  /**
   * The commit axis reads the registry's git stamp, and the run that refreshes
   * that stamp is the sync leg — `ReindexingOperations#reindexChanges` records
   * the entry on every successful return, quiet ones included (bd
   * tea-rags-mcp-zf3x0). Re-arming the reader before that stamp lands would
   * hand the next search a re-check against the stamp the recompute was about
   * to replace, and it would be told, with a fresh warning, about drift the run
   * had just repaired.
   *
   * What this pins is that the recompute AWAITS the sync leg to COMPLETION, not
   * merely that it calls it first. The marker is pushed after a macrotask tick,
   * so it lands only once the returned promise actually settles — the same
   * shape as the `statsCache.save` marker below, which fires inside the awaited
   * refresh. Drop the `await` in front of `this.reindex.reindexChanges` and the
   * reset runs while the sync leg is still pending, so the recorded order
   * inverts and this test fails.
   *
   * The sync leg is a fake here; that it records at all is proven against the
   * real pipeline in `domains/ingest/operations/reindex-registry-stamp.test.ts`.
   */
  it("awaits the sync leg to completion, stamp and all, BEFORE re-arming the reader on a recompute", async () => {
    const calls: string[] = [];
    const ops = new IndexingOps(
      makeDeps({
        driftReporter: { reset: (name: string) => calls.push(`reset:${name}`) },
        reindex: {
          reindexChanges: vi.fn().mockImplementation(async () => {
            // Yield a full macrotask first. A marker pushed synchronously would
            // land at CALL time and stay ordered even with the await removed;
            // a microtask would still beat the recompute's own awaits, which
            // are microtasks too. Only a macrotask lets the rest of the
            // recompute — the reset included — overtake an unawaited sync leg.
            await new Promise<void>((resolve) => setImmediate(resolve));
            calls.push("sync:record");
            return changeStats;
          }),
        } as never,
      }),
    );

    await ops.run(process.cwd(), { forceEnrichments: ["codegraph"] });

    expect(calls).toEqual(["sync:record", `reset:${collection}`]);
  });

  /**
   * The stats refresh is what rewrites `payloadFieldKeys`, which the payload-key
   * axis compares against. Re-arming the reader before that write lands leaves a
   * window in which a search re-checks the OLD keys and is told, with a fresh
   * warning, about drift the run just repaired. The full-reindex and recompute
   * paths already await it; the incremental one did not.
   *
   * Recorded through `statsCache.save`, which is the last thing the refresh
   * does — the other four cases wire no stats cache, so the refresh early-exits
   * there and their expectations are untouched.
   */
  /**
   * A relocated project (bd tea-rags-mcp-waj6k): the registry still holds the
   * ORIGINAL collection for the new path, and that is the one a search — and
   * therefore the drift reader — resolves. The stamp goes into that same
   * registry entry, so both must address it rather than the path hash.
   *
   * Only the runs that operate on an EXISTING collection resolve this way; the
   * full-index path below keeps the hash, because that run is what registers a
   * collection for the path in the first place.
   */
  describe("relocated project", () => {
    const RELOCATED = "code_relocated";
    const resolveCollectionForPath = async (): Promise<string> => RELOCATED;

    it("stamps and re-arms the registry's collection on a recompute", async () => {
      const run = makeRun();
      const ops = new IndexingOps(
        makeDeps({
          driftReporter: run.driftReporter,
          collectionRegistry: run.collectionRegistry as never,
          languageCodeVersions,
          resolveCollectionForPath,
        }),
      );

      await ops.run(process.cwd(), { forceEnrichments: ["codegraph"] });

      expect(run.calls).toEqual([`stamp:${RELOCATED}`, `reset:${RELOCATED}`]);
    });

    it("re-arms the registry's collection on an incremental", async () => {
      const run = makeRun();
      const ops = new IndexingOps(
        makeDeps({
          driftReporter: run.driftReporter,
          collectionRegistry: run.collectionRegistry as never,
          languageCodeVersions,
          resolveCollectionForPath,
        }),
      );

      await ops.run(process.cwd());

      expect(resetsOf(run.calls)).toEqual([RELOCATED]);
    });

    it("keeps the path hash on a full index, which is what registers the collection", async () => {
      const run = makeRun();
      const deps = makeDeps({
        driftReporter: run.driftReporter,
        collectionRegistry: run.collectionRegistry as never,
        languageCodeVersions,
        resolveCollectionForPath,
        qdrant: {
          collectionExists: vi.fn().mockResolvedValue(false),
          aliases: { listAliases: vi.fn().mockResolvedValue([]) },
        } as never,
      });

      await new IndexingOps(deps).run(process.cwd());

      expect(run.calls).toEqual([`stamp:${collection}`, `reset:${collection}`]);
    });
  });

  it("finishes the stats refresh BEFORE re-arming the reader on an incremental", async () => {
    const calls: string[] = [];
    const page = { points: [{ payload: { language: "typescript" } }], next_page_offset: null };
    const ops = new IndexingOps(
      makeDeps({
        driftReporter: { reset: (name: string) => calls.push(`reset:${name}`) },
        qdrant: {
          collectionExists: vi.fn().mockResolvedValue(true),
          aliases: { listAliases: vi.fn().mockResolvedValue([]) },
          client: { scroll: vi.fn().mockResolvedValue(page) },
        } as never,
        statsCache: { save: () => calls.push("stats"), load: vi.fn().mockReturnValue(null) } as never,
        allPayloadSignals: [{ key: "language", type: "string", description: "lang" }] as never,
        statsAccumulators: [],
      }),
    );

    await ops.run(process.cwd());

    expect(calls).toEqual(["stats", `reset:${collection}`]);
  });
});
