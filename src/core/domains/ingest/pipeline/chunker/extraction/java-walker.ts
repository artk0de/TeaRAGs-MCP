/**
 * Java extraction walker.
 *
 * Java imports come as `import_declaration` nodes with a
 * scoped_identifier child whose dotted text gives the fully-qualified
 * type name:
 *   import com.foo.Bar;
 *   import com.foo.*;          // wildcard
 *   import static com.foo.Bar.method;
 *
 * Walker emits the full dotted name as importText (caller resolver
 * can strip wildcards). Calls are method_invocation; receivers come
 * from the `object` field. Top-level symbols are class_declaration,
 * interface_declaration, enum_declaration. method_declaration nests
 * under classes.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface JavaExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromJavaFile(input: JavaExtractInput): FileExtraction {
  const imports = collectJavaImports(input.tree.rootNode);
  const calls = collectJavaCalls(input.tree.rootNode);
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

function collectJavaImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_declaration") return;
    // The dotted path lives in scoped_identifier (and asterisk node for
    // wildcards). Use the node text minus `import`, `static`, `;`.
    const text = node.text
      .replace(/^import\s+(static\s+)?/, "")
      .replace(/;$/, "")
      .trim();
    if (text.length === 0) return;
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectJavaCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "method_invocation") return;
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name");
    if (!name) return;
    const startLine = node.startPosition.row + 1;
    if (object) {
      out.push({ callText: node.text, receiver: object.text, member: name.text, startLine });
    } else {
      out.push({ callText: node.text, receiver: null, member: name.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
