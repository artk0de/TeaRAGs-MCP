/**
 * `--force-enrichments <keys>` — the forced STORE repair (bd tea-rags-mcp-cneu7).
 *
 * The recompute leg (`EnrichmentCoordinator#recomputeEnrichments`) rebuilds
 * Qdrant payload, but its writes to a provider's per-file store (DuckDB edge
 * rows) are ADDITIVE: a row written by older resolver code survives every
 * recompute on an unchanged file, because nothing retires it. Live on taxdome
 * 2026-09-21: phantom method edges (TS source -> Ruby target) and a dangling
 * `.scss.js` file edge lived through two `--force-enrichments codegraph`
 * runs; only a `CODEGRAPH_FORCE_RESOLVE=1` run — which forces the REPAIR leg,
 * whose per-file write reconciles through `applyScopedRowDiff` — killed them.
 *
 * So the recompute now routes its selected store providers through a FORCED
 * repair before its own cycle. What these pin, in both directions:
 *
 * - `runRepairPass` with a `forceProviders` entry re-extracts files whose
 *   persisted hash already matches; without the set (and without the env
 *   knob) nothing is extracted — the ordinary drift check is unchanged.
 * - `recomputeEnrichments` with a selector matching a store provider fires
 *   that forced repair before it opens its own run, and only for providers
 *   that keep a per-file store.
 * - The forced repair does NOT prune orphans: its eligibility is the run's
 *   stored-chunk scope (language-restricted under `--languages`), not the
 *   file universe the orphan diff needs — pruning would delete the other
 *   languages' live rows. The env knob keeps orphan pruning, as before.
 * - The synthetic eligibility map does not become the run's hash stamp: the
 *   finalize keeps threading the hashes the sync leg's repair captured, or a
 *   `""` stamp would make every later incremental repair the whole corpus
 *   (the exact defect class bd tea-rags-mcp-o317j fixed for first index).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

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

/** A store that is fully current: every eligible file's hash already matches. */
function currentStoreProvider() {
  return makeProvider({
    readPersistedFileHashes: vi.fn().mockResolvedValue(
      new Map<string, string | null>([
        ["src/a.ts", "h1"],
        ["src/b.ts", "h2"],
      ]),
    ),
  });
}

const SCANNED = new Map([
  ["src/a.ts", "h1"],
  ["src/b.ts", "h2"],
]);

afterEach(() => {
  delete process.env.CODEGRAPH_FORCE_RESOLVE;
  vi.restoreAllMocks();
});

describe("EnrichmentCoordinator.runRepairPass with selector-forced providers (cneu7)", () => {
  it("re-extracts an unchanged file when the provider is in the set", async () => {
    // The whole point: the hash gate is bypassed for the selected store
    // provider, so its edge rows are rewritten by current code even when the
    // store claims to be current — the claim is exactly what goes stale.
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      currentStoreProvider(),
      undefined,
      makeExecutor(runFileBatch),
    );

    expect(await coordinator.runRepairPass("code_x_v1", "/repo", SCANNED, undefined, new Set([PROVIDER_KEY]))).toBe(2);
    expect(runFileBatch).toHaveBeenCalledTimes(1);
    const [, root, paths] = runFileBatch.mock.calls[0] as [unknown, string, string[]];
    expect(root).toBe("/repo");
    expect([...paths].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("extracts nothing without the set and without the env knob", async () => {
    // The control: an ordinary call keeps bd tea-rags-mcp-6goqa's exact
    // semantics — a current store repairs nothing.
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      currentStoreProvider(),
      undefined,
      makeExecutor(runFileBatch),
    );

    expect(await coordinator.runRepairPass("code_x_v1", "/repo", SCANNED)).toBe(0);
    expect(runFileBatch).not.toHaveBeenCalled();
  });

  it("does not prune orphans when selector-forced — eligibility is the run's scope", async () => {
    // The forced eligibility set is the recompute's STORED CHUNK scope, which
    // `--languages` narrows to one language's files. Rows outside it are the
    // other languages' live rows, not orphans; pruning them would delete the
    // graph this run was told not to touch.
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const handleDeletedPaths = vi.fn().mockResolvedValue(undefined);
    const scopedStore = makeProvider({
      readPersistedFileHashes: vi.fn().mockResolvedValue(
        new Map<string, string | null>([
          ["src/a.ts", "h1"],
          ["app/models/user.rb", "h9"],
        ]),
      ),
      handleDeletedPaths,
    });
    const coordinator = new EnrichmentCoordinator(qdrant, scopedStore, undefined, makeExecutor(runFileBatch));

    await coordinator.runRepairPass(
      "code_x_v1",
      "/repo",
      new Map([["src/a.ts", "h1"]]),
      undefined,
      new Set([PROVIDER_KEY]),
    );

    expect(runFileBatch).toHaveBeenCalledTimes(1);
    expect(handleDeletedPaths).not.toHaveBeenCalled();
  });

  it("still prunes true orphans under the env knob — suppression is selector-only", async () => {
    // The env knob's eligibility is the full working-tree scan, so its orphan
    // diff stays meaningful and pruning must keep working there exactly as
    // before (bd tea-rags-mcp-bij2m pinned orphan behavior under the knob).
    process.env.CODEGRAPH_FORCE_RESOLVE = "1";
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const handleDeletedPaths = vi.fn().mockResolvedValue(undefined);
    const scopedStore = makeProvider({
      readPersistedFileHashes: vi.fn().mockResolvedValue(
        new Map<string, string | null>([
          ["src/a.ts", "h1"],
          ["src/gone.ts", "h9"],
        ]),
      ),
      handleDeletedPaths,
    });
    const coordinator = new EnrichmentCoordinator(qdrant, scopedStore, undefined, makeExecutor(runFileBatch));

    await coordinator.runRepairPass("code_x_v1", "/repo", new Map([["src/a.ts", "h1"]]));

    expect(handleDeletedPaths).toHaveBeenCalledWith(["src/gone.ts"], { collectionName: "code_x_v1" });
  });
});

/**
 * A store-keeping provider shaped so the RECOMPUTE's own file phase dispatches
 * nothing: `defersChunkEnrichment` with no `streamFileBatch` makes FilePhase
 * skip the batch (startDeferredExtraction returns undefined for a defer
 * provider without the method), so every `runFileBatch` call in these tests
 * belongs to the forced repair alone.
 */
function recomputeStoreProvider(overrides: Record<string, unknown> = {}): EnrichmentProvider {
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
    ...overrides,
  };
}

