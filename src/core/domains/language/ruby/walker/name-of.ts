/**
 * Ruby `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor(s)
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`rbNameOf` + the
 * `ruby*Emission` helpers) into the native Ruby language provider per the
 * `domains/language` consolidation (spec §3).
 *
 * Both `method` and `singleton_method` route through `classifyMethod` (in
 * `infra/symbolid`) so the chunker and codegraph agree on the separator for
 * the same physical AST node (`.claude/rules/symbolid-convention.md`).
 *
 * Class-body DSL macro expansion (`attr_*`, `delegate`, `has_many`, `scope`,
 * `define_method`, the two `alias` forms, …) is delegated to the SINGLE shared
 * engine `./macro-expansion.ts` — the same engine the chunker-side `macros.ts`
 * reads — so codegraph `cg_symbols` rows match chunker `symbolId`s by
 * construction. Codegraph takes the engine's FULL declared-method set (the
 * chunker filters association/scope; codegraph does not). The
 * `class << self` → static override stays here (`toStaticKind`).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { classifyMethod, rubyInsideSingletonClass } from "../../../../infra/symbolid/index.js";
import { expandAliasKeyword, expandClassBodyMacros, type DeclaredMethod } from "./macro-expansion.js";

function methodKindFromClassify(node: AstNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

/**
 * Force every emitted symbol's `methodKind` to `static`. Used when a
 * macro/define/alias node sits inside a `class << self` (singleton_class):
 * those declare CLASS-level methods (`Foo.method`, `.` separator) per
 * .claude/rules/symbolid-convention.md, mirroring the chunker-side
 * `extractRubyMacroSymbols` singleton override.
 */
function toStaticKind(result: NamedSymbol | NamedSymbol[]): NamedSymbol | NamedSymbol[] {
  return Array.isArray(result)
    ? result.map((s) => ({ ...s, methodKind: "static" as const }))
    : { ...result, methodKind: "static" as const };
}

/** Map an engine `DeclaredMethod` to a codegraph `NamedSymbol`. */
function toNamedSymbol(m: DeclaredMethod): NamedSymbol {
  return { name: m.name, descendsInto: false, methodKind: m.kind };
}

/**
 * Macros that historically emitted a SINGLE `NamedSymbol` (scalar) rather than
 * an array — `define_method`/`alias_method` (and the `alias` keyword form,
 * handled separately). Preserved verbatim so the codegraph result shape is
 * byte-identical to the pre-engine helpers; the consumer flattens either shape,
 * so this is presentation only.
 */
const SINGLE_EMISSION_MACROS = new Set(["define_method", "alias_method"]);

function macroNameOf(node: AstNode): string | undefined {
  const m = node.childForFieldName("method") ?? node.children.find((c) => c.type === "identifier");
  return m?.text;
}

export function rbNameOf(node: AstNode): NamedSymbol | NamedSymbol[] | null {
  // Both `method` and `singleton_method` route through classifyMethod
  // (in core/infra/symbolid) so the chunker and codegraph agree on the
  // separator for the same physical AST node. classifyMethod also walks
  // up to detect `class << self` blocks — regular `method` nodes inside
  // a singleton_class become class-level and join with `.` instead of `#`.
  if (node.type === "method" || node.type === "singleton_method") {
    const id = node.childForFieldName("name");
    if (id) {
      const kind = methodKindFromClassify(node) ?? "instance";
      // bd tea-rags-mcp-08v2 — `extend self` in a module body promotes every
      // instance method to ALSO be callable as a module-level method (`M.foo`
      // alongside `M#foo`). The chunker still emits a single symbolId per def
      // (instance form, matching the AST node's primary kind); the codegraph
      // adds the class-form alias so callers reaching `M.foo` resolve.
      // Only fires for regular `method` nodes inside a `module` body — class
      // <<<self and def self.foo already produce static-form symbols via
      // classifyMethod, and `extend self` is conventionally a module idiom
      // (`extend self` inside a class is rare and semantically different).
      if (node.type === "method" && kind === "instance" && rubyMethodInsideExtendSelfModule(node)) {
        return [
          { name: id.text, descendsInto: false, methodKind: "instance" },
          { name: id.text, descendsInto: false, methodKind: "static" },
        ];
      }
      return { name: id.text, descendsInto: false, methodKind: kind };
    }
  }
  if (node.type === "class" || node.type === "module") {
    // `class Acme::Auth` — read the scope_resolution chain so the
    // qualified class name composes correctly with the outer scope.
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const localName = nameNode.type === "scope_resolution" ? scopeResolutionText(nameNode) : nameNode.text;
    return { name: localName, descendsInto: true };
  }
  // Ruby DSL macros — `attr_accessor :a, :b`, `has_many :products`, etc.
  // Expansion (precedence, arg shapes, AR associations) lives in the shared
  // engine. Inside a `class << self`, every emission becomes static.
  if (node.type === "call" || node.type === "method_call") {
    const expanded = expandClassBodyMacros(node).map(toNamedSymbol);
    if (expanded.length > 0) {
      // define_method / alias_method historically returned a scalar NamedSymbol.
      const emit = SINGLE_EMISSION_MACROS.has(macroNameOf(node) ?? "") ? expanded[0] : expanded;
      return rubyInsideSingletonClass(node) ? toStaticKind(emit) : emit;
    }
  }
  // `alias new_name old_name` — Ruby keyword form is a distinct AST node
  // type (`alias`), not a `call`. Emit the new method name as an
  // instance method on the enclosing class so chunker and codegraph agree —
  // static inside a `class << self`. Historically a scalar NamedSymbol.
  if (node.type === "alias") {
    const aliasEmit = expandAliasKeyword(node).map(toNamedSymbol);
    if (aliasEmit.length > 0) {
      const emit = aliasEmit[0];
      return rubyInsideSingletonClass(node) ? toStaticKind(emit) : emit;
    }
  }
  return null;
}

function rubyMethodInsideExtendSelfModule(methodNode: AstNode): boolean {
  let p: AstNode | null = methodNode.parent;
  while (p) {
    if (p.type === "class") return false;
    if (p.type === "module") {
      const body = p.childForFieldName("body");
      const stmts = body ? body.children : p.children;
      for (const stmt of stmts) {
        if (stmt.type !== "call" && stmt.type !== "method_call") continue;
        if (stmt.childForFieldName("receiver")) continue;
        const methodField = stmt.childForFieldName("method") ?? stmt.children.find((c) => c.type === "identifier");
        if (methodField?.text !== "extend") continue;
        const args = stmt.childForFieldName("arguments") ?? stmt.children.find((c) => c.type === "argument_list");
        if (!args) continue;
        const firstArg = args.namedChildren[0];
        if (firstArg?.type === "self") return true;
      }
      return false;
    }
    p = p.parent;
  }
  return false;
}

function scopeResolutionText(node: AstNode): string {
  // Mirror ruby-walker's readScopeResolution; kept local to avoid an
  // export from the walker just for nameOf.
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (!name) return "";
  const left =
    scope?.type === "scope_resolution" ? scopeResolutionText(scope) : scope?.type === "constant" ? scope.text : "";
  return left ? `${left}::${name.text}` : name.text;
}
