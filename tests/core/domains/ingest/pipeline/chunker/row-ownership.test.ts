/**
 * Every non-blank row has exactly ONE owning chunk (bd tea-rags-mcp-5ndal).
 *
 * A row is owned by a chunk when the chunk's `lineRanges` (or, without them,
 * `startLine..endLine`) include it; text a chunk carries only as a prefix — a
 * container header, the character fallback's overlap — is content, not a claim.
 * Three shapes claimed rows twice: a single-line node reported `endLine` one
 * row past itself (a one-line `const f = () => …`, a TS one-line constructor, a
 * Ruby `class XError < StandardError; end`, an endless `def x = …`), so it owned
 * the next statement's row too; and the character fallback reported its
 * overlap rows as the next chunk's own rows.
 *
 * And a Ruby value-class container emitted as one leaf chunk opens with its
 * whole assignment row, `Row = Struct.new(…) do` (bd tea-rags-mcp-0k8zt).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const FIXTURES = join(__dirname, "../../../../../fixtures/row-ownership/ruby");

/** Non-blank rows owned by more than one chunk, as `line: text`. */
function doublyOwnedRows(code: string, chunks: CodeChunk[]): string[] {
  const owners = new Map<number, number>();
  for (const c of chunks) {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    const rows = new Set<number>();
    for (const r of ranges) for (let l = r.start; l <= r.end; l++) rows.add(l);
    for (const l of rows) owners.set(l, (owners.get(l) ?? 0) + 1);
  }
  return code
    .split("\n")
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text, line }) => text.trim() !== "" && (owners.get(line) ?? 0) > 1)
    .map(({ text, line }) => `${line}: ${text.trim()}`);
}

describe("TreeSitterChunker — every non-blank row has one owning chunk (5ndal)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 5000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("TypeScript: adjacent one-line arrow constants each own only their row", async () => {
    const code = [
      `import { createHash } from "node:crypto";`,
      ``,
      `const contentOf = (row: { payload: { content?: unknown } }): string => String(row.payload.content ?? "");`,
      `const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");`,
      `const lineOf = (payload: Record<string, unknown> | undefined, key: string): number | undefined => {`,
      `  const value = payload?.[key];`,
      `  return typeof value === "number" ? value : undefined;`,
      `};`,
      ``,
    ].join("\n");
    const chunks = await chunker.chunk(code, "src/rows.ts", "typescript");

    expect(doublyOwnedRows(code, chunks)).toEqual([]);
    const sha = chunks.find((c) => c.metadata.symbolId === "sha256");
    expect(sha?.startLine).toBe(4);
    expect(sha?.endLine).toBe(4);
  });

  it("TypeScript: a one-line constructor does not own the method row below it", async () => {
    const code = [
      `export class VisibilityNarrowerForRows implements CandidateNarrower {`,
      `  constructor(private readonly access: VisibilityAccessPolicy = DEFAULT_VISIBILITY_ACCESS) {}`,
      `  narrow(call: CallRef, candidates: SymbolDefinition[], ctx: CallContext): SymbolDefinition[] {`,
      `    return candidates.filter((c) => c.visibility === undefined || this.access.canReach(call, c, ctx));`,
      `  }`,
      `}`,
      ``,
    ].join("\n");
    const chunks = await chunker.chunk(code, "src/narrower.ts", "typescript");

    expect(doublyOwnedRows(code, chunks)).toEqual([]);
  });

  it("TypeScript character fallback: overlap rows are content of the next chunk, owned by the previous one", async () => {
    const small = new TreeSitterChunker(
      { chunkSize: 600, chunkOverlap: 150, maxChunkSize: 600 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
    const entries = Array.from(
      { length: 30 },
      (_, i) => `  entry${i}: { label: "the label of entry number ${i}", weight: ${i} },`,
    );
    const code = [
      `/**`,
      ` * A detector table: no function, no class, so the file has no AST chunk.`,
      ` */`,
      `export const detectorTable = {`,
      ...entries,
      `};`,
      ``,
    ].join("\n");
    const chunks = await small.chunk(code, "src/table.ts", "typescript");

    expect(chunks.length).toBeGreaterThan(1);
    expect(doublyOwnedRows(code, chunks)).toEqual([]);
    // The overlap is still carried as the next chunk's leading context: the
    // rows before its own are the previous chunk's last rows.
    const lines = code.split("\n");
    const second = chunks[1];
    const contentRows = second.content.split("\n");
    const overlapRows = contentRows.length - (second.endLine - second.startLine + 1);
    expect(overlapRows).toBeGreaterThan(0);
    expect(contentRows.slice(0, overlapRows)).toEqual(lines.slice(chunks[0].endLine - overlapRows, chunks[0].endLine));
  });

  it("Ruby: one-line error classes and endless defs each own only their row", async () => {
    const code = readFileSync(join(FIXTURES, "errors.rb"), "utf8");
    const chunks = await chunker.chunk(code, "app/gateway_client.rb", "ruby");

    expect(doublyOwnedRows(code, chunks)).toEqual([]);
  });

  it("Ruby: every fixture of the probe shapes has one owner per row", async () => {
    for (const name of ["handler.rb", "rows.rb", "errors.rb", "top_level_rows.rb"]) {
      const code = readFileSync(join(FIXTURES, name), "utf8");
      const chunks = await chunker.chunk(code, `app/${name}`, "ruby");
      expect(doublyOwnedRows(code, chunks), name).toEqual([]);
    }
  });
});

describe("TreeSitterChunker — a leaf value-class container opens with its assignment row (0k8zt)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 5000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("a Struct / Data container inside a module or class keeps `Const =` in its content", async () => {
    const code = readFileSync(join(FIXTURES, "rows.rb"), "utf8");
    const chunks = await chunker.chunk(code, "app/reports.rb", "ruby");

    for (const header of [
      "Row = Struct.new(:name, :count) do",
      "Cell = Data.define(:x, :y) do",
      "Line = Struct.new(:title, :total, keyword_init: true) do",
    ]) {
      const owner = chunks.find((c) => c.content.split("\n").some((row) => row.trim() === header));
      expect(owner, header).toBeDefined();
    }
  });

  it("a top-level value-class container keeps `Const =` in its content", async () => {
    const code = readFileSync(join(FIXTURES, "top_level_rows.rb"), "utf8");
    const chunks = await chunker.chunk(code, "app/top_level_rows.rb", "ruby");

    const owner = chunks.find((c) =>
      c.content.split("\n").some((row) => row.trim() === "Point = Struct.new(:x, :y) do"),
    );
    expect(owner).toBeDefined();
  });
});
