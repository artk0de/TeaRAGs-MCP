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
  classPropertyFunction,
  constObjectNamespaceName,
  functionValuedDeclaratorName,
} from "../../../../infra/symbolid/index.js";
import { callValuedExportNames } from "./call-valued-export.js";

function methodKindFromClassify(node: AstNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

export function tsNameOf(node: AstNode): NamedSymbol | NamedSymbol[] | null {
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
  // bd tea-rags-mcp-5ldqu — a class member declared as a FIELD bound to a
  // function rather than as a method:
  //
  //   class AdminentrypointPostFetcher { request = async () => fetch(url); }
  //
  // The same member as a `method_definition` for every purpose that matters
  // downstream, so it composes the same way — `#` for an instance field, `.` for
  // a `static` one. The shape-plus-kind gate lives in
  // `infra/symbolid/class-property-function.ts`, next to `classifyMethod`, which
  // is what it reads for the kind and what the chunker's class-body grouper
  // reads to bucket the same field.
  //
  // `descendsInto: false` matches `method_definition`: the field is a container
  // for scope purposes (a closure inside the arrow composes as
  // `Class#field.inner`) but composes no members onto itself.
  //
  // Placed AFTER `method_definition` and before everything else because the node
  // types are disjoint — the order is readability, not precedence.
  const classProperty = classPropertyFunction(node);
  if (classProperty) {
    return { name: classProperty.name, descendsInto: false, methodKind: classProperty.methodKind };
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
  // Naming the declarator fixes both at once: the receiver becomes lookup-able
  // and its members compose as `X.member` — `collectSymbols` extends the
  // composed scope for every named node, so the composition follows from
  // NAMING it, not from the `descendsInto: true` that describes it
  // (bd tea-rags-mcp-czoif).
  //
  // The shape gate (object literal carrying at least one `method_definition`,
  // seen through `as const` / `satisfies` / parentheses) lives in
  // `infra/symbolid/const-object-namespace.ts` — the CHUNKER asks the same
  // question about the same node and the two must not drift apart
  // (bd tea-rags-mcp-62hzr).
  const namespaceName = constObjectNamespaceName(node);
  if (namespaceName) return { name: namespaceName, descendsInto: true };

  // bd tea-rags-mcp-grz07 — const-bound FUNCTION expression, at MODULE level:
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
  // bd tea-rags-mcp-29m75 — the SAME shape one or more scopes deeper:
  //
  //   const RowEditor = () => { const handleChange = (v) => …; … };
  //   function useThing() { const doIt = () => …; return { doIt }; }
  //
  // grz07 stopped at module level to keep a bare `handler` out of
  // `globalShortName`'s reach. `collectSymbols` composes a nested declarator
  // under its enclosing symbol — `render.handler`, `Panel#open.onClose`,
  // `useThing.doIt` — so `lookup(fqName)` never gains the ambiguous key and
  // `sameFile` / the type-checker passes gain a real target to pin. The
  // short-name index is the part that is priced rather than avoided, and the
  // exchange rate is in the shared gate's docblock: on taxdome this shape was
  // 3,944 missed rows, 21.5% of the whole recall gap.
  //
  // `descendsInto: false` matches `function_declaration` — a function is a
  // leaf DECLARATION, not a member container like the const-object namespace
  // above. The flag is descriptive and no collector reads it (bd
  // tea-rags-mcp-czoif), so it neither grants nor withholds the nested
  // composition this bead is about. Matching `function_declaration` is also what
  // keeps JavaScript byte-identical: `jsNameOf` DELEGATES here before applying
  // its own pattern #5, which has always recognised this shape at ANY depth and
  // returns exactly this. Widening to match #5 is what keeps the delegation a
  // no-op there rather than a second emission.
  const functionName = functionValuedDeclaratorName(node);
  if (functionName) return { name: functionName, descendsInto: false };

  // bd tea-rags-mcp-llgrz — the WRAPPER-EXPORTED component:
  //
  //   const refForwarded = forwardRef(CardInner);
  //   export { refForwarded as Card };
  //   export const Panel = memo(PanelBase);
  //
  // Disjoint from both gates above by the VALUE node: a call is neither an
  // object literal nor a function expression, so the order here is readability.
  // The name recorded is the EXPORTED one, and only when a JSX tag could
  // reference it — both halves were measured against the type-checker oracle
  // rather than reasoned, and `./call-valued-export.ts` carries the numbers.
  //
  // The ARRAY form is deliberate. `collectSymbols` walks an array result's
  // children at the SAME scope, so what the call CONTAINS keeps composing
  // exactly where it did — `createSlice({ reducers: { addItem() {} } })` still
  // yields a bare `addItem`, which is the id the chunker's classifier writes
  // into the Qdrant payload for that member. Extending the scope instead would
  // move it to `slice.addItem` and leave the chunker's id with no cg_symbols row
  // (`.claude/rules/symbolid-convention.md`).
  const exportNames = callValuedExportNames(node);
  if (exportNames) return exportNames.map((name) => ({ name, descendsInto: false }));
  return null;
}
