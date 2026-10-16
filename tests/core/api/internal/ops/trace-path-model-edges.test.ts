/**
 * Model provenance on trace_path (bd tea-rags-mcp-2m83f.40): model edges are
 * walked like any other edge and MARKED — the step a model hop reaches carries
 * `origin: "model"`, `model`, `p`; a path with any model hop carries `minP`,
 * the weakest model verdict on it. An all-static path carries neither.
 */
import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import { fileScopedSymbolKey, type ScopedCalleeTarget } from "../../../../../src/core/contracts/types/codegraph.js";

const KEV = { origin: "model" as const, model: "kev" };
const ADJACENCY: Record<string, Omit<ScopedCalleeTarget, "relPath">[]> = {
  "A#run": [{ symbolId: "A#x" }, { symbolId: "A#y", ...KEV, p: 0.7 }],
  "A#x": [{ symbolId: "B#end" }],
  "A#y": [{ symbolId: "B#end", ...KEV, p: 0.9 }],
};
const fileOf = (symbolId: string) => (symbolId.startsWith("A") ? "a.rb" : "b.rb");

function makeOps() {
  const graphDb = {
    getSymbolRelPaths: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, [fileOf(id)]]))),
    getCalleeEdgesScoped: vi.fn(async (refs: { relPath: string; symbolId: string }[]) => {
      const out = new Map<string, ScopedCalleeTarget[]>();
      for (const ref of refs) {
        const targets = ADJACENCY[ref.symbolId];
        if (targets) {
          out.set(
            fileScopedSymbolKey(ref),
            targets.map((t) => ({ ...t, relPath: fileOf(t.symbolId) })),
          );
        }
      }
      return out;
    }),
    close: vi.fn(async () => undefined),
  };
  return new TracePathOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    qdrant: { scrollBySymbolIds: vi.fn(async () => []) },
    reranker: {} as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: (async (n: string) => n) as never,
  });
}

describe("TracePathOps — model edge provenance (2m83f.40)", () => {
  it("marks each model hop on the step it reaches and the path's weakest verdict", async () => {
    const res = await makeOps().tracePath({ collection: "c", from: "A#run", to: "B#end" });

    const viaModel = res.paths.find((p) => p.steps[1].symbolId === "A#y");
    expect(viaModel?.steps).toEqual([
      { symbolId: "A#run", relativePath: "a.rb", startLine: 0, endLine: 0 },
      { symbolId: "A#y", relativePath: "a.rb", startLine: 0, endLine: 0, origin: "model", model: "kev", p: 0.7 },
      { symbolId: "B#end", relativePath: "b.rb", startLine: 0, endLine: 0, origin: "model", model: "kev", p: 0.9 },
    ]);
    expect(viaModel?.minP).toBe(0.7);
  });

  it("an all-static path carries no provenance and no minP", async () => {
    const res = await makeOps().tracePath({ collection: "c", from: "A#run", to: "B#end" });

    const viaStatic = res.paths.find((p) => p.steps[1].symbolId === "A#x");
    expect(viaStatic?.steps.some((s) => "origin" in s || "p" in s)).toBe(false);
    expect(viaStatic).not.toHaveProperty("minP");
  });
});
