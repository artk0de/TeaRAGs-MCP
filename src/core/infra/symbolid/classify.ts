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
  // Ruby — three shapes for class-level methods:
  //   1. `def self.foo` — parsed as `singleton_method` directly.
  //   2. `class << self` block with `def foo` inside — the `def` is a
  //      regular `method` node, but its enclosing scope is a
  //      `singleton_class`, which makes the method class-level.
  //   3. Otherwise `def foo` is an instance method.
  if (node.type === "singleton_method") return "static";
  if (node.type === "method") return rubyInsideSingletonClass(node) ? "static" : "instance";
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

/**
 * Walk up the AST to find a `singleton_class` ancestor. Ruby's
 * `class << self ... def foo ... end ... end` syntax wraps regular
 * `method` nodes inside a `singleton_class` body — those `def`s are
 * class-level methods even though their AST type is `method` and not
 * `singleton_method`. Walking up stops at the first `class` / `module`
 * ancestor (those reset the singleton-class scope) so a nested regular
 * method declaration inside an inner class doesn't get mis-classified.
 */
export function rubyInsideSingletonClass(node: Parser.SyntaxNode): boolean {
  let p: Parser.SyntaxNode | null = node.parent;
  while (p) {
    if (p.type === "singleton_class") return true;
    if (p.type === "class" || p.type === "module") return false;
    p = p.parent;
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
