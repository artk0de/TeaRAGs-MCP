/**
 * A codegraph daemon from another build is LOUD, never silent (bd
 * tea-rags-mcp-39xca.4) — exercised through a full enrichment run: the
 * coordinator, the worker-pool executor whose compiled worker rebuilds the
 * codegraph provider (a pool with no respawn hook), and a real daemon whose op
 * table is trimmed to stand in for an older build (see the harness header).
 *
 * `capability-handshake.test.ts` pins the handshake verdict against a bare pool
 * and client. What it cannot show is where the refusal lands in a run — whether
 * the run stops before it writes graph data, and what the collection's markers
 * say afterwards — nor that a tolerated op degrades a whole run and says so once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { reindexRunSpec } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";
import {
  daemonOpsWithout,
  startEnrichmentLifecycleHarness,
  type EnrichmentLifecycleHarness,
} from "./__helpers__/enrichment-lifecycle-harness.js";

describe("enrichment run against a daemon from another build — real worker pool, codegraph and daemon", () => {
  let harness: EnrichmentLifecycleHarness | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness?.close();
    harness = undefined;
  });

  async function runOnce(active: EnrichmentLifecycleHarness): Promise<unknown> {
    const run = active.coordinator.beginRun(reindexRunSpec(active.runSpecInput()));
    active.coordinator.onChunksStored(run, active.chunkItems());
    active.coordinator.startChunkEnrichment(run, active.chunkMap());
    return active.coordinator.awaitCompletion(run).catch((error: unknown) => error);
  }

  it("refuses a daemon lacking a required op before the run writes graph data, and fails the run naming the op", async () => {
    harness = await startEnrichmentLifecycleHarness({ daemonOpCommands: daemonOpsWithout("listAllPass1Aggregates") });

    const outcome = await runOnce(harness);

    // Loud: the run's completion fails with the skew, naming the op the daemon lacks.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/runs an older build without op listAllPass1Aggregates/);
    // Refused before any run work: nothing reached the graph, and no chunk got codegraph signals.
    expect(await harness.persistedSymbols()).toEqual([]);
    expect(harness.qdrant.chunkSignalWrites.filter((write) => "fanIn" in write.payload)).toEqual([]);
    // ...and the collection never claims the run went through.
    const marker = await harness.readEnrichmentMarker();
    const codegraph = (marker.codegraph as Record<string, any> | undefined)?.symbols as
      | Record<string, { status?: string } | undefined>
      | undefined;
    expect(codegraph?.file?.status).not.toBe("completed");
    expect(codegraph?.chunk?.status).not.toBe("completed");
  });

  it("degrades on a tolerated op the daemon lacks — the run completes with its signals — and warns once for that op", async () => {
    const stderr = vi.spyOn(process.stderr, "write");
    harness = await startEnrichmentLifecycleHarness({ daemonOpCommands: daemonOpsWithout("getFileMetricsBulk") });

    // Two runs on the same worker: the warning is once per op per process.
    for (let run = 0; run < 2; run += 1) {
      expect(await runOnce(harness)).not.toBeInstanceOf(Error);
      const marker = await harness.readEnrichmentMarker();
      expect(marker.codegraph.symbols.file.status).toBe("completed");
      expect(marker.codegraph.symbols.chunk.status).toBe("completed");
    }

    // The legacy per-file reads still produced the file overlays.
    const point = await harness.qdrant.getPoint(harness.collection, "00000000-0000-4000-8000-000000000003");
    const fileSignals = (point?.payload?.codegraph as Record<string, any> | undefined)?.symbols?.file;
    expect(fileSignals).toEqual(expect.objectContaining({ fanIn: expect.any(Number), fanOut: expect.any(Number) }));

    const warnings = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('older build without "getFileMetricsBulk"'));
    expect(warnings).toHaveLength(1);
  });
});
