/**
 * Rails / ActiveRecord `enum` structured macro expander.
 *
 * Synthesises the accessor pair (`status`/`status=`) and per-value predicate
 * + bang methods (`active?` / `active!`) from an `enum` call node.
 *
 * Supports all three Rails enum syntaxes:
 *   Rails 7 positional: `enum :status, { active: 0 }`
 *   Rails 6 kwarg-hash: `enum status: { active: 0 }`
 *   Rails 6 kwarg-array: `enum status: [:active]`
 *
 * Class-level scopes (`Model.active`) are intentionally omitted — they are
 * conditional on `scopes: false` and synthesising them risks fabricating edge
 * targets the model may not define.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  literalNameFromArg,
  stripSymbolColon,
  type DeclaredMethod,
  type DslCategory,
  type MethodKind,
  type StructuredMacroExpander,
} from "./types.js";

/** Value names of an enum's values container — `hash` keys or `array` symbols. */
function enumValueNames(node: AstNode): string[] {
  const out: string[] = [];
  if (node.type === "hash") {
    for (const pair of node.namedChildren) {
      if (pair.type !== "pair") continue;
      const key = pair.childForFieldName("key") ?? pair.namedChildren[0];
      const name = key ? enumKeyName(key) : null;
      if (name) out.push(name);
    }
  } else if (node.type === "array") {
    for (const el of node.namedChildren) {
      const name = enumKeyName(el);
      if (name) out.push(name);
    }
  }
  return out;
}

/** A single enum key/value name from a `hash_key_symbol` / `simple_symbol` / string node. */
function enumKeyName(node: AstNode): string | null {
  if (node.type === "hash_key_symbol") {
    const text = node.text.replace(/:$/, "");
    return text.length > 0 ? text : null;
  }
  return literalNameFromArg(node);
}

export const enumExpander: StructuredMacroExpander = {
  macroName: "enum",

  expand(node: AstNode, startLine: number, endLine: number): DeclaredMethod[] {
    const mk = (name: string, kind: MethodKind, category: DslCategory): DeclaredMethod => ({
      name,
      kind,
      category,
      startLine,
      endLine,
    });
    const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
    if (!args) return [];
    const first = args.namedChildren[0];
    let enumName: string | null = null;
    let valuesNode: AstNode | null = null;
    if (first?.type === "simple_symbol") {
      enumName = stripSymbolColon(first.text);
      valuesNode = args.namedChildren[1] ?? null;
    } else if (first?.type === "pair") {
      const key = first.childForFieldName("key") ?? first.namedChildren[0];
      enumName = key ? enumKeyName(key) : null;
      valuesNode = first.childForFieldName("value") ?? first.namedChildren[1] ?? null;
    }
    const values = valuesNode ? enumValueNames(valuesNode) : [];
    if (!enumName || values.length === 0) return [];
    const out: DeclaredMethod[] = [mk(enumName, "instance", "enum"), mk(`${enumName}=`, "instance", "enum")];
    for (const value of values) {
      out.push(mk(`${value}?`, "instance", "enum"), mk(`${value}!`, "instance", "enum"));
    }
    return out;
  },
};
