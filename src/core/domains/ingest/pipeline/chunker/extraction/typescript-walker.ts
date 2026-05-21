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
  const classFieldTypes = collectClassFieldTypes(input.tree.rootNode);
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
    classFieldTypes,
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

/**
 * Collect class field declarations with type annotations: `className → fieldName → typeName`.
 * Covers two TS patterns:
 *   1. Constructor parameter properties — `constructor(private readonly foo: Bar)`
 *      The `required_parameter` has both an `accessibility_modifier` (or
 *      `readonly`) and a `type_annotation`. The presence of either marks
 *      this as a field; without one it's just a plain parameter.
 *   2. Class field declarations — `public_field_definition` with a `type_annotation`.
 *
 * Returns an empty Map when no class declarations are found.
 */
function collectClassFieldTypes(root: Parser.SyntaxNode): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const result = new Map<string, Map<string, string>>();
  walk(root, (node) => {
    if (node.type !== "class_declaration") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nameNode.text;
    const body = node.childForFieldName("body");
    if (!body) return;
    const fields = new Map<string, string>();

    for (const member of body.children) {
      // Pattern 2: public/private/protected/readonly field declaration
      if (member.type === "public_field_definition") {
        const fieldName = member.childForFieldName("name")?.text;
        const typeName = extractTypeNameFromAnnotation(member.children.find((c) => c.type === "type_annotation"));
        if (fieldName && typeName) fields.set(fieldName, typeName);
        continue;
      }
      // Pattern 1: constructor parameter properties
      if (member.type === "method_definition") {
        const methodName = member.childForFieldName("name")?.text;
        if (methodName !== "constructor") continue;
        const params = member.childForFieldName("parameters");
        if (!params) continue;
        for (const param of params.children) {
          if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
          // Must have an accessibility modifier OR readonly to count as a field
          const hasAccess = param.children.some(
            (c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.text === "readonly",
          );
          if (!hasAccess) continue;
          const pattern = param.childForFieldName("pattern");
          const fieldName = pattern?.text;
          const typeName = extractTypeNameFromAnnotation(param.children.find((c) => c.type === "type_annotation"));
          if (fieldName && typeName) fields.set(fieldName, typeName);
        }
      }
    }

    if (fields.size > 0) result.set(className, fields);
  });
  return result;
}

/**
 * Extract the bare type name from a `type_annotation` node. Strips generics
 * (`Foo<T>` → `Foo`) and qualified names (`Namespace.Foo` → keeps `Namespace.Foo`).
 * Returns null for union types, function types, or anything we can't pin
 * to a single class name.
 */
function extractTypeNameFromAnnotation(annotation: Parser.SyntaxNode | undefined): string | null {
  if (!annotation) return null;
  // type_annotation has form `: <type>` — first non-`:` child is the type
  const typeNode = annotation.children.find((c) => c.type !== ":");
  if (!typeNode) return null;
  // type_identifier — simple `Foo`
  if (typeNode.type === "type_identifier") return typeNode.text;
  // generic_type — `Foo<T>`: take the base type name
  if (typeNode.type === "generic_type") {
    const base = typeNode.children.find((c) => c.type === "type_identifier" || c.type === "nested_type_identifier");
    if (base) return base.text;
  }
  // nested_type_identifier — `Namespace.Foo`
  if (typeNode.type === "nested_type_identifier") return typeNode.text;
  return null;
}
