/**
 * Shared types and pure helpers for structured class-body macro expanders.
 *
 * Lives in the walker layer (not in `dsl/`) because the `StructuredMacroExpander`
 * interface references `AstNode` — a tree-sitter construct forbidden in the
 * pure-data `dsl/` catalogue.
 *
 * Both `macro-expansion.ts` and the individual expander modules import from
 * here to avoid a circular dependency.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { DslCategory, MethodKind } from "../../dsl/index.js";

/** A synthetic method a class-body macro declares, with provenance category + span. */
export interface DeclaredMethod {
  name: string;
  kind: MethodKind;
  category: DslCategory;
  startLine: number;
  endLine: number;
}

/**
 * Declarative interface for a structured class-body macro expander.
 * Mirrors the `FRAMEWORKS` array pattern — one expander per structured macro.
 */
export interface StructuredMacroExpander {
  readonly macroName: string;
  expand: (node: AstNode, startLine: number, endLine: number) => DeclaredMethod[];
}

/** Re-exported for convenience so expanders need only one import source. */
export type { DslCategory, MethodKind };

export function stripSymbolColon(text: string): string {
  return text.startsWith(":") ? text.slice(1) : text;
}

export function literalNameFromArg(arg: AstNode): string | null {
  if (arg.type === "simple_symbol") return stripSymbolColon(arg.text);
  if (arg.type === "string" || arg.type === "string_literal") {
    const inner = arg.namedChildren.find((c) => c.type === "string_content");
    const text = inner ? inner.text : arg.text.replace(/^["']|["']$/g, "");
    return text.length > 0 ? text : null;
  }
  return null;
}
