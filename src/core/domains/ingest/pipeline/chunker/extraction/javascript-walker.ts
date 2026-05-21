/**
 * JavaScript extraction walker.
 *
 * tree-sitter-javascript shares its core node types with
 * tree-sitter-typescript for the constructs codegraph cares about
 * (import_statement, call_expression, function_declaration,
 * method_definition, class_declaration). The walker is therefore a
 * thin re-export of `extractFromTypescriptFile` — kept as its own
 * file so the LANGUAGES dispatch table reads cleanly and so future
 * JS-specific quirks (CommonJS require, dynamic imports) have a
 * dedicated home to land without polluting the TS walker.
 *
 * CommonJS support: `require('./foo')` parses as a `call_expression`
 * with function = identifier "require" and a string argument. We
 * extend the import collection here to capture those alongside ES
 * module `import` statements. ES module `import()` (dynamic import)
 * appears as `call_expression` with function = `import` keyword —
 * also handled below.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface JsExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromJavascriptFile(input: JsExtractInput): FileExtraction {
  const imports = collectJsImports(input.tree.rootNode);
  const calls = collectJsCalls(input.tree.rootNode);
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

function collectJsImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type === "import_statement") {
      const src = node.children.find((c) => c.type === "string");
      if (!src) return;
      const text = src.text.replace(/^["']|["']$/g, "");
      out.push({ importText: text, startLine: node.startPosition.row + 1 });
      return;
    }
    // CommonJS `require('./foo')` + dynamic `import('./foo')`. Both are
    // call_expression nodes with a string argument. The function child
    // distinguishes them — `require` (identifier) or `import` (keyword).
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (!fn) return;
      const fnName = fn.type === "identifier" || fn.type === "import" ? fn.text : null;
      if (fnName !== "require" && fnName !== "import") return;
      const args = node.childForFieldName("arguments");
      if (!args) return;
      const stringArg = args.namedChildren.find((c) => c.type === "string");
      if (!stringArg) return;
      const text = stringArg.text.replace(/^["']|["']$/g, "");
      out.push({ importText: text, startLine: node.startPosition.row + 1 });
    }
  });
  return out;
}

function collectJsCalls(root: Parser.SyntaxNode): CallRef[] {
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
    } else if (callee.type === "identifier") {
      // Skip require/import — these are tracked as imports, not calls.
      if (callee.text === "require" || callee.text === "import") return;
      out.push({ callText: node.text, receiver: null, member: callee.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
