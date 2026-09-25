/**
 * The codegraph storage compaction step of the completion tail (bd
 * tea-rags-mcp-dvzdm).
 *
 * It runs once per run, after the last graph write of the run — the payload
 * heal's baseline refresh — and only when the run carried the codegraph, which
 * is exactly when the heal step applied. It is best-effort: a compaction that
 * fails leaves the previous file in place, so it must not fail the run.
 */

import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/contracts/constants.js";
import type { CodegraphStorageCompactionOutcome } from "../../../../../../src/core/contracts/types/codegraph.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

const COMPACTED: CodegraphStorageCompactionOutcome = {
  kind: "compacted",
  bytesBefore: 1_223_176_192,
  bytesAfter: 286_523_392,
  liveRows: 713_000,
  storedRows: 13_300_000,
  durationMs: 3900,
};

async function buildHarness(options: {
  defers: boolean;
  wired?: boolean;
  compact?: () => Promise<CodegraphStorageCompactionOutcome>;
  events?: string[];
}) {
  const qdrant = new MockQdrantManager();
  await qdrant.createCollection("coll", 384);
  await qdrant.addPoints("coll", [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);

  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
  const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
  filePhase.bindChunkPhase(chunkPhase);
  const backfiller = new EnrichmentBackfiller(applier, qdrant as never, new InlineEnrichmentExecutor());

  const events = options.events ?? [];
  const heal = vi.fn(async () => {
    events.push("heal");
    return { pointsRewritten: 0, filesTouched: 0 };
  });
  const compact = vi.fn(
    options.compact ??
      (async () => {
        events.push("compact");
        return COMPACTED;
      }),
  );
  const runner = new CompletionRunner({
    filePhase,
    chunkPhase,
    backfiller,
    applier,
    markerStore: marker,
    executor: new InlineEnrichmentExecutor(),
    codegraphHeal: { run: heal },
    codegraphCompaction: options.wired === false ? undefined : { run: compact },
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
  const markChunkFinal = marker.markChunkFinal.bind(marker);
  vi.spyOn(marker, "markChunkFinal").mockImplementation(async (...args) => {
    events.push("chunkMarker");
    return markChunkFinal(...args);
  });
  return { runner, contexts, compact, heal, events };
}

describe("CompletionRunner codegraph storage compaction", () => {
  it("compacts once per run, after the heal's baseline refresh and the terminal chunk markers", async () => {
    const { runner, contexts, compact, events } = await buildHarness({ defers: true });

    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]).toEqual(["coll"]);
    expect(events).toEqual(["heal", "chunkMarker", "compact"]);
  });

  it("is not applicable when the heal was not — the run carried no codegraph", async () => {
    const { runner, contexts, compact } = await buildHarness({ defers: false });

    await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");

    expect(compact).not.toHaveBeenCalled();
    expect(await runner.runCodegraphStorageCompaction("coll", { kind: "notApplicable" })).toEqual({
      kind: "notApplicable",
    });
  });

  it("is not applicable when no compaction runner is wired", async () => {
    const { runner } = await buildHarness({ defers: true, wired: false });

    expect(
      await runner.runCodegraphStorageCompaction("coll", { kind: "healed", pointsRewritten: 0, filesTouched: 0 }),
    ).toEqual({ kind: "notApplicable" });
  });

  it("still compacts after a heal that failed — the file bloats either way", async () => {
    const { runner, compact } = await buildHarness({ defers: true });

    const outcome = await runner.runCodegraphStorageCompaction("coll", { kind: "failed", error: "qdrant down" });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "settled", outcome: COMPACTED });
  });

  it("a compaction that throws settles as failed and the run still completes", async () => {
    const { runner, contexts } = await buildHarness({
      defers: true,
      compact: async () => {
        throw new Error("rename failed");
      },
    });

    expect(
      await runner.runCodegraphStorageCompaction("coll", { kind: "healed", pointsRewritten: 0, filesTouched: 0 }),
    ).toEqual({ kind: "failed", error: "rename failed" });
    const metrics = await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
