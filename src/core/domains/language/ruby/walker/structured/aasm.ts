/**
 * AASM gem state-machine structured macro expander.
 *
 * Synthesises a predicate (`sleeping?`) per `state` declaration and an event
 * method + bang (`run` / `run!`) per `event` declaration from an `aasm do…end`
 * block. Gated on the outer `aasm` macro name so stray inner `state`/`event`
 * calls elsewhere in the class body are never expanded.
 *
 * Class-level scopes (`Model.sleeping`) are intentionally omitted — they are
 * conditional on `create_scopes` and the predicate/event methods are always made.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  stripSymbolColon,
  type DeclaredMethod,
  type DslCategory,
  type MethodKind,
  type StructuredMacroExpander,
} from "./types.js";

export const aasmExpander: StructuredMacroExpander = {
  macroName: "aasm",

  expand(node: AstNode, startLine: number, endLine: number): DeclaredMethod[] {
    const mk = (name: string, kind: MethodKind, category: DslCategory): DeclaredMethod => ({
      name,
      kind,
      category,
      startLine,
      endLine,
    });
    const block =
      node.childForFieldName("block") ?? node.children.find((c) => c.type === "do_block" || c.type === "block");
    if (!block) return [];
    const body = block.childForFieldName("body") ?? block;
    const out: DeclaredMethod[] = [];
    for (const stmt of body.namedChildren) {
      if (stmt.type !== "call" && stmt.type !== "method_call") continue;
      const inner = stmt.childForFieldName("method") ?? stmt.children.find((c) => c.type === "identifier");
      const innerName = inner?.text;
      if (innerName !== "state" && innerName !== "event") continue;
      const innerArgs = stmt.childForFieldName("arguments") ?? stmt.children.find((c) => c.type === "argument_list");
      const firstSym = innerArgs?.namedChildren[0];
      if (firstSym?.type !== "simple_symbol") continue;
      const base = stripSymbolColon(firstSym.text);
      if (base.length === 0) continue;
      if (innerName === "state") {
        out.push(mk(`${base}?`, "instance", "state-machine"));
      } else {
        out.push(mk(base, "instance", "state-machine"), mk(`${base}!`, "instance", "state-machine"));
      }
    }
    return out;
  },
};
