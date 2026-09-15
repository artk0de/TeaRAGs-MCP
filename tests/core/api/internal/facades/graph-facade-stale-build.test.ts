/**
 * The graph tools keep refusing when the codegraph store exists but cannot be
 * read (bd tea-rags-mcp-a43tr, S2). find_symbol degrades its OPTIONAL codegraph
 * hop at the strategy; GraphFacade#withReadHandle does not — an empty edge list
 * from get_callers / get_callees / find_cycles is an assertion about the code,
 * so a stale daemon build must surface as the typed error, never as [].
 */

import { describe, expect, it, vi } from "vitest";

import { CodegraphDaemonStaleBuildError } from "../../../../../src/core/adapters/duckdb/errors.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { SymbolId } from "../../../../../src/core/contracts/types/codegraph.js";

describe("GraphFacade — stale daemon build with an existing graph database (a43tr S2)", () => {
  const stale = new CodegraphDaemonStaleBuildError("/tmp/cg/daemon.sock", "CLIENT-OLD", "DAEMON-NEW", [
    "DAEMON-NEW",
    "DAEMON-NEW",
    "DAEMON-NEW",
  ]);

  function makeFacade(): GraphFacade {
    const pool = {
      acquireReader: vi.fn().mockRejectedValue(stale),
      hasDatabase: vi.fn().mockReturnValue(true),
    };
    return new GraphFacade({
      pool: pool as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (c: string) => c,
    });
  }

  it("get_callers, get_callees and find_cycles throw the typed stale-build error", async () => {
    const facade = makeFacade();

    await expect(facade.getCallers({ collection: "code_x", symbolId: "A#b" })).rejects.toBe(stale);
    await expect(facade.getCallees({ collection: "code_x", symbolId: "A#b" })).rejects.toBe(stale);
    await expect(facade.findCycles({ collection: "code_x", scope: "file" })).rejects.toBe(stale);
  });

  it("resolveSymbolChunk keeps the shared rethrow — degradation belongs to the optional caller", async () => {
    const facade = makeFacade();

    await expect(facade.resolveSymbolChunk({ collection: "code_x" }, "A#b" as SymbolId)).rejects.toBe(stale);
  });
});
