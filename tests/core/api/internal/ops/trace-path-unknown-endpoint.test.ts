import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";

function makeOps(
  symbolPaths: Record<string, string[]>,
  shortNames: Record<string, string[]> = {},
  testChunks: Record<string, boolean> = {},
) {
  const graphDb = {
    getCalleeEdgesScoped: vi.fn(async () => new Map()),
    getSymbolRelPaths: vi.fn(
      async (ids: string[]) => new Map(ids.filter((id) => symbolPaths[id]).map((id) => [id, symbolPaths[id]])),
    ),
    getSymbolVisibilities: vi.fn(async () => []),
    lookupSymbolIdsByShortName: vi.fn(async (name: string) => shortNames[name] ?? []),
    close: vi.fn(async () => undefined),
  };
  return new TracePathOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    qdrant: {
      scrollBySymbolIds: vi.fn(async (_c: string, ids: string[]) =>
        ids
          .filter((id) => testChunks[id])
          .map((id) => ({ id, payload: { symbolId: id, relativePath: "spec/x_spec.rb", isTest: true } })),
      ),
    },
    reranker: { rerank: vi.fn() } as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: (async (n: string) => n) as never,
  });
}

describe("TracePathOps — unknown endpoint is reported, never a bare empty answer", () => {
  it("an unknown `from` answers empty.unknownSymbol with suggestions", async () => {
    const ops = makeOps({ B: ["b.ts"] }, { Missing: ["Other#Missing"] });

    const res = await ops.tracePath({ collection: "c", from: "Missing", to: "B" });

    expect(res.paths).toEqual([]);
    expect(res.empty?.reason).toBe("unknownSymbol");
    expect(res.empty?.message).toContain("Missing");
    expect(res.empty?.suggestions).toEqual(["Other#Missing"]);
  });

  it("an unknown `to` is reported the same way", async () => {
    const ops = makeOps({ A: ["a.ts"] });

    const res = await ops.tracePath({ collection: "c", from: "A", to: "Nope" });

    expect(res.empty?.reason).toBe("unknownSymbol");
    expect(res.empty?.message).toContain("Nope");
  });

  it("both endpoints known, no path: no `empty` (an empty `paths` means exactly that)", async () => {
    const ops = makeOps({ A: ["a.ts"], B: ["b.ts"] });

    const res = await ops.tracePath({ collection: "c", from: "A", to: "B" });

    expect(res.paths).toEqual([]);
    expect(res.empty).toBeUndefined();
  });

  it("a known endpoint narrowed away by fromPath is reported, not silently empty", async () => {
    const ops = makeOps({ A: ["a.ts"], B: ["b.ts"] });

    const res = await ops.tracePath({ collection: "c", from: "A", fromPath: "zzz.ts", to: "B" });

    expect(res.paths).toEqual([]);
    expect(res.empty?.reason).toBe("noMatch");
    expect(res.empty?.message).toContain("a.ts");
  });
});

describe("TracePathOps — endpoint id with the other member separator, and test-chunk endpoints", () => {
  it("traces from `Registry#client_for` via `Registry.client_for` when only the latter has a node, naming it", async () => {
    const ops = makeOps({ "Registry.client_for": ["lib/registry.rb"], B: ["b.ts"] });

    const res = await ops.tracePath({ collection: "c", from: "Registry#client_for", to: "B" });

    expect(res.resolvedEndpoints).toEqual({ from: "Registry.client_for" });
    expect(res.empty).toBeUndefined();
  });

  it("reports an indexed test chunk endpoint as testChunk", async () => {
    const ops = makeOps({ B: ["b.ts"] }, {}, { describe_widget: true });

    const res = await ops.tracePath({ collection: "c", from: "describe_widget", to: "B" });

    expect(res.empty?.reason).toBe("testChunk");
  });
});
