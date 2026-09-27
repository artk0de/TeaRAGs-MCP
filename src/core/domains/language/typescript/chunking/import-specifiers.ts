/**
 * `readEcmascriptImportSpecifiers` — the module specifiers an ECMAScript file
 * references, read off the chunk parse for `payload.imports`
 * (bd tea-rags-mcp-s9b0d). The TypeScript and JavaScript grammars emit the same
 * node shapes for all five forms, so one reader serves both facades:
 *
 *   - `import … from "./y"` / `import type … from "./y"` — `import_statement`
 *   - `import "./y"` (side effect)                       — `import_statement`
 *   - `export … from "./y"`                               — `export_statement` with a `source`
 *   - `require("./y")`                                    — `call_expression`, identifier callee
 *   - `import("./y")`                                     — `call_expression`, `import` callee
 *
 * This is the static payload's dependency list, not the codegraph's runtime
 * one: a statement-level `import type` still declares coupling and counts
 * here, as it did under the regex harvest this replaces. A non-literal
 * specifier (`import(name)`, a template) names no knowable module.
 *
 * Comments and string literals are nodes of their own, so import-shaped text
 * inside them is never visited as a statement (bd tea-rags-mcp-mjq5n).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";

export function readEcmascriptImportSpecifiers(root: AstNode): string[] {
  const specifiers: string[] = [];
  // Explicit pre-order stack: source order without recursion depth limits on a
  // deeply nested file.
  const pending: AstNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as AstNode;
    const specifier = moduleSpecifierOf(node);
    if (specifier !== undefined) specifiers.push(specifier);
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
  return specifiers;
}

function moduleSpecifierOf(node: AstNode): string | undefined {
  switch (node.type) {
    case "import_statement":
      return literalText(node.children.find((child) => child.type === "string"));
    case "export_statement":
      return literalText(node.childForFieldName("source") ?? undefined);
    case "call_expression": {
      const callee = node.childForFieldName("function");
      const loadsModule = callee?.type === "import" || (callee?.type === "identifier" && callee.text === "require");
      if (!loadsModule) return undefined;
      return literalText(node.childForFieldName("arguments")?.namedChildren[0]);
    }
    default:
      return undefined;
  }
}

/** Contents of a `string` literal node, quotes dropped; undefined for anything else. */
function literalText(node: AstNode | undefined): string | undefined {
  return node?.type === "string" ? node.text.slice(1, -1) : undefined;
}
