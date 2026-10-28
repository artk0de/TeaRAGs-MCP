/**
 * Ruby nested-form containers and class-level constants (bd tea-rags-mcp-1x85g).
 *
 * `module A` / `module B` / `class C` … `end end end` and the compact
 * `class A::B::C` declare the same class. The compact form always chunked the
 * class under its own id; the nested form stamped the class body under the
 * OUTERMOST module (`A`), so `A::B::C` had no chunk of its own and its outline
 * root read `A`. A class-level constant was a row of a body chunk carrying only
 * the container id, so `find_symbol("Owner::CONST")` knew no such symbol.
 *
 * Pinned through the real `TreeSitterChunker`:
 *   1. the compact form's chunks stay exactly as they were (lines, ids,
 *      content), the constants chunk only gaining its member ids;
 *   2. the nested form chunks the class under `A::B::C` — methods parented
 *      to the class, the class body under the class id, nothing of the class
 *      under an enclosing module's id;
 *   3. a constants body chunk names each constant as `Owner::CONST` in
 *      `memberSymbolIds`, so the class outline lists them and find_symbol
 *      answers them;
 *   4. a nested class larger than the chunk budget still has its methods
 *      extracted one by one, never character-split as one symbol.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const OWNER = "Billing::Reports::LedgerExporter";

const NESTED = [
  "module Billing",
  "  module Reports",
  "    class LedgerExporter",
  "      HEADER_SQL = <<~SQL",
  "        SELECT id, amount, posted_at",
  "        FROM ledger_entries",
  "        WHERE account_id = :account_id",
  "      SQL",
  "",
  "      BATCH_SIZE = 500",
  "",
  "      def initialize(account)",
  "        @account = account",
  "        @rows = []",
  "      end",
  "",
  "      def export",
  "        @rows = fetch_rows(HEADER_SQL)",
  "        @rows.each_slice(BATCH_SIZE).map { |slice| render(slice) }",
  "      end",
  "",
  "      def self.build(account)",
  "        new(account).tap { |exporter| exporter.export }",
  "      end",
  "    end",
  "  end",
  "end",
  "",
].join("\n");

const COMPACT = [
  "class Billing::Reports::LedgerExporter",
  "  HEADER_SQL = <<~SQL",
  "    SELECT id, amount, posted_at",
  "    FROM ledger_entries",
  "    WHERE account_id = :account_id",
  "  SQL",
  "",
  "  BATCH_SIZE = 500",
  "",
  "  def initialize(account)",
  "    @account = account",
  "    @rows = []",
  "  end",
  "",
  "  def export",
  "    @rows = fetch_rows(HEADER_SQL)",
  "    @rows.each_slice(BATCH_SIZE).map { |slice| render(slice) }",
  "  end",
  "",
  "  def self.build(account)",
  "    new(account).tap { |exporter| exporter.export }",
  "  end",
  "end",
  "",
].join("\n");

interface ChunkListing {
  chunkType: string | undefined;
  name: string | undefined;
  symbolId: string | undefined;
  parentSymbolId: string | undefined;
  parentType: string | undefined;
  lines: string;
  lineRanges: string | undefined;
}

function listing(chunks: CodeChunk[]): ChunkListing[] {
  return chunks.map((c) => ({
    chunkType: c.metadata.chunkType,
    name: c.metadata.name,
    symbolId: c.metadata.symbolId,
    parentSymbolId: c.metadata.parentSymbolId,
    parentType: c.metadata.parentType,
    lines: `${c.startLine}-${c.endLine}`,
    lineRanges: c.metadata.lineRanges?.map((r) => `${r.start}-${r.end}`).join(","),
  }));
}

/** The payload a scroll returns for a chunk — the fields resolveSymbols reads. */
function scrollRowOf(chunk: CodeChunk, i: number) {
  return {
    id: `chunk-${i}`,
    payload: {
      ...chunk.metadata,
      relativePath: "app/billing/reports/ledger_exporter.rb",
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    } as Record<string, unknown>,
  };
}

