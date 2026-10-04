/**
 * FileOutlineStrategy on a working tree (bd tea-rags-mcp-xi2r9.3): the
 * relativePath outline of a changed file lists the tree's members, an untracked
 * file is outlined from the tree alone, and a deleted file's outline is empty.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

describe("FileOutlineStrategy working-tree chunk floor", () => {
  const mockScrollFiltered = vi.fn();
  const qdrant = { scrollFiltered: mockScrollFiltered } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;

  const FOO = "src/foo.ts";
  const member = (id: string, symbolId: string, relativePath = FOO) =>
    codeRow(id, { symbolId, name: symbolId.split("#").pop(), parentSymbolId: "Foo", relativePath });

  const outline = async (relativePath: string, view?: WorkingTreeView, language?: string) =>
    new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath, language }).execute({
      collectionName: "c",
      limit: 1,
      ...(view ? { workingTreeView: view } : {}),
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists the tree's members for a modified file", async () => {
    mockScrollFiltered.mockResolvedValue([member("old", "Foo#oldName")]);
    const view = fakeWorkingTreeView({ changed: [FOO], rows: [member("new", "Foo#newName")] });

    const results = await outline(FOO, view);

    expect(results).toHaveLength(1);
    const text = String(results[0].payload?.content);
    expect(text).toContain("Foo#newName");
    expect(text).not.toContain("Foo#oldName");
  });

  it("outlines an untracked file from the tree alone", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const view = fakeWorkingTreeView({ changed: ["src/new.ts"], rows: [member("n", "Foo#fresh", "src/new.ts")] });

    const results = await outline("src/new.ts", view);

    expect(String(results[0].payload?.content)).toContain("Foo#fresh");
  });

  it("returns an empty outline for a file deleted in the tree", async () => {
    mockScrollFiltered.mockResolvedValue([member("old", "Foo#oldName")]);

    const results = await outline(FOO, fakeWorkingTreeView({ deleted: [FOO], rows: [] }));

    expect(results).toEqual([]);
  });

  it("keeps only the tree rows of the requested path and language", async () => {
    mockScrollFiltered.mockResolvedValue([]);
    const rows = [
      member("other", "Bar#elsewhere", "src/bar.ts"),
      codeRow("py", { symbolId: "Foo#py", relativePath: FOO, language: "python" }),
      member("ts", "Foo#kept"),
    ];

    const results = await outline(FOO, fakeWorkingTreeView({ changed: [FOO, "src/bar.ts"], rows }), "typescript");

    const text = String(results[0].payload?.content);
    expect(text).toContain("Foo#kept");
    expect(text).not.toContain("Bar#elsewhere");
    expect(text).not.toContain("Foo#py");
  });

  it("changes nothing when the view touches no path", async () => {
    mockScrollFiltered.mockResolvedValue([member("old", "Foo#oldName")]);
    const without = await outline(FOO);
    const withView = await outline(FOO, fakeWorkingTreeView({ rows: [] }));

    expect(JSON.stringify(withView)).toBe(JSON.stringify(without));
  });
});
