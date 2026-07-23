/**
 * ActiveRecord association / scope RETURN-type source (G1a).
 *
 * Reads the SAME class-body macro invocations the codegraph already parses for
 * `declares` / `emits` and emits `kind:"return"` facts so association / scope
 * accessors get a static receiver type in `resolver/type-propagation.ts`:
 *
 *   - `belongs_to` / `has_one`               → `instance(model)`
 *   - `has_many` / `has_and_belongs_to_many` → `container(model)` (a relation)
 *   - `scope`                                → `container(self)`  (a relation)
 *
 * The macro→shape mapping is DATA (`RubyDslEntry.returnShape` in `dsl/rails.ts`);
 * this file is the INTERPRETER. The container form reuses the existing
 * `RubyTypeRef` container that `returnTypeOf` already unwraps.
 *
 * SILENCE (precision, never fabricate): `polymorphic: true` and a non-literal
 * `class_name:` emit NO fact. Facts are tagged `source: "associations"` so the
 * store ranks a YARD `@return` of the same name ABOVE inflection.
 *
 * Model derivation is precision-GATED here (it silences polymorphic +
 * non-literal `class_name:`), unlike the walker's best-effort edge helper
 * `associationModelConstant` which falls through to convention — a distinct
 * function, not a copy. It reuses the shared `singularizeAssociation` inflection
 * primitive (the part most prone to drift) but stays runtime-decoupled from
 * `walker.ts`: importing `walker.ts` at runtime would cycle
 * walker → type-sources/index → associations → walker and leave
 * `INLINE_TYPE_SOURCES` holding an undefined source (yard.ts / ast-inference.ts
 * likewise only TYPE-import `walker.ts`).
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import { RUBY_DSL, singularizeAssociation } from "../../dsl/index.js";
import { readScopeResolution } from "../ast-utils.js";
import type { RubyExtractInput } from "../walker.js";
import type { RubyInlineTypeSource, RubyTypeFact } from "./types.js";

/** A constant name (`Foo`, `Acme::User`) — the accepted `class_name:` literal shape. */
const RUBY_CONST = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/** `blog_posts` → `BlogPost`: upcase each `_`-separated segment (Rails camelize). */
function camelizeModel(snake: string): string {
  return snake
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** The macro call's argument list node, or `null` for an arg-less call. */
function macroArgs(node: AstNode): AstNode | null {
  return node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list") ?? null;
}

/** First `simple_symbol` arg → accessor / method name (`belongs_to :owner` → "owner"). */
function firstSymbolName(args: AstNode): string | null {
  const first = args.namedChildren[0];
  if (first?.type !== "simple_symbol") return null;
  const base = first.text.startsWith(":") ? first.text.slice(1) : first.text;
  return base.length > 0 ? base : null;
}

/** A `class_name:` value as a constant name when it is a literal, else `null` (silence). */
function literalClassName(value: AstNode | null): string | null {
  if (!value) return null;
  if (value.type === "string" || value.type === "string_literal") {
    const inner = value.namedChildren.find((c) => c.type === "string_content");
    const literal = inner ? inner.text : value.text.replace(/^["']|["']$/g, "");
    return RUBY_CONST.test(literal) ? literal : null;
  }
  if (value.type === "constant") return value.text;
  if (value.type === "scope_resolution") return readScopeResolution(value);
  return null; // a non-literal expression → no static target
}

/**
 * The associated model constant for an association macro, or `null` (silence):
 * `polymorphic: true` and a non-literal `class_name:` both yield `null`; a literal
 * `class_name:` wins; otherwise the first symbol is singularized + camelized.
 */
function deriveAssociationModel(args: AstNode): string | null {
  let classNameModel: string | null | undefined; // undefined ⇒ no class_name: pair seen
  for (const arg of args.namedChildren) {
    if (arg.type !== "pair") continue;
    const key = arg.childForFieldName("key");
    const value = arg.childForFieldName("value");
    if (key?.text === "polymorphic" && value?.type === "true") return null; // no single static target
    if (key?.text === "class_name") classNameModel = literalClassName(value);
  }
  if (classNameModel !== undefined) return classNameModel; // present: literal wins, non-literal silences
  const sym = firstSymbolName(args);
  if (sym === null) return null;
  const model = camelizeModel(singularizeAssociation(sym));
  return model.length > 0 ? model : null;
}

/**
 * The `RubyTypeRef` an association / scope accessor returns, or `undefined` when
 * silenced / underivable. `scope-relation` is a relation over the enclosing
 * model; the association shapes derive the model and wrap it as instance or
 * container (a relation).
 */
function returnTypeForShape(args: AstNode, shape: string, scope: readonly string[]): RubyTypeRef | undefined {
  if (shape === "scope-relation") {
    const self = scope.join("::");
    if (self.length === 0) return undefined;
    return { form: "container", element: { form: "instance", name: self } };
  }
  const model = deriveAssociationModel(args);
  if (model === null) return undefined;
  const modelRef: RubyTypeRef = { form: "instance", name: model };
  return shape === "association-collection" ? { form: "container", element: modelRef } : modelRef;
}

/** Emit the return fact for a single class-body macro call, if it declares one. */
function emitMacroReturnFact(node: AstNode, scope: readonly string[], out: RubyTypeFact[]): void {
  // Class-body macro form only: bare call, or an explicit `self` receiver.
  const receiver = node.childForFieldName("receiver");
  if (receiver && receiver.type !== "self") return;
  const method = node.childForFieldName("method") ?? node.children.find((c) => c.type === "identifier");
  if (!method) return;
  const shape = RUBY_DSL[method.text]?.returnShape;
  if (!shape) return;
  const args = macroArgs(node);
  if (!args) return;
  const accessor = firstSymbolName(args);
  if (accessor === null) return;
  const type = returnTypeForShape(args, shape, scope);
  if (type === undefined) return;
  out.push({ kind: "return", source: "associations", symbolScope: [...scope], methodName: accessor, type });
}

/**
 * Walk the tree tracking the enclosing class/module scope (mirroring
 * `collectRubyAssociationTypes` / `buildDefScopeMap`), attributing each macro's
 * return fact to that scope. A macro inside a Concern's `included do` block is
 * NOT a class/module node, so it keeps the module scope — attributing the fact to
 * the CONCERN, which the includer reaches via its ancestor MRO.
 */
function collectAssociationReturnFacts(root: AstNode): RubyTypeFact[] {
  const facts: RubyTypeFact[] = [];
  const walkScope = (node: AstNode, scope: readonly string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
        const body = node.childForFieldName("body");
        const nextScope = [...scope, ...localName.split("::")];
        for (const child of (body ?? node).children) walkScope(child, nextScope);
        return;
      }
      for (const child of node.children) walkScope(child, scope);
      return;
    }
    if (node.type === "call" || node.type === "method_call") emitMacroReturnFact(node, scope, facts);
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return facts;
}

export const rubyAssociationTypeSource: RubyInlineTypeSource = {
  name: "associations",
  extract(input: RubyExtractInput): RubyTypeFact[] {
    const root = input.tree?.rootNode;
    if (!root) return [];
    return collectAssociationReturnFacts(root);
  },
};
