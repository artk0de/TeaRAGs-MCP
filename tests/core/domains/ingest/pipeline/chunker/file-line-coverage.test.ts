/**
 * Every non-blank line a grep would find lands in some emitted chunk
 * (bd tea-rags-mcp-6xdwe).
 *
 * The chunker dropped two kinds of text grep sees: a whole small file (a
 * re-export barrel, a one-line class) yielded ZERO chunks, and a tiny
 * top-level statement the 50-char noise gate skipped vanished from a larger
 * file. The noise gate still keeps such text from becoming a chunk of its own;
 * it now rides in a neighbouring chunk, and a small file becomes one
 * whole-file chunk.
 *
 * Import / re-export rows of a file that has other chunks are excluded from the
 * per-line check: they are the file's `imports` payload, not chunk text — the
 * module remainder's documented contract (module-remainder.test.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { assignNavigationAndDocSymbolId } from "../../../../../../src/core/domains/ingest/pipeline/chunker/chunk-navigation.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const MAX = 4500;

function uncoveredNonBlankLines(code: string, chunks: CodeChunk[]): string[] {
  const covered = new Set<number>();
  for (const c of chunks) {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    for (const r of ranges) for (let l = r.start; l <= r.end; l++) covered.add(l);
  }
  return code
    .split("\n")
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text, line }) => text.trim() !== "" && !covered.has(line))
    .map(({ text, line }) => `${line}: ${text}`);
}

/** Every non-blank line's text appears in the content of a chunk covering it. */
function missingFromContent(code: string, chunks: CodeChunk[]): string[] {
  return code
    .split("\n")
    .filter((text) => text.trim() !== "")
    .filter((text) => !chunks.some((c) => c.content.includes(text.trim())));
}

function bigFunction(name: string): string {
  const body = Array.from({ length: 6 }, (_, i) => `  const step${i} = computeTheStepValueFor${name}(${i});`);
  return [`function ${name}(): number {`, ...body, "  return step0 + step5;", "}", ""].join("\n");
}

