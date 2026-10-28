/**
 * The Ruby value-class builders — `Struct.new(…)` / `Data.define(…)` — and the
 * member names one declares. A constant bound to such a call is a class: the
 * walker's census counts its symbols as fields and its block's `def`s as
 * methods, and the chunker treats the call with its block as a container (bd
 * tea-rags-mcp-0td4h). One recogniser here, in this contracts-only leaf, so the
 * walker and the chunker cannot disagree about which calls build a class.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";

/** `Struct.new(…)` / `Data.define(…)` — the receiver constant and the method that builds a value class. */
const VALUE_CLASS_BUILDERS: ReadonlyMap<string, string> = new Map([
  ["Struct", "new"],
  ["Data", "define"],
]);

/**
 * The member names a `Struct.new(:a, :b)` / `Data.define(:a, :b)` call declares,
 * or null when `node` is no such call. A `Struct.new("Name", :a)` class-name
 * string and a `keyword_init: true` pair are not members.
 */
export function valueClassMemberNames(node: AstNode | null | undefined): string[] | null {
  if (node?.type !== "call") return null;
  const receiver = node.childForFieldName("receiver")?.text.replace(/^::/, "");
  const method = node.childForFieldName("method")?.text;
  if (receiver === undefined || method === undefined || VALUE_CLASS_BUILDERS.get(receiver) !== method) return null;
  return (node.childForFieldName("arguments")?.namedChildren ?? [])
    .filter((arg) => arg.type === "simple_symbol")
    .map((arg) => arg.text.slice(1));
}
