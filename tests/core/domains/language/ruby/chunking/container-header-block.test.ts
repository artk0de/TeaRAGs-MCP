/**
 * The Ruby container header block — the body chunk that carries a class /
 * module's own rows above, between and below its methods.
 *
 *   1. The comment block directly above a container declaration belongs to
 *      the container's header block, the way a method's leading comment
 *      belongs to the method chunk: its rows are in `lineRanges` and
 *      `startLine` starts there. One row, one owner.
 *   2. A one-line nested `class X < Y; end` / `module Z; end` is a member of
 *      the header block (`Owner::X`), like a constant, so `find_symbol`
 *      answers it by its own id.
 *   3. The header text keeps each row's original indentation and collapses
 *      the blank runs left where methods were taken out to one blank line;
 *      `lineRanges` is unaffected.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const OWNER = "Payments::Gateways::Catalog";

const CATALOG = [
  "# frozen_string_literal: true", // 1
  "", // 2
  "# Resolves which gateway adapter answers for an account. Each namespace", // 3
  "# provides a Connection model and a Client beside the services it calls.", // 4
  `module ${OWNER}`, // 5
  "  class UnknownGatewayError < StandardError; end", // 6
  "  module Defaults; end", // 7
  "", // 8
  "  GATEWAYS = { stripe: :stripe_adapter, adyen: :adyen_adapter }.freeze", // 9
  "", // 10
  "  module_function", // 11
  "", // 12
  "", // 13
  "  # Every registered gateway adapter, for work that names no gateway.", // 14
  "  def adapters", // 15
  "    GATEWAYS.values.map { |adapter| adapter.to_s.upcase }", // 16
  "  end", // 17
  "", // 18
  "  # The gateway registered under the given key, or raise when unknown.", // 19
  "  def adapter_for(key)", // 20
  "    GATEWAYS.fetch(key) { raise UnknownGatewayError, key.to_s }", // 21
  "  end", // 22
  "", // 23
  "  def connection_for(account)", // 24
  "    account.connections.find { |connection| connection.active? }", // 25
  "  end", // 26
  "end", // 27
  "",
].join("\n");

/** Every 1-based row each chunk claims, by `lineRanges` or its whole span. */
function claimedRows(chunk: CodeChunk): number[] {
  const ranges = chunk.metadata.lineRanges ?? [{ start: chunk.startLine, end: chunk.endLine }];
  const rows = new Set<number>();
  for (const { start, end } of ranges) for (let row = start; row <= end; row++) rows.add(row);
  return [...rows];
}

function ownersByRow(chunks: CodeChunk[]): Map<number, number> {
  const owners = new Map<number, number>();
  for (const chunk of chunks) for (const row of claimedRows(chunk)) owners.set(row, (owners.get(row) ?? 0) + 1);
  return owners;
}

