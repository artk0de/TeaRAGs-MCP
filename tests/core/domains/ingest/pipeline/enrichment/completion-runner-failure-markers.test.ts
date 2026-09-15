/**
 * A completion that throws settles the terminal markers it still owes as
 * `failed` (bd tea-rags-mcp-39xca.11).
 *
 * Proven on the P7 lifecycle harness: a daemon skew made the codegraph finalize
 * (step 2) throw, `CompletionRunner#run` rejected, and no terminal marker was
 * ever written — the collection kept only `enrichment._run`, so status read
 * `in_progress` / `stalled` instead of `failed` with a cause. The rule these
 * pin: every provider gets a `failed` marker, carrying the error's message, at
 * every level THIS run has not already written; levels already terminal keep
 * what the run wrote; the original error is what the run rejects with.
 */
import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/contracts/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";
import type {
  ChunkFinalInput,
  FileFinalInput,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

const PROVIDER_KEYS = ["git", "codegraph.symbols"] as const;

async function seedMarkerPoint(qdrant: MockQdrantManager, coll: string): Promise<void> {
  await qdrant.createCollection(coll, 384);
  await qdrant.addPoints(coll, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

function providerContext(key: string, defers: boolean): Record<string, unknown> {
  return {
    key,
    provider: {
      key,
      defersChunkEnrichment: defers,
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      resolveRoot: (p: string) => p,
      fileSignalTransform: undefined,
    },
    effectiveRoot: "/repo",
    ignoreFilter: null,
  };
}

interface MarkerWrite {
  level: "file" | "chunk";
  providerKey: string;
  input: FileFinalInput | ChunkFinalInput;
}

interface FailureHarness {
  runner: CompletionRunner;
  contexts: Map<string, unknown>;
  executor: InlineEnrichmentExecutor;
  chunkPhase: ChunkPhase;
  marker: EnrichmentMarkerStore;
  writes: MarkerWrite[];
}

async function buildHarness(): Promise<FailureHarness> {
  const qdrant = new MockQdrantManager();
  await seedMarkerPoint(qdrant, "coll");

  const executor = new InlineEnrichmentExecutor();
  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  const filePhase = new FilePhase(applier, marker, executor);
  const chunkPhase = new ChunkPhase(applier, executor);
  filePhase.bindChunkPhase(chunkPhase);
  const backfiller = new EnrichmentBackfiller(applier, qdrant as never, executor);
  const runner = new CompletionRunner({ filePhase, chunkPhase, backfiller, applier, markerStore: marker, executor });

  const contexts = new Map<string, unknown>([
    ["git", providerContext("git", false)],
    ["codegraph.symbols", providerContext("codegraph.symbols", true)],
  ]);
  filePhase.init(contexts as never, "coll", "run-1", "ts");
  chunkPhase.init(contexts as never, "coll", "ts");
  await marker.markRunStart("coll", PROVIDER_KEYS, "run-1", "ts");

  // A deferred chunk map, so the deferred pass has work to run (and to fail).
  chunkPhase.onBatchProvider("codegraph.symbols", "coll", "/repo", [
    {
      type: "upsert",
      chunkId: "c1",
      chunk: { content: "", startLine: 1, endLine: 10, metadata: { filePath: "/repo/src/changed.ts" } },
    },
  ] as never);

  const writes: MarkerWrite[] = [];
  const markFileFinal = marker.markFileFinal.bind(marker);
  vi.spyOn(marker, "markFileFinal").mockImplementation(async (coll, providerKey, input) => {
    writes.push({ level: "file", providerKey, input });
    return markFileFinal(coll, providerKey, input);
  });
  const markChunkFinal = marker.markChunkFinal.bind(marker);
  vi.spyOn(marker, "markChunkFinal").mockImplementation(async (coll, providerKey, input) => {
    writes.push({ level: "chunk", providerKey, input });
    return markChunkFinal(coll, providerKey, input);
  });

  return { runner, contexts, executor, chunkPhase, marker, writes };
}

async function persistedLevel(
  marker: EnrichmentMarkerStore,
  providerKey: string,
  level: "file" | "chunk",
): Promise<Record<string, unknown> | undefined> {
  let node: unknown = await marker.read("coll");
  for (const segment of providerKey.split(".")) {
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }
  return (node as Record<string, Record<string, unknown> | undefined> | undefined)?.[level];
}

function writesAt(writes: MarkerWrite[], level: "file" | "chunk"): MarkerWrite[] {
  return writes.filter((write) => write.level === level);
}

describe("CompletionRunner — a completion that throws settles its unwritten terminal markers as failed", () => {
  it("a finalize failure (step 2) marks file AND chunk failed for every provider, and rejects with the original error", async () => {
    const { runner, contexts, executor, marker, writes } = await buildHarness();
    const skew = new Error("codegraph daemon runs an older build without op listAllPass1Aggregates");
    vi.spyOn(executor, "runFinalize").mockRejectedValue(skew);

    const outcome = await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBe(skew);
    for (const level of ["file", "chunk"] as const) {
      const atLevel = writesAt(writes, level);
      expect(atLevel.map((write) => write.providerKey).sort()).toEqual([...PROVIDER_KEYS].sort());
      for (const write of atLevel) {
        expect(write.input).toEqual(
          expect.objectContaining({ runId: "run-1", status: "failed", errorMessage: skew.message }),
        );
      }
      for (const providerKey of PROVIDER_KEYS) {
        expect(await persistedLevel(marker, providerKey, level)).toEqual(
          expect.objectContaining({ runId: "run-1", status: "failed", errorMessage: skew.message }),
        );
      }
    }
  });

  it("a deferred chunk pass failure (after the file markers) leaves the file markers as written and marks only chunk failed", async () => {
    const { runner, contexts, chunkPhase, marker, writes } = await buildHarness();
    const boom = new Error("deferred chunk pass exploded");
    vi.spyOn(chunkPhase, "runDeferredChunk").mockRejectedValue(boom);

    await expect(runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1")).rejects.toBe(boom);

    // The file level was already terminal: written once per provider, never overwritten.
    const fileWrites = writesAt(writes, "file");
    expect(fileWrites.map((write) => write.providerKey).sort()).toEqual([...PROVIDER_KEYS].sort());
    for (const write of fileWrites) {
      expect(write.input.status).toBe("completed");
      expect(write.input.errorMessage).toBeUndefined();
    }
    for (const providerKey of PROVIDER_KEYS) {
      expect(await persistedLevel(marker, providerKey, "file")).toEqual(
        expect.objectContaining({ status: "completed" }),
      );
      expect(await persistedLevel(marker, providerKey, "chunk")).toEqual(
        expect.objectContaining({ runId: "run-1", status: "failed", errorMessage: boom.message }),
      );
    }
    const chunkWrites = writesAt(writes, "chunk");
    expect(chunkWrites.map((write) => write.providerKey).sort()).toEqual([...PROVIDER_KEYS].sort());
    for (const write of chunkWrites) {
      expect(write.input).toEqual(expect.objectContaining({ status: "failed", errorMessage: boom.message }));
    }
  });

  it("a failure-marker write that throws is logged and swallowed — the run still rejects with the original error", async () => {
    const { runner, contexts, executor, marker } = await buildHarness();
    const original = new Error("finalize refused");
    vi.spyOn(executor, "runFinalize").mockRejectedValue(original);
    vi.spyOn(marker, "markFileFinal").mockRejectedValue(new Error("qdrant down while marking"));
    const chunkWrites: string[] = [];
    vi.spyOn(marker, "markChunkFinal").mockImplementation(async (_coll, providerKey) => {
      chunkWrites.push(providerKey);
    });
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");
    // The unenriched count is best-effort too: a reader that throws falls back to 0.
    const unenrichedReader = vi.fn().mockRejectedValue(new Error("count scroll failed"));

    try {
      await expect(
        runner.run("coll", contexts as never, Date.now() - 1000, unenrichedReader, "ts", "run-1"),
      ).rejects.toBe(original);

      // One throwing write does not stop the others.
      expect(chunkWrites.sort()).toEqual([...PROVIDER_KEYS].sort());
      const failureLogs = phases.mock.calls.filter(([name]) => name === "COMPLETION_FAILURE_MARKER_FAILED");
      expect(failureLogs).toHaveLength(PROVIDER_KEYS.length);
      for (const [, data] of failureLogs) {
        expect(data).toEqual(
          expect.objectContaining({ collection: "coll", level: "file", error: "qdrant down while marking" }),
        );
      }
      expect(vi.mocked(marker.markChunkFinal).mock.calls.map(([, , input]) => input.unenrichedChunks)).toEqual([0, 0]);
    } finally {
      phases.mockRestore();
    }
  });

  it("a successful completion writes exactly the success-path markers, in order, with the same step log", async () => {
    const { runner, contexts, writes } = await buildHarness();
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");

    try {
      await runner.run("coll", contexts as never, Date.now() - 1000, undefined, "ts", "run-1");

      expect(writes.map((write) => `${write.level}:${write.providerKey}:${write.input.status}`)).toEqual([
        "file:git:completed",
        "file:codegraph.symbols:completed",
        "chunk:git:completed",
        "chunk:codegraph.symbols:completed",
      ]);
      expect(writes.every((write) => write.input.errorMessage === undefined)).toBe(true);
      expect(
        phases.mock.calls
          .filter(([name]) => name === "COMPLETION_STEP")
          .map(([, data]) => (data as { step: string }).step),
      ).toEqual(["fileFinalize", "backfillAwait", "fileMarkers", "chunkDrain", "deferredChunk", "chunkMarkers"]);
      expect(phases.mock.calls.some(([name]) => name === "COMPLETION_FAILURE_MARKER_FAILED")).toBe(false);
    } finally {
      phases.mockRestore();
    }
  });
});
