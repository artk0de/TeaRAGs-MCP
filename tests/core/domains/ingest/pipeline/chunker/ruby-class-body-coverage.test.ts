/**
 * bd tea-rags-mcp-30qdc — every row of a large Ruby class body lands in a
 * chunk, and every `def` is addressable by its symbolId.
 *
 * A method under the engine's 50-char child floor (`def base_url` / `BASE_URL`
 * / `end`) is never extracted as a child, so its rows reach the Ruby class-body
 * hook as body lines. The hook dropped every declaration group under the same
 * floor (`private`, a lone `include`), and once it wrote ANY body chunk the
 * engine's container remainder stayed out — so those rows were in no chunk, and
 * `find_symbol("Owner#base_url")` fell back to the class.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

function coveredLines(chunks: CodeChunk[]): Set<number> {
  const covered = new Set<number>();
  for (const c of chunks) {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    for (const r of ranges) for (let l = r.start; l <= r.end; l++) covered.add(l);
  }
  return covered;
}

/** Non-blank rows strictly inside the container opened on `headerLine` and closed on `endLine` (1-based) that no chunk covers. */
function uncoveredBodyLines(code: string, chunks: CodeChunk[], headerLine: number, endLine: number): string[] {
  const covered = coveredLines(chunks);
  const text = code.split("\n");
  const missing: string[] = [];
  for (let line = headerLine + 1; line < endLine; line++) {
    if (text[line - 1].trim().length > 0 && !covered.has(line)) missing.push(`${line}: ${text[line - 1]}`);
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

/** `count` documented request methods, each well above the child floor. */
function requestMethods(count: number, indent: string): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `${indent}# Fetches catalogue page ${i} for the given path.\n` +
      `${indent}def fetch_page_${i}(path:)\n` +
      `${indent}  response = request(:post, '/pages/${i}', body: {Path: path, Page: ${i}})\n` +
      `${indent}  parse(response.body).fetch('items', []).map { |row| Item.new(row) }\n` +
      `${indent}end\n`,
  ).join("\n");
}

describe("TreeSitterChunker — Ruby class body rows and short defs (bd 30qdc)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 5000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  const tail = (indent: string): string =>
    `${indent}def list(path:)\n` +
    `${indent}  request(:post, '/docs', body: {Path: path})\n` +
    `${indent}end\n\n` +
    `${indent}private\n\n` +
    `${indent}def base_url\n` +
    `${indent}  BASE_URL\n` +
    `${indent}end\n\n` +
    `${indent}def auth_headers(token)\n` +
    `${indent}  {'Authorization' => "Bearer #{token}"}\n` +
    `${indent}end\n`;

  it("covers every body row and addresses the short private def of a compact-named class", async () => {
    const code = `class A::B::C\n  include Gateway::Requests\n\n${requestMethods(20, "  ")}\n${tail("  ")}end\n`;
    const chunks = await chunker.chunk(code, "lib/a/b/c.rb", "ruby");

    expect(uncoveredBodyLines(code, chunks, 1, lineOf(code, "end"))).toEqual([]);
    expect(chunksAnswering(chunks, "A::B::C#base_url")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "A::B::C#auth_headers")).not.toHaveLength(0);
  });

  it("covers every body row and addresses the short defs of a class nested in a module", async () => {
    const code =
      `module Shop\n  class Gateway\n    include Gateway::Requests\n\n${requestMethods(20, "    ")}\n` +
      `    def self.root\n      ROOT\n    end\n\n${tail("    ")}  end\nend\n`;
    const chunks = await chunker.chunk(code, "lib/shop/gateway.rb", "ruby");

    expect(uncoveredBodyLines(code, chunks, 2, lineOf(code, "  end"))).toEqual([]);
    expect(chunksAnswering(chunks, "Shop::Gateway#base_url")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "Shop::Gateway.root")).not.toHaveLength(0);
  });
});
