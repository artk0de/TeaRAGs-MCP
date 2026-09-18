import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { reindexRunSpec } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

const specFor = (absolutePath: string, collection: string) =>
  reindexRunSpec({ absolutePath, collection, fileCount: 0 });

/**
 * bd tea-rags-mcp-62pgi — `whenCompletionsSettled(collection)` is how an index
 * operation learns that the background enrichment it detached has finished, so
 * it can stop holding its collection. It must be exact about WHICH collection,
 * and must never wait on a run whose completion never started — that promise
 * never settles, and waiting on it would lock the collection for the life of the
 * process.
 */

function qdrantDouble(): Record<string, unknown> {
  return {
    scrollFiltered: vi.fn().mockResolvedValue([]),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
  };
}

/** Provider whose finalize waits for `held`, keeping a completion in flight. */
function heldProvider(held: Promise<void>): EnrichmentProvider {
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals: vi.fn(async () => {
      await held;
      return new Map();
    }),
  };
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      resolve(marker);
    }, 20);
  });
  const winner = await Promise.race([promise, timeout]);
  return winner === marker;
}

describe("EnrichmentCoordinator.whenCompletionsSettled", () => {
  it("stays pending while a completion on the collection is in flight, and settles with it", async () => {
    const held = gate();
    const coordinator = new EnrichmentCoordinator(qdrantDouble() as never, [heldProvider(held.opened)]);

    const run = coordinator.beginRun(specFor("/repo", "coll_v2"));
    const completion = coordinator.awaitCompletion(run);
    const settled = coordinator.whenCompletionsSettled("coll_v2");

    expect(await isPending(settled)).toBe(true);
    held.open();
    await completion;
    expect(await isPending(settled)).toBe(false);
  });

  it("resolves at once for a run whose completion never started", async () => {
    const coordinator = new EnrichmentCoordinator(qdrantDouble() as never, [heldProvider(new Promise(() => {}))]);

    coordinator.beginRun(specFor("/repo", "coll_v2"));

    expect(await isPending(coordinator.whenCompletionsSettled("coll_v2"))).toBe(false);
  });

  it("does not wait on another collection's completion", async () => {
    const held = gate();
    const coordinator = new EnrichmentCoordinator(qdrantDouble() as never, [heldProvider(held.opened)]);

    const run = coordinator.beginRun(specFor("/other", "other_v1"));
    const completion = coordinator.awaitCompletion(run);

    expect(await isPending(coordinator.whenCompletionsSettled("coll_v2"))).toBe(false);
    held.open();
    await completion;
  });
});
