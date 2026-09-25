/**
 * Collection-completion hooks (bd tea-rags-mcp-x4rpp) — how a codegraph
 * sub-graph other than symbols (the temporal co-change graph) rebuilds its
 * tables once per run, at the point the collection's graph is whole.
 *
 * Invariants under test:
 *   - a single-worker finalize runs every hook once, with the project root and
 *     the collection's graph DB;
 *   - under language affinity only the completion owner's `readBack` runs them —
 *     never a partition's `resolve`, never a non-owner's `readBack`;
 *   - a hook that throws is logged and does not fail the finalize.
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

describe("CodegraphEnrichmentProvider collection-completion hooks (bd tea-rags-mcp-x4rpp)", () => {
  it("runs every hook once at a single-worker finalize", async () => {
    const graphDb = stubGraphDb();
    const first = recordingHook("first");
    const second = recordingHook("second");

    await makeProvider(graphDb, [first, second]).finalizeSignals("/repo/project", { paths: [] });

    expect(first.calls).toEqual([{ projectRoot: "/repo/project", graphDb }]);
    expect(second.calls).toHaveLength(1);
  });

  it("runs hooks only at the completion owner's readBack under language affinity", async () => {
    const hook = recordingHook();
    const provider = makeProvider(stubGraphDb(), [hook]);

    await provider.finalizeSignals("/repo", { paths: [], finalizeStage: "resolve" });
    await provider.finalizeSignals("/repo", { paths: [], finalizeStage: "readBack" });
    expect(hook.calls).toHaveLength(0);

    await provider.finalizeSignals("/repo", { paths: [], finalizeStage: "readBack", ownsCollectionCompletion: true });
    expect(hook.calls).toHaveLength(1);
  });

  it("logs a failing hook and still finishes the finalize", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failing: CodegraphCollectionCompletionHook = {
      name: "failing",
      onCollectionComplete: async () => {
        throw new Error("git unavailable");
      },
    };
    const after = recordingHook();

    await expect(
      makeProvider(stubGraphDb(), [failing, after]).finalizeSignals("/repo", { paths: [] }),
    ).resolves.toBeInstanceOf(Map);

    expect(after.calls).toHaveLength(1);
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain("failing");
    stderr.mockRestore();
  });
});