describe("TreeSitterChunker — every non-blank line is chunked", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: MAX, chunkOverlap: 450, maxChunkSize: MAX },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("turns a TypeScript re-export barrel into one whole-file chunk that keeps its imports", async () => {
    const code = 'export * from "./routes";\nexport { mocks } from "./mocks";\n';
    const { chunks, imports } = await chunker.chunkWithTree(code, "/repo/Routes/index.ts", "typescript");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.chunkType).toBe("block");
    expect(chunks[0].metadata.language).toBe("typescript");
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    expect(missingFromContent(code, chunks)).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["./routes", "./mocks"]));
  });

  it("turns a one-line Ruby class into one chunk carrying the class symbolId", async () => {
    const code = "class Firm < Base; end\n";
    const chunks = await chunker.chunk(code, "/repo/lib/firm.rb", "ruby");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.symbolId).toBe("Firm");
    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("keeps a one-line Ruby file with a require and a tiny method whole", async () => {
    const code = 'require "x"\ndef ping = :pong\n';
    const chunks = await chunker.chunk(code, "/repo/lib/ping.rb", "ruby");

    expect(chunks).toHaveLength(1);
    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("puts a tiny top-level function between two big ones into a neighbouring chunk", async () => {
    const code = [bigFunction("first"), "function tiny() {}", "", bigFunction("second")].join("\n");
    const chunks = await chunker.chunk(code, "/repo/steps.ts", "typescript");

    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    expect(missingFromContent(code, chunks)).toEqual([]);
    // The noise gate still holds: no chunk of its own for the tiny function.
    expect(chunks.map((c) => c.metadata.symbolId)).toEqual(["first", "second"]);
  });

  it("puts a tiny Ruby method between two big ones into some chunk", async () => {
    const big = (name: string): string[] => [
      `  def ${name}`,
      ...Array.from({ length: 5 }, (_, i) => `    value_${i} = compute_the_value_for_${name}(${i})`),
      "  end",
      "",
    ];
    const code = ["class Steps", ...big("first"), "  def x; 1; end", "", ...big("second"), "end", ""].join("\n");
    const chunks = await chunker.chunk(code, "/repo/steps.rb", "ruby");

    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("keeps a tiny file of a language with no grammar (character fallback)", async () => {
    const code = "FOO=1\n";
    const chunks = await chunker.chunk(code, "/repo/settings.env", "unknown");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.chunkType).toBe("block");
    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("keeps a tiny tree-sitter file with no chunkable node", async () => {
    const code = "export const x = 1;\n";
    const chunks = await chunker.chunk(code, "/repo/x.ts", "typescript");

    expect(chunks).toHaveLength(1);
    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("keeps a tiny headingless markdown file as one documentation chunk", async () => {
    const code = "Short text.\n";
    const chunks = await chunker.chunk(code, "/repo/tiny.md", "markdown");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Short text.");
    expect(chunks[0].metadata.isDocumentation).toBe(true);
    expect(chunks[0].metadata.chunkType).toBe("block");
    expect(chunks[0].metadata.headingPath).toEqual([]);
    assignNavigationAndDocSymbolId(chunks, "/repo");
    expect(chunks[0].metadata.symbolId).toMatch(/^doc:[0-9a-f]{12}$/);
    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("keeps a tiny markdown file holding only a heading line", async () => {
    const code = "# Title\n";
    const chunks = await chunker.chunk(code, "/repo/title.md", "markdown");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.isDocumentation).toBe(true);
    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("keeps a tiny YAML file as one documentation chunk", async () => {
    const code = "debug: true\n";
    const chunks = await chunker.chunk(code, "/repo/config/app.yaml", "yaml");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.isDocumentation).toBe(true);
    expect(chunks[0].metadata.chunkType).toBe("block");
    expect(chunks[0].metadata.headingPath).toEqual([]);
    assignNavigationAndDocSymbolId(chunks, "/repo");
    expect(chunks[0].metadata.symbolId).toMatch(/^doc:[0-9a-f]{12}$/);
    expect(missingFromContent(code, chunks)).toEqual([]);
  });

  it("keeps every line of a Rake task file in some chunk (bd tea-rags-mcp-k0602)", async () => {
    const code = [
      'require "csv"',
      "",
      "def log_line(text) = puts(text)",
      "",
      "namespace :billing do",
      "  # Syncs every billing invoice.",
      '  desc "Seed"',
      "  task seed: :environment do",
      "    Template.where(kind: :billing).find_each(&:seed!)",
      "  end",
      "",
      "  namespace :cache do",
      "    task :clear do",
      "      Rails.cache.clear",
      "    end",
      "  end",
      "  task default: :seed",
      '  desc "dangling"',
      "end",
      "",
      'desc "Run all"',
      "task all: %w[billing:sync]",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/lib/tasks/billing.rake", "ruby");

    // A namespace's own `do` row is carried as its title row, without the
    // block opener, exactly as an RSpec scope's is; a bare `end` is no search
    // target. Every other line is chunk text verbatim.
    const searchable = code
      .split("\n")
      .filter((text) => text.trim() !== "" && text.trim() !== "end" && text.trim() !== 'require "csv"')
      .map((text) => text.replace(/\s+do$/, ""))
      .join("\n");
    expect(missingFromContent(searchable, chunks)).toEqual([]);
  });

  it("still yields no chunk for a blank markdown or YAML file", async () => {
    expect(await chunker.chunk("\n \n", "/repo/blank.md", "markdown")).toEqual([]);
    expect(await chunker.chunk("\n", "/repo/config/blank.yaml", "yaml")).toEqual([]);
  });

  it("still yields no chunk for a blank file", async () => {
    expect(await chunker.chunk("", "/repo/empty.ts", "typescript")).toEqual([]);
    expect(await chunker.chunk("  \n\n", "/repo/blank.rb", "ruby")).toEqual([]);
  });
});
