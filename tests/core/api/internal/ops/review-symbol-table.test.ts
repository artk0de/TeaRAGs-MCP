/**
 * The review's symbol table (bd tea-rags-mcp-vdhjc): the index's codegraph rows
 * — every persisted definition and every indexed file — hydrated into one
 * table, then overlaid with the working tree: a file the change adds is a
 * member, a file it deletes is not, and a reviewed file's definitions are the
 * tree's, not the index's. A missing or failed read is a typed reason, never
 * an empty table.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildReviewSymbolTable,
  IndexedSymbolRowsCache,
  readIndexedSymbolRows,
  type IndexedSymbolRows,
} from "../../../../../src/core/api/internal/ops/review-symbol-table.js";
import type { FileExtraction, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";

let workTree: string | undefined;

afterEach(() => {
  if (workTree !== undefined) rmSync(workTree, { recursive: true, force: true });
  workTree = undefined;
});

function freshWorkTree(): string {
  workTree = mkdtempSync(join(tmpdir(), "review-symbol-table-"));
  return workTree;
}

function writeFile(relPath: string, text = ""): void {
  const absolute = join(workTree!, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
}

function definition(relPath: string, fqName: string): SymbolDefinition {
  const shortName = fqName.split(/::|\.|#/).pop()!;
  return { symbolId: fqName, fqName, shortName, relPath, scope: [] };
}

function extractionOf(relPath: string, symbolIds: readonly string[]): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    chunks: symbolIds.map((symbolId) => ({ symbolId, scope: [], calls: [] })),
    fileScope: [],
  };
}

describe("readIndexedSymbolRows", () => {
  it("reads every persisted definition and every indexed file", async () => {
    const rows = await readIndexedSymbolRows({
      listAllSymbols: async () => [definition("app/models/user.rb", "User")],
      listFileContentHashes: async () => [
        { relPath: "app/models/user.rb", contentHash: "a" },
        { relPath: "pkg/__init__.py", contentHash: "b" },
      ],
    });

    expect("rows" in rows && rows.rows.files).toEqual(["app/models/user.rb", "pkg/__init__.py"]);
    expect("rows" in rows && rows.rows.definitions.map((def) => def.fqName)).toEqual(["User"]);
  });

  it("names the missing database when the collection has none", async () => {
    const rows = await readIndexedSymbolRows(undefined);

    expect(rows).toEqual({ unavailable: expect.stringContaining("no codegraph database") });
  });

  it("names the failure when the read throws — never an empty table", async () => {
    const rows = await readIndexedSymbolRows({
      listAllSymbols: async () => {
        throw new Error("daemon down");
      },
      listFileContentHashes: async () => [],
    });

    expect(rows).toEqual({ unavailable: expect.stringContaining("daemon down") });
  });

  it("reads an index that holds no file as unavailable, not as a project of nothing", async () => {
    const rows = await readIndexedSymbolRows({
      listAllSymbols: async () => [],
      listFileContentHashes: async () => [],
    });

    expect(rows).toEqual({ unavailable: expect.stringContaining("holds no file") });
  });
});

describe("buildReviewSymbolTable", () => {
  const indexed: IndexedSymbolRows = {
    definitions: [
      definition("app/models/user.rb", "User"),
      definition("app/models/legacy.rb", "Legacy"),
      definition("app/models/account.rb", "Account"),
    ],
    files: ["app/models/user.rb", "app/models/legacy.rb", "app/models/account.rb", "pkg/__init__.py"],
  };

  it("answers hasFile for every indexed file, symbol-free ones included", () => {
    const tree = freshWorkTree();

    const table = buildReviewSymbolTable(indexed, { workTree: tree, touchedFiles: new Set(), treeExtractions: [] });

    expect(table.hasFile("app/models/user.rb")).toBe(true);
    expect(table.hasFile("pkg/__init__.py")).toBe(true);
    expect(table.hasFile("app/models/nope.rb")).toBe(false);
    expect(table.lookup("User").map((def) => def.relPath)).toEqual(["app/models/user.rb"]);
  });

  it("holds a file the tree adds and drops one the tree deletes, definitions included", () => {
    const tree = freshWorkTree();
    writeFile("app/models/invoice.rb", "class Invoice\nend\n");

    const table = buildReviewSymbolTable(indexed, {
      workTree: tree,
      touchedFiles: new Set(["app/models/invoice.rb", "app/models/legacy.rb"]),
      treeExtractions: [],
    });

    expect(table.hasFile("app/models/invoice.rb")).toBe(true);
    expect(table.hasFile("app/models/legacy.rb")).toBe(false);
    expect(table.lookup("Legacy")).toEqual([]);
  });

  it("does not make a touched non-code file a member — the index's file set is code only", () => {
    const tree = freshWorkTree();
    writeFile("config/settings.yml", "a: 1\n");

    const table = buildReviewSymbolTable(indexed, {
      workTree: tree,
      touchedFiles: new Set(["config/settings.yml"]),
      treeExtractions: [],
    });

    expect(table.hasFile("config/settings.yml")).toBe(false);
  });

  it("replaces a reviewed file's indexed definitions with the tree's", () => {
    const tree = freshWorkTree();
    writeFile("app/models/account.rb", "class Ledger\nend\n");
    writeFile("app/models/invoice.rb", "class Invoice\nend\n");

    const table = buildReviewSymbolTable(indexed, {
      workTree: tree,
      touchedFiles: new Set(["app/models/account.rb", "app/models/invoice.rb"]),
      treeExtractions: [
        extractionOf("app/models/account.rb", ["Ledger"]),
        extractionOf("app/models/invoice.rb", ["Invoice"]),
      ],
    });

    expect(table.lookup("Account")).toEqual([]);
    expect(table.lookup("Ledger").map((def) => def.relPath)).toEqual(["app/models/account.rb"]);
    expect(table.lookup("Invoice").map((def) => def.relPath)).toEqual(["app/models/invoice.rb"]);
  });
});

describe("IndexedSymbolRowsCache", () => {
  function countingGraph(files: string[] = ["app/models/user.rb"]) {
    return {
      listAllSymbols: vi.fn(async () => [definition("app/models/user.rb", "User")]),
      listFileContentHashes: vi.fn(async () => files.map((relPath) => ({ relPath, contentHash: null }))),
    };
  }

  it("serves a second review of an unchanged database without reading it again", async () => {
    const cache = new IndexedSymbolRowsCache();
    const graph = countingGraph();

    const first = await cache.read("code_a", () => "gen-1", graph);
    const second = await cache.read("code_a", () => "gen-1", graph);

    expect(second).toBe(first);
    expect(graph.listAllSymbols).toHaveBeenCalledTimes(1);
  });

  it("reads again once a write moved the stamp — an index run or a recompute alike", async () => {
    const cache = new IndexedSymbolRowsCache();
    const graph = countingGraph();
    let stamp = "gen-1";

    await cache.read("code_a", () => stamp, graph);
    stamp = "gen-2";
    await cache.read("code_a", () => stamp, graph);

    expect(graph.listAllSymbols).toHaveBeenCalledTimes(2);
  });

  it("takes the stamp BEFORE the read, so a write racing the read is re-read next time", async () => {
    const cache = new IndexedSymbolRowsCache();
    let stamp = "gen-1";
    const graph = countingGraph();
    graph.listAllSymbols.mockImplementationOnce(async () => {
      stamp = "gen-2"; // a write committed while the rows were in flight
      return [definition("app/models/user.rb", "User")];
    });

    await cache.read("code_a", () => stamp, graph);
    await cache.read("code_a", () => stamp, graph);

    expect(graph.listAllSymbols).toHaveBeenCalledTimes(2);
  });

  it("holds one entry per collection: another collection's read never evicts it", async () => {
    const cache = new IndexedSymbolRowsCache();
    const a = countingGraph();
    const b = countingGraph();

    await cache.read("code_a", () => "gen-1", a);
    await cache.read("code_b", () => "gen-1", b);
    await cache.read("code_a", () => "gen-1", a);

    expect(a.listAllSymbols).toHaveBeenCalledTimes(1);
    expect(b.listAllSymbols).toHaveBeenCalledTimes(1);
  });

  it("never caches an unavailable read, nor reads cached without a stamp", async () => {
    const cache = new IndexedSymbolRowsCache();
    const empty = countingGraph([]);
    const unstamped = countingGraph();

    await cache.read("code_a", () => "gen-1", empty);
    await cache.read("code_a", () => "gen-1", empty);
    await cache.read("code_b", () => undefined, unstamped);
    await cache.read("code_b", () => undefined, unstamped);

    expect(empty.listAllSymbols).toHaveBeenCalledTimes(2);
    expect(unstamped.listAllSymbols).toHaveBeenCalledTimes(2);
  });

  it("answers unavailable for a collection with no codegraph database", async () => {
    const cache = new IndexedSymbolRowsCache();

    expect(await cache.read("code_a", () => "gen-1", undefined)).toEqual({
      unavailable: expect.stringContaining("no codegraph database"),
    });
  });
});
