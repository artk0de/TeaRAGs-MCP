/**
 * Go's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.5) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: parameters, `:=` / `var` locals, `range` bindings
 * and named struct fields. A method RECEIVER is left out: it is typed by
 * construction and named by Go's one-letter convention, so every method on
 * `Svc` would add an `s Svc` row and drown how the project names a `Svc`
 * parameter everywhere else.
 *
 * Go declares several names per node (`a, b int`, `row, err := …`) and the
 * grammar repeats the `name` field, which `childForFieldName` answers only once,
 * so names are read as the node's identifier children. A `:=` / `var` value is
 * paired with its name POSITIONALLY; a multi-value call (`row, err := f()`)
 * gives no name an initializer.
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
import type {
  DeclaredIdentifierSite,
  IdentifierDeclarationRule,
  IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";

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

/** `x, y := a, b` — each name paired with the value at its position, when the counts line up. */
function shortVarSites(node: AstNode): DeclaredIdentifierSite[] {
  const names = childrenOfType(node.childForFieldName("left"), "identifier");
  const values = node.childForFieldName("right")?.namedChildren ?? [];
  return names.map((nameNode, i) => ({
    nameNode,
    kind: "local",
    valueNode: values.length === names.length ? values[i] : null,
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
    valueNode: values.length === names.length ? values[i] : null,
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

export const GO_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    rule("parameter_declaration", parameterSites),
    rule("variadic_parameter_declaration", parameterSites),
    rule("short_var_declaration", shortVarSites),
    rule("var_spec", varSpecSites),
    rule("range_clause", rangeClauseSites),
    rule("field_declaration", fieldSites),
  ],
  annotationTypeName: goDeclarationTypeName,
  constructorTypeName: goConstructorTypeName,
};
