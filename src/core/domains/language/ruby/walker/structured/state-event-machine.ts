/**
 * Shared block-walk synthesis for `state`/`event`-block state-machine macros.
 *
 * AASM (`aasm do … end`) and state_machines (`state_machine :attr do … end`)
 * share the IDENTICAL inner grammar — a predicate (`sleeping?`) per `state`
 * declaration and an event method + bang (`run` / `run!`) per `event`
 * declaration — differing only in the OUTER macro name (and state_machines'
 * leading attribute symbol, which is not walked). The block-walk therefore lives
 * here ONCE (no-duplication rule); each expander module is a thin
 * `StructuredMacroExpander` binding this function under its own `macroName`.
 *
 * Class-level scopes (`Model.sleeping`) are intentionally omitted — they are
 * conditional (aasm `create_scopes`, state_machines integrations) and the
 * predicate/event methods are the always-defined surface.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { stripSymbolColon, type DeclaredMethod, type DslCategory, type MethodKind } from "./types.js";

/**
 * Walk a state-machine macro's `do`/brace block and synthesise the predicate
 * (per `state`) and method+bang (per `event`) it declares. Gated by the caller
 * on the outer macro name, so stray inner `state`/`event` calls elsewhere in the
 * class body are never expanded.
 */
export function expandStateEventBlock(node: AstNode, startLine: number, endLine: number): DeclaredMethod[] {
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
}
