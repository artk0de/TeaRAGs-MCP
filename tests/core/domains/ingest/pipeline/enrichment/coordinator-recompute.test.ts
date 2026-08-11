import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

/**
 * A recompute is a full enrichment RUN, not a repair.
 *
 * That distinction is the whole point of these tests. Driving it through
 * recovery rewrote payload correctly but never opened a run, so
 * `finalizeSignals` — where codegraph persists its resolve breakdown to
 * `cg_run_stats` — never fired, and the coordinator's RunState reported zero
 * work. Both were observed live on 2026-08-11.
 */
function provider(key: string, extra: Partial<EnrichmentProvider> = {}): EnrichmentProvider {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    ...extra,
  } as unknown as EnrichmentProvider;
}

/** Qdrant double serving one page of already-indexed points. */
function qdrantWithPoints(points: { id: string; relativePath: string }[]): Record<string, unknown> {
  return {
    scrollFiltered: vi.fn().mockResolvedValue(
      points.map((p) => ({
        id: p.id,
        payload: { relativePath: p.relativePath, startLine: 1, endLine: 10 },
      })),
    ),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

const POINTS = [
  { id: "c1", relativePath: "src/a.ts" },
  { id: "c2", relativePath: "src/b.ts" },
];

describe("EnrichmentCoordinator.recomputeEnrichments", () => {
  let qdrant: Record<string, unknown>;

  beforeEach(() => {
    qdrant = qdrantWithPoints(POINTS);
  });

  it("opens a real run so the provider's finalize hook fires", async () => {
    // finalizeSignals is where codegraph writes cg_run_stats. A repair-style
    // pass never calls it, which is exactly the defect this replaces.
    const finalizeSignals = vi.fn().mockResolvedValue(new Map());
    const p = provider("codegraph.symbols", { finalizeSignals, defersChunkEnrichment: true });
    const coordinator = new EnrichmentCoordinator(qdrant as never, [p]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);

    expect(finalizeSignals).toHaveBeenCalled();
  });

  it("returns the run's enrichment metrics rather than nothing", async () => {
    // The CLI's --json surfaces these; reporting zero work on a successful
    // recompute is what made the run look like a no-op.
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    const metrics = await coordinator.recomputeEnrichments("coll", "/repo", ["git"]);

    expect(metrics).toBeDefined();
  });

  it("feeds every indexed file to the selected provider", async () => {
    const p = provider("git");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [p]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"]);

    const paths = (p.buildFileSignals as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      (call) => (call[1] as { paths?: string[] })?.paths ?? [],
    );
    expect(new Set(paths)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  it("leaves unselected providers untouched", async () => {
    const git = provider("git");
    const cg = provider("codegraph.symbols");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [git, cg]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"]);

    expect(git.buildFileSignals).toHaveBeenCalled();
    expect(cg.buildFileSignals).not.toHaveBeenCalled();
  });

  it("expands a namespace selector to every provider under it", async () => {
    const symbols = provider("codegraph.symbols");
    const complexity = provider("codegraph.complexity");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git"), symbols, complexity]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);

    expect(symbols.buildFileSignals).toHaveBeenCalled();
    expect(complexity.buildFileSignals).toHaveBeenCalled();
  });

  it("does nothing when no provider matches the selector", async () => {
    const p = provider("git");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [p]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["nonsense"]);

    expect(p.buildFileSignals).not.toHaveBeenCalled();
  });

  it("does nothing when the index holds no points", async () => {
    const p = provider("git");
    const coordinator = new EnrichmentCoordinator(qdrantWithPoints([]) as never, [p]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"]);

    expect(p.buildFileSignals).not.toHaveBeenCalled();
  });
});
