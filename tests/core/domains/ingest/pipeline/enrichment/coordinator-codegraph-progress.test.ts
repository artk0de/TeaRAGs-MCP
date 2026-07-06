import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProgressEvent } from "../../../../../../src/core/types.js";

/**
 * yl9tv Task 3 — surfaces the eager codegraph node-upsert progress (Tasks 1-2:
 * codegraph writes its nodes in bulk DURING embedding on the cross-pass path)
 * through the EXISTING `codegraph.symbols:symbols` progress event, so the CLI
 * indexing UI stops treating it as a dark tail.
 */
describe("EnrichmentCoordinator — codegraph.symbols:symbols progress (yl9tv Task 3)", () => {
  let mockQdrant: any;
  let mockProvider: EnrichmentProvider;

  const threeExtractions: FileExtraction[] = [
    { relPath: "src/a.ts", language: "typescript", imports: [], chunks: [], fileScope: [] },
    { relPath: "src/b.ts", language: "typescript", imports: [], chunks: [], fileScope: [] },
    { relPath: "src/c.ts", language: "typescript", imports: [], chunks: [], fileScope: [] },
  ];

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    mockProvider = {
      key: "codegraph",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      // A codegraph-style provider accepts cross-pass FileExtractions.
      acceptExtraction: vi.fn(),
    };
  });

  it("emits codegraph.symbols:symbols progress per accepted extraction on cross-pass", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    const events: EnrichmentProgressEvent[] = [];
    coordinator.setEnrichmentProgress((e) => events.push(e));

    coordinator.beginRun("/repo", "c", undefined, undefined, true);
    for (const ex of threeExtractions) coordinator.onFileExtraction("c", ex);

    const symbols = events.filter((e) => e.providerKey === "codegraph.symbols" && e.level === "symbols");
    expect(symbols.map((e) => e.applied)).toEqual([1, 2, 3]);
    expect(symbols.at(-1)?.totalFinal).toBe(false);
  });

  it("does NOT emit the symbols level on a non-cross-pass (incremental) run", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    const events: EnrichmentProgressEvent[] = [];
    coordinator.setEnrichmentProgress((e) => events.push(e));

    coordinator.beginRun("/repo", "c"); // crossPass defaults to false
    for (const ex of threeExtractions) coordinator.onFileExtraction("c", ex);

    expect(events.filter((e) => e.level === "symbols")).toHaveLength(0);
  });

  it("does NOT emit the symbols level when no provider implements acceptExtraction", async () => {
    // Even on a cross-pass run, a coordinator with only non-codegraph providers
    // (no acceptExtraction hook) must never emit the symbols level.
    const nonCodegraphProvider: EnrichmentProvider = { ...mockProvider, acceptExtraction: undefined };
    const coordinator = new EnrichmentCoordinator(mockQdrant, nonCodegraphProvider);
    const events: EnrichmentProgressEvent[] = [];
    coordinator.setEnrichmentProgress((e) => events.push(e));

    coordinator.beginRun("/repo", "c", undefined, undefined, true);
    for (const ex of threeExtractions) coordinator.onFileExtraction("c", ex);

    expect(events.filter((e) => e.level === "symbols")).toHaveLength(0);
  });

  it("resets codegraphSymbolsApplied between runs — run 2 starts back at 1", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    const run1Events: EnrichmentProgressEvent[] = [];
    coordinator.setEnrichmentProgress((e) => run1Events.push(e));
    coordinator.beginRun("/repo", "c1", undefined, undefined, true);
    for (const ex of threeExtractions) coordinator.onFileExtraction("c1", ex);
    const run1Symbols = run1Events.filter((e) => e.level === "symbols");
    expect(run1Symbols.at(-1)?.applied).toBe(3);

    const run2Events: EnrichmentProgressEvent[] = [];
    coordinator.setEnrichmentProgress((e) => run2Events.push(e));
    coordinator.beginRun("/repo", "c2", undefined, undefined, true);
    coordinator.onFileExtraction("c2", threeExtractions[0]);
    const run2Symbols = run2Events.filter((e) => e.level === "symbols");
    expect(run2Symbols).toHaveLength(1);
    expect(run2Symbols[0].applied).toBe(1);
  });
});
