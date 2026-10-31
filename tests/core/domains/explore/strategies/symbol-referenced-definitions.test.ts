/**
 * find_symbol method rows carry `referencedDefinitions` (bd
 * tea-rags-mcp-d0z7b.4): the defining statements of the class-level constants
 * the body names, found through the owner's header chunks and read from the
 * tree file the view reads. Capped per row and per answer; absent under
 * metaOnly and when nothing is referenced.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import { SymbolBatchDrill } from "../../../../../src/core/domains/explore/symbol-batch.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const OWNER = "TaxPreparation::Document";
const PATH = "app/models/tax_preparation/document.rb";
const LONG = `Regexp.new(${"'x' + ".repeat(104)}'x')`;

const TREE = [
  "module TaxPreparation", // 1
  "  class Document < ApplicationRecord", // 2
  '    EXTENSIONS_BLACK_LIST_REGEX = Regexp.new("^#{Settings.documents.black_list}", Regexp::IGNORECASE)', // 3
  "    PREVIEWABLE_EXTENSIONS_REGEX = Regexp.new(Settings.documents.previewable, Regexp::IGNORECASE)", // 4
  `    LONG_A = ${LONG}`, // 5
  `    LONG_B = ${LONG}`, // 6
  `    LONG_C = ${LONG}`, // 7
  "", // 8
  "    def previewable?", // 9
  "      file_extension.match?(TaxPreparation::Document::PREVIEWABLE_EXTENSIONS_REGEX)", // 10
  "    end", // 11
  "    def title", // 12
  "      name", // 13
  "    end", // 14
  "    def first_long", // 15
  "      LONG_A + LONG_B", // 16
  "    end", // 17
  "    def second_long", // 18
  "      LONG_C", // 19
  "    end", // 20
  "    def third_long", // 21
  "      LONG_A", // 22
  "    end", // 23
  "  end", // 24
  "end", // 25
].join("\n");

const lines = TREE.split("\n");
const method = (name: string, startLine: number, endLine: number): ScrollChunk => ({
  id: `m-${name}`,
  payload: {
    relativePath: PATH,
    language: "ruby",
    chunkType: "function",
    symbolId: `${OWNER}#${name}`,
    name,
    parentSymbolId: OWNER,
    parentType: "class",
    startLine,
    endLine,
    content: lines.slice(startLine - 1, endLine).join("\n"),
  },
});

const header: ScrollChunk = {
  id: "header",
  payload: {
    relativePath: PATH,
    language: "ruby",
    chunkType: "block",
    symbolId: OWNER,
    parentSymbolId: OWNER,
    parentType: "class",
    startLine: 3,
    endLine: 7,
    content: lines.slice(2, 7).join("\n"),
    memberSymbolIds: ["EXTENSIONS_BLACK_LIST_REGEX", "PREVIEWABLE_EXTENSIONS_REGEX", "LONG_A", "LONG_B", "LONG_C"].map(
      (n) => `${OWNER}::${n}`,
    ),
  },
};

const ROWS = [
  header,
  method("previewable?", 9, 11),
  method("title", 12, 14),
  method("first_long", 15, 17),
  method("second_long", 18, 20),
  method("third_long", 21, 23),
];

describe("SymbolSearchStrategy referencedDefinitions", () => {
  const mockScrollFiltered = vi.fn();
  const qdrant = { scrollFiltered: mockScrollFiltered, getPoint: vi.fn() } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as any;

  /** Every `must` condition holds: `text` = token contained, `value` = equal. */
  const matches = (row: ScrollChunk, must: { key: string; match: { text?: string; value?: unknown } }[]) =>
    must.every(({ key, match }) => {
      const v = row.payload[key];
      if (match.value !== undefined) return v === match.value;
      return typeof v === "string" && v.toLowerCase().includes(String(match.text).toLowerCase());
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockScrollFiltered.mockImplementation(async (_c: string, filter: { must: any[] }) =>
      ROWS.filter((r) => matches(r, filter.must)),
    );
  });

  const treeView = (): WorkingTreeView => fakeWorkingTreeView({ files: { [PATH]: TREE } });
  const find = async (symbol: string, extra: { metaOnly?: boolean; view?: WorkingTreeView } = {}) =>
    new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol }).execute({
      collectionName: "c",
      limit: 50,
      ...(extra.metaOnly ? { metaOnly: true } : {}),
      ...(extra.view ? { workingTreeView: extra.view } : {}),
    });

  it("inlines the defining line of a constant the method names as Owner::NAME", async () => {
    const [row] = await find(`${OWNER}#previewable?`, { view: treeView() });

    expect(row.payload?.referencedDefinitions).toEqual([
      { symbolId: `${OWNER}::PREVIEWABLE_EXTENSIONS_REGEX`, startLine: 4, endLine: 4, text: lines[3] },
    ]);
  });

  it("adds no field to a method referencing no header constant", async () => {
    const [row] = await find(`${OWNER}#title`, { view: treeView() });

    expect(row.payload).toBeDefined();
    expect(row.payload).not.toHaveProperty("referencedDefinitions");
  });

  it("adds no field under metaOnly", async () => {
    const [row] = await find(`${OWNER}#previewable?`, { metaOnly: true, view: treeView() });

    expect(row.payload).not.toHaveProperty("referencedDefinitions");
  });

  it("adds no field when the view reads no tree file", async () => {
    const [row] = await find(`${OWNER}#previewable?`);

    expect(row.payload).not.toHaveProperty("referencedDefinitions");
  });

  it("caps one row at 800 chars of definition text, naming the rest by id", async () => {
    const [row] = await find(`${OWNER}#first_long`, { view: treeView() });
    const defs = row.payload?.referencedDefinitions as { symbolId: string; text?: string }[];

    expect(defs.map((d) => [d.symbolId, d.text !== undefined])).toEqual([
      [`${OWNER}::LONG_A`, true],
      [`${OWNER}::LONG_B`, false],
    ]);
    expect(defs.reduce((n, d) => n + (d.text?.length ?? 0), 0)).toBeLessThanOrEqual(800);
  });

  it("caps a batch answer at 2000 chars of definition text across its rows", async () => {
    const drill = new SymbolBatchDrill(
      (symbol) => new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol }),
    );
    const symbols = ["first_long", "second_long", "previewable?", "third_long"].map((m) => `${OWNER}#${m}`);
    const answer = await drill.execute(symbols, { collectionName: "c", limit: 50, workingTreeView: treeView() });
    const defs = answer.rows.flatMap(
      (r) => (r.result.payload?.referencedDefinitions ?? []) as { symbolId: string; text?: string }[],
    );
    const text = defs.reduce((n, d) => n + (d.text?.length ?? 0), 0);

    expect(defs.length).toBe(5);
    expect(text).toBeGreaterThan(0);
    expect(text).toBeLessThanOrEqual(2000);
    expect(defs.at(-1)).toEqual({ symbolId: `${OWNER}::LONG_A`, startLine: 5, endLine: 5 });
  });
});