describe("Ruby chunking — nested-form containers and class constants (bd tea-rags-mcp-1x85g)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  describe("compact form (baseline — unchanged)", () => {
    it("keeps every chunk's lines, ids and content", async () => {
      const chunks = await chunker.chunk(COMPACT, "/repo/app/billing/reports/ledger_exporter.rb", "ruby");

      expect(listing(chunks)).toEqual([
        {
          chunkType: "function",
          name: "initialize",
          symbolId: `${OWNER}#initialize`,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "10-13",
          lineRanges: undefined,
        },
        {
          chunkType: "function",
          name: "export",
          symbolId: `${OWNER}#export`,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "15-18",
          lineRanges: undefined,
        },
        {
          chunkType: "function",
          name: "build",
          symbolId: `${OWNER}.build`,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "20-22",
          lineRanges: undefined,
        },
        {
          chunkType: "block",
          name: OWNER,
          symbolId: OWNER,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "2-8",
          lineRanges: "2-8",
        },
      ]);
      expect(chunks.map((c) => c.content)).toEqual([
        "class Billing::Reports::LedgerExporter\ndef initialize(account)\n    @account = account\n    @rows = []\n  end",
        "class Billing::Reports::LedgerExporter\ndef export\n    @rows = fetch_rows(HEADER_SQL)\n    @rows.each_slice(BATCH_SIZE).map { |slice| render(slice) }\n  end",
        "class Billing::Reports::LedgerExporter\ndef self.build(account)\n    new(account).tap { |exporter| exporter.export }\n  end",
        "class Billing::Reports::LedgerExporter\nHEADER_SQL = <<~SQL\n    SELECT id, amount, posted_at\n    FROM ledger_entries\n    WHERE account_id = :account_id\n  SQL\n\n  BATCH_SIZE = 500",
      ]);
    });
  });

  describe("nested form", () => {
    it("chunks the class under its full id, not the outermost module's", async () => {
      const chunks = await chunker.chunk(NESTED, "/repo/app/billing/reports/ledger_exporter.rb", "ruby");

      expect(listing(chunks)).toEqual([
        {
          chunkType: "function",
          name: "initialize",
          symbolId: `${OWNER}#initialize`,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "12-15",
          lineRanges: undefined,
        },
        {
          chunkType: "function",
          name: "export",
          symbolId: `${OWNER}#export`,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "17-20",
          lineRanges: undefined,
        },
        {
          chunkType: "function",
          name: "build",
          symbolId: `${OWNER}.build`,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "22-24",
          lineRanges: undefined,
        },
        {
          chunkType: "block",
          name: "LedgerExporter",
          symbolId: OWNER,
          parentSymbolId: OWNER,
          parentType: "class",
          lines: "4-10",
          lineRanges: "4-10",
        },
      ]);
    });

    it("puts no row of the class under an enclosing module's id", async () => {
      const chunks = await chunker.chunk(NESTED, "/repo/app/billing/reports/ledger_exporter.rb", "ruby");

      const underModules = chunks.filter(
        (c) => c.metadata.symbolId === "Billing" || c.metadata.symbolId === "Billing::Reports",
      );
      expect(underModules.filter((c) => c.content.includes("HEADER_SQL"))).toEqual([]);
    });

    it("names each nested level with the full parent id in a three-deep chain", async () => {
      const code = [
        "module Billing",
        "  module Reports",
        "    class LedgerExporter",
        "      class Row",
        "        def to_csv(separator = ',')",
        "          [id, amount, posted_at].join(separator)",
        "        end",
        "      end",
        "",
        "      def export_all_rows(rows)",
        "        rows.map { |row| Row.new(row).to_csv }",
        "      end",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n");
      const chunks = await chunker.chunk(code, "/repo/app/billing/reports/ledger_exporter.rb", "ruby");

      const methods = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methods.map((c) => [c.metadata.symbolId, c.metadata.parentSymbolId])).toEqual([
        [`${OWNER}::Row#to_csv`, `${OWNER}::Row`],
        [`${OWNER}#export_all_rows`, OWNER],
      ]);
    });

    it("extracts the methods of a nested class larger than the chunk budget one by one", async () => {
      const small = new TreeSitterChunker(
        { chunkSize: 400, chunkOverlap: 40, maxChunkSize: 400 },
        new DefaultSymbolIdComposer(),
        new LanguageFactory(),
      );
      const chunks = await small.chunk(NESTED, "/repo/app/billing/reports/ledger_exporter.rb", "ruby");

      const methods = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methods.map((c) => c.metadata.symbolId)).toEqual([
        `${OWNER}#initialize`,
        `${OWNER}#export`,
        `${OWNER}.build`,
      ]);
      expect(chunks.some((c) => /#part\d+$/.test(c.metadata.symbolId ?? ""))).toBe(false);
    });
  });

  describe("class-level constants", () => {
    it.each([
      ["compact", COMPACT],
      ["nested", NESTED],
    ])("names each constant of the %s form as Owner::CONST", async (_form, code) => {
      const chunks = await chunker.chunk(code, "/repo/app/billing/reports/ledger_exporter.rb", "ruby");

      const constants = chunks.filter((c) => c.metadata.memberSymbolIds !== undefined);
      expect(constants.map((c) => [c.metadata.symbolId, c.metadata.memberSymbolIds])).toEqual([
        [OWNER, [`${OWNER}::HEADER_SQL`, `${OWNER}::BATCH_SIZE`]],
      ]);
    });

    it("names a module-level constant under its module", async () => {
      const code = [
        "module Billing",
        "  module Reports",
        "    DEFAULT_CURRENCY = 'USD'.freeze",
        "    SUPPORTED_FORMATS = %w[csv xlsx json].freeze",
        "",
        "    def self.default_format",
        "      SUPPORTED_FORMATS.first",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n");
      const chunks = await chunker.chunk(code, "/repo/app/billing/reports.rb", "ruby");

      const constants = chunks.filter((c) => c.metadata.memberSymbolIds !== undefined);
      expect(constants.map((c) => [c.metadata.symbolId, c.metadata.memberSymbolIds])).toEqual([
        ["Billing::Reports", ["Billing::Reports::DEFAULT_CURRENCY", "Billing::Reports::SUPPORTED_FORMATS"]],
      ]);
    });

    it("gives a body chunk without constants no member ids", async () => {
      const code = [
        "class Invoice < ApplicationRecord",
        "  belongs_to :account",
        "  has_many :line_items, dependent: :destroy",
        "",
        "  def total",
        "    line_items.sum(&:amount)",
        "  end",
        "end",
        "",
      ].join("\n");
      const chunks = await chunker.chunk(code, "/repo/app/models/invoice.rb", "ruby");

      expect(chunks.filter((c) => c.metadata.memberSymbolIds !== undefined)).toEqual([]);
    });

    it("lists the constants in the class outline and answers a constant by its id", async () => {
      const chunks = await chunker.chunk(NESTED, "/repo/app/billing/reports/ledger_exporter.rb", "ruby");
      const rows = chunks.map(scrollRowOf);

      // find_symbol(OWNER): the chunks naming the class as their own id or parent.
      const classRows = rows.filter((r) => r.payload.symbolId === OWNER || r.payload.parentSymbolId === OWNER);
      const [outline] = resolveSymbols(classRows, OWNER);
      expect(outline.payload?.content).toContain(`${OWNER}::HEADER_SQL`);
      expect(outline.payload?.content).toContain(`${OWNER}::BATCH_SIZE`);

      // find_symbol(OWNER::HEADER_SQL): no chunk owns the id, the member scroll finds its body chunk.
      const constantId = `${OWNER}::HEADER_SQL`;
      const memberRows = rows.filter(
        (r) => Array.isArray(r.payload.memberSymbolIds) && (r.payload.memberSymbolIds as string[]).includes(constantId),
      );
      const [answer] = resolveSymbols(memberRows, constantId);
      expect(answer.payload?.content).toContain("HEADER_SQL = <<~SQL");
      expect(answer.payload?.content).toContain("FROM ledger_entries");
    });
  });
});
