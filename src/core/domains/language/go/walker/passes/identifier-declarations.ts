/**
 * Go's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.5) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: parameters, `:=` / `var` locals, `range` bindings
 * named struct fields, and each func's first result type (`returnSites`). A method RECEIVER is left out: it is typed by
 * construction and named by Go's one-letter convention, so every method on
 * `Svc` would add an `s Svc` row and drown how the project names a `Svc`
 * parameter everywhere else.
 *
 * Go declares several names per node (`a, b int`, `row, err := …`) and the
 * grammar repeats the `name` field, which `childForFieldName` answers only once,
 * so names are read as the node's identifier children. A `:=` / `var` value is
 * paired with its name POSITIONALLY; a multi-value call (`row, err := f()`)
 * binds only its FIRST name to the call — `row` is the call's result, `err` is
 * not — so only that name carries the bound callee.
 *
 * The declaration type unwraps pointers AND slices / arrays to the element
 * (`[]*Doc` → `Doc`) — the lexicon groups `docs` with `Doc`. That is
 * deliberately not `goFieldTypeName`'s reading, which records a slice field as
 * no single nominal type for the resolver. A package qualifier is kept
 * (`sync.Pool`), type arguments dropped. Only a composite literal (`X{}`,
 * `&X{}`) types by constructor; a `NewX()` call's type is joined at sink time
 * from the return-type channel.
 */

import { isSameAstNode, type AstNode } from "../../../../../contracts/types/ast.js";
import {
  boundCalleeFromCallShape,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/index.js";
import { goCallSiteShape } from "../walker.js";

function childrenOfType(node: AstNode | null, type: string): AstNode[] {
  return node === null ? [] : node.namedChildren.filter((child) => child.type === type);
}

/** Whether `param` sits in a method's receiver list rather than its parameter list. */
function isReceiver(param: AstNode): boolean {
  const list = param.parent;
  const method = list?.parent;
  return method?.type === "method_declaration" && isSameAstNode(method.childForFieldName("receiver"), list);
}

/** `a, b T` / `opts ...T` — one site per name, all sharing the declared type. */
function parameterSites(node: AstNode): DeclaredIdentifierSite[] {
  if (isReceiver(node)) return [];
  const typeNode = node.childForFieldName("type");
  return childrenOfType(node, "identifier").map((nameNode) => ({ nameNode, kind: "param", typeNode }));
}

/**
 * The initializer of the `i`-th of `nameCount` names: the value at its
 * position when the counts line up; for one multi-value CALL on the right, the
 * call for the first name only (a call is never a composite literal, so it
 * cannot type that name by constructor).
 */
function positionalValue(values: readonly AstNode[], nameCount: number, i: number): AstNode | null {
  if (values.length === nameCount) return values[i];
  return values.length === 1 && i === 0 && values[0].type === "call_expression" ? values[0] : null;
}

/** `x, y := a, b` — each name paired with the value at its position. */
function shortVarSites(node: AstNode): DeclaredIdentifierSite[] {
  const names = childrenOfType(node.childForFieldName("left"), "identifier");
  const values = node.childForFieldName("right")?.namedChildren ?? [];
  return names.map((nameNode, i) => ({
    nameNode,
    kind: "local",
    valueNode: positionalValue(values, names.length, i),
  }));
}

/** `var q, r T = a, b` — names are the spec's identifier children, values positional. */
function varSpecSites(node: AstNode): DeclaredIdentifierSite[] {
  const names = childrenOfType(node, "identifier");
  const typeNode = node.childForFieldName("type");
  const values = node.childForFieldName("value")?.namedChildren ?? [];
  return names.map((nameNode, i) => ({
    nameNode,
    kind: "local",
    typeNode,
    valueNode: positionalValue(values, names.length, i),
  }));
}

/** `for i, v := range xs` declares; `for i, v = range xs` assigns existing names. */
function rangeClauseSites(node: AstNode): DeclaredIdentifierSite[] {
  if (!node.children.some((child) => child.type === ":=")) return [];
  return childrenOfType(node.childForFieldName("left"), "identifier").map((nameNode) => ({ nameNode, kind: "local" }));
}

/** Named fields only — an embedded field (`Base`) declares no name of its own. */
function fieldSites(node: AstNode): DeclaredIdentifierSite[] {
  const typeNode = node.childForFieldName("type");
  return childrenOfType(node, "field_identifier").map((nameNode) => ({ nameNode, kind: "field", typeNode }));
}

const rule = (nodeType: string, collect: IdentifierDeclarationRule["collect"]): IdentifierDeclarationRule => ({
  nodeType,
  collect,
});

/** `*Repo` / `[]*Doc` / `[4]Item` / `List[T]` → the element's nominal name; maps, funcs, channels → none. */
function goDeclarationTypeName(node: AstNode): string | undefined {
  switch (node.type) {
    case "type_identifier":
    case "qualified_type":
      return node.text;
    case "pointer_type":
    case "slice_type":
    case "array_type": {
      const element = node.namedChildren.at(-1);
      return element ? goDeclarationTypeName(element) : undefined;
    }
    case "generic_type": {
      const base = node.childForFieldName("type");
      return base ? goDeclarationTypeName(base) : undefined;
    }
    default:
      return undefined;
  }
}

/** `X{}` / `pkg.X{}` / `List[int]{}` / `&X{}` → the literal's type name. */
function goConstructorTypeName(value: AstNode): string | undefined {
  if (value.type === "unary_expression") {
    const operand = value.childForFieldName("operand");
    return operand?.type === "composite_literal" ? goConstructorTypeName(operand) : undefined;
  }
  if (value.type !== "composite_literal") return undefined;
  const typeNode = value.childForFieldName("type");
  return typeNode ? goDeclarationTypeName(typeNode) : undefined;
}

/**
 * `func F() T` / `func (s *S) M() (T, error)` — the func's FIRST result, as a
 * `return` of the func itself (bd tea-rags-mcp-4p3sb.21). A multi-value call
 * binds only its first name to the call (`positionalValue`), so the first
 * result is the type that name holds. Unlike the resolver's
 * `functionReturnTypes`, which drops multi-value signatures, the lexicon asks
 * only what the bound name IS.
 */
function returnSites(node: AstNode): DeclaredIdentifierSite[] {
  const nameNode = node.childForFieldName("name");
  const result = node.childForFieldName("result");
  if (nameNode === null || result === null) return [];
  const typeNode =
    result.type === "parameter_list"
      ? (childrenOfType(result, "parameter_declaration")[0]?.childForFieldName("type") ?? null)
      : result;
  return [{ nameNode, kind: "return", typeNode }];
}

export const GO_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    rule("parameter_declaration", parameterSites),
    rule("variadic_parameter_declaration", parameterSites),
    rule("short_var_declaration", shortVarSites),
    rule("var_spec", varSpecSites),
    rule("range_clause", rangeClauseSites),
    rule("field_declaration", fieldSites),
    rule("function_declaration", returnSites),
    rule("method_declaration", returnSites),
  ],
  annotationTypeName: goDeclarationTypeName,
  constructorTypeName: goConstructorTypeName,
  boundCalleeOf: (value) => boundCalleeFromCallShape(goCallSiteShape(value)),
};
