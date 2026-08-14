/**
 * CompletionRunner step timing markers.
 *
 * The serial tail between the last DEFERRED chunk pass and ALL_COMPLETE ran
 * 121 s on one taxdome force-reindex and 261 s on the next, with NOT ONE line
 * of log between them — the runner emitted no markers at all, so the largest
 * remaining block of wall time after embedding could not be attributed to a
 * step. These pin that each step reports itself with a duration, which is what
 * makes the window measurable at all.
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
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

async function seedMarkerPoint(qdrant: MockQdrantManager, coll: string): Promise<void> {
  await qdrant.createCollection(coll, 384);
  await qdrant.addPoints(coll, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

function buildRunner(qdrant: MockQdrantManager): CompletionRunner {
  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  return new CompletionRunner({
    filePhase: new FilePhase(applier, marker, new InlineEnrichmentExecutor()),
    chunkPhase: new ChunkPhase(applier, new InlineEnrichmentExecutor()),
    backfiller: new EnrichmentBackfiller(applier, qdrant as never, new InlineEnrichmentExecutor()),
    applier,
    markerStore: marker,
    executor: new InlineEnrichmentExecutor(),
  });
}

const providerCtx = {
  key: "git",
  provider: {
    key: "git",
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    resolveRoot: (p: string) => p,
    fileSignalTransform: undefined,
  },
  effectiveRoot: "/repo",
  ignoreFilter: null,
};

describe("CompletionRunner step markers", () => {
  it("reports every step of the serial tail with a duration", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase").mockImplementation(() => undefined);

    try {
      await buildRunner(qdrant).run("coll", new Map([["git", providerCtx as never]]), Date.now());

      const steps = phases.mock.calls
        .filter(([name]) => name === "COMPLETION_STEP")
        .map(([, payload]) => payload as { step: string; durationMs: number });

      expect(steps.map((s) => s.step)).toEqual(
        expect.arrayContaining(["fileFinalize", "backfillAwait", "fileMarkers", "chunkDrain", "chunkMarkers"]),
      );
      for (const step of steps) {
        expect(typeof step.durationMs).toBe("number");
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      phases.mockRestore();
    }
  });

  // Both marker steps do exactly two things: a filtered scan for residual
  // unenriched points, and the terminal marker write. The write is `wait: true`,
  // so it is also a barrier on every `wait: false` payload write the preceding
  // apply step queued. On taxdome the scans measure ~6ms since the v14 payload
  // indexes while the steps measure 11.6s and 11.4s — a gap that is only
  // attributable once the two halves are reported apart.
  it("splits each marker step into its scan and its terminal write", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase").mockImplementation(() => undefined);

    try {
      await buildRunner(qdrant).run("coll", new Map([["git", providerCtx as never]]), Date.now(), async () => 0);

      const splits = phases.mock.calls
        .filter(([name]) => name === "COMPLETION_MARKER_SPLIT")
        .map(([, payload]) => payload as { step: string; scanMs: number; writeMs: number });

      expect(splits.map((s) => s.step)).toEqual(["fileMarkers", "chunkMarkers"]);
      for (const split of splits) {
        expect(split.scanMs).toBeGreaterThanOrEqual(0);
        expect(split.writeMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      phases.mockRestore();
    }
  });
});
