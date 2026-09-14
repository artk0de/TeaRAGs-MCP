import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

/**
 * bd tea-rags-mcp-xpmwg — a provider's finalize must be told whether the run
 * resolved its whole corpus. Codegraph uses it to decide what its resolve
 * breakdown may claim: a whole-corpus run's per-file tallies describe every
 * language it walked, an incremental run's describe only the files it touched.
 * The coordinator is the one place that knows which kind of run it opened.
 */
function codegraphProvider(finalizeSignals: ReturnType<typeof vi.fn>): EnrichmentProvider {
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals,
    defersChunkEnrichment: true,
  } as unknown as EnrichmentProvider;
}

function qdrantWithPoints(points: { id: string; relativePath: string }[]): Record<string, unknown> {
  return {
    scrollFiltered: vi
      .fn()
      .mockResolvedValue(
        points.map((p) => ({ id: p.id, payload: { relativePath: p.relativePath, startLine: 1, endLine: 10 } })),
      ),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

const coverageOf = (finalizeSignals: ReturnType<typeof vi.fn>): unknown[] =>
  finalizeSignals.mock.calls.map((call) => (call[1] as { runCoverage?: unknown } | undefined)?.runCoverage);

describe("EnrichmentCoordinator — finalize run coverage (xpmwg)", () => {
  it("a recompute tells finalize it resolved the whole corpus", async () => {
    const finalizeSignals = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(qdrantWithPoints([{ id: "c1", relativePath: "src/a.ts" }]) as never, [
      codegraphProvider(finalizeSignals),
    ]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"], ["typescript"]);

    expect(coverageOf(finalizeSignals)).toEqual(["wholeCorpus"]);
  });

  it("a finalize-only repair run tells finalize it resolved a subset", async () => {
    const finalizeSignals = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(qdrantWithPoints([]) as never, [codegraphProvider(finalizeSignals)]);

    await coordinator.runFinalizeOnly("/repo", "coll");

    expect(coverageOf(finalizeSignals)).toEqual(["subset"]);
  });

  it("an ordinary run is a subset unless its caller declares the whole corpus", async () => {
    const subsetFinalize = vi.fn().mockResolvedValue(new Map());
    const subset = new EnrichmentCoordinator(qdrantWithPoints([]) as never, [codegraphProvider(subsetFinalize)]);
    subset.beginRun("/repo", "coll");
    await subset.awaitCompletion("coll");

    const wholeFinalize = vi.fn().mockResolvedValue(new Map());
    const whole = new EnrichmentCoordinator(qdrantWithPoints([]) as never, [codegraphProvider(wholeFinalize)]);
    whole.beginRun("/repo", "coll", undefined, undefined, false, 0, undefined, undefined, undefined, "wholeCorpus");
    await whole.awaitCompletion("coll");

    expect(coverageOf(subsetFinalize)).toEqual(["subset"]);
    expect(coverageOf(wholeFinalize)).toEqual(["wholeCorpus"]);
  });
});
