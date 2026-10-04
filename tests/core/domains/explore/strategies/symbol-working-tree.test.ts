/**
 * SymbolSearchStrategy on a working tree (bd tea-rags-mcp-xi2r9.3): find_symbol
 * has the chunk floor. Base rows of a changed or deleted file are dropped, and
 * the tree's rows that pass the same predicate the two Qdrant scrolls apply
 * take their place — before the pathPattern and exact-symbol filters, so a
 * tree row is answered exactly as an indexed one would be.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

describe("SymbolSearchStrategy working-tree chunk floor", () => {
  const mockScrollFiltered = vi.fn();
  const qdrant = { scrollFiltered: mockScrollFiltered } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as any;

  /** The index: answers each scroll with the rows whose key carries the queried token. */
  const indexHolds = (rows: ScrollChunk[]) => {
    mockScrollFiltered.mockImplementation(async (_c: string, filter: { must: any[] }) => {
      const [{ key, match }] = filter.must;
      return rows.filter((r) => {
        const v = r.payload[key];
        return typeof v === "string" && v.includes(match.text);
      });
    });
  };

  const find = async (symbol: string, view?: WorkingTreeView, extra: Record<string, unknown> = {}) =>
    new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol, ...extra }).execute({
      collectionName: "c",
      limit: 50,
      ...(view ? { workingTreeView: view } : {}),
    });

  const FOO = "src/foo.ts";
  const baseOld = codeRow("old", {
    symbolId: "Foo#oldName",
    parentSymbolId: "Foo",
    relativePath: FOO,
    content: "index body",
  });
  const treeNew = codeRow("new", {
    symbolId: "Foo#newName",
    parentSymbolId: "Foo",
    relativePath: FOO,
    content: "tree body",
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not find a method renamed in the tree under its old name", async () => {
    indexHolds([baseOld]);

    const results = await find("oldName", fakeWorkingTreeView({ changed: [FOO], rows: [treeNew] }));

    expect(results).toEqual([]);
  });

  it("finds a method renamed in the tree under its new name, with the tree's body", async () => {
    indexHolds([baseOld]);

    const results = await find("Foo#newName", fakeWorkingTreeView({ changed: [FOO], rows: [treeNew] }));

    expect(results).toHaveLength(1);
    expect(results[0].payload?.symbolId).toBe("Foo#newName");
    expect(results[0].payload?.content).toBe("tree body");
  });

  it("finds a method added in an untracked file", async () => {
    indexHolds([]);
    const added = codeRow("added", { symbolId: "helper", relativePath: "src/new.ts", content: "fresh" });

    const results = await find("helper", fakeWorkingTreeView({ changed: ["src/new.ts"], rows: [added] }));

    expect(results).toHaveLength(1);
    expect(results[0].payload?.content).toBe("fresh");
  });

  it("does not find the symbols of a file deleted in the tree", async () => {
    indexHolds([codeRow("gone", { symbolId: "gone", relativePath: "src/gone.ts" })]);

    const results = await find("gone", fakeWorkingTreeView({ deleted: ["src/gone.ts"], rows: [] }));

    expect(results).toEqual([]);
  });

  it("reassembles #partN delta rows through resolveSymbols like base rows", async () => {
    indexHolds([]);
    const parts = [
      codeRow("small", {
        symbolId: "Foo#small",
        name: "small",
        parentSymbolId: "Foo",
        parentType: "class_declaration",
        relativePath: FOO,
        startLine: 2,
        endLine: 4,
      }),
      codeRow("big-1", {
        symbolId: "Foo#big#part1",
        name: "big (part 1/2)",
        parentSymbolId: "Foo#big",
        parentType: "method_definition",
        relativePath: FOO,
        startLine: 6,
        endLine: 40,
      }),
      codeRow("big-2", {
        symbolId: "Foo#big#part2",
        name: "big (part 2/2)",
        parentSymbolId: "Foo#big",
        parentType: "method_definition",
        relativePath: FOO,
        startLine: 41,
        endLine: 70,
      }),
    ];

    const results = await find("Foo", fakeWorkingTreeView({ changed: [FOO], rows: parts }));

    expect(results).toHaveLength(1);
    const outline = String(results[0].payload?.content);
    expect(outline).toContain("Foo#big");
    expect(outline).toContain("Foo#small");
    expect(outline).not.toContain("#part");
  });

  it("keeps a delta row only when it passes the scroll's language condition", async () => {
    indexHolds([]);
    const python = codeRow("py", { symbolId: "helper", relativePath: "src/new.py", language: "python" });

    const results = await find("helper", fakeWorkingTreeView({ changed: ["src/new.py"], rows: [python] }), {
      language: "typescript",
    });

    expect(results).toEqual([]);
  });

  it("applies the exact pathPattern to delta rows", async () => {
    indexHolds([]);
    const outside = codeRow("out", { symbolId: "helper", relativePath: "lib/new.ts" });

    const results = await find("helper", fakeWorkingTreeView({ changed: ["lib/new.ts"], rows: [outside] }), {
      pathPattern: "src/**",
    });

    expect(results).toEqual([]);
  });

  it("does not stamp treeState on rows the floor already took from the tree", async () => {
    indexHolds([baseOld]);

    const results = await find("Foo#newName", fakeWorkingTreeView({ changed: [FOO], rows: [treeNew] }));

    expect(results[0]).not.toHaveProperty("treeState");
  });

  it("hydrates a tree test example of a modified spec with the tree's setup, not the index's", async () => {
    const SPEC = "tests/user.test.ts";
    const header = 'describe("User", () => {';
    const setupRow = (id: string, body: string) =>
      codeRow(id, {
        symbolId: `${id}.setup`,
        relativePath: SPEC,
        chunkType: "test_setup",
        startLine: 2,
        scopeLineRanges: [{ start: 1, end: 20 }],
        memberRowCounts: [1],
        content: `${header}\n${body}`,
      });
    const treeExample = codeRow("ex", {
      symbolId: "User.works",
      parentSymbolId: "User",
      parentType: "test_scope",
      chunkType: "test",
      relativePath: SPEC,
      startLine: 5,
      content: `${header}\n  it("works", () => {});`,
    });
    mockScrollFiltered.mockImplementation(async (_c: string, filter: { must: any[] }) =>
      filter.must[0].key === "chunkType" ? [setupRow("index", "  const user = indexUser();")] : [],
    );
    const view = fakeWorkingTreeView({
      changed: [SPEC],
      rows: [setupRow("tree", "  const user = treeUser();"), treeExample],
    });

    const results = await find("User.works", view);

    const content = String(results[0].payload?.content);
    expect(content).toContain("treeUser()");
    expect(content).not.toContain("indexUser()");
  });

  it("changes nothing when the view touches no path", async () => {
    indexHolds([baseOld]);
    const without = await find("Foo");

    indexHolds([baseOld]);
    const withView = await find("Foo", fakeWorkingTreeView({ rows: [] }));

    expect(JSON.stringify(withView)).toBe(JSON.stringify(without));
  });
});
