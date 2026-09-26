/**
 * Python declaration kinds (bd tea-rags-mcp-vi0wx) — which `SymbolDefinitionKind`
 * each chunk the walker emits declares. The chunk set is `pyNameOf`'s: a
 * `class_definition` or a `function_definition`, so those are the only node
 * types mapped.
 *
 * A `def` is a `method` when it sits directly in a class body — decorated with
 * `@classmethod` / `@staticmethod` or not, since the decorator changes the
 * binding, not the kind — and a `function` everywhere else, including a def
 * nested in a method body. Module-level constants are NOT mapped: `pyNameOf`
 * emits no chunk for `MAX = 3`, and adding one would re-own every module-level
 * call site (`X = build()`) to that chunk and hand the resolver a new
 * short-name candidate, which is a call-resolution change, not a tag.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import { isPythonMethodDef } from "./passes/python-def-signatures.js";

/** The declaration kind a node type spells; `undefined` for a node that declares no symbol. */
export function symbolKindOf(nodeType: string, context: { inClassBody: boolean }): SymbolDefinitionKind | undefined {
  if (nodeType === "class_definition") return "class";
  if (nodeType === "function_definition") return context.inClassBody ? "method" : "function";
  return undefined;
}

/**
 * A flat-descent visitor filling `out` with every declaration's kind, keyed by
 * its 1-based start line. That key is the chunk's `startLine`: `collectSymbols`
 * ranges the node `pyNameOf` names — the `function_definition`, never its
 * `decorated_definition` wrapper — so the join matches `collectPythonDefSignatures`.
 */
export function collectPythonSymbolKinds(out: Map<number, SymbolDefinitionKind>): (node: AstNode) => void {
  return (node) => {
    const kind = symbolKindOf(node.type, {
      inClassBody: node.type === "function_definition" && isPythonMethodDef(node),
    });
    if (kind !== undefined) out.set(node.startPosition.row + 1, kind);
  };
}
