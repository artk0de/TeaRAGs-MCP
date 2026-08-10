/**
 * TypeScript `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`tsNameOf` +
 * `methodKindFromClassify`) into the native TypeScript language provider per the
 * `domains/language` consolidation (spec §3; bd tea-rags-mcp-cen6).
 * Behaviour-preserving extraction: the node-shape detection and symbol emission
 * are identical to the provider's former inline function.
 *
 * `method_definition` routes through `classifyMethod` (in `infra/symbolid`) so
 * the chunker and codegraph agree on the separator (`#` instance / `.` static)
 * for the same physical AST node (`.claude/rules/symbolid-convention.md`).
 *
 * NOTE: the JavaScript-only shapes (CommonJS `obj.method = fn`,
 * `Foo.prototype.bar`, `Object.defineProperty` getters, the HTTP-verb forEach
 * dispatch, etc.) are NOT here — `jsNameOf` in `provider.ts` wraps the codegraph
 * config's TS `nameOf` and adds those. JavaScript is still served by the legacy
 * adapter, so its `jsNameOf` keeps a local `tsNameOf` to delegate to. This
 * native copy serves the TypeScript provider's `walker.nameOf` capability.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { classifyMethod } from "../../../../infra/symbolid/index.js";

function methodKindFromClassify(node: AstNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

export function tsNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "method_definition") {
    const id = node.childForFieldName("name");
    // bd tea-rags-mcp-2jhwk — a `method_definition` sitting directly in an
    // OBJECT LITERAL is a namespace member, not a class method: it is invoked
    // as `X.member()` on the object itself and there is no instance to bind.
    // `classifyMethod` only knows the class-body question ("is the `static`
    // keyword present?") and answers "instance" for every object-literal
    // method, which would compose `X#member`. Leaving `methodKind` unset lets
    // the language `scopeSeparator` compose the `Outer.Nested` namespace form
    // the convention reserves for exactly this case
    // (`.claude/rules/symbolid-convention.md`).
    if (id) {
      const methodKind = node.parent?.type === "object" ? undefined : methodKindFromClassify(node);
      return { name: id.text, descendsInto: false, methodKind };
    }
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
    // bd tea-rags-mcp-vw1u — synthesize Class#constructor when no explicit
    // constructor is declared in the body. TS/JS classes without
    // `constructor() {}` still have an implicit constructor that
    // `new Class()` / `super()` resolve to; the synthetic keeps
    // resolver lookups consistent.
    //
    // bd tea-rags-mcp-q3o2 — tree-sitter-typescript emits
    // `abstract_class_declaration` (NOT `class_declaration`) for
    // `abstract class X {}`. Without this branch the walker skipped
    // abstract bases entirely: their members never reached cg_symbols,
    // children's `super(...)` calls resolved against an empty parent
    // entry, and `get_callers(AbstractBase#constructor)` returned `[]`
    // even though concrete subclasses called it. Same `childForFieldName`
    // shape, same class_body — the only difference is the keyword.
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true, syntheticConstructorIfMissing: true };
  }
  // bd tea-rags-mcp-2jhwk — const-object NAMESPACE:
  //
  //   export const FileLevelGrouper = { group(...) { … } };
  //
  // A widely-used alternative to a static-only class, and previously invisible:
  // the members landed as bare top-level symbols (fq `group`, scope `[]`) and
  // the receiver name had no symbol at all. Two consequences, both measured by
  // `scripts/ts-codegraph-typechecker-oracle.ts` over this repo's own `src`:
  // `FileLevelGrouper.group()` could not be pinned (the barrel re-export hop in
  // `TSNamedImportSymbolResolutionStrategy` gates on the receiver being in the
  // symbol table, so those calls held a file-only edge on the BARREL), and
  // three different files each declared a symbol called plain `group`, so
  // `find_symbol` / `get_callers` could not tell them apart.
  //
  // Naming the declarator with `descendsInto: true` fixes both at once: the
  // receiver becomes lookup-able and its members compose as `X.member`.
  //
  // Gated on the object carrying at least one `method_definition`. A data-only
  // object (`const PALETTE = { red: "#f00" }`) declares nothing callable, and
  // naming it would add symbols no call site can ever target.
  if (node.type === "variable_declarator") {
    const id = node.childForFieldName("name");
    // `const { a, b } = …` binds an `object_pattern`, which names no namespace.
    if (id?.type !== "identifier") return null;
    const value = node.childForFieldName("value");
    if (!value) return null;
    const object = unwrapTypeAssertions(value);
    if (object.type !== "object") return null;
    if (!object.children.some((child) => child.type === "method_definition")) return null;
    return { name: id.text, descendsInto: true };
  }
  return null;
}

/**
 * Peel the TypeScript-only wrappers that sit between a declarator's `value`
 * field and the object literal underneath: `as const` / `as Shape`
 * (`as_expression`), `satisfies Shape` (`satisfies_expression`), and explicit
 * parentheses. All three are type-level annotations — the declared value is
 * still the object literal, so the namespace shape must be recognised through
 * them.
 */
function unwrapTypeAssertions(node: AstNode): AstNode {
  let current = node;
  // Bounded by the AST depth of the wrapper chain; each step strips one level.
  while (
    current.type === "as_expression" ||
    current.type === "satisfies_expression" ||
    current.type === "parenthesized_expression"
  ) {
    // `namedChildren[0]` is the wrapped expression in all three shapes; using
    // it rather than `children[0]` skips the anonymous punctuation tokens
    // (`(`, `as`, `satisfies`) tree-sitter keeps in the full child list.
    const inner = current.namedChildren[0];
    if (!inner || inner === current) break;
    current = inner;
  }
  return current;
}
