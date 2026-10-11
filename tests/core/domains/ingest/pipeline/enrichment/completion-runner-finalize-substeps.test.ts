/**
 * fileFinalize sub-step attribution (bd tea-rags-mcp-4ybh4).
 *
 * `fileFinalize` ran 125-158 s in fast taxdome recomputes and 496-1214 s in
 * slow ones, with ~1209 s of the slowest unattributed: the step logged only its
 * total. Each stage inside it now reports itself through `FILE_FINALIZE_STEP`, and
 * `FilePhase#drain` reports its own wall clock with the Qdrant update-queue
 * length at both ends, so the slow mode can be placed in DuckDB/CPU work
 * (`runFinalize`), the node flush, the pass-1 read or the Qdrant drain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { fixturePhysicalCollectionName } from "../../../../__helpers__/collection-identity.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/contracts/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";
import { setDebug } from "../../../../../../src/core/infra/runtime.js";

const COLL = fixturePhysicalCollectionName("coll");

type PhaseCall = [string, Record<string, unknown>];

async function seed(qdrant: MockQdrantManager): Promise<void> {
  await qdrant.createCollection("coll", 384);
  await qdrant.addPoints("coll", [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

function harness(qdrant: MockQdrantManager) {
  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
  const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
  filePhase.bindChunkPhase(chunkPhase);
  const runner = new CompletionRunner({
    filePhase,
    chunkPhase,
    backfiller: new EnrichmentBackfiller(applier, qdrant as never, new InlineEnrichmentExecutor()),
    applier,
    markerStore: marker,
    executor: new InlineEnrichmentExecutor(),
  });
  return { runner, filePhase };
}

const codegraphLikeCtx = {
  key: "codegraph.symbols",
  provider: {
    key: "codegraph.symbols",
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    resolveRoot: (p: string) => p,
    fileSignalTransform: undefined,
    endExtractionRun: vi.fn().mockResolvedValue(undefined),
    readPersistedPass1Aggregates: vi.fn().mockResolvedValue([]),
    finalizeSignals: vi.fn().mockResolvedValue(new Map([["a.ts", { fanIn: 1 }]])),
  },
  effectiveRoot: "/repo",
  ignoreFilter: null,
};

describe("fileFinalize sub-steps", () => {
  let phases: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setDebug(true);
    phases = vi.spyOn(pipelineLog, "enrichmentPhase").mockImplementation(() => undefined);
  });

  afterEach(() => {
    phases.mockRestore();
    setDebug(false);
  });

  const calls = (name: string): Record<string, unknown>[] =>
    (phases.mock.calls as PhaseCall[]).filter(([n]) => n === name).map(([, payload]) => payload);

  it("times endExtractionRun, readPass1Aggregates, runFinalize, applyFinalize and the closing drain", async () => {
    const qdrant = new MockQdrantManager();
    await seed(qdrant);
    const { runner, filePhase } = harness(qdrant);
    const contexts = new Map([["codegraph.symbols", codegraphLikeCtx as never]]);
    filePhase.init(contexts, COLL, "run-1", new Date().toISOString(), true);

    await runner.run(COLL, contexts, Date.now());

    const steps = calls("FILE_FINALIZE_STEP").map((s) => s.step);
    expect(steps).toEqual(
      expect.arrayContaining(["endExtractionRun", "readPass1Aggregates", "runFinalize", "applyFinalize", "drain"]),
    );
    for (const s of calls("FILE_FINALIZE_STEP").filter((c) => c.step !== "drain")) {
      expect(s.provider).toBe("codegraph.symbols");
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("skips endExtractionRun timing off cross-pass", async () => {
    const qdrant = new MockQdrantManager();
    await seed(qdrant);
    const { runner, filePhase } = harness(qdrant);
    const contexts = new Map([["codegraph.symbols", codegraphLikeCtx as never]]);
    filePhase.init(contexts, COLL, "run-1", new Date().toISOString(), false);

    await runner.run(COLL, contexts, Date.now());

    expect(calls("FILE_FINALIZE_STEP").map((s) => s.step)).not.toContain("endExtractionRun");
  });
});

describe("FilePhase#drain — update-queue length", () => {
  let phases: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setDebug(true);
    phases = vi.spyOn(pipelineLog, "enrichmentPhase").mockImplementation(() => undefined);
  });

  afterEach(() => {
    phases.mockRestore();
    setDebug(false);
  });

  const drainLines = (): Record<string, unknown>[] =>
    (phases.mock.calls as PhaseCall[]).filter(([n]) => n === "FILE_PHASE_DRAIN").map(([, payload]) => payload);

  async function drained(info: () => Promise<unknown>): Promise<void> {
    const qdrant = new MockQdrantManager();
    await seed(qdrant);
    qdrant.getCollectionInfo = info as never;
    const { filePhase } = harness(qdrant);
    filePhase.init(new Map() as never, COLL, "run-1", new Date().toISOString());
    await filePhase.drain();
  }

  it("logs the queue length at drain start and end when Qdrant reports it", async () => {
    const lengths = [41, 3];
    await drained(async () => ({ updateQueueLength: lengths.shift() }));

    expect(drainLines()).toEqual([
      expect.objectContaining({ queueLengthStart: 41, queueLengthEnd: 3, durationMs: expect.any(Number) }),
    ]);
  });

  it("omits the queue fields when Qdrant does not report the queue", async () => {
    await drained(async () => ({ pointsCount: 1 }));

    const [line] = drainLines();
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty("queueLengthStart");
    expect(line).not.toHaveProperty("queueLengthEnd");
  });

  it("still drains and logs the duration when the queue read throws", async () => {
    await drained(async () => {
      throw new Error("qdrant down");
    });

    const [line] = drainLines();
    expect(line).toEqual(expect.objectContaining({ durationMs: expect.any(Number) }));
    expect(line).not.toHaveProperty("queueLengthStart");
  });

  it("neither reads the queue nor logs when DEBUG is off", async () => {
    setDebug(false);
    const info = vi.fn(async () => ({ updateQueueLength: 1 }));
    await drained(info);

    expect(info).not.toHaveBeenCalled();
    expect(drainLines()).toEqual([]);
  });
});
