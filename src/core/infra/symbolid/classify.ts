/**
 * Single source of truth for the project's symbolId separator
 * convention: instance methods join their enclosing class with `#`,
 * class / static / abstract methods join with `.`. Per
 * `.claude/rules/symbolid-convention.md` the convention is universal
 * across languages — only the per-language AST-shape detection
 * differs.
 *
 * Two consumers use this module:
 *
 *   1. The chunker (`domains/ingest/pipeline/chunker/tree-sitter.ts`)
 *      writes the Qdrant payload `symbolId`.
 *   2. The codegraph provider
 *      (`domains/trajectory/codegraph/symbols/provider.ts`) writes
 *      `cg_symbols.symbol_id` rows in DuckDB.
 *
 * Both must agree on the same physical AST node — otherwise an
 * `EnrichmentMarkerStore#read` from a search hit doesn't match the
 * `EnrichmentMarkerStore.read` row in cg_symbols and
 * `get_callers`/`get_callees` silently return empty. Centralising the
 * detection logic here is the only way to keep them in lockstep as
 * grammars evolve and new languages are added.
 */

import type Parser from "tree-sitter";

/** Universal separator between a class and its instance method. */
export const INSTANCE_METHOD_SEPARATOR = "#";

/**
 * Method classification — drives the separator choice. Only declared
 * for AST node types that ARE methods; everything else returns null
 * and the caller falls back to the language's scope separator.
 */
export type MethodClassification = "instance" | "static";

/**
 * Classify an AST node as `instance` or `static` method. Returns null
 * when the node is not a recognized method declaration shape (e.g.
 * `class_declaration`, `function_declaration` top-level). The caller
 * should use the language scope separator for non-method joins.
 */
export function classifyMethod(node: Parser.SyntaxNode): MethodClassification | null {
  // TypeScript / JavaScript — explicit `static` keyword child.
  if (node.type === "method_definition") return hasChildOfTypeOrText(node, "static") ? "static" : "instance";
  // Java — `static` modifier nested under a `modifiers` child.
  if (node.type === "method_declaration") return javaHasStaticModifier(node) ? "static" : "instance";
  // Java constructor — instance-bound (initializes an instance).
  if (node.type === "constructor_declaration") return "instance";
  // Ruby — `def self.foo` is parsed as `singleton_method` (a class
  // method), `def foo` as `method` (an instance method).
  if (node.type === "singleton_method") return "static";
  if (node.type === "method") return "instance";
  // Python — `function_definition` decorated with `@classmethod` or
  // `@staticmethod` is class-level, otherwise instance. Module-level
  // functions also pass through here but the caller filters those
  // out by checking the parent kind before joining.
  if (node.type === "function_definition") return pythonHasClassOrStaticDecorator(node) ? "static" : "instance";
  // Rust — `function_item` declared inside `impl T { ... }`. With a
  // `self` / `&self` / `&mut self` parameter, the fn is an instance
  // method; without, it's an associated function (treated as
  // class-level per the convention).
  if (node.type === "function_item") return rustHasSelfParam(node) ? "instance" : "static";
  // Go — `method_declaration` always has a receiver, always instance.
  if (node.type === "method_declaration_go") return "instance";
  return null;
}

/** Convenience for callers that only need a boolean — `true` for static. */
export function isStaticMethodNode(node: Parser.SyntaxNode): boolean {
  return classifyMethod(node) === "static";
}

function hasChildOfTypeOrText(node: Parser.SyntaxNode, keyword: string): boolean {
  for (const child of node.children) {
    if (child.type === keyword || child.text === keyword) return true;
  }
  return false;
}

function javaHasStaticModifier(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "modifiers") {
      for (const m of child.children) {
        if (m.type === "static" || m.text === "static") return true;
      }
    }
  }
  return false;
}

function pythonHasClassOrStaticDecorator(node: Parser.SyntaxNode): boolean {
  const { parent } = node;
  if (parent?.type !== "decorated_definition") return false;
  for (const child of parent.children) {
    if (child.type !== "decorator") continue;
    const { text } = child;
    if (text.includes("@classmethod") || text.includes("@staticmethod")) return true;
  }
  return false;
}

function rustHasSelfParam(node: Parser.SyntaxNode): boolean {
  const params = node.childForFieldName("parameters");
  if (!params) return false;
  for (const child of params.children) {
    if (child.type === "self_parameter") return true;
    if (child.type === "parameter") {
      const pattern = child.childForFieldName("pattern");
      if (pattern?.text === "self") return true;
    }
  }
  return false;
}
