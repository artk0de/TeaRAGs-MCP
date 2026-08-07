/**
 * `EnrichmentCoordinator.runRepairPass` (bd tea-rags-mcp-6goqa).
 *
 * A provider's per-file store drifts from the code whenever a run writes
 * somewhere the readers never look — which is exactly what the shadow-DuckDB
 * defect did for months. The repair pass makes each run check its own store and
 * fix precisely what does not match, silently: no announcement, only extra
 * time.
 *
 * What these pin: the pass re-extracts exactly the repair set (never more, so a
 * healthy graph costs one query), prunes rows that are no longer eligible, and
 * skips providers with no per-file store instead of assuming one.
 */

import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";

const qdrant = {} as never;

/** Marker-store surface — `runFinalizeOnly` writes terminal markers for real. */
function makeMarkerQdrant() {
  return {
    getPoint: vi.fn().mockResolvedValue(null),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    setPayload: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    key: "codegraph.symbols",
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

function makeExecutor(runFileSignals: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return {
    runFileSignals,
    runFileSignalsStreaming: vi.fn().mockResolvedValue(new Map()),
    runChunkSignals: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseCollection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

describe("EnrichmentCoordinator.runRepairPass", () => {
  it("re-extracts exactly the drifted and missing files, and prunes orphan rows", async () => {
    const runFileSignals = vi.fn().mockResolvedValue(new Map());
    const handleDeletedPaths = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider({
      handleDeletedPaths,
      readPersistedFileHashes: vi.fn().mockResolvedValue(
        new Map<string, string | null>([
          ["src/kept.ts", "same"],
          ["src/drifted.ts", "old"],
          ["src/gone.ts", "h"],
        ]),
      ),
    });
    const coordinator = new EnrichmentCoordinator(qdrant, provider, undefined, makeExecutor(runFileSignals));

    const repaired = await coordinator.runRepairPass(
      "code_x_v1",
      "/repo",
      new Map([
        ["src/kept.ts", "same"],
        ["src/drifted.ts", "new"],
        ["src/added.ts", "fresh"],
      ]),
    );

    // The count is what tells a no-changes run it still did real work and must
    // not take its early return before the finalize.
    expect(repaired).toBe(2);
    expect(runFileSignals).toHaveBeenCalledTimes(1);
    const [, root, paths, options] = runFileSignals.mock.calls[0] as [
      unknown,
      string,
      string[],
      { collectionName: string; contentHashes?: ReadonlyMap<string, string> },
    ];
    expect(root).toBe("/repo");
    expect([...paths].sort()).toEqual(["src/added.ts", "src/drifted.ts"]);
    expect(options.collectionName).toBe("code_x_v1");
    // Without the hashes reaching extraction the rows persist NULL, the next
    // run's repair set is maximal again, and the check never converges — the
    // exact defect live validation caught (bd tea-rags-mcp-ymjxj).
    expect(options.contentHashes?.get("src/drifted.ts")).toBe("new");
    expect(handleDeletedPaths).toHaveBeenCalledWith(["src/gone.ts"], { collectionName: "code_x_v1" });
  });

  it("extracts nothing when the store already matches the code", async () => {
    const runFileSignals = vi.fn().mockResolvedValue(new Map());
    const provider = makeProvider({
      readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>([["src/a.ts", "h1"]])),
    });
    const coordinator = new EnrichmentCoordinator(qdrant, provider, undefined, makeExecutor(runFileSignals));

    const repaired = await coordinator.runRepairPass("code_x_v1", "/repo", new Map([["src/a.ts", "h1"]]));

    expect(repaired).toBe(0);
    expect(runFileSignals).not.toHaveBeenCalled();
  });

  it("skips a provider that keeps no per-file store", async () => {
    const runFileSignals = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(qdrant, makeProvider(), undefined, makeExecutor(runFileSignals));

    await coordinator.runRepairPass("code_x_v1", "/repo", new Map([["src/a.ts", "h1"]]));

    expect(runFileSignals).not.toHaveBeenCalled();
  });

  it("repairs everything when the store is empty, which is the fresh-collection case", async () => {
    const runFileSignals = vi.fn().mockResolvedValue(new Map());
    const provider = makeProvider({
      readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>()),
    });
    const coordinator = new EnrichmentCoordinator(qdrant, provider, undefined, makeExecutor(runFileSignals));

    await coordinator.runRepairPass(
      "code_x_v1",
      "/repo",
      new Map([
        ["src/a.ts", "h1"],
        ["src/b.ts", "h2"],
      ]),
    );

    const [, , paths] = runFileSignals.mock.calls[0] as [unknown, string, string[]];
    expect([...paths].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

/**
 * `EnrichmentCoordinator.runFinalizeOnly` (bd tea-rags-mcp-gvw8h).
 *
 * A repair opens a run on the provider — it extracts, it accumulates run-global
 * state, it leaves counters behind. On the reindex path that ends with a chunk
 * pass, the pipeline's own finalize closes that run. A reindex that took an
 * early return has no chunk pass and therefore no closer, which is why the
 * repair used to be skipped there entirely and a quiet repo never healed.
 *
 * This is the closer for that case: the same completion sequence, minus every
 * assumption that chunks were stored.
 */
describe("EnrichmentCoordinator.runFinalizeOnly", () => {
  it("runs the provider finalize with no chunk pass behind it", async () => {
    const runFinalize = vi.fn().mockResolvedValue(new Map());
    const provider = makeProvider({ finalizeSignals: vi.fn().mockResolvedValue(new Map()) });
    const coordinator = new EnrichmentCoordinator(
      makeMarkerQdrant(),
      provider,
      undefined,
      makeExecutor(vi.fn().mockResolvedValue(new Map()), { runFinalize }),
    );

    await coordinator.runFinalizeOnly("/repo", "code_x_v1");

    expect(runFinalize).toHaveBeenCalledTimes(1);
    const [, root, options] = runFinalize.mock.calls[0] as [unknown, string, { collectionName?: string }];
    expect(root).toBe("/repo");
    expect(options.collectionName).toBe("code_x_v1");
  });

  it("closes the run it opened, so the next one starts from a clean slate", async () => {
    const provider = makeProvider({ finalizeSignals: vi.fn().mockResolvedValue(new Map()) });
    const releaseCollection = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnrichmentCoordinator(
      makeMarkerQdrant(),
      provider,
      undefined,
      makeExecutor(vi.fn().mockResolvedValue(new Map()), { releaseCollection }),
    );

    await coordinator.runFinalizeOnly("/repo", "code_x_v1");

    // The release is the executor-side end-of-run signal — reaching it means the
    // completion sequence ran to the end rather than being short-circuited.
    expect(releaseCollection).toHaveBeenCalledTimes(1);
    // whenComplete resolves against the SETTLED run, not a new one.
    await expect(coordinator.whenComplete()).resolves.toBeUndefined();
  });
});
