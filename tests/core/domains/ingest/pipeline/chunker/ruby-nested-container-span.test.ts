/**
 * bd tea-rags-mcp-mfnvp — a container nested in a class (`Row = Struct.new(…) do
 * … end`, `class Row … end`) keeps its own span. The outer class's sub-floor
 * remainder row (`private`) was hosted by the FIRST chunk after the outer
 * header row — the nested container's member chunk — so that chunk's span ran
 * over every outer method between them. A nested value-class container's member
 * chunks also named it `Struct.new(…) do`, without the `Row =` it is bound to.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

function rowsOf(chunk: CodeChunk): number[] {
  const ranges = chunk.metadata.lineRanges?.length
    ? chunk.metadata.lineRanges
    : [{ start: chunk.startLine, end: chunk.endLine }];
  return ranges.flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, i) => start + i));
}

/** Rows two chunks both claim through their line ranges. */
function overlappingRows(chunks: CodeChunk[]): string[] {
  const owner = new Map<number, string>();
  const overlaps: string[] = [];
  for (const chunk of chunks) {
    for (const row of rowsOf(chunk)) {
      const previous = owner.get(row);
      if (previous !== undefined) overlaps.push(`${row}: ${previous} & ${chunk.metadata.symbolId}`);
      else owner.set(row, String(chunk.metadata.symbolId));
    }
  }
  return overlaps;
}

/** Chunks whose startLine..endLine span reaches a row another chunk claims. */
function crossMemberSpans(chunks: CodeChunk[]): string[] {
  const crossings: string[] = [];
  for (const chunk of chunks) {
    for (const other of chunks) {
      if (other === chunk) continue;
      const intruder = rowsOf(other).find((row) => row >= chunk.startLine && row <= chunk.endLine);
      if (intruder !== undefined) {
        crossings.push(`${chunk.metadata.symbolId} spans ${other.metadata.symbolId}@${intruder}`);
      }
    }
  }
  return crossings;
}

/** Non-blank, non-comment, non-`end` rows no chunk claims nor carries as a whole content line. */
function uncoveredRows(code: string, chunks: CodeChunk[]): string[] {
  const claimed = new Set(chunks.flatMap(rowsOf));
  const carried = new Set(chunks.flatMap((c) => c.content.split("\n").map((l) => l.trim())));
  return code
    .split("\n")
    .map((text, i) => ({ text: text.trim(), line: i + 1 }))
    .filter(({ text, line }) => text && !text.startsWith("#") && text !== "end" && !claimed.has(line))
    .filter(({ text }) => !carried.has(text))
    .map(({ text, line }) => `${line}: ${text}`);
}

const OUTER_TAIL =
  `\n  def self.list(firm:)\n    new(firm: firm).list\n  end\n\n` +
  `  def list\n    rows = @firm.clients.map { |c| Row.new(client_id: c.id, name: c.name) }\n    rows.sort_by(&:name)\n  end\n\n` +
  `  private\n\n` +
  `  def helper_one\n    @firm.clients.where(active: true).order(:name).limit(100).to_a\n  end\nend\n`;

const NESTED_BODY = `    def read_attribute_for_serialization(key)\n      public_send(key)\n    end\n  end\n`;

const nestedStruct = (): string =>
  `class Billing::Holders\n  Row = Struct.new(:client_id, :name, keyword_init: true) do\n${NESTED_BODY}${OUTER_TAIL}`;
const nestedClass = (): string => `class Billing::Holders\n  class Row\n${NESTED_BODY}${OUTER_TAIL}`;

describe("TreeSitterChunker — Ruby nested containers keep their own span (bd mfnvp)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 5000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  for (const [shape, build] of [
    ["nested Struct.new block", nestedStruct],
    ["nested class", nestedClass],
  ] as const) {
    it(`${shape}: no two chunks claim one row, no span crosses a sibling, every row covered`, async () => {
      const code = build();
      const chunks = await chunker.chunk(code, "lib/billing/holders.rb", "ruby");

      expect(overlappingRows(chunks)).toEqual([]);
      expect(crossMemberSpans(chunks)).toEqual([]);
      expect(uncoveredRows(code, chunks)).toEqual([]);
      const nested = chunks.find(
        (c) => c.metadata.symbolId === "Billing::Holders::Row#read_attribute_for_serialization",
      );
      expect(nested?.content).not.toContain("private");
      expect(nested?.endLine).toBe(5);
    });
  }

  it("a nested value-class container's member chunk names it by its whole assignment row", async () => {
    const chunks = await chunker.chunk(nestedStruct(), "lib/billing/holders.rb", "ruby");
    const nested = chunks.find((c) => c.metadata.symbolId === "Billing::Holders::Row#read_attribute_for_serialization");

    expect(nested?.content.split("\n").map((l) => l.trim())).toContain(
      "Row = Struct.new(:client_id, :name, keyword_init: true) do",
    );
  });
});
