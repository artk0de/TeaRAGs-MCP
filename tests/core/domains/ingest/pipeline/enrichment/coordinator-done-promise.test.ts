import { afterEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { reindexRunSpec } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

/**
 * bd tea-rags-mcp-qiu3o — a superseded run's failed completion must not become an
 * unhandled rejection.
 *
 * The failure is already reported through the run's terminal markers. Only
 * `whenComplete()` ever attached to a run's done-promise, and it only reaches the
 * CURRENT run — so a run replaced by a newer `beginRun` rejected with nobody
 * listening, and the detached CLI worker's crash guard turned that into exit 1.
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

/** Provider whose FIRST finalize waits for `held` and then throws; later ones succeed. */
function failingOnceProvider(held: Promise<void>): EnrichmentProvider {
  let finalizeCalls = 0;
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
      finalizeCalls += 1;
      if (finalizeCalls === 1) {
        await held;
        throw new Error("finalize failed");
      }
      return new Map();
    }),
  } as unknown as EnrichmentProvider;
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Let Node deliver any pending `unhandledRejection` events. */
async function drainRejectionTracking(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe("EnrichmentCoordinator — a superseded run's failed completion", () => {
  const listeners: ((reason: unknown) => void)[] = [];

  afterEach(() => {
    for (const listener of listeners.splice(0)) process.off("unhandledRejection", listener);
  });

  it("produces no unhandled rejection, while whenComplete still settles for the current run", async () => {
    const unhandled = vi.fn();
    listeners.push(unhandled);
    process.on("unhandledRejection", unhandled);

    const held = gate();
    const coordinator = new EnrichmentCoordinator(qdrantDouble() as never, [failingOnceProvider(held.opened)]);

    const supersededRun = coordinator.beginRun(
      reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }),
    );
    const superseded = coordinator.awaitCompletion(supersededRun).catch((error: unknown) => error);
    const currentRun = coordinator.beginRun(
      reindexRunSpec({ absolutePath: "/repo", collection: "coll", fileCount: 0 }),
    );
    const current = coordinator.awaitCompletion(currentRun);

    held.open();
    expect(await superseded).toBeInstanceOf(Error);
    await current;
    await drainRejectionTracking();

    expect(unhandled).not.toHaveBeenCalled();
    await expect(coordinator.whenComplete()).resolves.toBeUndefined();
  });
});
