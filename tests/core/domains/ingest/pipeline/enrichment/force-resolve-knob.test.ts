/**
 * `CODEGRAPH_FORCE_RESOLVE` — the diagnostic force-resolve knob (bd tea-rags-mcp-bij2m).
 *
 * Pass-2 resolve is 97.6% of a large codegraph enrichment wall (2,106,536 ms of
 * 2,159,393 ms on a 10,374-file TypeScript corpus), and it is the one phase that
 * cannot be sampled on demand: the 6goqa content-hash check keeps unchanged
 * files out of pass-1, so they never reach the spill and pass-2 never sees them.
 * A repeat run therefore resolves a few hundred drifted files and the profiler
 * captures the wrong phase.
 *
 * The knob forces every eligible file into the repair set, which is the only
 * lever that reaches pass-2 — `resolveAndUpsert` resolves whatever is in the
 * spill, unconditionally, so the file set is decided upstream or not at all.
 *
 * What these pin, in both directions: with the knob absent the skip behaves
 * EXACTLY as it does today (an unchanged file is not re-extracted), and with it
 * set the same unchanged file is. The off-path assertions are deliberate
 * duplicates of the 6goqa expectations — a diagnostic knob that alters the
 * default is a defect, not a diagnostic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { computeExtractionRepair } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/extraction-repair.js";

const qdrant = {} as never;

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

function makeExecutor(runFileBatch: ReturnType<typeof vi.fn>) {
  return {
    runFileBatch,
    runFileSignalsStreaming: vi.fn().mockResolvedValue(new Map()),
    runChunkSignals: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseCollection: vi.fn().mockResolvedValue(undefined),
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
});

describe("computeExtractionRepair force-all", () => {
  it("leaves a matching file out of the repair set by default", () => {
    // The knob is a third parameter with a false default, so an unchanged call
    // site keeps 6goqa's exact semantics.
    const eligible = new Map([["src/a.ts", "h1"]]);
    const persisted = new Map<string, string | null>([["src/a.ts", "h1"]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({ repair: [], orphans: [] });
    expect(computeExtractionRepair(eligible, persisted, false)).toEqual({ repair: [], orphans: [] });
  });

  it("repairs every eligible file when forced, hash match or not", () => {
    const eligible = new Map([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
    ]);
    const persisted = new Map<string, string | null>([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
    ]);

    expect(computeExtractionRepair(eligible, persisted, true)).toEqual({
      repair: ["src/a.ts", "src/b.ts"],
      orphans: [],
    });
  });

  it("still reports orphans when forced, and never invents eligible files", () => {
    // Forcing widens the repair set only. Orphan detection is hash-independent
    // and must not change, or a forced profiling run would start pruning rows.
    const eligible = new Map([["src/a.ts", "h1"]]);
    const persisted = new Map<string, string | null>([
      ["src/a.ts", "h1"],
      ["src/gone.ts", "h9"],
    ]);

    expect(computeExtractionRepair(eligible, persisted, true)).toEqual({
      repair: ["src/a.ts"],
      orphans: ["src/gone.ts"],
    });
  });

  it("repairs nothing when forced over an empty eligible set", () => {
    expect(computeExtractionRepair(new Map(), new Map(), true)).toEqual({ repair: [], orphans: [] });
  });
});

describe("EnrichmentCoordinator.runRepairPass under CODEGRAPH_FORCE_RESOLVE", () => {
  it("extracts nothing when the knob is absent and the store is current", async () => {
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

  it("re-extracts every eligible file when the knob is set", async () => {
    process.env.CODEGRAPH_FORCE_RESOLVE = "1";
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      currentStoreProvider(),
      undefined,
      makeExecutor(runFileBatch),
    );

    expect(await coordinator.runRepairPass("code_x_v1", "/repo", SCANNED)).toBe(2);
    expect(runFileBatch).toHaveBeenCalledTimes(1);
    const [, root, paths] = runFileBatch.mock.calls[0] as [unknown, string, string[]];
    expect(root).toBe("/repo");
    expect([...paths].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accepts `true` as well as `1`", async () => {
    process.env.CODEGRAPH_FORCE_RESOLVE = "true";
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      currentStoreProvider(),
      undefined,
      makeExecutor(runFileBatch),
    );

    await coordinator.runRepairPass("code_x_v1", "/repo", SCANNED);

    expect(runFileBatch).toHaveBeenCalledTimes(1);
  });

  it.each(["0", "false", "yes", ""])("stays off for %o, the same as absent", async (value) => {
    // Anything that is not `1` / `true` is off. A profiling knob that turns
    // itself on for a typo would silently make every run pay a full resolve.
    process.env.CODEGRAPH_FORCE_RESOLVE = value;
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

  it("still threads the run's content hashes, so the stamps stay correct", async () => {
    // A forced run resolves files a normal run would have skipped and stamps
    // them with their CURRENT hash — exactly what a full resolve does. Losing
    // the hashes here would persist NULL and leave the next ordinary run with a
    // maximal repair set: corruption beyond what forcing itself implies.
    process.env.CODEGRAPH_FORCE_RESOLVE = "1";
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      currentStoreProvider(),
      undefined,
      makeExecutor(runFileBatch),
    );

    await coordinator.runRepairPass("code_x_v1", "/repo", SCANNED);

    const [, , , options] = runFileBatch.mock.calls[0] as [
      unknown,
      string,
      string[],
      { collectionName: string; contentHashes?: ReadonlyMap<string, string> },
    ];
    expect(options.collectionName).toBe("code_x_v1");
    expect(options.contentHashes?.get("src/a.ts")).toBe("h1");
    expect(options.contentHashes?.get("src/b.ts")).toBe("h2");
  });

  it("does not force a provider that keeps no per-file store", async () => {
    // Forcing widens a drift check. A provider with no store has no drift check
    // to widen, so git must stay exactly where it was: skipped.
    process.env.CODEGRAPH_FORCE_RESOLVE = "1";
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(qdrant, makeProvider(), undefined, makeExecutor(runFileBatch));

    expect(await coordinator.runRepairPass("code_x_v1", "/repo", SCANNED)).toBe(0);
    expect(runFileBatch).not.toHaveBeenCalled();
  });
});
