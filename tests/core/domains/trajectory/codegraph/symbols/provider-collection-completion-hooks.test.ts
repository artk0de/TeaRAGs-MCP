/**
 * Collection-completion hooks (bd tea-rags-mcp-x4rpp) — how a codegraph
 * sub-graph other than symbols (the temporal co-change graph) rebuilds its
 * tables once per run, at the point the collection's graph is whole.
 *
 * Invariants under test:
 *   - NO finalize stage runs them (bd tea-rags-mcp-vtuu4): `finalizeSignals`
 *     executes inside the enrichment worker, beside the whole-project
 *     `ts.Program`, and the co-change build on top of it pushed a 17k-file
 *     repository's worker past its heap ceiling. Neither a single-worker
 *     finalize nor any stage of a partitioned one (`resolve`, a non-owner's or
 *     the completion owner's `readBack`) may call a hook;
 *   - `completeCollection` — the main-thread seam — runs every hook once;
 *   - a hook that throws is logged and does not fail the call.
 */

import { describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import type { CodegraphCollectionCompletionHook } from "../../../../../../src/core/domains/trajectory/codegraph/collection-completion-hook.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function stubGraphDb(): Record<string, unknown> {
  return {
    getFanInP95: async () => 0,
    getFileMetricsBulk: async () => new Map(),
    recordRunStats: async () => undefined,
    hasStaleDerivedTables: async () => false,
    computeAndPersistCyclesAndSignals: async () => undefined,
  };
}

function recordingHook(name = "recording"): CodegraphCollectionCompletionHook & {
  calls: { projectRoot: string; graphDb: unknown }[];
} {
  const calls: { projectRoot: string; graphDb: unknown }[] = [];
  return {
    name,
    calls,
    onCollectionComplete: async (context) => {
      calls.push(context);
    },
  };
}

function makeProvider(graphDb: Record<string, unknown>, hooks: CodegraphCollectionCompletionHook[]) {
  return new CodegraphEnrichmentProvider({
    graphDb: graphDb as never,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
    collectionCompletionHooks: hooks,
  });
}

describe("CodegraphEnrichmentProvider finalize never runs collection-completion hooks (bd tea-rags-mcp-vtuu4)", () => {
  it("a single-worker finalize runs no hook", async () => {
    const first = recordingHook("first");
    const second = recordingHook("second");

    await makeProvider(stubGraphDb(), [first, second]).finalizeSignals("/repo/project", { paths: [] });

    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
  });

  it("no stage of a partitioned finalize runs a hook — the completion owner's readBack included", async () => {
    const hook = recordingHook();
    const provider = makeProvider(stubGraphDb(), [hook]);

    await provider.finalizeSignals("/repo", { paths: [], finalizeStage: "resolve" });
    await provider.finalizeSignals("/repo", { paths: [], finalizeStage: "readBack" });
    await provider.finalizeSignals("/repo", { paths: [], finalizeStage: "readBack", ownsCollectionCompletion: true });

    expect(hook.calls).toHaveLength(0);
  });
});

/**
 * `completeCollection` (bd tea-rags-mcp-l1ot.2) — the same hooks, reached by a
 * reindex that finalized nothing (a deletion-only run, a run with no file
 * change). The delete-only fast path never opens an enrichment run, so without
 * this seam the co-change graph kept a deleted file's pairs.
 */
describe("CodegraphEnrichmentProvider.completeCollection (bd tea-rags-mcp-l1ot.2)", () => {
  it("runs every hook once with the project root and the collection's graph DB", async () => {
    const graphDb = stubGraphDb();
    const first = recordingHook("first");
    const second = recordingHook("second");

    await makeProvider(graphDb, [first, second]).completeCollection("/repo/project", {
      collectionName: "code_x_v1" as never,
    });

    expect(first.calls).toEqual([{ projectRoot: "/repo/project", graphDb }]);
    expect(second.calls).toHaveLength(1);
  });

  it("opens no graph store when the family registers no hook (git history off)", async () => {
    const acquireWrite = vi.fn();
    const provider = new CodegraphEnrichmentProvider({
      pool: { acquireWrite } as never,
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
      collectionCompletionHooks: [],
    });

    await provider.completeCollection("/repo", { collectionName: "code_x_v1" as never });

    expect(acquireWrite).not.toHaveBeenCalled();
  });

  it("logs a failing hook and resolves", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failing: CodegraphCollectionCompletionHook = {
      name: "failing",
      onCollectionComplete: async () => {
        throw new Error("git unavailable");
      },
    };
    const after = recordingHook();

    try {
      await expect(
        makeProvider(stubGraphDb(), [failing, after]).completeCollection("/repo", {
          collectionName: "code_x_v1" as never,
        }),
      ).resolves.toBeUndefined();
      expect(after.calls).toHaveLength(1);
      expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain("git unavailable");
    } finally {
      stderr.mockRestore();
    }
  });
});
