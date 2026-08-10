/**
 * Name resolution for JavaScript container nodes the engine's default
 * extraction cannot name.
 *
 * `export_statement` is a JavaScript `chunkableType`, so `findChunkableNodes`
 * claims the export INSTEAD of the `class_declaration` it wraps. The engine's
 * default `extractName` then looks for a `name` field on the export — which
 * tree-sitter puts on the wrapped DECLARATION, not on the `export_statement` —
 * and falls through to its "first identifier child" heuristic, which an
 * `export_statement` has none of. The container comes back unnamed, so a method
 * extracted out of it is scoped at file level (`register`) rather than under
 * its class (`Registry#register`), and the id matches no `cg_symbols` row.
 *
 * TypeScript never needs this: it keeps `export_statement` out of
 * `chunkableTypes`, so the walk descends to the class declaration itself.
 *
 * bd tea-rags-mcp-ll0u9.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";

/**
 * Declaration node types an `export_statement` can wrap and that carry a `name`
 * field worth scoping children under. `lexical_declaration` /
 * `variable_declaration` are deliberately absent — their name lives on a nested
 * `variable_declarator`, and those shapes are claimed by the classifier
 * (`jsChunkSymbols`), which composes their symbolIds itself.
 */
const NAMED_EXPORTABLE_DECLARATIONS = new Set(["class_declaration", "function_declaration"]);

/**
 * Resolves the name of an `export_statement` to the name of the declaration it
 * exports. Returns `undefined` for every other node type so the engine's
 * default extraction stays in charge — this extractor is consulted FIRST for
 * ALL nodes, so anything it names it takes over.
 */
export function jsExportNameExtractor(node: AstNode, code: string): string | undefined {
  if (node.type !== "export_statement") return undefined;

  const declaration = node.namedChildren.find((child) => NAMED_EXPORTABLE_DECLARATIONS.has(child.type));
  if (!declaration) return undefined;

  const nameNode = declaration.childForFieldName("name");
  if (!nameNode) return undefined;

  return code.substring(nameNode.startIndex, nameNode.endIndex);
}
