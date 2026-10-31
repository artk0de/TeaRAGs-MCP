/**
 * Referenced definitions (bd tea-rags-mcp-d0z7b.4): a method row names the
 * statements defining the class-level constants its body references — found
 * through its owner's header chunks (`memberSymbolIds`), their text read from
 * the tree file — so the caller does not grep for `NAME =` next.
 */

import { describe, expect, it } from "vitest";

import type { ScrollChunk } from "../../../../src/core/domains/explore/chunk-grouping/index.js";
import {
  collectReferencedDefinitions,
  spendReferencedDefinitionsAllowance,
} from "../../../../src/core/domains/explore/referenced-definitions.js";

const OWNER = "TaxPreparation::Document";

const TREE = [
  "module TaxPreparation", // 1
  "  class Document < ApplicationRecord", // 2
  "    STATUSES = %w[", // 3
  "      pending", // 4
  "      done", // 5
  "    ].freeze", // 6
  '    EXTENSIONS_BLACK_LIST_REGEX = Regexp.new("^#{Settings.documents.black_list}", Regexp::IGNORECASE)', // 7
  "    PREVIEWABLE_EXTENSIONS_REGEX = Regexp.new(Settings.documents.previewable, Regexp::IGNORECASE)", // 8
  "    RECENT_TIME_LIMIT = 2.days", // 9
  "    has_many :documents", // 10
  "", // 11
  "    def previewable?", // 12
  "      file_extension.match?(TaxPreparation::Document::PREVIEWABLE_EXTENSIONS_REGEX)", // 13
  "    end", // 14
  "  end", // 15
  "end", // 16
].join("\n");

const header: ScrollChunk = {
  id: "h1",
  payload: {
    relativePath: "app/models/tax_preparation/document.rb",
    symbolId: OWNER,
    parentSymbolId: OWNER,
    parentType: "class",
    chunkType: "block",
    startLine: 3,
    endLine: 10,
    memberSymbolIds: [
      `${OWNER}::STATUSES`,
      `${OWNER}::EXTENSIONS_BLACK_LIST_REGEX`,
      `${OWNER}::PREVIEWABLE_EXTENSIONS_REGEX`,
      `${OWNER}::RECENT_TIME_LIMIT`,
      `${OWNER}#documents`,
    ],
  },
};

const collect = (body: string, treeText = TREE, headerChunks: ScrollChunk[] = [header]) =>
  collectReferencedDefinitions({ body, ownerSymbolId: OWNER, headerChunks, treeText });

describe("collectReferencedDefinitions", () => {
  it("answers a bare constant reference with its defining line", () => {
    const defs = collect("def invalid_format?\n  name =~ EXTENSIONS_BLACK_LIST_REGEX\nend");

    expect(defs).toEqual([
      {
        symbolId: `${OWNER}::EXTENSIONS_BLACK_LIST_REGEX`,
        startLine: 7,
        endLine: 7,
        text: '    EXTENSIONS_BLACK_LIST_REGEX = Regexp.new("^#{Settings.documents.black_list}", Regexp::IGNORECASE)',
      },
    ]);
  });

  it("answers a reference qualified by the row's own owner (`Owner::NAME`)", () => {
    const full = collect(
      "def previewable?\n  file_extension.match?(TaxPreparation::Document::PREVIEWABLE_EXTENSIONS_REGEX)\nend",
    );
    const tail = collect("def previewable?\n  Document::PREVIEWABLE_EXTENSIONS_REGEX.match?(x)\nend");

    expect(full.map((d) => [d.symbolId, d.startLine, d.endLine])).toEqual([
      [`${OWNER}::PREVIEWABLE_EXTENSIONS_REGEX`, 8, 8],
    ]);
    expect(tail.map((d) => d.symbolId)).toEqual([`${OWNER}::PREVIEWABLE_EXTENSIONS_REGEX`]);
  });

  it("ignores a same-named constant qualified by another owner", () => {
    expect(collect("def recent?\n  created_at > Other::RECENT_TIME_LIMIT.ago\nend")).toEqual([]);
  });

  it("spans a multi-line definition to its closing bracket", () => {
    const [def] = collect("def known?\n  STATUSES.include?(status)\nend");

    expect(def).toEqual({
      symbolId: `${OWNER}::STATUSES`,
      startLine: 3,
      endLine: 6,
      text: "    STATUSES = %w[\n      pending\n      done\n    ].freeze",
    });
  });

  it("adds nothing when the body references no header constant", () => {
    expect(collect("def title\n  name.upcase\nend")).toEqual([]);
  });

  it("never takes a member whose statement does not begin with its name (a DSL row)", () => {
    expect(collect("def first_document\n  documents.first\nend")).toEqual([]);
  });

  it("names a definition past the per-row cap by id and lines only", () => {
    const long = `    RECENT_TIME_LIMIT = ${"1 + ".repeat(240)}1`;
    const tree = TREE.replace("    RECENT_TIME_LIMIT = 2.days", long);
    const defs = collect("def recent?\n  STATUSES.any? && RECENT_TIME_LIMIT\nend", tree);

    expect(defs.map((d) => [d.symbolId, d.text !== undefined])).toEqual([
      [`${OWNER}::STATUSES`, true],
      [`${OWNER}::RECENT_TIME_LIMIT`, false],
    ]);
    expect(defs[1]).toEqual({ symbolId: `${OWNER}::RECENT_TIME_LIMIT`, startLine: 9, endLine: 9 });
  });

  it("reads nothing from a header chunk of another owner", () => {
    const foreign: ScrollChunk = {
      ...header,
      payload: { ...header.payload, symbolId: "Other", parentSymbolId: "Other" },
    };
    expect(collect("def x\n  RECENT_TIME_LIMIT\nend", TREE, [foreign])).toEqual([]);
  });
});

describe("spendReferencedDefinitionsAllowance", () => {
  const row = (defs: unknown) => ({
    payload: { symbolId: `${OWNER}#x`, content: "def x; end", referencedDefinitions: defs },
  });

  it("keeps text within the allowance and names the rest by id and lines", () => {
    const defs = [
      { symbolId: "A::ONE", startLine: 1, endLine: 1, text: "a".repeat(150) },
      { symbolId: "A::TWO", startLine: 2, endLine: 2, text: "b".repeat(150) },
    ];
    const spent = spendReferencedDefinitionsAllowance(row(defs), 200);

    expect(spent?.spent).toBe(150);
    expect(spent?.result.payload.referencedDefinitions).toEqual([
      defs[0],
      { symbolId: "A::TWO", startLine: 2, endLine: 2 },
    ]);
  });

  it("leaves a row without referenced definitions alone", () => {
    expect(spendReferencedDefinitionsAllowance({ payload: { content: "x" } }, 100)).toBeUndefined();
  });
});
