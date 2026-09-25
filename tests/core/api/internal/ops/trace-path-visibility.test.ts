/**
 * Declared visibility on trace_path steps (bd tea-rags-mcp-sqqkz): each step
 * carries `visibility` exactly when `cg_symbols` states one for its
 * (relPath, symbolId); NULL, unknown, or a failed lookup omit the field.
 */
import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import { fileScopedSymbolKey, type SymbolVisibilityRow } from "../../../../../src/core/contracts/types/codegraph.js";

const ADJACENCY: Record<string, string[]> = { "A#run": ["A#helper"], "A#helper": ["A#hook"], "A#hook": ["B#legacy"] };
const ROWS: SymbolVisibilityRow[] = [
  { relPath: "a.ts", symbolId: "A#run", visibility: "public" },
  { relPath: "a.ts", symbolId: "A#helper", visibility: "private" },
  { relPath: "a.ts", symbolId: "A#hook", visibility: "protected" },
  { relPath: "b.ts", symbolId: "B#legacy", visibility: null },
  // A namesake in another file must not answer for the step on the path.
  { relPath: "z.ts", symbolId: "A#run", visibility: "private" },
];
const fileOf = (symbolId: string) => (symbolId.startsWith("A") ? "a.ts" : "b.ts");

function makeOps(getSymbolVisibilities: (ids: readonly string[]) => Promise<SymbolVisibilityRow[]>) {
  const graphDb = {
    getSymbolRelPaths: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, [fileOf(id)]]))),
    getCalleeEdgesScoped: vi.fn(async (refs: { relPath: string; symbolId: string }[]) => {
      const out = new Map<string, { relPath: string; symbolId: string }[]>();
      for (const ref of refs) {
        const targets = ADJACENCY[ref.symbolId];
        if (targets) {
          out.set(
            fileScopedSymbolKey(ref),
            targets.map((s) => ({ relPath: fileOf(s), symbolId: s })),
          );
        }
      }
      return out;
    }),
    getSymbolVisibilities: vi.fn(getSymbolVisibilities),
    close: vi.fn(async () => undefined),
  };
  const qdrant = { scrollBySymbolIds: vi.fn(async () => []) };
  const ops = new TracePathOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    qdrant: qdrant as never,
    reranker: {} as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n,
  });
  return { ops, graphDb };
}

describe("TracePathOps — declared visibility (bd tea-rags-mcp-sqqkz)", () => {
  it("each step carries its declared visibility, a NULL step omits it", async () => {
    const { ops, graphDb } = makeOps(async (ids) => ROWS.filter((r) => ids.includes(r.symbolId)));

    const res = await ops.tracePath({ collection: "c", from: "A#run", to: "B#legacy" });

    expect(res.paths[0].steps).toEqual([
      { symbolId: "A#run", relativePath: "a.ts", startLine: 0, endLine: 0, visibility: "public" },
      { symbolId: "A#helper", relativePath: "a.ts", startLine: 0, endLine: 0, visibility: "private" },
      { symbolId: "A#hook", relativePath: "a.ts", startLine: 0, endLine: 0, visibility: "protected" },
      { symbolId: "B#legacy", relativePath: "b.ts", startLine: 0, endLine: 0 },
    ]);
    expect(graphDb.getSymbolVisibilities).toHaveBeenCalledTimes(1);
    // The read happened while the handle was still open.
    expect(graphDb.close).toHaveBeenCalledTimes(1);
    expect(graphDb.getSymbolVisibilities.mock.invocationCallOrder[0]).toBeLessThan(
      graphDb.close.mock.invocationCallOrder[0],
    );
  });

  it("a failing lookup leaves every step undecorated", async () => {
    const { ops } = makeOps(async () => {
      throw new Error("boom");
    });

    const res = await ops.tracePath({ collection: "c", from: "A#run", to: "A#hook" });

    expect(res.paths[0].steps.every((s) => !("visibility" in s))).toBe(true);
  });
});
