/**
 * Rake is its own DSL (bd tea-rags-mcp-k0602): a `.rake` file chunks per task
 * through the same scope-tree machinery the RSpec chunker uses — `namespace`
 * is the container, `task` / `multitask` / `file` / `rule` the leaves, `desc`
 * travels with the leaf it describes — and every task is addressed by its
 * namespace-qualified Rake name (`billing:sync`). A task is production code,
 * never a test chunk.
 */
import { describe, expect, it } from "vitest";

import { CodeChunkGrouper } from "../../../../../../src/core/domains/explore/chunk-grouping/index.js";
import { resolveSymbols } from "../../../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";
import { RAKE_FILE, RAKE_PATH } from "../fixtures/billing-rake.js";

function newChunker(): TreeSitterChunker {
  return new TreeSitterChunker(
    { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );
}

function byId(chunks: CodeChunk[], symbolId: string): CodeChunk {
  const chunk = chunks.find((c) => c.metadata.symbolId === symbolId);
  if (!chunk) throw new Error(`no chunk ${symbolId} in ${chunks.map((c) => c.metadata.symbolId).join(", ")}`);
  return chunk;
}

/** The scroll rows explore reads, as the payload builder lays them out. */
function asScrollRows(chunks: CodeChunk[]): { id: string; payload: Record<string, unknown> }[] {
  return chunks.map((c, i) => ({
    id: `chunk-${i}`,
    payload: {
      relativePath: RAKE_PATH,
      language: "ruby",
      content: c.content,
      startLine: c.startLine,
      endLine: c.endLine,
      chunkType: c.metadata.chunkType,
      name: c.metadata.name,
      symbolId: c.metadata.symbolId,
      parentSymbolId: c.metadata.parentSymbolId,
      parentType: c.metadata.parentType,
    },
  }));
}

describe("Rake DSL chunking (bd tea-rags-mcp-k0602)", () => {
  it("addresses every task by its namespace-qualified Rake name, in source order", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, RAKE_PATH, "ruby");
    const taskIds = chunks.map((c) => c.metadata.symbolId).filter((id) => id !== "sync_logger");

    expect(taskIds).toEqual([
      "billing:sync",
      "billing:invoices:reconcile",
      "billing:invoices:prune",
      "billing:export",
      "billing:parallel_sync",
      // Rake never scopes a file task or a rule by its namespace.
      "billing.csv",
      ".json",
      "billing_all",
    ]);
  });

  it("chunks a task as production code under its namespace, never as a test", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, RAKE_PATH, "ruby");
    const seed = byId(chunks, "billing:sync");
    const reset = byId(chunks, "billing:invoices:reconcile");

    expect(seed.metadata).toMatchObject({ chunkType: "function", name: "sync", parentSymbolId: "billing" });
    expect(reset.metadata).toMatchObject({ chunkType: "function", parentSymbolId: "billing:invoices" });
    expect(chunks.some((c) => c.metadata.chunkType === "test" || c.metadata.chunkType === "test_setup")).toBe(false);
    expect(chunks.some((c) => c.metadata.parentType === "test_scope")).toBe(false);
  });

  it("carries a task's desc with the task, under the namespace title path", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, RAKE_PATH, "ruby");
    const seed = byId(chunks, "billing:sync");
    const reset = byId(chunks, "billing:invoices:reconcile");

    expect(seed.startLine).toBe(9);
    expect(seed.content).toContain('desc "Sync the billing invoices"');
    expect(seed.content).toContain("sync_logger.info");
    expect(reset.content).toContain("namespace :invoices");
    expect(reset.content).toContain('desc "Reconcile one invoice by id"');
  });

  it("keeps every leaf of a namespace as its own chunk, however small", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, RAKE_PATH, "ruby");

    expect(byId(chunks, "billing:parallel_sync").content).toContain("multitask parallel_sync:");
    expect(byId(chunks, "billing.csv").content).toContain('file "billing.csv"');
    expect(chunks.every((c) => c.metadata.memberSymbolIds === undefined)).toBe(true);
  });

  it("names a top-level task by its Rake name and keeps a top-level def a normal Ruby chunk", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, RAKE_PATH, "ruby");

    expect(byId(chunks, "billing_all").metadata.chunkType).toBe("function");
    expect(byId(chunks, "sync_logger").content).toContain("ActiveSupport::Logger.new");
  });

  it("chunks the same source in a .rb file as plain Ruby", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, "lib/billing.rb", "ruby");

    expect(chunks.map((c) => c.metadata.symbolId)).not.toContain("billing:sync");
  });

  it("answers find_symbol for a task id with that task, and outlines the file by Rake names", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, RAKE_PATH, "ruby");
    const rows = asScrollRows(chunks);

    const [hit] = resolveSymbols(
      rows.filter((r) => r.payload.symbolId === "billing:sync"),
      "billing:sync",
    );
    expect(hit.payload?.symbolId).toBe("billing:sync");
    expect(hit.payload?.content).toContain("Invoice.where");

    const outline = CodeChunkGrouper.groupFile(rows).payload?.content as string;
    expect(outline.split("\n")).toEqual([
      RAKE_PATH,
      "  sync_logger",
      "  billing:sync",
      "  billing:invoices:reconcile",
      "  billing:invoices:prune",
      "  billing:export",
      "  billing:parallel_sync",
      "  billing.csv",
      "  .json",
      "  billing_all",
    ]);
  });
});

/** A namespace holding a helper `def` beside its tasks. */
const RAKE_WITH_HELPER = `namespace :billing do
  def sync_scope
    Invoice.where(kind: "billing")
  end

  task :sync do
    sync_scope.each(&:touch)
  end
end
`;

describe("Rake DSL chunking keeps Ruby declarations and top-level descs (bd tea-rags-mcp-k0602)", () => {
  it("keeps a def inside a namespace its own method chunk", async () => {
    const chunks = await newChunker().chunk(RAKE_WITH_HELPER, RAKE_PATH, "ruby");
    const helper = byId(chunks, "sync_scope");

    expect(helper.metadata.chunkType).toBe("function");
    expect(helper.startLine).toBe(2);
    expect(helper.endLine).toBe(4);
    expect(helper.content).toContain('Invoice.where(kind: "billing")');
    expect(byId(chunks, "billing:sync").content).not.toContain("def sync_scope");
  });

  it("opens a top-level task at the desc above it", async () => {
    const chunks = await newChunker().chunk(RAKE_FILE, RAKE_PATH, "ruby");
    const all = byId(chunks, "billing_all");

    expect(all.startLine).toBe(38);
    expect(all.content).toContain('desc "Run the full billing pipeline"');
  });

  it("still carries every non-blank line of a .rake file in some chunk (bd tea-rags-mcp-6xdwe)", async () => {
    for (const source of [RAKE_FILE, RAKE_WITH_HELPER]) {
      const chunks = await newChunker().chunk(source, RAKE_PATH, "ruby");
      // `require` lines are the file's imports payload, not chunk text.
      // A namespace row is carried as its scope title, without the block opener.
      const missing = source
        .split("\n")
        .map((text) => text.trim().replace(/\s+do$/, ""))
        .filter((text) => text !== "" && !text.startsWith("require"))
        .filter((text) => !chunks.some((c) => c.content.includes(text)));
      expect(missing).toEqual([]);
    }
  });
});
