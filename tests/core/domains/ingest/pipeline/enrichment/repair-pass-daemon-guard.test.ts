/**
 * `EnrichmentCoordinator#runRepairPass` holds the codegraph daemon guard around
 * its worker dispatch (bd tea-rags-mcp-as1zl).
 *
 * The repair pass runs BEFORE `beginRun`, so the run's own keep-alive is not
 * open yet, and its `runFileBatch` reaches the daemon through a worker pool
 * that can only CONNECT — it cannot spawn a daemon. On a project whose
 * codegraph was just enabled (no DuckDB file), the store read never triggers
 * the reader-side ensure, every eligible file is "drifted", and the worker's
 * first connect found no socket: `--force-enrichments codegraph` failed with
 * `INFRA_CODEGRAPH_DAEMON_BUILD_UNAVAILABLE`. What these pin: the guard is
 * begun before the dispatch and released after it (even on rejection), it is
 * begun lazily — a converged store pays nothing — and the recompute's forced
 * repair is covered too.
 */

import { describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../../__helpers__/collection-identity.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

const PROVIDER_KEY = "codegraph.symbols";

const qdrant = {} as never;

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    key: PROVIDER_KEY,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: vi.fn((p: string) => p),
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as never;
}

function makeExecutor(runFileBatch: ReturnType<typeof vi.fn>) {
  return {
    runFileBatch,
    runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
    runChunkSignals: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseRun: vi.fn().mockResolvedValue(undefined),
  } as never;
}

/** A guard whose begin and release append to `log`. */
function makeLoggingGuard(log: string[]) {
  const release = vi.fn(async () => {
    log.push("release");
  });
  const guard = {
    begin: vi.fn(async (collection: string) => {
      log.push(`begin:${collection}`);
      return release;
    }),
  };
  return { guard, release };
}

const SCANNED = new Map([
  ["src/a.ts", "h1"],
  ["src/b.ts", "h2"],
]);

describe("EnrichmentCoordinator.runRepairPass holds the daemon guard (as1zl)", () => {
  it("begins the guard before the worker dispatch and releases it after", async () => {
    const log: string[] = [];
    const { guard, release } = makeLoggingGuard(log);
    const runFileBatch = vi.fn(async () => {
      log.push("runFileBatch");
      return new Map();
    });
    // No DuckDB file yet: the store reads empty, so every eligible file drifts.
    const provider = makeProvider({ readPersistedFileHashes: vi.fn().mockResolvedValue(new Map()) });
    const coordinator = new EnrichmentCoordinator(qdrant, provider, undefined, makeExecutor(runFileBatch), guard);

    expect(await coordinator.runRepairPass(fixturePhysicalCollectionName("code_x_v1"), "/repo", SCANNED)).toBe(2);

    expect(log).toEqual(["begin:code_x_v1", "runFileBatch", "release"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the guard when the worker dispatch rejects, and still propagates the rejection", async () => {
    const log: string[] = [];
    const { guard, release } = makeLoggingGuard(log);
    const runFileBatch = vi.fn().mockRejectedValue(new Error("daemon build unavailable"));
    const provider = makeProvider({ readPersistedFileHashes: vi.fn().mockResolvedValue(new Map()) });
    const coordinator = new EnrichmentCoordinator(qdrant, provider, undefined, makeExecutor(runFileBatch), guard);

    await expect(
      coordinator.runRepairPass(fixturePhysicalCollectionName("code_x_v1"), "/repo", SCANNED),
    ).rejects.toThrow("daemon build unavailable");

    expect(guard.begin).toHaveBeenCalledWith("code_x_v1");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not begin the guard when the store already matches the code", async () => {
    const log: string[] = [];
    const { guard } = makeLoggingGuard(log);
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const provider = makeProvider({
      readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>(SCANNED)),
    });
    const coordinator = new EnrichmentCoordinator(qdrant, provider, undefined, makeExecutor(runFileBatch), guard);

    expect(await coordinator.runRepairPass(fixturePhysicalCollectionName("code_x_v1"), "/repo", SCANNED)).toBe(0);

    expect(runFileBatch).not.toHaveBeenCalled();
    expect(guard.begin).not.toHaveBeenCalled();
  });

  it("begins the guard once per pass, however many providers dispatch", async () => {
    const log: string[] = [];
    const { guard, release } = makeLoggingGuard(log);
    const runFileBatch = vi.fn(async () => {
      log.push("runFileBatch");
      return new Map();
    });
    const first = makeProvider({ readPersistedFileHashes: vi.fn().mockResolvedValue(new Map()) });
    const second = makeProvider({
      key: "codegraph.other",
      readPersistedFileHashes: vi.fn().mockResolvedValue(new Map()),
    });
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      [first, second] as never,
      undefined,
      makeExecutor(runFileBatch),
      guard,
    );

    await coordinator.runRepairPass(fixturePhysicalCollectionName("code_x_v1"), "/repo", SCANNED);

    expect(log).toEqual(["begin:code_x_v1", "runFileBatch", "runFileBatch", "release"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

/** Store provider whose recompute file phase dispatches nothing (see force-enrichments-provider-repair.test.ts). */
function recomputeStoreProvider(): EnrichmentProvider {
  return {
    key: PROVIDER_KEY,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    defersChunkEnrichment: true,
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals: vi.fn().mockResolvedValue(new Map()),
    readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>()),
  };
}

function recomputeQdrant(points: { id: string; payload: Record<string, unknown> }[]) {
  return {
    scrollFiltered: vi.fn().mockResolvedValue(points),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

describe("EnrichmentCoordinator.recomputeEnrichments forced repair holds the daemon guard (as1zl)", () => {
  it("begins the guard before the forced repair's worker dispatch and releases it after", async () => {
    const log: string[] = [];
    const { guard } = makeLoggingGuard(log);
    const executor = new InlineEnrichmentExecutor();
    vi.spyOn(executor, "runFileBatch").mockImplementation(async () => {
      log.push("runFileBatch");
      return new Map();
    });
    const coordinator = new EnrichmentCoordinator(
      recomputeQdrant([
        { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
        { id: "c2", payload: { relativePath: "src/b.ts", startLine: 1, endLine: 10 } },
      ]) as never,
      recomputeStoreProvider(),
      undefined,
      executor,
      guard,
    );

    await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("code_x_v1"), "/repo", ["codegraph"]);

    // The run's own guard (begun at `beginRun`) follows; the repair's must
    // bracket the forced repair's dispatch on its own.
    expect(log.slice(0, 3)).toEqual(["begin:code_x_v1", "runFileBatch", "release"]);
  });
});
