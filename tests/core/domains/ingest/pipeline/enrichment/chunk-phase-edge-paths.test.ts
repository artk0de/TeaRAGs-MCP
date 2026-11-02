import { afterEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { fixturePhysicalCollectionName } from "../../../../__helpers__/collection-identity.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";

const coll = fixturePhysicalCollectionName("coll");

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    key: "git",
    provider: { key: "git", buildChunkSignals: vi.fn().mockResolvedValue(new Map()), ...overrides } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null as any,
  };
}

const items = [
  { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 } } as any,
];

function makePhase(ctx: ReturnType<typeof buildCtx>) {
  const applier = new EnrichmentApplier(new MockQdrantManager() as any);
  const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
  phase.init(new Map([[ctx.key, ctx]]), coll, "ts");
  return { phase, applier };
}

describe("ChunkPhase defensive edge paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fireOnComplete swallows a throwing callback and logs it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { phase } = makePhase(buildCtx());
    const cb = vi.fn().mockRejectedValue(new Error("boom"));
    phase.setOnComplete(cb);

    await expect(phase.fireOnComplete(coll)).resolves.toBeUndefined();

    expect(cb).toHaveBeenCalledWith(coll);
    expect(errSpy).toHaveBeenCalled();
  });

  it("fireOnComplete is a no-op without a registered callback", async () => {
    const { phase } = makePhase(buildCtx());
    await expect(phase.fireOnComplete(coll)).resolves.toBeUndefined();
  });

  it("ignores markFailed, onBatch and appendDeferredChunks for an unknown provider key", async () => {
    const ctx = buildCtx();
    const { phase } = makePhase(ctx);

    phase.markFailed("nope");
    phase.appendDeferredChunks("nope", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 2 }]]]));
    // A streaming (non-deferred) provider accepts no deferred appends either.
    phase.appendDeferredChunks("git", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 2 }]]]));
    expect(phase.getDeferredChunkMap("git").size).toBe(0);

    phase.onBatch(coll, "/repo", items);
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).toHaveBeenCalledTimes(1);
  });

  it("appendDeferredChunks seeds a deferred provider's map and remembers the seeded paths", () => {
    const ctx = buildCtx({ defersChunkEnrichment: true });
    const { phase } = makePhase(ctx);

    phase.appendDeferredChunks("git", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 2 }]]]));

    expect(phase.getDeferredChunkMap("git").has("src/a.ts")).toBe(true);
    expect(phase.getSeededDeferredPaths("git").has("src/a.ts")).toBe(true);
  });

  it("runDeferredChunk clears the map and dispatches nothing when the policy declines every file", async () => {
    const ctx = buildCtx({ defersChunkEnrichment: true, shouldEnrich: () => "none" });
    const { phase, applier } = makePhase(ctx);
    const applySpy = vi.spyOn(applier, "applyChunkSignals").mockResolvedValue(0);
    phase.appendDeferredChunks("git", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 2 }]]]));

    await phase.runDeferredChunk(coll, ctx, "/repo", phase.getDeferredChunkMap("git"));

    expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
    expect(phase.getDeferredChunkMap("git").size).toBe(0);
  });

  it("runDeferredChunk records a failure when the deferred pass throws", async () => {
    const ctx = buildCtx({
      defersChunkEnrichment: true,
      buildChunkSignals: vi.fn().mockRejectedValue(new Error("graph gone")),
    });
    const { phase } = makePhase(ctx);
    phase.appendDeferredChunks("git", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 2 }]]]));

    await phase.runDeferredChunk(coll, ctx, "/repo", phase.getDeferredChunkMap("git"));

    expect(phase.hasChunkEnrichmentFailed("git")).toBe(true);
  });

  it("logs a skip-stamp write failure without failing the batch", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = buildCtx({
      shouldEnrich: (f: { classification: { isDocumentation: boolean } }) =>
        f.classification.isDocumentation ? "file-only" : "full",
    });
    const { phase, applier } = makePhase(ctx);
    vi.spyOn(applier, "applySkipStamps").mockRejectedValue(new Error("qdrant down"));

    phase.onBatch(coll, "/repo", [
      { chunkId: "d1", chunk: { metadata: { filePath: "/repo/docs/guide.md" }, startLine: 1, endLine: 20 } } as any,
    ]);
    await phase.drain();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("skip-stamp write failed"), expect.any(Error));
  });
});
