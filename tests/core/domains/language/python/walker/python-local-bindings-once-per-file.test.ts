/**
 * `localBindings` is collected ONCE per file and sliced per chunk
 * (bd tea-rags-mcp-1v12o.2.4, E6.1 FIX A).
 *
 * The per-chunk collector walked the WHOLE file tree for EVERY chunk, so a file
 * of C chunks paid C full traversals: netbox's `dcim/tests/test_filtersets.py`
 * (7.7k lines, 620 chunks) spent 14.1 s in that one function, and
 * `dcim/views.py` (5k lines, 475 chunks) 0.87 s. Both halves below are the gate:
 * the OUTPUT must stay byte-identical chunk by chunk, and the COST of adding
 * chunks must stop being a multiple of the file's node count.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const METHOD_COUNT = 8;

type ChunkPlan = { symbolId: string; startLine: number; endLine: number; scope: string[] };

/** A class whose every method contributes both binding families, one chunk per method. */
function fixtureSource(): string {
  const lines = ["class Service:"];
  for (let i = 0; i < METHOD_COUNT; i++) {
    lines.push(`    def handle_${i}(self, request: HttpRequest, flag: Toggle = None):`);
    lines.push(`        repo_${i} = AccountRepository()`);
    lines.push(`        note_${i}: Note = build()`);
    lines.push(`        return repo_${i}`);
    lines.push("");
  }
  return lines.join("\n");
}

function materialize(src: string): { rootNode: AstNode } {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return { rootNode: materializeTree(parser.parse(src).rootNode, src) };
}

function countNodes(node: AstNode): number {
  let n = 1;
  for (const child of node.children) n += countNodes(child);
  return n;
}

/** Replace every node's `startPosition` with a counting getter over the same value. */
function instrumentStartPositionReads(root: AstNode): () => number {
  let reads = 0;
  const visit = (node: AstNode): void => {
    const value = node.startPosition;
    Object.defineProperty(node, "startPosition", {
      configurable: true,
      get(): { row: number; column: number } {
        reads++;
        return value;
      },
    });
    for (const child of node.children) visit(child);
  };
  visit(root);
  return () => reads;
}

/** The class chunk alone, then the class chunk plus one chunk per method. */
function chunkPlans(src: string): { one: ChunkPlan[]; many: ChunkPlan[] } {
  const total = src.split("\n").length;
  const one: ChunkPlan[] = [{ symbolId: "Service", startLine: 1, endLine: total, scope: [] }];
  const many: ChunkPlan[] = [...one];
  for (let i = 0; i < METHOD_COUNT; i++) {
    const start = 2 + i * 5;
    many.push({ symbolId: `Service.handle_${i}`, startLine: start, endLine: start + 3, scope: ["Service"] });
  }
  return { one, many };
}

function extract(src: string, chunks: ChunkPlan[], tree: { rootNode: AstNode }) {
  return extractFromPythonFile({ tree, code: src, relPath: "app/service.py", language: "python", chunks });
}

describe("extractFromPythonFile — local bindings cost one file walk, not one per chunk", () => {
  const src = fixtureSource();
  const { one, many } = chunkPlans(src);

  it("keeps each chunk's localBindings exactly what the per-chunk walk produced", () => {
    const out = extract(src, many, materialize(src));
    // The class chunk sees every binding in the file, in document order.
    const classChunk = out.chunks[0].localBindings;
    expect(Object.keys(classChunk ?? {})).toEqual([
      "request",
      "flag",
      "repo_0",
      "note_0",
      ...Array.from({ length: METHOD_COUNT - 1 }, (_, i) => [`repo_${i + 1}`, `note_${i + 1}`]).flat(),
    ]);
    expect(classChunk?.request).toHaveLength(METHOD_COUNT);
    expect(classChunk?.request?.[0]).toEqual({ line: 2, type: "HttpRequest" });
    expect(classChunk?.repo_0).toEqual([{ line: 3, type: "AccountRepository", endLine: 3 }]);
    expect(classChunk?.note_0).toEqual([{ line: 4, type: "Note", endLine: 4 }]);
    // A method chunk sees only what its own range establishes.
    const method3 = out.chunks[4].localBindings;
    expect(Object.keys(method3 ?? {})).toEqual(["request", "flag", "repo_3", "note_3"]);
    expect(method3?.request).toEqual([{ line: 17, type: "HttpRequest" }]);
    expect(method3?.repo_3).toEqual([{ line: 18, type: "AccountRepository", endLine: 18 }]);
  });

  it("does not re-read the tree once per chunk", () => {
    const nodes = countNodes(materialize(src).rootNode);

    const treeOne = materialize(src);
    const readsOne = instrumentStartPositionReads(treeOne.rootNode);
    extract(src, one, treeOne);

    const treeMany = materialize(src);
    const readsMany = instrumentStartPositionReads(treeMany.rootNode);
    extract(src, many, treeMany);

    // Eight extra chunks must not cost eight extra traversals of the file.
    expect(readsMany() - readsOne()).toBeLessThan(nodes);
  });
});
