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

  // bd tea-rags-mcp-03yel: an outline of a small file costs a second turn (the
  // agent Reads the file anyway), so a small file answers with its full text,
  // read from the tree — never reassembled from overlapping chunks.
  describe("small file answers with its full text", () => {
    const lines = (n: number, width = 1) =>
      `${Array.from({ length: n }, (_, i) => "x".repeat(width) + String(i)).join("\n")}\n`;
    const outlineCtx = async (view: WorkingTreeView, extra: Record<string, unknown> = {}) =>
      new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: FOO }).execute({
        collectionName: "c",
        limit: 1,
        workingTreeView: view,
        ...extra,
      });

    it("answers a file of at most 150 lines with the tree's text as one file row", async () => {
      mockScrollFiltered.mockResolvedValue([member("m", "Foo#bar")]);
      const text = lines(150);

      const results = await outlineCtx(fakeWorkingTreeView({ files: { [FOO]: text } }));

      expect(results).toHaveLength(1);
      expect(results[0].payload).toMatchObject({
        kind: "file",
        relativePath: FOO,
        language: "typescript",
        content: text,
        startLine: 1,
        endLine: 150,
      });
    });

    it("keeps the outline of a file over 150 lines whose outline is shorter than its text", async () => {
      mockScrollFiltered.mockResolvedValue([member("m", "Foo#bar")]);

      const results = await outlineCtx(fakeWorkingTreeView({ files: { [FOO]: lines(151, 40) } }));

      expect(results[0].payload?.kind).toBeUndefined();
      expect(String(results[0].payload?.content)).toContain("Foo#bar");
    });

    it("answers a file over 150 lines with its text when the outline is at least as long", async () => {
      const members = Array.from({ length: 40 }, (_, i) => member(`m${i}`, `Foo#aRatherLongMemberName${i}`));
      mockScrollFiltered.mockResolvedValue(members);
      const text = "\n".repeat(160);

      const results = await outlineCtx(fakeWorkingTreeView({ files: { [FOO]: text } }));

      expect(results[0].payload).toMatchObject({ kind: "file", content: text, startLine: 1, endLine: 160 });
    });

    it("keeps the doc TOC of a small markdown file", async () => {
      const DOC = "docs/a.md";
      mockScrollFiltered.mockResolvedValue([
        codeRow("d", { relativePath: DOC, language: "markdown", isDocumentation: true, symbolId: "doc:1", name: "A" }),
      ]);

      const results = await new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: DOC }).execute({
        collectionName: "c",
        limit: 1,
        workingTreeView: fakeWorkingTreeView({ files: { [DOC]: "# A\n" } }),
      });

      expect(results[0].payload?.kind).toBeUndefined();
    });

    it("keeps the outline under metaOnly", async () => {
      mockScrollFiltered.mockResolvedValue([member("m", "Foo#bar")]);

      const results = await outlineCtx(fakeWorkingTreeView({ files: { [FOO]: lines(3) } }), { metaOnly: true });

      expect(results[0].payload?.kind).toBeUndefined();
      expect(results[0].payload?.content).toBe("src/foo.ts\n  Foo#bar L1-3");
    });

    it("falls back to the outline when the tree cannot read the file", async () => {
      mockScrollFiltered.mockResolvedValue([member("m", "Foo#bar")]);

      const results = await outlineCtx(fakeWorkingTreeView({ files: {} }));

      expect(results[0].payload?.kind).toBeUndefined();
      expect(String(results[0].payload?.content)).toContain("Foo#bar");
    });

    it("keeps the outline of a file the view serves from the index", async () => {
      mockScrollFiltered.mockResolvedValue([member("m", "Foo#bar")]);

      const results = await outlineCtx(fakeWorkingTreeView({ indexServed: [FOO], files: { [FOO]: lines(3) } }));

      expect(results[0].payload?.kind).toBeUndefined();
      expect(results[0].treeState).toBe("modified");
    });

    it("answers a modified file with the tree's text, not the index's", async () => {
      mockScrollFiltered.mockResolvedValue([member("old", "Foo#oldName")]);
      const view = fakeWorkingTreeView({
        changed: [FOO],
        rows: [member("new", "Foo#newName")],
        files: { [FOO]: "class Foo { newName() {} }\n" },
      });

      const results = await outlineCtx(view);

      expect(results[0].payload).toMatchObject({ kind: "file", content: "class Foo { newName() {} }\n", endLine: 1 });
      expect(results[0].treeState).toBeUndefined();
    });
  });
});
