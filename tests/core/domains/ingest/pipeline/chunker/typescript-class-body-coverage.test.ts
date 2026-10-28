/**
 * bd tea-rags-mcp-xiki8 — every row of a large TypeScript class body lands in
 * a chunk, and every method is addressable by its symbolId.
 *
 * The TypeScript class-body hook dropped every member group under the 50-char
 * noise floor (a lone `private n = 1;` between two methods), and once it wrote
 * ANY body chunk the engine's container remainder stayed out — so that row was
 * in no chunk. A method under the engine's 50-char child floor (`get id() {
 * return 1; }`) rides a body chunk as a neighbour member (bd u7tjf) but no
 * chunk declared it, so `find_symbol("Gateway#id")` fell back to the class.
 * Sibling of the Ruby fix, bd tea-rags-mcp-30qdc.
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
function requestMethods(from: number, count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `  /** Fetches catalogue page ${from + i} for the given path. */\n` +
      `  async fetchPage${from + i}(path: string): Promise<Item[]> {\n` +
      `    const response = await this.request("POST", "/pages/${from + i}", { path, page: ${from + i} });\n` +
      `    return parse(response.body).items.map((row) => new Item(row));\n` +
      `  }\n`,
  ).join("\n");
}

describe("TreeSitterChunker — TypeScript class body rows and short methods (bd xiki8)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 5000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  const routes =
    `  static readonly ROUTES = {\n` +
    `    list: "/documents",\n` +
    `    fetch: "/documents/:id",\n` +
    `    remove: "/documents/:id/remove",\n` +
    `  };\n`;

  it("covers a lone sub-floor field row between two methods", async () => {
    const code =
      `export class Gateway {\n${routes}\n${requestMethods(0, 3)}\n  private n = 1;\n\n` + `${requestMethods(3, 3)}}\n`;
    const chunks = await chunker.chunk(code, "src/gateway.ts", "typescript");

    expect(uncoveredBodyLines(code, chunks, 1, lineOf(code, "}"))).toEqual([]);
  });

  it("addresses the short instance and static methods the engine does not extract", async () => {
    const code =
      `export class Gateway {\n${routes}\n${requestMethods(0, 3)}\n  get id() { return 1; }\n\n` +
      `  static root() { return R; }\n\n${requestMethods(3, 3)}}\n`;
    const chunks = await chunker.chunk(code, "src/gateway.ts", "typescript");

    expect(uncoveredBodyLines(code, chunks, 1, lineOf(code, "}"))).toEqual([]);
    expect(chunksAnswering(chunks, "Gateway#id")).not.toHaveLength(0);
    expect(chunksAnswering(chunks, "Gateway.root")).not.toHaveLength(0);
  });

  it("covers a class whose only body rows are sub-floor (engine remainder keeps them)", async () => {
    const code = `export class Tiny {\n  private n = 1;\n\n${requestMethods(0, 2)}}\n`;
    const chunks = await chunker.chunk(code, "src/tiny.ts", "typescript");

    expect(uncoveredBodyLines(code, chunks, 1, lineOf(code, "}"))).toEqual([]);
  });
});
