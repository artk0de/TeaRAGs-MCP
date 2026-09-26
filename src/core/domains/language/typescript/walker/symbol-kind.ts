/**
 * ECMAScript declaration kind (bd tea-rags-mcp-vi0wx) — maps a tree-sitter node
 * type the TypeScript or JavaScript `nameOf` names onto `SymbolDefinitionKind`:
 *
 *   | node                                               | kind       |
 *   | -------------------------------------------------- | ---------- |
 *   | `class` / `abstract class` declaration, class expr | class      |
 *   | `interface`                                        | interface  |
 *   | `enum`                                             | enum       |
 *   | `type T = …`                                       | type_alias |
 *   | function declaration                               | function   |
 *   | class method, function-valued class field          | method     |
 *   | declarator bound to a function or a call (`memo`)  | function   |
 *   | declarator bound to an object namespace            | module     |
 *   | any other declarator at module level               | constant   |
 *   | CommonJS assignment / getter onto a member target  | method     |
 *   | CommonJS assignment onto `exports.f` / module name | function   |
 *
 * A declarator's kind is decided by what it is bound to, which the node type
 * alone does not carry — the caller passes the value's node type (seen through
 * `as` / `satisfies` / parentheses) and whether the emitted name is a member
 * target. Pure: no AST access here.
 */

import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";

export interface EcmascriptSymbolKindContext {
  /** The declaration sits at module level (directly or under `export`). */
  atTopLevel: boolean;
  /** `variable_declarator` only: node type of the bound value. */
  valueType?: string;
  /** `assignment_expression` / `call_expression` only: the emitted name addresses a member (`Foo#bar`, `obj.m`). */
  memberTarget?: boolean;
}

const KIND_BY_NODE_TYPE: ReadonlyMap<string, SymbolDefinitionKind> = new Map<string, SymbolDefinitionKind>([
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["class", "class"],
  ["interface_declaration", "interface"],
  ["enum_declaration", "enum"],
  ["type_alias_declaration", "type_alias"],
  ["function_declaration", "function"],
  ["generator_function_declaration", "function"],
  ["method_definition", "method"],
  ["public_field_definition", "method"],
]);

const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
  "call_expression",
]);

/** Node types {@link symbolKindOf} can answer for — the only ones worth naming. */
export const SYMBOL_KIND_NODE_TYPES: ReadonlySet<string> = new Set([
  ...KIND_BY_NODE_TYPE.keys(),
  "variable_declarator",
  "assignment_expression",
  "call_expression",
]);

export function symbolKindOf(nodeType: string, context: EcmascriptSymbolKindContext): SymbolDefinitionKind | undefined {
  const direct = KIND_BY_NODE_TYPE.get(nodeType);
  if (direct !== undefined) return direct;
  switch (nodeType) {
    case "variable_declarator":
      if (context.valueType !== undefined && FUNCTION_VALUE_TYPES.has(context.valueType)) return "function";
      if (context.valueType === "object") return "module";
      return context.atTopLevel ? "constant" : undefined;
    case "assignment_expression":
    case "call_expression":
      return context.memberTarget === true ? "method" : "function";
    default:
      return undefined;
  }
}