/** Qdrant double whose scroll answers with `points` — the recompute's stored chunks. */
function recomputeQdrant(points: { id: string; payload: Record<string, unknown> }[], events?: string[]) {
  return {
    scrollFiltered: vi.fn().mockResolvedValue(points),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn(async (_coll: string, ops: { key?: string }[]) => {
      for (const op of ops) {
        if (op.key === "enrichment._run" && events) events.push("run-pointer");
      }
    }),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

const STORED_POINTS = [
  { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
  { id: "c2", payload: { relativePath: "src/b.ts", startLine: 1, endLine: 10 } },
];

describe("EnrichmentCoordinator.recomputeEnrichments forces the store repair (cneu7)", () => {
  it("walks every stored file of the selected store provider through a forced repair", async () => {
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");
    const executor = new InlineEnrichmentExecutor();
    const runFileBatch = vi.spyOn(executor, "runFileBatch");
    const coordinator = new EnrichmentCoordinator(
      recomputeQdrant(STORED_POINTS) as never,
      recomputeStoreProvider(),
      undefined,
      executor,
    );

    await coordinator.recomputeEnrichments("code_x_v1", "/repo", ["codegraph"]);

    // The forced repair is the only runFileBatch dispatch (see the provider
    // shape above) and it carries the whole stored corpus, hash gate off.
    expect(runFileBatch).toHaveBeenCalledTimes(1);
    const [, root, paths] = runFileBatch.mock.calls[0] as [unknown, string, string[]];
    expect(root).toBe("/repo");
    expect([...paths].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(phases).toHaveBeenCalledWith("RECOMPUTE_FORCED_PROVIDER_REPAIR", {
      providers: [PROVIDER_KEY],
      files: 2,
    });
  });

  it("runs the forced repair before opening its own run", async () => {
    // The repair's extractions must land in the same run sink the recompute's
    // finalize drains — writing them after `beginRun` would race the run's own
    // batches on the serialized per-collection chain for nothing.
    const events: string[] = [];
    const executor = new InlineEnrichmentExecutor();
    vi.spyOn(executor, "runFileBatch").mockImplementation(async () => {
      events.push("forced-repair");
      return new Map();
    });
    const coordinator = new EnrichmentCoordinator(
      recomputeQdrant(STORED_POINTS, events) as never,
      recomputeStoreProvider(),
      undefined,
      executor,
    );

    await coordinator.recomputeEnrichments("code_x_v1", "/repo", ["codegraph"]);

    expect(events).toContain("forced-repair");
    expect(events).toContain("run-pointer");
    expect(events.indexOf("forced-repair")).toBeLessThan(events.indexOf("run-pointer"));
  });

  it("skips the forced repair when no matched provider keeps a per-file store", async () => {
    // git-only selections behave exactly as before: no store, nothing to
    // force, no phase line.
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");
    const executor = new InlineEnrichmentExecutor();
    const runFileBatch = vi.spyOn(executor, "runFileBatch");
    const coordinator = new EnrichmentCoordinator(
      recomputeQdrant(STORED_POINTS) as never,
      recomputeStoreProvider(),
      undefined,
      executor,
    );

    await coordinator.recomputeEnrichments("code_x_v1", "/repo", ["git"]);

    expect(runFileBatch).not.toHaveBeenCalled();
    expect(phases).not.toHaveBeenCalledWith("RECOMPUTE_FORCED_PROVIDER_REPAIR", expect.anything());
  });

  it("keeps the finalize stamping the hashes the sync leg captured, not the eligibility map", async () => {
    // `runRepairPass` captures its `scanned` as the run's `runContentHashes`,
    // and the recompute's finalize stamps that map onto every
    // `cg_symbols_files` row. The forced repair's synthetic eligibility map
    // (`""` where no scan hash is known) must not leak into the stamp, or the
    // store never converges and every later incremental repairs the corpus.
    const executor = new InlineEnrichmentExecutor();
    const runFileBatch = vi.spyOn(executor, "runFileBatch");
    const provider = recomputeStoreProvider({
      readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>([["src/a.ts", "realA"]])),
    });
    const coordinator = new EnrichmentCoordinator(
      recomputeQdrant([
        { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
        { id: "c2", payload: { relativePath: "src/c.ts", startLine: 1, endLine: 10 } },
      ]) as never,
      provider,
      undefined,
      executor,
    );

    // The sync leg's ordinary repair captured the scan's real hashes (store
    // current for the file it knows -> no dispatch).
    await coordinator.runRepairPass("code_x_v1", "/repo", new Map([["src/a.ts", "realA"]]));
    expect(runFileBatch).not.toHaveBeenCalled();

    await coordinator.recomputeEnrichments("code_x_v1", "/repo", ["codegraph"]);

    // The forced repair walked the whole stored corpus, eligibility included
    // src/c.ts — which no scan hash covers.
    const repairPaths = runFileBatch.mock.calls.flatMap((call) => call[2]);
    expect([...new Set(repairPaths)].sort()).toEqual(["src/a.ts", "src/c.ts"]);
    // But the finalize stamps the PRE-repair map: src/c.ts is absent from it,
    // not `""`.
    const finalizeOptions = (provider.finalizeSignals as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      contentHashes?: ReadonlyMap<string, string>;
    };
    expect(finalizeOptions.contentHashes?.get("src/a.ts")).toBe("realA");
    expect(finalizeOptions.contentHashes?.has("src/c.ts")).toBe(false);
  });
});

describe("EnrichmentCoordinator.recomputeEnrichments forced repair covers chunkless files (nlbhg)", () => {
  // A file that yields no chunk (a tiny one) has no Qdrant point, so the
  // stored-chunk scope never lists it — yet it is codegraph-extractable and
  // its edges belong in the graph. The forced repair takes its eligibility
  // from the working-tree scan the sync leg captured, narrowed by
  // `--languages`, so such files re-extract too.
  const SYNC_SCAN = new Map([
    ["src/a.ts", "hA"],
    ["src/tiny.ts", "hT"],
    ["app/models/user.rb", "hR"],
  ]);

  async function recomputeAfterSync(
    points: { id: string; payload: Record<string, unknown> }[],
    languages?: readonly string[],
  ): Promise<{ walked: string[]; provider: EnrichmentProvider }> {
    const executor = new InlineEnrichmentExecutor();
    const runFileBatch = vi.spyOn(executor, "runFileBatch");
    const provider = recomputeStoreProvider({
      readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>(SYNC_SCAN)),
    });
    const coordinator = new EnrichmentCoordinator(recomputeQdrant(points) as never, provider, undefined, executor);
    // The sync leg's ordinary repair: the store is current, nothing dispatched.
    await coordinator.runRepairPass("code_x_v1", "/repo", SYNC_SCAN);
    expect(runFileBatch).not.toHaveBeenCalled();

    await coordinator.recomputeEnrichments("code_x_v1", "/repo", ["codegraph"], languages);
    const walked = [...new Set(runFileBatch.mock.calls.flatMap((call) => call[2]))].sort();
    return { walked, provider };
  }

  it("walks scanned files that have no stored chunks", async () => {
    const { walked } = await recomputeAfterSync([
      { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
    ]);
    expect(walked).toEqual(["app/models/user.rb", "src/a.ts", "src/tiny.ts"]);
  });

  it("narrows the scanned files to --languages", async () => {
    const { walked } = await recomputeAfterSync(
      [{ id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10, language: "typescript" } }],
      ["typescript"],
    );
    expect(walked).toEqual(["src/a.ts", "src/tiny.ts"]);
  });

  it("still repairs and finalizes when the scope holds no stored chunk at all", async () => {
    const { walked, provider } = await recomputeAfterSync([], ["typescript"]);
    expect(walked).toEqual(["src/a.ts", "src/tiny.ts"]);
    // Pass-2 resolution and `cg_run_stats` live in the finalize: a repair
    // without one leaves the re-extracted rows unresolved.
    expect(provider.finalizeSignals).toHaveBeenCalled();
  });
});
