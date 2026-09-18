import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { reindexRunSpec } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";

/**
 * bd tea-rags-mcp-9mwny — the applier deletes the optional overlay keys a
 * written overlay omits, but only for providers it was TOLD about. The run's
 * applier is built inside the coordinator, so this pins that the coordinator
 * hands it the composition's providers: without them every run silently keeps
 * the stale keys, and every applier-level test still passes.
 */

type DeleteOp = { keys: string[]; points: (string | number)[] };

describe("EnrichmentCoordinator — the run's applier knows each provider's optional overlay keys", () => {
  it("a run's overlay write deletes the declared optional key its overlay omits", async () => {
    const deletes: DeleteOp[] = [];
    const qdrant = {
      getPoint: vi.fn().mockResolvedValue(null),
      setPayload: vi.fn().mockResolvedValue(undefined),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      batchDeletePayload: vi.fn(async (_collection: string, ops: DeleteOp[]) => {
        deletes.push(...ops);
        return Promise.resolve();
      }),
    };
    const provider = {
      key: "codegraph.symbols",
      signals: [],
      derivedSignals: [],
      filters: [],
      presets: [],
      defersChunkEnrichment: true,
      optionalOverlayKeys: { chunk: ["pageRank"] },
      resolveRoot: (p: string) => p,
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      finalizeSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const executor = {
      runFileBatch: vi.fn().mockResolvedValue(new Map()),
      runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
      // The deferred chunk pass's overlay leaves `pageRank` out.
      runChunkBatch: vi.fn().mockResolvedValue(new Map([["src/app.ts", new Map([["c-1", { fanIn: 1, fanOut: 0 }]])]])),
      runFinalize: vi.fn().mockResolvedValue(new Map()),
      releaseRun: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const coordinator = new EnrichmentCoordinator(qdrant as never, provider, undefined, executor);

    const run = coordinator.beginRun(reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }));
    coordinator.seedDeferredChunks(
      run,
      new Map([["codegraph.symbols", new Map([["src/app.ts", [{ chunkId: "c-1", startLine: 1, endLine: 20 }]]])]]),
    );
    await coordinator.awaitCompletion(run);

    expect(deletes).toEqual([{ keys: ["codegraph.symbols.chunk.pageRank"], points: ["c-1"] }]);
  });
});
