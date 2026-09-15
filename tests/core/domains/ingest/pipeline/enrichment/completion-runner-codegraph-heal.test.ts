import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/contracts/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import type { CodegraphPayloadHealRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

async function seedMarkerPoint(qdrant: MockQdrantManager, coll: string): Promise<void> {
  await qdrant.createCollection(coll, 384);
  await qdrant.addPoints(coll, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

function chunkItem(root: string, relPath: string, chunkId: string): unknown {
  return {
    type: "upsert",
    chunkId,
    chunk: { content: "", startLine: 1, endLine: 10, metadata: { filePath: `${root}/${relPath}` } },
  };
}

interface Harness {
  runner: CompletionRunner;
  contexts: Map<string, unknown>;
  heal: ReturnType<typeof vi.fn>;
  chunkPhase: ChunkPhase;
  marker: EnrichmentMarkerStore;
}

async function buildHarness(options: { defers: boolean; heal?: CodegraphPayloadHealRunner["run"] }): Promise<Harness> {
  const qdrant = new MockQdrantManager();
  await seedMarkerPoint(qdrant, "coll");

  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
  const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
  filePhase.bindChunkPhase(chunkPhase);
  const backfiller = new EnrichmentBackfiller(applier, qdrant as never, new InlineEnrichmentExecutor());

  const heal = vi.fn(options.heal ?? (async () => ({ pointsRewritten: 4, filesTouched: 2 })));
  const runner = new CompletionRunner({
    filePhase,
    chunkPhase,
    backfiller,
    applier,
    markerStore: marker,
    executor: new InlineEnrichmentExecutor(),
    codegraphHeal: { run: heal } as CodegraphPayloadHealRunner,
  });

  const ctx = {
    key: "codegraph.symbols",
    provider: {
      key: "codegraph.symbols",
      defersChunkEnrichment: options.defers,
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      resolveRoot: (p: string) => p,
      fileSignalTransform: undefined,
    },
    effectiveRoot: "/repo",
    ignoreFilter: null,
  };
  const contexts = new Map([[ctx.key, ctx]]);
  filePhase.init(contexts as never, "coll", "run-1", "ts");
  chunkPhase.init(contexts as never, "coll", "ts");
  await marker.markRunStart("coll", [ctx.key], "run-1", "ts");

  // Accumulate the run's own chunk map — these are the files the finalize pass
  // rewrites, and exactly the ones the heal must NOT touch again.
  chunkPhase.onBatchProvider("codegraph.symbols", "coll", "/repo", [
    chunkItem("/repo", "src/changed.ts", "c1"),
  ] as never);

  return { runner, contexts: contexts as Map<string, unknown>, heal, chunkPhase, marker };
}

// bd tea-rags-mcp-39xca.5 — the completion tail's step dependencies are values, not
// comments: the deferred chunk pass returns the paths it owned, the heal builds its
// skip set from that value alone, and the chunk markers take the heal's outcome.
describe("CompletionRunner typed completion plan", () => {
  it("the deferred chunk pass names the whole-file paths it owned, seeded paths excluded", async () => {
    const { runner, contexts, chunkPhase } = await buildHarness({ defers: true });
    chunkPhase.appendDeferredChunks(
      "codegraph.symbols",
      new Map([["src/owed.ts", [{ chunkId: "o1", startLine: 1, endLine: 5 }]]]),
    );

    const deferredPass = await runner.runDeferredChunkPass("coll", contexts as never);

    expect(deferredPass.kind).toBe("deferred");
    const owned = deferredPass.kind === "deferred" ? [...deferredPass.wholeFileRelPaths] : [];
    expect(owned).toEqual(["src/changed.ts"]);
    // The pass clears its accumulated map on the way out — the outcome is what survives.
    expect(chunkPhase.getDeferredChunkMap("codegraph.symbols").size).toBe(0);
  });

  it("the heal receives exactly the paths the deferred pass returned", async () => {
    const { runner, contexts, heal } = await buildHarness({ defers: true });

    const deferredPass = await runner.runDeferredChunkPass("coll", contexts as never);
    const healOutcome = await runner.runCodegraphHeal("coll", deferredPass, "2026-09-15T00:00:00.000Z");

    expect(heal).toHaveBeenCalledTimes(1);
    const [coll, skip, enrichedAt] = heal.mock.calls[0];
    expect(coll).toBe("coll");
    expect(deferredPass.kind).toBe("deferred");
    expect(skip).toEqual(deferredPass.kind === "deferred" ? deferredPass.wholeFileRelPaths : undefined);
    expect(enrichedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(healOutcome).toEqual({ kind: "healed", pointsRewritten: 4, filesTouched: 2 });
  });

  it("a run with no deferring provider yields a not-applicable heal without calling the runner", async () => {
    const { runner, contexts, heal } = await buildHarness({ defers: false });

    const deferredPass = await runner.runDeferredChunkPass("coll", contexts as never);
    const healOutcome = await runner.runCodegraphHeal("coll", deferredPass, "ts");

    expect(deferredPass).toEqual({ kind: "noDeferringProvider" });
    expect(healOutcome).toEqual({ kind: "notApplicable" });
    expect(heal).not.toHaveBeenCalled();
  });

  it("a heal that throws settles as a failed outcome instead of rejecting", async () => {
    const { runner, contexts } = await buildHarness({
      defers: true,
      heal: async () => {
        throw new Error("qdrant unreachable");
      },
    });

    const deferredPass = await runner.runDeferredChunkPass("coll", contexts as never);

    expect(await runner.runCodegraphHeal("coll", deferredPass, "ts")).toEqual({
      kind: "failed",
      error: "qdrant unreachable",
    });
  });

  it("writes the terminal chunk marker only after the heal outcome has settled", async () => {
    const events: string[] = [];
    const { runner, contexts, marker } = await buildHarness({
      defers: true,
      heal: async () => {
        events.push("heal:start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push("heal:settled");
        return { pointsRewritten: 1, filesTouched: 1 };
      },
    });
    const markChunkFinal = marker.markChunkFinal.bind(marker);
    vi.spyOn(marker, "markChunkFinal").mockImplementation(async (...args) => {
      events.push("chunkMarker");
      return markChunkFinal(...args);
    });

    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");

    expect(events).toEqual(["heal:start", "heal:settled", "chunkMarker"]);
  });
});

// bd tea-rags-mcp-fxio5 — a path seeded from a recovery handoff carries only the
// chunks recovery found owed, not the file's whole chunk set. The deferred pass
// rewrites just those, so the heal must still reach the rest of the file.
describe("CompletionRunner codegraph payload heal — seeded deferred chunks", () => {
  it("keeps paths seeded from a recovery handoff out of the skip set", async () => {
    const { runner, contexts, heal, chunkPhase } = await buildHarness({ defers: true });
    chunkPhase.appendDeferredChunks(
      "codegraph.symbols",
      new Map([["src/owed.ts", [{ chunkId: "o1", startLine: 1, endLine: 5 }]]]),
    );

    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");

    expect(heal).toHaveBeenCalledTimes(1);
    const [, skip] = heal.mock.calls[0];
    expect([...(skip as Set<string>)]).toEqual(["src/changed.ts"]);
  });
});

// bd tea-rags-mcp-a2ddb — the heal runs inside the completion tail, after the
// deferred chunk pass (which is what rewrites this run's own chunk map) and
// before the terminal chunk marker (whose `wait: true` write is the barrier
// that drains the heal's `wait: false` payload writes).
describe("CompletionRunner codegraph payload heal", () => {
  it("heals with the run's own chunk-map files as the skip set", async () => {
    const { runner, contexts, heal } = await buildHarness({ defers: true });

    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "2026-09-11T00:00:00.000Z", "run-1");

    expect(heal).toHaveBeenCalledTimes(1);
    const [coll, skip, enrichedAt] = heal.mock.calls[0];
    expect(coll).toBe("coll");
    // The deferred pass CLEARS the chunk map, so a skip set read after it would
    // be empty and the heal would rewrite the run's own files a second time.
    expect([...(skip as Set<string>)]).toEqual(["src/changed.ts"]);
    expect(enrichedAt).toBe("2026-09-11T00:00:00.000Z");
  });

  it("skips the heal entirely when no provider in the run defers chunk enrichment", async () => {
    const { runner, contexts, heal } = await buildHarness({ defers: false });
    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");
    expect(heal).not.toHaveBeenCalled();
  });

  it("does not fail the run when the heal throws — the diff stands for the next run", async () => {
    const { runner, contexts, heal } = await buildHarness({
      defers: true,
      heal: async () => {
        throw new Error("qdrant unreachable");
      },
    });

    const metrics = await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");
    expect(heal).toHaveBeenCalledTimes(1);
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
