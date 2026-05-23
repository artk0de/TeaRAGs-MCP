/**
 * Rust extraction walker.
 *
 * Rust imports use `use` declarations:
 *   use foo::bar;
 *   use foo::bar::Baz;
 *   use crate::foo::bar;
 *   use super::foo;
 *   use foo::{bar, baz};      // grouped
 *
 * Tree-sitter-rust emits these as `use_declaration` with a `path`
 * child that is either an `identifier`, `scoped_identifier`,
 * `scoped_use_list`, or `use_list`. We capture the full dotted form;
 * the resolver handles `crate::` / `super::` / `self::` prefixes.
 *
 * Calls are `call_expression`. Top-level symbols: `function_item`,
 * `impl_item` (with type_identifier name), `struct_item`,
 * `enum_item`, `trait_item`, `mod_item`.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface RustExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromRustFile(input: RustExtractInput): FileExtraction {
  const imports = collectRustImports(input.tree.rootNode);
  const calls = collectRustCalls(input.tree.rootNode);
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

function collectRustImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "use_declaration") return;
    // Strip `use`, trailing `;`, trim. Group lists (`use foo::{a, b}`)
    // are preserved verbatim — resolver expands as needed.
    const text = node.text
      .replace(/^use\s+/, "")
      .replace(/;$/, "")
      .trim();
    if (text.length === 0) return;
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectRustCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    // bd tea-rags-mcp-jyzb — macro_invocation (`println!()`, `my_macro!()`)
    // is a separate node type in tree-sitter-rust, not a `call_expression`.
    // The macro name lives on the `macro` field (an `identifier` or
    // `scoped_identifier`). We treat the macro name as the call member
    // with no receiver — usually unresolvable (std-lib macros), but
    // user-defined `macro_rules!` symbols emit a definition (see
    // provider.ts `rustNameOf`) so the resolver can link them.
    if (node.type === "macro_invocation") {
      const macroField = node.childForFieldName("macro");
      if (!macroField) return;
      const startLine = node.startPosition.row + 1;
      if (macroField.type === "scoped_identifier") {
        const path = macroField.childForFieldName("path");
        const name = macroField.childForFieldName("name");
        if (!name) return;
        out.push({ callText: node.text, receiver: path?.text ?? null, member: name.text, startLine });
        return;
      }
      // Plain `identifier` — bare macro name.
      out.push({ callText: node.text, receiver: null, member: macroField.text, startLine });
      return;
    }
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn) return;
    const startLine = node.startPosition.row + 1;
    if (fn.type === "field_expression") {
      const value = fn.childForFieldName("value");
      const field = fn.childForFieldName("field");
      if (!value || !field) return;
      out.push({ callText: node.text, receiver: value.text, member: field.text, startLine });
    } else if (fn.type === "scoped_identifier") {
      // foo::bar::baz() — receiver = foo::bar, member = baz.
      const path = fn.childForFieldName("path");
      const name = fn.childForFieldName("name");
      if (!name) return;
      const receiver = path?.text ?? null;
      out.push({ callText: node.text, receiver, member: name.text, startLine });
    } else if (fn.type === "identifier") {
      out.push({ callText: node.text, receiver: null, member: fn.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
