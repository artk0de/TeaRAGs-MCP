import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";

describe("EnrichmentBackfiller", () => {
  it("fetches file overlays for missed paths and applies them to chunks", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);

    // Seed missed paths via reflection (test-only). The 95-line block is
    // out-of-scope; we drive its state through markBackfilled/getMissedFileChunks
    // contract instead.
    const internal = (applier as any)._missedFileChunks as Map<string, any[]>;
    internal.set("src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]);
    applier.missedFiles = 1;
    applier.matchedFiles = 0;

    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);

    const buildFileSignals = vi.fn().mockResolvedValue(new Map([["src/a.ts", { authorPct: 100 }]]));
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map([["src/a.ts", new Map([["c1", { commits: 3 }]])]]));
    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals,
        buildChunkSignals,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };

    await backfiller.runFor("coll", ctx, "2026-05-07T10:00:00Z");

    expect(buildFileSignals).toHaveBeenCalledWith("/repo", {
      paths: ["src/a.ts"],
    });
    expect(applier.matchedFiles).toBe(1);
    expect(applier.missedFiles).toBe(0);
    expect(buildChunkSignals).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no files are missed", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const buildFileSignals = vi.fn();
    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals,
        buildChunkSignals: vi.fn(),
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    await backfiller.runFor("coll", ctx, "ts");
    expect(buildFileSignals).not.toHaveBeenCalled();
  });
});
