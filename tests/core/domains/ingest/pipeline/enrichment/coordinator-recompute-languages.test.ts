import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

/**
 * The language filter must reach the Qdrant scroll that collects the points to
 * recompute — filtering after the read would still pull the whole corpus
 * through memory, which is the cost the flag exists to avoid.
 */
function provider(key: string): EnrichmentProvider {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
  } as unknown as EnrichmentProvider;
}

function qdrantDouble(): Record<string, unknown> {
  return {
    scrollFiltered: vi.fn().mockResolvedValue([
      { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
      { id: "c2", payload: { relativePath: "lib/b.rb", startLine: 1, endLine: 10 } },
    ]),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

/** The filter object handed to the first scrollFiltered call. */
function scrollFilter(qdrant: Record<string, unknown>): {
  must?: { key?: string; match?: { any?: string[] } }[];
  must_not?: unknown[];
} {
  return (qdrant.scrollFiltered as ReturnType<typeof vi.fn>).mock.calls[0][1];
}

describe("EnrichmentCoordinator.recomputeEnrichments — language filter", () => {
  it("adds a language condition to the scroll when languages are given", async () => {
    const qdrant = qdrantDouble();
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"], ["typescript"]);

    const must = scrollFilter(qdrant).must ?? [];
    expect(must).toContainEqual({ key: "language", match: { any: ["typescript"] } });
  });

  it("carries every requested language in one condition", async () => {
    const qdrant = qdrantDouble();
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"], ["typescript", "ruby"]);

    const must = scrollFilter(qdrant).must ?? [];
    expect(must).toContainEqual({ key: "language", match: { any: ["typescript", "ruby"] } });
  });

  it("leaves the filter untouched when no languages are given", async () => {
    // The whole-index recompute is the default path and must stay byte-for-byte
    // what it was before the flag existed.
    const qdrant = qdrantDouble();
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"]);

    expect(scrollFilter(qdrant).must).toBeUndefined();
  });

  it("keeps the metadata exclusions alongside the language condition", async () => {
    // The language filter narrows what to enrich; it must not accidentally
    // re-admit the indexing_metadata points the recompute has always skipped.
    const qdrant = qdrantDouble();
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"], ["typescript"]);

    expect(scrollFilter(qdrant).must_not).toHaveLength(3);
  });

  it("treats an empty language list as no filter, not as an empty match", async () => {
    // `match: { any: [] }` selects nothing in Qdrant, which would silently turn
    // a recompute into a no-op that still reports success.
    const qdrant = qdrantDouble();
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    await coordinator.recomputeEnrichments("coll", "/repo", ["git"], []);

    expect(scrollFilter(qdrant).must).toBeUndefined();
  });
});
