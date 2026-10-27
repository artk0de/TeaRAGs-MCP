/**
 * A Rake task is a codegraph symbol (bd tea-rags-mcp-k0602): the walker
 * attributes the calls inside a task body to a `function` symbol whose id IS
 * the chunk's Rake name (`billing:sync`), over the chunk's own lines (desc
 * row to `end`). A `def` inside a namespace stays the method it was, and owns
 * its own calls. Only a `.rake` file reads as Rake.
 *
 * The symbol ranges come from the REAL symbol collection (`collectSymbols` over
 * `rbNameOf`), exactly as the pipeline hands them to the walker.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { ChunkExtraction, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { rbNameOf } from "../../../../../../src/core/domains/language/ruby/walker/name-of.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { RAKE_FILE, RAKE_PATH } from "../fixtures/billing-rake.js";

const composer = new DefaultSymbolIdComposer();

function extract(src: string, relPath: string): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const tree = parser.parse(src);
  const chunks = collectSymbols(tree, (n) => rbNameOf(n), "::", false, composer);
  return extractFromRubyFile({ tree, code: src, relPath, language: "ruby", chunks });
}

function symbol(ex: FileExtraction, symbolId: string): ChunkExtraction {
  const found = ex.chunks.find((c) => c.symbolId === symbolId);
  if (!found) throw new Error(`no symbol ${symbolId} in ${ex.chunks.map((c) => c.symbolId).join(", ")}`);
  return found;
}

const calledMembers = (c: ChunkExtraction): string[] => c.calls.map((call) => call.member);

const RAKE_WITH_HELPER = `namespace :billing do
  def sync_scope
    Invoice.where(kind: "billing")
  end

  task :sync do
    sync_scope.each(&:touch)
  end
end
`;

describe("Rake task symbols in the Ruby walker (bd tea-rags-mcp-k0602)", () => {
  it("attributes a task body's calls to the task, addressed by its Rake name", () => {
    const seed = symbol(extract(RAKE_FILE, RAKE_PATH), "billing:sync");

    expect(seed).toMatchObject({ symbolKind: "function", startLine: 9, endLine: 14 });
    expect(calledMembers(seed)).toEqual(expect.arrayContaining(["where", "update!", "info"]));
    expect(seed.calls).toContainEqual(expect.objectContaining({ receiver: "Invoice", member: "where" }));
    expect(seed.calls).toContainEqual(expect.objectContaining({ receiver: "sync_logger", member: "info" }));
  });

  it("gives every task chunk a codegraph symbol with the chunk's id and lines", async () => {
    const chunker = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
    const taskChunks = (await chunker.chunk(RAKE_FILE, RAKE_PATH, "ruby")).filter(
      (c) => c.metadata.symbolId !== undefined && c.metadata.symbolId !== "sync_logger",
    );
    const ex = extract(RAKE_FILE, RAKE_PATH);

    expect(taskChunks).toHaveLength(8);
    for (const chunk of taskChunks) {
      expect(symbol(ex, chunk.metadata.symbolId as string)).toMatchObject({
        symbolKind: "function",
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    }
  });

  it("keeps a top-level task's calls on it, its desc row included", () => {
    const all = symbol(extract(RAKE_FILE, RAKE_PATH), "billing_all");

    expect(all).toMatchObject({ symbolKind: "function", startLine: 38, endLine: 42 });
    expect(calledMembers(all)).toContain("invoke");
  });

  it("keeps a def inside a namespace a method that owns its own calls", () => {
    const ex = extract(RAKE_WITH_HELPER, RAKE_PATH);
    const helper = symbol(ex, "sync_scope");
    const seed = symbol(ex, "billing:sync");

    expect(helper).toMatchObject({ symbolKind: "method", startLine: 2, endLine: 4 });
    expect(calledMembers(helper)).toContain("where");
    expect(calledMembers(seed)).not.toContain("where");
    expect(seed.calls).toContainEqual(expect.objectContaining({ receiver: "sync_scope", member: "each" }));
  });

  it("reads the same source in a .rb file as plain Ruby", () => {
    const ex = extract(RAKE_FILE, "lib/billing.rb");

    expect(ex.chunks.map((c) => c.symbolId)).not.toContain("billing:sync");
  });
});
