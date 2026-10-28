/**
 * bd tea-rags-mcp-0td4h — a constant bound to a value-class builder with a
 * block (`Billing::Entry = Data.define(:a) do … end`, `Struct.new(…) do`) is a
 * container like a `class`: every non-blank row of it lands in a chunk, and
 * every `def` in the block is addressable under the constant's name.
 *
 * The RSpec filter rejected the builder `call` outside spec files, so the
 * engine descended through it and emitted the long `def`s as bare top-level
 * chunks (`build`, `problem`). The assignment row, the endless defs between
 * them and `private_class_method :new` belonged to no chunk.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

/**
 * Non-blank, non-comment rows strictly inside the container opened on
 * `headerLine` and closed on `endLine` (1-based) that no chunk covers — the
 * header row travels as every body chunk's prefix, as a `class` header does.
 */
function uncoveredBodyLines(code: string, chunks: CodeChunk[], headerLine: number, endLine: number): string[] {
  const covered = new Set<number>();
  for (const c of chunks) {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    for (const r of ranges) for (let l = r.start; l <= r.end; l++) covered.add(l);
  }
  const text = code.split("\n");
  const missing: string[] = [];
  for (let line = headerLine + 1; line < endLine; line++) {
    const row = text[line - 1].trim();
    if (row.length > 0 && !row.startsWith("#") && !covered.has(line)) missing.push(`${line}: ${text[line - 1]}`);
  }
  return missing;
}

/** 1-based line of the first row whose text equals `row`. */
function lineOf(code: string, row: string): number {
  return code.split("\n").indexOf(row) + 1;
}

/** The chunks answering `symbolId` — its own chunk, or a body chunk declaring it as a member. */
function chunksAnswering(chunks: CodeChunk[], symbolId: string): CodeChunk[] {
  return chunks.filter((c) => c.metadata.symbolId === symbolId || c.metadata.memberSymbolIds?.includes(symbolId));
}

const DATA_DEFINE_BODY = (indent: string): string =>
  `${indent}  def self.build(name)\n` +
  `${indent}    new(name: name, kind: 'gate')\n` +
  `${indent}  end\n\n` +
  `${indent}  def gate? = kind == 'gate'\n\n` +
  `${indent}  def limit? = kind == 'limit'\n\n` +
  `${indent}  def problem\n` +
  `${indent}    return 'missing' if name.blank?\n` +
  `${indent}    nil\n` +
  `${indent}  end\n`;

describe("TreeSitterChunker — Ruby value-class builder block bodies (bd 0td4h)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 5000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("covers every row of a top-level Data.define block and addresses its defs under the constant", async () => {
    const code = `Billing::Entry = Data.define(:name, :kind) do\n${DATA_DEFINE_BODY("")}end\n`;
    const chunks = await chunker.chunk(code, "lib/billing/entry.rb", "ruby");

    expect(uncoveredBodyLines(code, chunks, 1, lineOf(code, "end"))).toEqual([]);
    const gateChunks = chunksAnswering(chunks, "Billing::Entry#gate?");
    expect(gateChunks.map((c) => c.content.split("\n")[0])).toContain("Billing::Entry = Data.define(:name, :kind) do");
    expect(chunksAnswering(chunks, "Billing::Entry.build")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "Billing::Entry#problem")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "Billing::Entry#gate?")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "Billing::Entry#limit?")).not.toHaveLength(0);
  });

  it("covers every row of a Struct.new block with private_class_method, nested in a module", async () => {
    const code =
      `module Billing\n` +
      `  Slot = Struct.new(:name, :kind, keyword_init: true) do\n` +
      `    private_class_method :new\n\n` +
      `${DATA_DEFINE_BODY("  ")}` +
      `  end\n` +
      `end\n`;
    const chunks = await chunker.chunk(code, "lib/billing/slot.rb", "ruby");

    expect(uncoveredBodyLines(code, chunks, 2, lineOf(code, "  end"))).toEqual([]);
    expect(chunksAnswering(chunks, "Billing::Slot.build")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "Billing::Slot#problem")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "Billing::Slot#gate?")).not.toHaveLength(0);
  });
});
