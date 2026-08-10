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
import {
  classifyMethod,
  constObjectNamespaceName,
  moduleLevelFunctionDeclaratorName,
} from "../../../../infra/symbolid/index.js";

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
    // `classifyMethod` declines to classify those, leaving `methodKind` unset so
    // the language `scopeSeparator` composes the `Outer.Nested` namespace form
    // the convention reserves for exactly this case
    // (`.claude/rules/symbolid-convention.md`).
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
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
  // The shape gate (object literal carrying at least one `method_definition`,
  // seen through `as const` / `satisfies` / parentheses) lives in
  // `infra/symbolid/const-object-namespace.ts` — the CHUNKER asks the same
  // question about the same node and the two must not drift apart
  // (bd tea-rags-mcp-62hzr).
  const namespaceName = constObjectNamespaceName(node);
  if (namespaceName) return { name: namespaceName, descendsInto: true };

  // bd tea-rags-mcp-grz07 — MODULE-LEVEL const-bound FUNCTION expression:
  //
  //   export const genValidationSchema = (message: string) => …
  //   const legacyExpression = function (value) { … };
  //
  // The dominant declaration shape in React code, and previously unnamed on
  // BOTH sides — so the checker could resolve a bare call to a real project
  // declaration the symbol table had no way to name, and no edge could be
  // emitted however good the resolver chain got. Measured on the taxdome
  // `react-app/components` corpus: 179 of the bare-call targets the checker
  // pinned to a module-level const arrow, every one of them landing in the
  // oracle's "unpinned target" bucket.
  //
  // `descendsInto: false` matches `function_declaration` — a function is a
  // container for scope purposes but composes no members onto itself, which is
  // what separates this from the const-object namespace above. It is also what
  // keeps JavaScript byte-identical: `jsNameOf` DELEGATES here before applying
  // its own pattern #5 for the same shape, and #5 returns exactly this.
  //
  // The MODULE-LEVEL restriction is the whole boundary, and it lives in the
  // shared gate so the chunker cannot drift from it. A function-scoped const is
  // a local variable, not an addressable symbol; bd tea-rags-mcp-w7qv4's
  // resolver guard declines bare calls on those by DECLARATION SCOPE, and
  // naming them here would hand `globalShortName` precisely the candidates that
  // guard exists to withhold (452 of them on the same corpus, named
  // `handleClick` / `renderContent` / `setRef` across hundreds of files).
  const functionName = moduleLevelFunctionDeclaratorName(node);
  if (functionName) return { name: functionName, descendsInto: false };
  return null;
}
