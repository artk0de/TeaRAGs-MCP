/**
 * A top-level symbol emitted as ONE leaf chunk carries the comment block above
 * it, for a language that declares `LanguageChunkerHooks.leadingCommentRows` —
 * the same rows its member comment-capture gives a method. The rows are the
 * chunk's own (`startLine` moves to the comment), and the module remainder
 * never takes them: one row, one owner.
 *
 * Only Ruby declares the hook. A language that does not (TypeScript here) keeps
 * its leaf chunks exactly as they were.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

function ownersByRow(chunks: CodeChunk[]): Map<number, number> {
  const owners = new Map<number, number>();
  for (const chunk of chunks) {
    const ranges = chunk.metadata.lineRanges?.length
      ? chunk.metadata.lineRanges
      : [{ start: chunk.startLine, end: chunk.endLine }];
    const rows = new Set<number>();
    for (const { start, end } of ranges) for (let row = start; row <= end; row++) rows.add(row);
    for (const row of rows) owners.set(row, (owners.get(row) ?? 0) + 1);
  }
  return owners;
}

function chunkClaiming(chunks: CodeChunk[], row: number): CodeChunk | undefined {
  return chunks.find((c) => {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    return ranges.some(({ start, end }) => start <= row && row <= end);
  });
}

describe("leaf chunk leading comment", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 2500, chunkOverlap: 0, maxChunkSize: 2500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("joins a Ruby top-level leaf class's comment to its chunk", async () => {
    const code = [
      "# frozen_string_literal: true",
      "",
      "# Raised when a gateway answers with a payload the adapter cannot read.",
      "# Carries the raw body so the caller can log it.",
      "class Payments::UnreadableResponseError < StandardError",
      "  def initialize(body) = super(body.to_s)",
      "end",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/app/lib/payments/unreadable_response_error.rb", "ruby");
    const owners = ownersByRow(chunks);

    const carrier = chunkClaiming(chunks, 3);
    expect(carrier?.metadata.symbolId).toBe("Payments::UnreadableResponseError");
    expect(carrier?.startLine).toBe(3);
    expect(carrier?.content.startsWith("# Raised when a gateway answers")).toBe(true);
    for (const row of [3, 4, 5, 6, 7]) expect(owners.get(row)).toBe(1);
  });

  it("opens part 1 of an oversized Ruby leaf with its comment", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => `    "code_${i}" => "Description of reason code number ${i}",`);
    const code = [
      "# Reason codes the clearing house returns, as published in its spec.",
      "module Payments::ReasonCodes",
      "  ALL = {",
      ...rows,
      "  }.freeze",
      "end",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/app/lib/payments/reason_codes.rb", "ruby");
    const owners = ownersByRow(chunks);

    const first = chunkClaiming(chunks, 1);
    expect(first?.startLine).toBe(1);
    expect(first?.content).toContain("# Reason codes the clearing house returns");
    expect(owners.get(1)).toBe(1);
  });

  it("keeps a leaf value-class container's assignment row under its comment", async () => {
    const code = [
      "# One posted ledger line, as the exporter renders it.",
      "LedgerLine = Struct.new(:account_id, :amount_cents, :posted_on) do",
      "  def amount = amount_cents / 100.0",
      "end",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/app/lib/ledger_line.rb", "ruby");

    const carrier = chunkClaiming(chunks, 1);
    expect(carrier?.startLine).toBe(1);
    expect(carrier?.content).toContain(
      "# One posted ledger line, as the exporter renders it.\nLedgerLine = Struct.new(:account_id",
    );
    expect(ownersByRow(chunks).get(1)).toBe(1);
  });

  it("does not attach a Ruby comment across two blank rows", async () => {
    const code = [
      "# A file-level note that describes nothing in particular below it.",
      "",
      "",
      "class Payments::Noop < StandardError",
      "  def initialize(body) = super(body.to_s)",
      "end",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/app/lib/payments/noop.rb", "ruby");

    expect(chunkClaiming(chunks, 4)?.startLine).toBe(4);
  });

  it("leaves a TypeScript top-level function's chunk where it was", async () => {
    const code = [
      "/** Formats an amount in cents for the ledger export, two decimals. */",
      "export function formatCents(amountCents: number): string {",
      "  return (amountCents / 100).toFixed(2);",
      "}",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/src/format.ts", "typescript");

    expect(chunkClaiming(chunks, 2)?.startLine).toBe(2);
  });
});
