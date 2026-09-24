/**
 * Swift's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.6) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: function and closure parameters (the INTERNAL name —
 * `with opts: Options` declares `opts`), `let` / `var` in a body as locals, and
 * stored properties of a type body as fields.
 *
 * Every read is POSITIONAL. tree-sitter-swift registers `parameter.type` and
 * `type_annotation.type` under `name` as well, and `materializeTree` keeps only
 * `name`, so a `childForFieldName("type")` works on the native tree a unit test
 * parses and returns nothing on the materialized tree production walks (the
 * hazard `swiftTypeNodeAfter` in `walker.ts` documents). A parameter's name is
 * the identifier right before its `:`, its type the node right after; a
 * property declaration is scanned as its flat `pattern [type_annotation] [= value]`
 * clause list, so `let x: Int = 1, y = Foo()` yields both names.
 *
 * The annotation type is the nominal (`Set<Foo>` → `Set`, `Outer.Inner` kept),
 * seen through `?`, `any` / `some` and array sugar (`[Item]` → `Item`). A
 * constructor is a CapWords callee (`Widget()`, `Foo.Bar()`) or an explicitly
 * specialised construction (`Protected<[T]>(…)`). A local or property bound to
 * a call carries its callee, split the way the walker splits its `CallRef`,
 * seen through `try` and `await` (read positionally, like everything here).
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierBoundCallee } from "../../../../../contracts/types/codegraph.js";
import {
  boundCalleeFromCallShape,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";
import { swiftCallSiteShape } from "../walker.js";

/** Type bodies whose `let` / `var` members are stored properties, not locals. */
const TYPE_BODY_TYPES = new Set(["class_body", "enum_class_body", "protocol_body"]);

function nodeAfter(node: AstNode, separator: string): AstNode | null {
  const at = node.children.findIndex((child) => child.type === separator);
  return at === -1 ? null : (node.children[at + 1] ?? null);
}

/** `id: String` / `_ doc: Doc` / `with opts: Options? = nil` — the name is the identifier before `:`. */
function parameterSites(node: AstNode): DeclaredIdentifierSite[] {
  const at = node.children.findIndex((child) => child.type === ":");
  const nameNode = at > 0 ? node.children[at - 1] : null;
  if (nameNode?.type !== "simple_identifier") return [];
  return [{ nameNode, kind: "param", typeNode: node.children[at + 1] ?? null }];
}

/** The identifiers a `pattern` binds: itself when it wraps one name, each name of a tuple pattern. */
function patternNameNodes(pattern: AstNode): AstNode[] {
  const names: AstNode[] = [];
  const stack: AstNode[] = [pattern];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "simple_identifier") names.push(node);
    else if (node.type === "pattern" || node.type === "tuple_pattern") {
      for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
    }
  }
  return names;
}

/** `let x: Int = 1, y = Foo()` — one clause per `pattern` child, annotation and value following it. */
function propertySites(node: AstNode): DeclaredIdentifierSite[] {
  const kind = node.parent && TYPE_BODY_TYPES.has(node.parent.type) ? "field" : "local";
  const sites: DeclaredIdentifierSite[] = [];
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type !== "pattern") continue;
    const names = patternNameNodes(kids[i]);
    let next = i + 1;
    const annotation = kids[next]?.type === "type_annotation" ? kids[next] : null;
    if (annotation) next += 1;
    const valueNode = kids[next]?.type === "=" ? (kids[next + 1] ?? null) : null;
    if (names.length === 1) {
      sites.push({
        nameNode: names[0],
        kind,
        typeNode: annotation ? nodeAfter(annotation, ":") : null,
        valueNode,
      });
    } else {
      for (const nameNode of names) sites.push({ nameNode, kind });
    }
  }
  return sites;
}

const rule = (nodeType: string, collect: IdentifierDeclarationRule["collect"]): IdentifierDeclarationRule => ({
  nodeType,
  collect,
});

/** `Foo` / `Set<Foo>` → `Set` / `Outer.Inner`, seen through `?`, `any` / `some` and `[Element]`. */
function swiftAnnotationTypeName(node: AstNode): string | undefined {
  switch (node.type) {
    case "user_type": {
      const nominal = node.text.split("<")[0].trim();
      return nominal === "" ? undefined : nominal;
    }
    case "optional_type":
    case "existential_type":
    case "opaque_type":
    case "array_type": {
      const inner = node.namedChildren[0];
      return inner ? swiftAnnotationTypeName(inner) : undefined;
    }
    default:
      return undefined;
  }
}

/** `Widget()` / `Foo.Bar()` (CapWords final segment) / `Protected<[T]>(…)` → the constructed type. */
function swiftConstructorTypeName(value: AstNode): string | undefined {
  if (value.type === "constructor_expression") {
    const constructed = value.namedChildren.find((child) => child.type === "user_type");
    return constructed ? swiftAnnotationTypeName(constructed) : undefined;
  }
  if (value.type !== "call_expression") return undefined;
  const callee = value.namedChildren.find((child) => child.type !== "call_suffix");
  if (callee?.type !== "simple_identifier" && callee?.type !== "navigation_expression") return undefined;
  if (!/^[\w.]+$/.test(callee.text)) return undefined;
  const finalSegment = callee.text.slice(callee.text.lastIndexOf(".") + 1);
  return /^_*[A-Z]/.test(finalSegment) ? callee.text : undefined;
}

/** `try f()` / `try? f()` / `await f()` / `try await f()` → the call `f()`. */
function swiftBoundCallee(value: AstNode): IdentifierBoundCallee | undefined {
  let call: AstNode | undefined = value;
  while (call?.type === "try_expression" || call?.type === "await_expression") {
    call = call.namedChildren.find((child) => child.type !== "try_operator");
  }
  return call === undefined ? undefined : boundCalleeFromCallShape(swiftCallSiteShape(call));
}

export const SWIFT_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    rule("parameter", parameterSites),
    rule("lambda_parameter", parameterSites),
    rule("property_declaration", propertySites),
  ],
  annotationTypeName: swiftAnnotationTypeName,
  constructorTypeName: swiftConstructorTypeName,
  boundCalleeOf: swiftBoundCallee,
};
