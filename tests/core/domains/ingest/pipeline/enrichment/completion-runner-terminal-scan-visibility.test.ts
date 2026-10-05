/**
 * The terminal markers must be judged on the payload the run actually wrote
 * (bd tea-rags-mcp-vnmj1).
 *
 * Every enrichment payload write is `wait: false`: Qdrant acknowledges it once
 * it is in the WAL and applies it later, and a count or scroll issued meanwhile
 * reads the segments as they were. The only `wait: true` write of a run was the
 * terminal marker itself — AFTER the unenriched scan that decides its status. On
 * taxdome (`--force-enrichments codegraph`) the file-marker write took 37.9 s to
 * drain that queue while the scan before it took 0.6 s, so the 92 points whose
 * first codegraph file stamp was still queued were counted unenriched: the
 * marker said `degraded / 92` and the index, read a minute later, had 0.
 *
 * `QueuedWriteQdrant` models that visibility rule; the unenriched reader reads
 * only what has been applied.
 */
import { describe, expect, it, vi } from "vitest";

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

type WriteOptions = { wait?: boolean } | undefined;

/** Qdrant's write visibility: a `wait: false` update is invisible to reads until a `wait: true` one drains the queue. */
class QueuedWriteQdrant extends MockQdrantManager {
  private readonly pending: (() => Promise<void>)[] = [];

  override async batchSetPayload(
    collectionName: string,
    operations: { payload: Record<string, any>; points: (string | number)[]; key?: string }[],
    options?: WriteOptions,
  ): Promise<void> {
    await this.enqueue(async () => super.batchSetPayload(collectionName, operations, options), options);
  }

  override async batchDeletePayload(
    collectionName: string,
    operations: { keys: string[]; points: (string | number)[] }[],
    options?: WriteOptions,
  ): Promise<void> {
    await this.enqueue(async () => super.batchDeletePayload(collectionName, operations, options), options);
  }

  override async awaitQueuedUpdates(_collectionName: string): Promise<void> {
    await this.drain();
  }

  private async enqueue(apply: () => Promise<void>, options: WriteOptions): Promise<void> {
    this.pending.push(apply);
    // Updates apply in submission order, so waiting on this one waits on every one before it.
    if (options?.wait === true) await this.drain();
  }

  private async drain(): Promise<void> {
    for (let next = this.pending.shift(); next; next = this.pending.shift()) await next();
  }
}

const COLL = fixturePhysicalCollectionName("coll");
const PROVIDER = "codegraph.symbols";

async function seed(qdrant: MockQdrantManager): Promise<void> {
  await qdrant.createCollection(COLL, 4);
  await qdrant.addPoints(COLL, [
    { id: INDEXING_METADATA_ID, vector: [0, 0, 0, 0], payload: {} },
    // Neither point carries a codegraph stamp yet — this run's writes are their first.
    { id: "c1", vector: [0, 0, 0, 0], payload: { relativePath: "a.ts" } },
    { id: "d1", vector: [0, 0, 0, 0], payload: { relativePath: "doc.md" } },
  ]);
}

/** Counts the APPLIED state, like the real unenriched scan. */
async function unenrichedOf(qdrant: MockQdrantManager, level: "file" | "chunk"): Promise<number> {
  const points = await qdrant.scrollFiltered(COLL, {}, 100);
  return points.filter((p) => {
    if (p.id === INDEXING_METADATA_ID) return false;
    const node = (p.payload.codegraph as { symbols?: Record<string, Record<string, unknown>> } | undefined)?.symbols?.[
      level
    ];
    return node?.enrichedAt === undefined && node?.skippedAs === undefined;
  }).length;
}

