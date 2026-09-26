/**
 * executeReindexPipelines — the changes leg of an incremental reindex in
 * isolation (bd tea-rags-mcp-7njy). Deletion and file processing are stubbed so
 * the two-level ordering, the provider-notification scope, the partial-outcome
 * counters and the optimizer window are observable directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import {
  executeReindexPipelines,
  type ReindexExecutionParams,
} from "../../../../../src/core/domains/ingest/operations/reindex-parallel-executor.js";
import type { ProcessingContext } from "../../../../../src/core/domains/ingest/pipeline/base.js";
import type { QuarantineStore } from "../../../../../src/core/domains/ingest/sync/index.js";
import type { FileChanges } from "../../../../../src/core/types.js";

const { events, deletion, processRelativeFilesMock } = vi.hoisted(() => {
  const events: string[] = [];
  const deletion: { resolve?: () => void; failed: string[]; hookPaths?: string[] } = { failed: [] };
  const processRelativeFilesMock = vi.fn(async (paths: string[], _base: string, ...rest: unknown[]) => {
    const options = rest[2] as { coordinator?: { canUpsertForFile: (path: string) => boolean } };
    const label = rest[4] as string;
    events.push(`process:${label}:start`);
    // Like the real processor: a gated file whose delete failed is not upserted.
    const upserted = paths.filter((path) => options.coordinator?.canUpsertForFile(path) ?? true);
    return upserted.length * 10;
  });
  return { events, deletion, processRelativeFilesMock };
});

vi.mock("../../../../../src/core/domains/ingest/pipeline/file-processor.js", () => ({
  processRelativeFiles: processRelativeFilesMock,
}));

vi.mock("../../../../../src/core/domains/ingest/sync/deletion/strategy.js", async () => {
  const { createDeletionOutcome: create } =
    await import("../../../../../src/core/domains/ingest/sync/deletion/outcome.js");
  return {
    performDeletion: vi.fn(
      async (
        _q: unknown,
        _c: string,
        files: string[],
        _cfg: unknown,
        _p: unknown,
        hook?: (paths: string[]) => Promise<void>,
      ) => {
        await hook?.(files);
        await new Promise<void>((resolve) => {
          deletion.resolve = resolve;
        });
        events.push("delete:settled");
        const outcome = create(files);
        for (const path of deletion.failed) outcome.markFailed(path);
        return outcome;
      },
    ),
  };
});

function changesOf(partial: Partial<FileChanges>): FileChanges {
  return { added: [], modified: [], deleted: [], newlyIgnored: [], newlyUnignored: [], ...partial };
}

function paramsFor(changes: FileChanges, overrides: Partial<ReindexExecutionParams> = {}): ReindexExecutionParams {
  const chunkPipeline = {
    getStats: () => ({ itemsProcessed: 0, batchesProcessed: 0, throughput: 0 }),
    getPendingCount: () => 0,
  };
  return {
    qdrant: {
      pauseOptimizer: vi.fn(async () => {
        events.push("optimizer:pause");
      }),
      resumeOptimizer: vi.fn(async () => {
        events.push("optimizer:resume");
      }),
    } as never,
    targetCollection: fixturePhysicalCollectionName("code_abc_v2"),
    absolutePath: "/repo",
    changes,
    retryPaths: [],
    quarantineStore: {} as QuarantineStore,
    processingCtx: { chunkerPool: {}, chunkPipeline, enrichmentRun: {} } as unknown as ProcessingContext,
    deleteConfig: { batchSize: 500, concurrency: 8 },
    enableGitMetadata: false,
    fileConcurrency: 4,
    notifyDeletions: vi.fn(async (paths: string[]) => {
      deletion.hookPaths = paths;
    }),
    ...overrides,
  };
}

/** Let the stubbed delete settle once every pending microtask has run. */
async function settleDeletion(): Promise<void> {
  await vi.waitFor(() => {
    expect(deletion.resolve).toBeDefined();
  });
  deletion.resolve?.();
}

describe("executeReindexPipelines", () => {
  beforeEach(() => {
    events.length = 0;
    deletion.resolve = undefined;
    deletion.failed = [];
    deletion.hookPaths = undefined;
    processRelativeFilesMock.mockClear();
  });

  it("starts added files alongside the delete and modified files only after it settles", async () => {
    const run = executeReindexPipelines(paramsFor(changesOf({ added: ["a.ts"], modified: ["m.ts"] })));
    await settleDeletion();
    const result = await run;

    expect(events).toEqual([
      "optimizer:pause",
      "process:added:start",
      "delete:settled",
      "process:modified:start",
      "optimizer:resume",
    ]);
    expect(result.chunksAdded).toBe(20);
  });

  it("notifies providers of removed paths only, never of modified ones", async () => {
    const run = executeReindexPipelines(
      paramsFor(changesOf({ modified: ["m.ts"], deleted: ["d.ts"], newlyIgnored: ["i.ts"] })),
    );
    await settleDeletion();
    await run;

    expect(deletion.hookPaths).toEqual(["d.ts", "i.ts"]);
  });

  it("queues retried quarantine paths with the added files", async () => {
    const run = executeReindexPipelines(paramsFor(changesOf({ added: ["a.ts"] }), { retryPaths: ["q.ts"] }));
    await settleDeletion();
    await run;

    const addedCall = processRelativeFilesMock.mock.calls.find((call) => call[6] === "added");
    expect(addedCall?.[0]).toEqual(["a.ts", "q.ts"]);
  });

  it("counts blocked modified files and failed removals as a partial outcome", async () => {
    deletion.failed = ["m1.ts", "m2.ts", "d.ts"];
    const run = executeReindexPipelines(paramsFor(changesOf({ modified: ["m1.ts", "m2.ts"], deleted: ["d.ts"] })));
    await settleDeletion();
    const result = await run;

    expect(result.filesSkippedDueToDeleteFailure).toBe(2);
    expect(result.filesFailedToDelete).toBe(1);
    expect([...(result.deletionOutcome?.failed ?? [])].sort()).toEqual(["d.ts", "m1.ts", "m2.ts"]);
  });

  it("reports no partial counters when every delete succeeded", async () => {
    const run = executeReindexPipelines(paramsFor(changesOf({ modified: ["m.ts"], deleted: ["d.ts"] })));
    await settleDeletion();
    const result = await run;

    expect(result.filesSkippedDueToDeleteFailure).toBeUndefined();
    expect(result.filesFailedToDelete).toBeUndefined();
  });

  it("resumes the optimizer even when file processing fails", async () => {
    processRelativeFilesMock.mockImplementationOnce(async () => {
      throw new Error("chunker died");
    });
    const run = executeReindexPipelines(paramsFor(changesOf({ added: ["a.ts"] })));
    await settleDeletion();

    await expect(run).rejects.toThrow("chunker died");
    expect(events.at(-1)).toBe("optimizer:resume");
  });
});
