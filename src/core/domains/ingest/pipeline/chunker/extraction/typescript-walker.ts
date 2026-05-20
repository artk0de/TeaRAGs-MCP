/**
 * TypeScript extraction walker.
 *
 * Slice-1 design note: this walker is invoked **outside the chunker hook
 * chain** (which is per-container — see `.claude/rules/chunker-hooks.md`)
 * and outside the worker thread (`TreeSitterChunker` runs in a worker via
 * `ChunkerPool`; `ExtractionSink` lives in the main process at the
 * codegraph enrichment provider).
 *
 * Slice 1 wires the walker into the main-thread post-chunking pass
 * (T10 integration). The walker reuses the chunker's intent to walk the
 * AST exactly once per file, but it parses on its own to avoid the
 * non-serialisable function across the worker boundary. Slice 2 may
 * fold extraction into the worker response to eliminate the second
 * parse — at that point both sides return both artifacts and the
 * walker becomes the canonical extraction shape.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface ExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  /** Caller-provided chunk-range index, sorted by startLine ascending. */
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromTypescriptFile(input: ExtractInput): FileExtraction {
  const imports = collectImports(input.tree.rootNode);
  const calls = collectCalls(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
  }));
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
}

function collectImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_statement") return;
    const src = node.children.find((c) => c.type === "string");
    if (!src) return;
    const text = src.text.replace(/^["']|["']$/g, "");
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call_expression") return;
    const callee = node.childForFieldName("function");
    if (!callee) return;
    const startLine = node.startPosition.row + 1;
    if (callee.type === "member_expression") {
      const obj = callee.childForFieldName("object");
      const prop = callee.childForFieldName("property");
      if (!obj || !prop) return;
      out.push({ callText: node.text, receiver: obj.text, member: prop.text, startLine });
    } else {
      out.push({ callText: node.text, receiver: null, member: callee.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
