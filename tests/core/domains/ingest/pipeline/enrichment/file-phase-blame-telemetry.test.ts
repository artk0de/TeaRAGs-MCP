/**
 * bd tea-rags-mcp-v2mlw — FilePhase binds onBlameStats to the pipeline debug
 * log: one [GitEnrich] BLAME line per blame pass + the "blame" STAGE
 * PROFILING stage (mirrors ChunkPhase's onWalkStats → [ChunkChurn] WALK).
 * Inline-only dispatch path; the callback is never serialized.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

const items = [
  {
    chunkId: "c1",
    chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 },
  } as any,
];

describe("FilePhase blame telemetry (bd tea-rags-mcp-v2mlw)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds onBlameStats to the [GitEnrich] BLAME pipeline log and the blame stage", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    vi.spyOn(applier, "applyFileSignals").mockResolvedValue();
    const stepSpy = vi.spyOn(pipelineLog, "step");
    const stageSpy = vi.spyOn(pipelineLog, "addStageTime");

    const streamFileBatch = vi.fn().mockImplementation(async (_root: string, _paths: string[], options: any) => {
      options?.onBlameStats?.({ files: 3, hits: 2, misses: 1, durationMs: 12 });
      return new Map();
    });
    const ctx = {
      key: "git",
      provider: { key: "git", streamFileBatch, resolveRoot: (p: string) => p } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null as any,
    };

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");
    phase.onBatch("coll", "/repo", items);
    await phase.drain();

    expect(streamFileBatch).toHaveBeenCalledTimes(1);
    expect(stepSpy).toHaveBeenCalledWith(
      { component: "GitEnrich" },
      "BLAME",
      expect.objectContaining({ provider: "git", files: 3, hits: 2, misses: 1 }),
    );
    expect(stageSpy).toHaveBeenCalledWith("blame", 12);
  });
});