function buildRun(qdrant: MockQdrantManager, fileOverlays: Map<string, Record<string, unknown>>) {
  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
  const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
  const runner = new CompletionRunner({
    filePhase,
    chunkPhase,
    backfiller: new EnrichmentBackfiller(applier, qdrant as never, new InlineEnrichmentExecutor()),
    applier,
    markerStore: marker,
    executor: new InlineEnrichmentExecutor(),
  });
  const ctx = {
    key: PROVIDER,
    provider: {
      key: PROVIDER,
      defersChunkEnrichment: true,
      finalizeSignals: vi.fn().mockResolvedValue(fileOverlays),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map([["a.ts", new Map([["c1", { fanIn: 1 }]])]])),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      streamFileBatch: vi.fn().mockResolvedValue(new Map()),
      resolveRoot: (p: string) => p,
    },
    effectiveRoot: "/repo",
    ignoreFilter: null,
  };
  const contexts = new Map([[ctx.key, ctx as never]]);
  filePhase.init(contexts, COLL, "run-1", "ts");
  chunkPhase.init(contexts, COLL, "ts");
  chunkPhase.onBatch(COLL, "/repo", [
    { chunkId: "c1", chunk: { metadata: { filePath: "/repo/a.ts" }, startLine: 1, endLine: 10 } } as never,
    { chunkId: "d1", chunk: { metadata: { filePath: "/repo/doc.md" }, startLine: 1, endLine: 30 } } as never,
  ]);
  const run = async () =>
    runner.run(
      COLL,
      contexts,
      Date.now(),
      async (_coll, _provider, level) => unenrichedOf(qdrant, level),
      "ts",
      "run-1",
    );
  return { run, marker };
}

async function terminalMarkers(marker: EnrichmentMarkerStore) {
  const record = (await marker.read(COLL)) as { codegraph: { symbols: Record<string, Record<string, unknown>> } };
  return record.codegraph.symbols;
}

describe("CompletionRunner terminal scan visibility (vnmj1)", () => {
  it("judges the file marker on the stamps fileFinalize queued, not on the segments before they land", async () => {
    const qdrant = new QueuedWriteQdrant();
    await seed(qdrant);
    const { run, marker } = buildRun(qdrant, new Map([["a.ts", { fanIn: 2 }]]));

    await run();

    const { file } = await terminalMarkers(marker);
    expect(file).toMatchObject({ status: "completed", unenrichedChunks: 0 });
  });

  it("judges the chunk marker on the stamps the deferred chunk pass queued", async () => {
    const qdrant = new QueuedWriteQdrant();
    await seed(qdrant);
    const { run, marker } = buildRun(qdrant, new Map([["a.ts", { fanIn: 2 }]]));

    await run();

    const { chunk } = await terminalMarkers(marker);
    expect(chunk).toMatchObject({ status: "completed", unenrichedChunks: 0 });
  });
});

// Why those 92 points had no codegraph file stamp BEFORE the recompute: the
// sync leg re-ingested only the two markdown files, the graph held no row for
// either, so finalize returned an EMPTY overlay map — and the file-finalize step
// skipped the apply outright on `size === 0`. The apply is also what bare-stamps
// a file the graph has nothing for, so the sync run ended with those points
// carrying neither terminal marker (its own file marker `degraded / 92`, the
// sync log's `missedFiles: 0`), owed until some later run.
describe("CompletionRunner file finalize with an empty overlay map (vnmj1)", () => {
  it("still settles the run's files the graph holds nothing for", async () => {
    const qdrant = new MockQdrantManager();
    await seed(qdrant);
    const { run, marker } = buildRun(qdrant, new Map());

    await run();

    const points = await qdrant.scrollFiltered(COLL, {}, 100);
    const fileStamps = Object.fromEntries(
      points
        .filter((p) => p.id !== INDEXING_METADATA_ID)
        .map((p) => [p.id, (p.payload.codegraph as any)?.symbols?.file?.enrichedAt]),
    );
    expect(fileStamps).toEqual({ c1: "ts", d1: "ts" });
    const { file } = await terminalMarkers(marker);
    expect(file).toMatchObject({ status: "completed", unenrichedChunks: 0 });
  });
});
