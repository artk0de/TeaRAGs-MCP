import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

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

describe("EnrichmentCoordinator.recomputeEnrichments", () => {
  let recovery: { recoverAll: ReturnType<typeof vi.fn> };
  let qdrant: Record<string, unknown>;
  let coordinator: EnrichmentCoordinator;

  beforeEach(() => {
    recovery = { recoverAll: vi.fn().mockResolvedValue(undefined) };
    qdrant = {};
    coordinator = new EnrichmentCoordinator(
      qdrant as never,
      [provider("git"), provider("codegraph.symbols"), provider("codegraph.complexity")],
      recovery as never,
    );
  });

  /** Provider keys the coordinator handed to recovery on the Nth call. */
  function dispatchedKeys(call = 0): string[] {
    const contexts = recovery.recoverAll.mock.calls[call][2] as ReadonlyMap<string, unknown>;
    return [...contexts.keys()];
  }

  function dispatchedScope(call = 0): string {
    return recovery.recoverAll.mock.calls[call][4] as string;
  }

  it("recomputes over the full point set, not just the unenriched one", async () => {
    await coordinator.recomputeEnrichments("coll", "/repo", ["all"]);

    expect(dispatchedScope()).toBe("all");
  });

  it("dispatches only the selected provider", async () => {
    await coordinator.recomputeEnrichments("coll", "/repo", ["git"]);

    expect(dispatchedKeys()).toEqual(["git"]);
  });

  it("expands a namespace selector to every provider under it", async () => {
    await coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);

    expect(dispatchedKeys()).toEqual(["codegraph.symbols", "codegraph.complexity"]);
  });

  it("dispatches every provider for the `all` selector", async () => {
    await coordinator.recomputeEnrichments("coll", "/repo", ["all"]);

    expect(dispatchedKeys()).toEqual(["git", "codegraph.symbols", "codegraph.complexity"]);
  });

  it("does nothing when no provider matches the selector", async () => {
    await coordinator.recomputeEnrichments("coll", "/repo", ["nonsense"]);

    expect(recovery.recoverAll).not.toHaveBeenCalled();
  });

  it("is a no-op when the coordinator was built without recovery", async () => {
    const bare = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    await expect(bare.recomputeEnrichments("coll", "/repo", ["all"])).resolves.toBeUndefined();
  });
});
