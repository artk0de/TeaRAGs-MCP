/**
 * find_symbol class outlines list the container's DIRECT ancestors as drillable
 * lines (bd tea-rags-mcp-82cot), read from the codegraph hierarchy by the
 * container's id.
 *
 * Contract under test:
 *   - each direct ancestor renders one line right under the owner line:
 *     `  extends <id>` for a superclass, `  <kind> <id>` for every other kind,
 *     in the order the resolver returns them (MRO order, the facade's job);
 *   - the id is the ancestor's resolved project symbolId — the address
 *     find_symbol answers; an ancestor the index never resolved keeps its
 *     written name and is marked `(unresolved)`, never presented as indexed;
 *   - no ancestor, no resolver (codegraph off) or a throwing resolver renders
 *     today's outline;
 *   - metaOnly and a member-body answer read nothing.
 */
import { describe, expect, it, vi } from "vitest";

import type { InheritanceEdge } from "../../../../../src/core/contracts/types/codegraph.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

const PATH = "src/svc.ts";
const member = (symbolId: string, startLine: number) => ({
  id: `id-${symbolId}`,
  payload: {
    symbolId,
    name: symbolId.split("#")[1],
    chunkType: "function",
    relativePath: PATH,
    content: `${symbolId} body`,
    startLine,
    endLine: startLine + 2,
    parentSymbolId: "Svc",
    parentType: "class_declaration",
  },
});
const CLASS_CHUNK = {
  id: "id-Svc",
  payload: {
    symbolId: "Svc",
    name: "Svc",
    chunkType: "class",
    relativePath: PATH,
    content: "class Svc extends Base {}",
    startLine: 1,
    endLine: 40,
  },
};
const MEMBERS = [member("Svc#run", 5), member("Svc#helper", 10)];

const edge = (ancestorFqName: string, ancestorSymbolId: string | null, kind: InheritanceEdge["kind"]) => ({
  sourceFqName: "Svc",
  ancestorFqName,
  ancestorSymbolId,
  kind,
  depth: 1,
  ordinal: 0,
});

function resolver(edges: InheritanceEdge[] | Error) {
  return {
    resolveContainerAncestors: vi.fn(async (_c: string, ids: readonly string[]) => {
      if (edges instanceof Error) throw edges;
      return edges.filter((e) => ids.includes(e.sourceFqName));
    }),
  };
}

function symbolStrategy(symbol: string, scroll: unknown[], ancestors?: ReturnType<typeof resolver>) {
  const qdrant = {
    scrollFiltered: vi
      .fn()
      .mockImplementation(async (_c: string, filter: { must?: { key: string }[] }) =>
        JSON.stringify(filter).includes("parentSymbolId") ? scroll.filter((c) => c !== CLASS_CHUNK) : scroll,
      ),
    getPoint: vi.fn(),
  };
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) };
  return new SymbolSearchStrategy(
    qdrant as never,
    {} as never,
    [],
    [],
    registry as never,
    { symbol },
    undefined,
    undefined,
    ancestors,
  );
}

const runExplore = async (strat: unknown, metaOnly = false) =>
  (strat as { executeExplore: (c: unknown) => Promise<{ payload: { content?: string } }[]> }).executeExplore({
    collectionName: "col",
    limit: 10,
    metaOnly,
  });

const PLAIN_MEMBERS = ["  Svc#run L5-7", "  Svc#helper L10-12"];
const withSvcHeader = (ancestorLines: string[]): string =>
  [
    "Svc",
    ...ancestorLines,
    "  header 1–40",
    ...PLAIN_MEMBERS,
    "",
    "── header 1–40 ──",
    CLASS_CHUNK.payload.content,
  ].join("\n");

describe("find_symbol class outline — ancestors (bd tea-rags-mcp-82cot)", () => {
  it("a project superclass renders `extends <symbolId>` right under the owner line", async () => {
    const anc = resolver([edge("Base", "Base", "super")]);
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], anc));

    expect(results).toHaveLength(1);
    expect(results[0].payload.content).toBe(withSvcHeader(["  extends Base"]));
    expect(anc.resolveContainerAncestors).toHaveBeenCalledTimes(1);
    expect(anc.resolveContainerAncestors.mock.calls[0][0]).toBe("col");
    expect(anc.resolveContainerAncestors.mock.calls[0][1]).toEqual(["Svc"]);
  });

  it("the line carries the RESOLVED symbolId, not the name as written", async () => {
    const anc = resolver([edge("Base", "Platform::Base", "super")]);
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], anc));

    expect(results[0].payload.content).toBe(withSvcHeader(["  extends Platform::Base"]));
  });

  it("an ancestor the index never resolved keeps its written name, marked (unresolved)", async () => {
    const anc = resolver([edge("ActiveRecord::Base", null, "super")]);
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], anc));

    expect(results[0].payload.content).toBe(withSvcHeader(["  extends ActiveRecord::Base (unresolved)"]));
  });

  it("mixins and interfaces render under their own kind, in the resolver's order", async () => {
    const anc = resolver([
      edge("Audited", "Audited", "prepend"),
      edge("Concern", "Concern", "include"),
      edge("Runnable", "Runnable", "implements"),
      edge("Base", "Base", "super"),
    ]);
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], anc));

    expect(results[0].payload.content).toBe(
      withSvcHeader(["  prepend Audited", "  include Concern", "  implements Runnable", "  extends Base"]),
    );
  });

  it("a synthesised class outline (no class chunk) lists ancestors the same way", async () => {
    const results = await runExplore(symbolStrategy("Svc", MEMBERS, resolver([edge("Base", "Base", "super")])));

    expect(results[0].payload.content).toBe(["Svc", "  extends Base", ...PLAIN_MEMBERS].join("\n"));
  });

  it("no ancestor renders today's outline", async () => {
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], resolver([])));

    expect(results[0].payload.content).toBe(withSvcHeader([]));
  });

  it("no resolver (codegraph off) renders today's outline", async () => {
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS]));

    expect(results[0].payload.content).toBe(withSvcHeader([]));
  });

  it("a throwing resolver (graph unreadable) degrades silently to today's outline", async () => {
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], resolver(new Error("lock"))));

    expect(results[0].payload.content).toBe(withSvcHeader([]));
  });

  it("metaOnly reads nothing", async () => {
    const anc = resolver([edge("Base", "Base", "super")]);
    await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], anc), true);

    expect(anc.resolveContainerAncestors).not.toHaveBeenCalled();
  });

  it("a member body answer reads nothing", async () => {
    const anc = resolver([edge("Base", "Base", "super")]);
    await runExplore(symbolStrategy("Svc#run", [member("Svc#run", 5)], anc));

    expect(anc.resolveContainerAncestors).not.toHaveBeenCalled();
  });
});
