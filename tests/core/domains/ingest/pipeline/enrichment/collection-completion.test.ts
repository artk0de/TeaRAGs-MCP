/**
 * `EnrichmentCoordinator.runCollectionCompletion` (bd tea-rags-mcp-l1ot.2).
 *
 * A reindex that takes an early return — nothing to chunk, or only deletions —
 * opens no enrichment run, so no provider finalize reaches the whole-collection
 * work a finalize ends with (codegraph's co-change rebuild). This seam is how
 * such a run still owes it: every provider that declares `completeCollection`
 * is asked once, with its own effective root and the physical collection.
 *
 * Invariants under test:
 *   - each declaring provider is called with `resolveRoot(absolutePath)` and the
 *     collection; a provider without the method is skipped;
 *   - a provider that throws is logged and never fails the call, and the next
 *     provider still runs.
 */

import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";

const qdrant = {} as never;

function makeProvider(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: vi.fn((p: string) => `${p}/effective`),
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as never;
}

function makeExecutor() {
  return {
    runFileBatch: vi.fn().mockResolvedValue(new Map()),
    runFileSignalsStreaming: vi.fn().mockResolvedValue(new Map()),
    runChunkSignals: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseRun: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe("EnrichmentCoordinator.runCollectionCompletion (bd tea-rags-mcp-l1ot.2)", () => {
  it("asks every declaring provider once, with its effective root and the collection", async () => {
    const completeCollection = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      [makeProvider("git"), makeProvider("codegraph.symbols", { completeCollection })],
      undefined,
      makeExecutor(),
    );

    await coordinator.runCollectionCompletion("/repo", "code_x_v3" as never);

    expect(completeCollection).toHaveBeenCalledTimes(1);
    expect(completeCollection).toHaveBeenCalledWith("/repo/effective", { collectionName: "code_x_v3" });
  });

  it("logs a failing provider and still runs the next one", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const after = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      [
        makeProvider("codegraph.symbols", { completeCollection: vi.fn().mockRejectedValue(new Error("daemon gone")) }),
        makeProvider("other", { completeCollection: after }),
      ],
      undefined,
      makeExecutor(),
    );

    try {
      await expect(coordinator.runCollectionCompletion("/repo", "code_x_v3" as never)).resolves.toBeUndefined();
      expect(after).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain("daemon gone");
    } finally {
      stderr.mockRestore();
    }
  });
});
