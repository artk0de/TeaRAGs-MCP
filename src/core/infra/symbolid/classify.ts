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

import type { AstNode } from "../../contracts/types/ast.js";

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
export function classifyMethod(node: AstNode): MethodClassification | null {
  // TypeScript / JavaScript — explicit `static` keyword child.
  if (node.type === "method_definition") {
    // bd tea-rags-mcp-2jhwk / 62hzr — a `method_definition` sitting directly in
    // an OBJECT LITERAL is a namespace member, not a class method: it is invoked
    // as `X.member()` on the object itself and there is no instance to bind.
    // Declining to classify it lets the caller compose the `Outer.Nested`
    // namespace form the convention reserves for exactly this case. See
    // `./const-object-namespace.ts` for who the enclosing namespace is.
    if (node.parent?.type === "object") return null;
    return hasChildOfTypeOrText(node, "static") ? "static" : "instance";
  }
  // TypeScript — a class FIELD bound to a function (`request = async () => {}`)
  // is a member with the same two kinds a method has, and two consumers must
  // agree on which: the codegraph walker composing `F#request` vs `F.request`
  // (via `./class-property-function.ts`), and the chunker's class-body grouper
  // bucketing the field as a static member vs a plain property
  // (bd tea-rags-mcp-5ldqu).
  //
  // Detection is deliberately STRICTER than the `method_definition` branch
  // above: only an UNNAMED `static` keyword counts, never a child whose text
  // happens to read "static". `class X { static = () => 1 }` declares a field
  // NAMED `static` — a single named `property_identifier` with no modifier —
  // and the text fallback would flip its separator.
  if (node.type === "public_field_definition") return hasStaticModifier(node) ? "static" : "instance";
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
  // Swift — `function_declaration` is the METHOD shape inside a type body.
  // The node type collides with the TypeScript / JavaScript TOP-LEVEL
  // function (which must keep returning null), so the branch is gated on
  // the Swift `func` keyword child the other grammars never emit — their
  // keyword node is `function`, Swift's is `func`.
  if (node.type === "function_declaration" && swiftHasFuncKeyword(node)) {
    return swiftHasClassLevelModifier(node) ? "static" : "instance";
  }
  // Swift — signature-only protocol requirement (`func draw()` inside a
  // protocol body). Same two kinds as a concrete method.
  if (node.type === "protocol_function_declaration") {
    return swiftHasClassLevelModifier(node) ? "static" : "instance";
  }
  // Swift initializer — instance-bound (constructs an instance), like the
  // Java constructor above. `init_declaration` never carries static/class.
  if (node.type === "init_declaration") return "instance";
  return null;
}

/** Convenience for callers that only need a boolean — `true` for static. */
export function isStaticMethodNode(node: AstNode): boolean {
  return classifyMethod(node) === "static";
}

function hasChildOfTypeOrText(node: AstNode, keyword: string): boolean {
  for (const child of node.children) {
    if (child.type === keyword || child.text === keyword) return true;
  }
  return false;
}

/**
 * The `static` MODIFIER, told apart from a member merely named `static`.
 *
 * A modifier is an unnamed keyword node; a member name is a named identifier.
 * Testing both is what keeps `class X { static = () => 1 }` an instance member.
 */
function hasStaticModifier(node: AstNode): boolean {
  for (const child of node.children) {
    if (!child.isNamed && child.type === "static") return true;
  }
  return false;
}

function javaHasStaticModifier(node: AstNode): boolean {
  for (const child of node.children) {
    if (child.type === "modifiers") {
      for (const m of child.children) {
        if (m.type === "static" || m.text === "static") return true;
      }
    }
  }
  return false;
}

function pythonHasClassOrStaticDecorator(node: AstNode): boolean {
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
export function rubyInsideSingletonClass(node: AstNode): boolean {
  let p: AstNode | null = node.parent;
  while (p) {
    if (p.type === "singleton_class") return true;
    if (p.type === "class" || p.type === "module") return false;
    p = p.parent;
  }
  return false;
}

function rustHasSelfParam(node: AstNode): boolean {
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

/**
 * The Swift `func` keyword — the discriminator that keeps the Swift
 * `function_declaration` branch away from the TypeScript / JavaScript
 * top-level function of the same node type. Their keyword node is `function`;
 * Swift's is `func`, and in both grammars the keyword is an anonymous child.
 */
function swiftHasFuncKeyword(node: AstNode): boolean {
  for (const child of node.children) {
    if (!child.isNamed && child.type === "func") return true;
  }
  return false;
}

/**
 * The Swift class-level modifiers, told apart from a member merely named so:
 *   - `static func build()` / `public class func make()` — the keyword lands
 *     inside the `modifiers` wrapper as a `property_modifier` node (or a bare
 *     modifier child) whose text IS the keyword.
 *   - `class func make()` — tree-sitter-swift ALSO parses the `class` keyword
 *     directly on the declaration as an anonymous `class` node (the same
 *     token a type declaration starts with — unambiguous here because this
 *     helper is only consulted for method shapes).
 * `mutating` / access modifiers are ignored — a `mutating func` is an
 * instance method.
 */
function swiftHasClassLevelModifier(node: AstNode): boolean {
  for (const child of node.children) {
    if (child.type === "modifiers") {
      for (const m of child.children) {
        if (m.text === "static" || m.text === "class") return true;
      }
    }
    if (!child.isNamed && (child.type === "class" || child.type === "static")) return true;
  }
  return false;
}
