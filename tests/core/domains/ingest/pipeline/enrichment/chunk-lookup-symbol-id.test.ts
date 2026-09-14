/**
 * Every producer of a `ChunkLookupEntry` carries the chunker's symbolId when the
 * chunk has one (bd tea-rags-mcp-9i2ow).
 *
 * The codegraph chunk-owner rule anchors on that symbolId: without it a primary
 * chunk whose leading comment starts above its method, or a `#part` chunk past
 * every nested helper, has nothing to fall back to. An entry is built in four
 * places — the live pipeline's batch map, pre-reindex recovery, the
 * `--force-enrichments` recompute scroll, and the missed-file backfill — and an
 * entry that loses the id in any one of them silently maps by lines alone.
 */

import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

const PART_ID = "Foo#bar#part2";

describe("ChunkLookupEntry.symbolId producers (bd tea-rags-mcp-9i2ow)", () => {
  it("the pipeline's batch chunk map carries the chunk's symbolId into the deferred map", async () => {
    const applier = new EnrichmentApplier(new MockQdrantManager() as any);
    const ctx = {
      key: "codegraph.symbols",
      provider: { key: "codegraph.symbols", defersChunkEnrichment: true, buildChunkSignals: vi.fn() } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null as any,
    };
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", [
      {
        chunkId: "c1",
        chunk: { metadata: { filePath: "/repo/src/a.ts", symbolId: PART_ID }, startLine: 20, endLine: 40 },
      },
      { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 41, endLine: 50 } },
    ] as any);
    await phase.drain();

    expect(phase.getDeferredChunkMap("codegraph.symbols").get("src/a.ts")).toEqual([
      { chunkId: "c1", startLine: 20, endLine: 40, symbolId: PART_ID },
      { chunkId: "c2", startLine: 41, endLine: 50 },
    ]);
  });

  it("recovery reads the symbolId back and hands it off with the owed chunk", async () => {
    const qdrant = {
      scrollFiltered: vi
        .fn()
        .mockResolvedValue([
          { id: "c1", payload: { relativePath: "src/a.ts", startLine: 20, endLine: 40, symbolId: PART_ID } },
        ]),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(0),
    };
    const applier = { applySkipStamps: vi.fn().mockResolvedValue(0), applyChunkSignals: vi.fn() };
    const recovery = new EnrichmentRecovery(qdrant as any, applier as any, {
      executor: { runChunkBatch: vi.fn() } as any,
    });
    const provider = {
      key: "codegraph.symbols",
      defersChunkEnrichment: true,
      resolveRoot: (p: string) => p,
      buildChunkSignals: vi.fn(),
      filterExtractablePaths: (paths: readonly string[]) => paths,
    };

    const result = await recovery.recoverChunkLevel("coll", "/repo", provider as any, "2026-01-01T00:00:00Z");

    expect(qdrant.scrollFiltered.mock.calls[0][4]).toContain("symbolId");
    expect(result.deferredChunks).toEqual(
      new Map([["src/a.ts", [{ chunkId: "c1", startLine: 20, endLine: 40, symbolId: PART_ID }]]]),
    );
  });

  it("the recompute scroll reads the symbolId and passes it to the deferred chunk pass", async () => {
    const qdrant = {
      scrollFiltered: vi
        .fn()
        .mockResolvedValue([
          { id: "c1", payload: { relativePath: "src/a.ts", startLine: 20, endLine: 40, symbolId: PART_ID } },
        ]),
      setPayload: vi.fn().mockResolvedValue(undefined),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(0),
      getPoint: vi.fn().mockResolvedValue(null),
      upsertPoints: vi.fn().mockResolvedValue(undefined),
    };
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
    const provider = {
      key: "codegraph.symbols",
      signals: [],
      derivedSignals: [],
      filters: [],
      presets: [],
      resolveRoot: (p: string) => p,
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      finalizeSignals: vi.fn().mockResolvedValue(new Map()),
      defersChunkEnrichment: true,
      buildChunkSignals,
    } as unknown as EnrichmentProvider;
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider]);
    // The recompute's chunk map is handed to the run's chunk phase here, the one
    // seam every provider's deferred pass reads from. Snapshot at call time: the
    // deferred pass clears the map it dispatched once it settles.
    const passed: unknown[] = [];
    const start = coordinator.startChunkEnrichment.bind(coordinator);
    vi.spyOn(coordinator, "startChunkEnrichment").mockImplementation((coll, path, map) => {
      passed.push(...structuredClone([...map.values()].flat()));
      start(coll, path, map);
    });

    await coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);

    expect(qdrant.scrollFiltered.mock.calls[0][4]).toContain("symbolId");
    expect(passed).toEqual([{ chunkId: "c1", startLine: 20, endLine: 40, symbolId: PART_ID }]);
  });

  it("the missed-file backfill keeps the symbolId the applier saw", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    await applier.applyFileSignals("coll", "codegraph.symbols", new Map(), "/repo", [
      {
        type: "upsert",
        id: "c1",
        chunkId: "c1",
        codebasePath: "/repo",
        chunk: { content: "", startLine: 20, endLine: 40, metadata: { filePath: "/repo/src/a.ts", symbolId: PART_ID } },
      } as any,
    ]);
    expect(applier.getMissedFileChunks().get("src/a.ts")).toEqual([
      { chunkId: "c1", startLine: 20, endLine: 40, symbolId: PART_ID },
    ]);

    const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    await backfiller.runFor(
      "coll",
      {
        key: "codegraph.symbols",
        provider: {
          key: "codegraph.symbols",
          buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { fanIn: 1 }]])),
          buildChunkSignals,
          fileSignalTransform: undefined,
        } as any,
        effectiveRoot: "/repo",
        ignoreFilter: null,
      } as any,
      "2026-01-01T00:00:00Z",
    );

    expect(buildChunkSignals.mock.calls[0][1]).toEqual(
      new Map([["src/a.ts", [{ chunkId: "c1", startLine: 20, endLine: 40, symbolId: PART_ID }]]]),
    );
  });
});
