/**
 * Go extraction walker.
 *
 * Go imports come in two shapes:
 *   import "foo/bar"
 *   import ( "a"; "b/c" )    // grouped
 *
 * Tree-sitter-go represents both as `import_declaration` nodes;
 * single-line uses `import_spec` directly, grouped uses
 * `import_spec_list` containing multiple `import_spec` children.
 *
 * Calls are `call_expression`. Receivers come from `selector_expression`
 * (`pkg.Func()` → receiver "pkg", member "Func"). Top-level symbols
 * are `function_declaration` and `method_declaration`. Go doesn't
 * have nested classes/methods so `descendsInto` stays false at the
 * top level.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface GoExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromGoFile(input: GoExtractInput): FileExtraction {
  const imports = collectGoImports(input.tree.rootNode);
  const calls = collectGoCalls(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    startLine: c.startLine,
    endLine: c.endLine,
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

function collectGoImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_spec") return;
    // import_spec has fields name (optional alias) and path (interpreted_string_literal).
    const path = node.childForFieldName("path");
    if (!path) return;
    const literal = path.text.replace(/^["`]|["`]$/g, "");
    out.push({ importText: literal, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectGoCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn) return;
    const startLine = node.startPosition.row + 1;
    if (fn.type === "selector_expression") {
      const operand = fn.childForFieldName("operand");
      const field = fn.childForFieldName("field");
      if (!operand || !field) return;
      out.push({ callText: node.text, receiver: operand.text, member: field.text, startLine });
    } else {
      out.push({ callText: node.text, receiver: null, member: fn.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
