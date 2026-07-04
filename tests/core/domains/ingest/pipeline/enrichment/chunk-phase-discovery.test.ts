/**
 * bd tea-rags-mcp-82va1 — ChunkPhase lifecycle of the run-scoped commit
 * discovery.
 *
 * ONE matrix per run shared by streaming batches + the post-flush mega-walk:
 * lazily created at first chunk dispatch via the provider's
 * createCommitDiscovery hook (the provider owns the window config), dropped at
 * drain(). Providers without the hook never see options.commitDiscovery.
 */

import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";

function buildCtx(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    provider: { key, buildChunkSignals: vi.fn().mockResolvedValue(new Map()), ...overrides } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null as any,
  };
}

function fakeDiscoveryInstance() {
  return {
    commitsForFiles: vi.fn().mockResolvedValue([]),
    getBugFixShas: vi.fn().mockResolvedValue(new Set<string>()),
  };
}

const itemsFor = (file: string, chunkId: string) =>
  [
    {
      chunkId,
      chunk: { metadata: { filePath: `/repo/${file}` }, startLine: 1, endLine: 10 },
    },
  ] as any[];

describe("ChunkPhase run-scoped commit discovery (bd tea-rags-mcp-82va1)", () => {
  it("creates the discovery ONCE and threads the same instance into every chunk-signal call", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const instance = fakeDiscoveryInstance();
    const createCommitDiscovery = vi.fn().mockReturnValue(instance);
    const ctx = buildCtx("git", { createCommitDiscovery });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-07-04T10:00:00Z");

    // Two streaming batches (different files) + post-flush catch-up (third file).
    phase.onBatch("coll", "/repo", itemsFor("src/a.ts", "c1"));
    phase.onBatch("coll", "/repo", itemsFor("src/b.ts", "c2"));
    phase.enrichRemaining("coll", "/repo", new Map([["src/c.ts", [{ chunkId: "c3", startLine: 1, endLine: 10 }]]]));
    await phase.drain();

    expect(createCommitDiscovery).toHaveBeenCalledTimes(1);
    expect(createCommitDiscovery).toHaveBeenCalledWith("/repo");
    const { calls } = ctx.provider.buildChunkSignals.mock;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[2].commitDiscovery).toBe(instance);
    }
  });

  it("drops the discovery at drain() — a later batch lazily creates a fresh one", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const createCommitDiscovery = vi
      .fn()
      .mockReturnValueOnce(fakeDiscoveryInstance())
      .mockReturnValueOnce(fakeDiscoveryInstance());
    const ctx = buildCtx("git", { createCommitDiscovery });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", itemsFor("src/a.ts", "c1"));
    await phase.drain();
    expect(createCommitDiscovery).toHaveBeenCalledTimes(1);

    phase.onBatch("coll", "/repo", itemsFor("src/b.ts", "c2"));
    await phase.drain();
    expect(createCommitDiscovery).toHaveBeenCalledTimes(2);
  });

  it("leaves options.commitDiscovery undefined for providers without the hook", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx("git");
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", itemsFor("src/a.ts", "c1"));
    await phase.drain();

    expect(ctx.provider.buildChunkSignals).toHaveBeenCalledTimes(1);
    expect(ctx.provider.buildChunkSignals.mock.calls[0][2].commitDiscovery).toBeUndefined();
  });

  it("with mixed providers only the hook provider's options carry the instance", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const instance = fakeDiscoveryInstance();
    const withHook = buildCtx("git", { createCommitDiscovery: vi.fn().mockReturnValue(instance) });
    const withoutHook = buildCtx("other");
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(
      new Map([
        [withHook.key, withHook],
        [withoutHook.key, withoutHook],
      ]),
      "coll",
      "ts",
    );

    phase.onBatch("coll", "/repo", itemsFor("src/a.ts", "c1"));
    await phase.drain();

    expect(withHook.provider.buildChunkSignals.mock.calls[0][2].commitDiscovery).toBe(instance);
    expect(withoutHook.provider.buildChunkSignals.mock.calls[0][2].commitDiscovery).toBeUndefined();
  });
});
