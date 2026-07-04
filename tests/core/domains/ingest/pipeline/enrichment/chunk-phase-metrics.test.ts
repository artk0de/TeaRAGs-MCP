/**
 * bd tea-rags-mcp-iqpuu — per-provider chunk metrics + policy-drop visibility.
 *
 * getMetrics() exposes per-provider wall spans (providerDurationsMs) and the
 * churn total excludes deferred providers (the codegraph resolve pass no
 * longer pollutes chunkChurnDurationMs). The formerly-silent
 * filterByEnrichmentPolicy drop inside runChunkSignals now logs a
 * CHUNK_POLICY_FILTERED pipeline event with counts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

function buildCtx(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    provider: { key, buildChunkSignals: vi.fn().mockResolvedValue(new Map()), ...overrides } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null as any,
  };
}

const batchOf = (rel: string, chunkId: string) =>
  [{ chunkId, chunk: { metadata: { filePath: `/repo/${rel}` }, startLine: 1, endLine: 10 } }] as any[];

const sleep = async (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ChunkPhase per-provider metrics (bd tea-rags-mcp-iqpuu)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getMetrics exposes per-provider durations and excludes deferred providers from the churn total", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);

    const gitBuild = vi.fn().mockImplementation(async () => {
      await sleep(15);
      return new Map();
    });
    const cgBuild = vi.fn().mockImplementation(async () => {
      await sleep(15);
      return new Map();
    });
    const gitCtx = buildCtx("git", { buildChunkSignals: gitBuild });
    const cgCtx = buildCtx("cg", { buildChunkSignals: cgBuild, defersChunkEnrichment: true });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(
      new Map([
        [gitCtx.key, gitCtx],
        [cgCtx.key, cgCtx],
      ]),
      "coll",
      "ts",
    );

    // Streaming batch: git dispatches, cg only accumulates.
    phase.onBatch("coll", "/repo", batchOf("src/a.ts", "c1"));
    await phase.drain();

    // A visible gap between the git span and the deferred cg pass — if the
    // total still included cg, it would cover this gap too.
    await sleep(30);
    await phase.runDeferredChunk("coll", cgCtx, "/repo", phase.getDeferredChunkMap("cg"));

    const m = phase.getMetrics();
    expect(m.providerDurationsMs.git).toBeGreaterThan(0);
    expect(m.providerDurationsMs.cg).toBeGreaterThan(0);
    // The churn total is pinned to the ONLY non-deferred provider's span —
    // exact equality: git is the single streaming provider here.
    expect(m.totalChunkEnrichmentDurationMs).toBe(m.providerDurationsMs.git);
  });

  it("logs the silent enrichment-policy drop with counts", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
    // Provider policy drops EVERYTHING from the chunk walk.
    const ctx = buildCtx("git", { buildChunkSignals, shouldEnrich: () => "none" });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    const phaseSpy = vi.spyOn(pipelineLog, "enrichmentPhase");
    phase.enrichRemaining(
      "coll",
      "/repo",
      new Map([
        ["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
        ["src/b.ts", [{ chunkId: "c2", startLine: 1, endLine: 10 }]],
      ]),
    );
    await phase.drain();

    expect(phaseSpy).toHaveBeenCalledWith(
      "CHUNK_POLICY_FILTERED",
      expect.objectContaining({ provider: "git", inputFiles: 2, policyDropped: 2, dispatched: 0 }),
    );
    expect(buildChunkSignals).not.toHaveBeenCalled();
  });
});