function headerBlock(chunks: CodeChunk[], owner: string): CodeChunk {
  const blocks = chunks.filter((c) => c.metadata.symbolId === owner && c.metadata.chunkType === "block");
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

describe("Ruby container header block", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  describe("leading comment of the container", () => {
    it("is carried by the header block: rows in lineRanges, startLine moved to the comment", async () => {
      const chunks = await chunker.chunk(CATALOG, "/repo/app/lib/payments/gateways/catalog.rb", "ruby");
      const block = headerBlock(chunks, OWNER);

      expect(block.startLine).toBe(3);
      expect(block.metadata.lineRanges?.[0]).toEqual({ start: 3, end: 4 });
      expect(block.content).toContain("# Resolves which gateway adapter answers for an account. Each namespace");
      expect(block.content).toContain("# provides a Connection model and a Client beside the services it calls.");
    });

    it("claims every comment row exactly once across the file", async () => {
      const chunks = await chunker.chunk(CATALOG, "/repo/app/lib/payments/gateways/catalog.rb", "ruby");
      const owners = ownersByRow(chunks);

      for (const row of [3, 4, 14, 19]) expect(owners.get(row)).toBe(1);
      expect([...owners.values()].every((count) => count === 1)).toBe(true);
    });

    it("is carried by a container whose body holds only methods", async () => {
      const code = [
        "# Settles an invoice against the ledger; idempotent per invoice id.",
        "class Billing::InvoiceSettler < ApplicationService",
        "  def call(invoice)",
        "    ledger.post(invoice.id, invoice.amount_cents, currency: invoice.currency)",
        "  end",
        "",
        "  def ledger",
        "    @ledger ||= Billing::Ledger.for(account: Current.account, strict: true)",
        "  end",
        "end",
        "",
      ].join("\n");
      const chunks = await chunker.chunk(code, "/repo/app/services/billing/invoice_settler.rb", "ruby");
      const owners = ownersByRow(chunks);

      expect(owners.get(1)).toBe(1);
      const carrier = chunks.find((c) => claimedRows(c).includes(1));
      expect(carrier?.metadata.symbolId).toBe("Billing::InvoiceSettler");
      expect(carrier?.content).toContain("# Settles an invoice against the ledger; idempotent per invoice id.");
      // The container remainder stays out once the hook writes a chunk, so the
      // header block keeps the declaration row it carried.
      expect(owners.get(2)).toBe(1);
      expect(carrier?.metadata.lineRanges).toEqual([{ start: 1, end: 2 }]);
    });

    it("splits a leading comment over the budget at row boundaries, each row claimed once", async () => {
      const small = new TreeSitterChunker(
        { chunkSize: 800, chunkOverlap: 0, maxChunkSize: 800 },
        new DefaultSymbolIdComposer(),
        new LanguageFactory(),
      );
      const notes = Array.from(
        { length: 40 },
        (_, i) => `# Design note ${i}: the exporter batches ledger rows per account and flushes them.`,
      );
      const code = [
        ...notes,
        "module Billing::Exporting",
        "  BATCH_SIZE = 500",
        "",
        "  def self.export_all_rows_for(account)",
        "    account.ledger_rows.each_slice(BATCH_SIZE).map { |slice| render(slice) }",
        "  end",
        "end",
        "",
      ].join("\n");
      const chunks = await small.chunk(code, "/repo/app/billing/exporting.rb", "ruby");
      const owners = ownersByRow(chunks);

      for (let row = 1; row <= notes.length; row++) expect(owners.get(row)).toBe(1);
      expect([...owners.values()].every((count) => count === 1)).toBe(true);
      expect(chunks.every((c) => c.content.length <= 800)).toBe(true);
    });

    it("is carried by a nested container's own header block, not the outer one's", async () => {
      const code = [
        "module Billing",
        "  RETRY_LIMIT = 3",
        "",
        "  # Exports ledger rows in batches; one exporter per account.",
        "  class Exporter < Base",
        "    BATCH_SIZE = 500",
        "    FORMATS = %w[csv xlsx].freeze",
        "",
        "    def export_all_the_rows(account)",
        "      account.ledger_rows.each_slice(BATCH_SIZE).map { |slice| render(slice) }",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n");
      const chunks = await chunker.chunk(code, "/repo/app/billing.rb", "ruby");
      const owners = ownersByRow(chunks);

      expect(owners.get(4)).toBe(1);
      const block = headerBlock(chunks, "Billing::Exporter");
      expect(claimedRows(block)).toContain(4);
      expect(block.startLine).toBe(4);
    });

    it("is not attached across two blank lines, as for methods", async () => {
      const code = [
        "# A file-level note that describes nothing in particular below it.",
        "",
        "",
        "module Billing::Formats",
        "  CSV_SEPARATOR = ','",
        "  XLSX_SHEET_NAME = 'Ledger rows exported by the billing exporter'",
        "",
        "  def self.separator_for(format)",
        "    format == :csv ? CSV_SEPARATOR : XLSX_SHEET_NAME",
        "  end",
        "end",
        "",
      ].join("\n");
      const chunks = await chunker.chunk(code, "/repo/app/billing/formats.rb", "ruby");

      expect(claimedRows(headerBlock(chunks, "Billing::Formats"))).not.toContain(1);
    });
  });

  describe("one-line nested containers", () => {
    it("are members of the header block as Owner::Name", async () => {
      const chunks = await chunker.chunk(CATALOG, "/repo/app/lib/payments/gateways/catalog.rb", "ruby");

      expect(headerBlock(chunks, OWNER).metadata.memberSymbolIds).toEqual(
        expect.arrayContaining([`${OWNER}::UnknownGatewayError`, `${OWNER}::Defaults`, `${OWNER}::GATEWAYS`]),
      );
    });

    it("answers find_symbol for the nested class by its own id", async () => {
      const chunks = await chunker.chunk(CATALOG, "/repo/app/lib/payments/gateways/catalog.rb", "ruby");
      const nestedId = `${OWNER}::UnknownGatewayError`;
      const rows = chunks
        .filter((c) => (c.metadata.memberSymbolIds ?? []).includes(nestedId))
        .map((c) => ({
          id: `${c.startLine}`,
          score: 1,
          payload: {
            ...c.metadata,
            relativePath: "app/lib/payments/gateways/catalog.rb",
            content: c.content,
            startLine: c.startLine,
            endLine: c.endLine,
          },
        }));

      const [answer] = resolveSymbols(rows, nestedId);
      expect(answer.payload?.content).toContain("class UnknownGatewayError < StandardError; end");
    });
  });

  describe("header text shape", () => {
    it("keeps each row's indentation and collapses blank runs to one blank line", async () => {
      const chunks = await chunker.chunk(CATALOG, "/repo/app/lib/payments/gateways/catalog.rb", "ruby");
      const block = headerBlock(chunks, OWNER);

      expect(block.content).toContain("\n  class UnknownGatewayError < StandardError; end\n  module Defaults; end\n");
      expect(block.content).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
    });
  });
});
