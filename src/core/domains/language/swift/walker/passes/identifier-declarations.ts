/**
 * Swift's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.6) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: function and closure parameters (the INTERNAL name —
 * `with opts: Options` declares `opts`), `let` / `var` in a body as locals,
 * stored properties of a type body as fields, and each func's return type
 * (`returnSites`).
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
 * The annotation type is the nominal (`Dictionary<K, V>` → `Dictionary`,
 * `Outer.Inner` kept), seen through `?`, `any` / `some` and array sugar
 * (`[Item]` → `Item`); `Array<T>` / `Set<T>` / `Optional<T>` name their element
 * the same way (bd tea-rags-mcp-4p3sb.17). A map keeps its head, an element with
 * no nominal name (a tuple) gives no type. A
 * constructor is a CapWords callee (`Widget()`, `Foo.Bar()`) or an explicitly
 * specialised construction (`Protected<[T]>(…)`). A local or property bound to
 * a call carries its callee, split the way the walker splits its `CallRef`,
 * seen through `try` and `await` (read positionally, like everything here).
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierBoundCallee } from "../../../../../contracts/types/codegraph.js";
import {
  boundCalleeFromCallShape,
  elementOfCollection,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "../../../kernel/index.js";
import { SWIFT_SINGLE_ELEMENT_SEQUENCES, swiftCallSiteShape } from "../walker.js";

/** Type bodies whose `let` / `var` members are stored properties, not locals. */
const TYPE_BODY_TYPES = new Set(["class_body", "enum_class_body", "protocol_body"]);

function nodeAfter(node: AstNode, separator: string): AstNode | null {
  const at = node.children.findIndex((child) => child.type === separator);
  return at === -1 ? null : (node.children[at + 1] ?? null);
}

/**
 * `id: String` / `_ doc: Doc` / `with opts: Options? = nil` — the name is the
 * identifier before `:`. A variadic `rest: Item...` is an `[Item]`, though its
 * type node names only the element.
 */
function parameterSites(node: AstNode): DeclaredIdentifierSite[] {
  const at = node.children.findIndex((child) => child.type === ":");
  const nameNode = at > 0 ? node.children[at - 1] : null;
  if (nameNode?.type !== "simple_identifier") return [];
  const typeNode = node.children[at + 1] ?? null;
  return node.children.some((child) => child.type === "...")
    ? [{ nameNode, kind: "param", typeNode, typeMultiplicity: "many" }]
    : [{ nameNode, kind: "param", typeNode }];
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

/**
 * Generic heads whose annotation names its first type argument, matched on the
 * final segment (`Swift.Array`): the walker's single-element sequences (one
 * vocabulary for the element slot and the lexicon), plus `Optional`, which
 * wraps one value rather than iterating it.
 */
const ELEMENT_NAMING_HEADS: ReadonlySet<string> = new Set([...SWIFT_SINGLE_ELEMENT_SEQUENCES, "Optional"]);

/** A `user_type`'s nominal as written, generic arguments dropped: `Dictionary<K, V>` → `Dictionary`. */
function swiftUserTypeNominal(userType: AstNode): string | undefined {
  const nominal = userType.text.split("<")[0].trim();
  return nominal === "" ? undefined : nominal;
}

/**
 * `Foo` / `Dictionary<K, V>` → `Dictionary` / `Outer.Inner`, seen through `?`,
 * `any` / `some` and `[Element]`; `Array<T>` / `Set<T>` / `Optional<T>` → the
 * element — many for `[T]` and a sequence, one for `Optional` (bd
 * tea-rags-mcp-4p3sb.26). The type arguments are the `user_type`'s trailing
 * child, read by position like every other read here.
 */
function swiftAnnotationType(node: AstNode): IdentifierSyntacticType | undefined {
  switch (node.type) {
    // A class / struct / enum declaration's own name — what a `-> Self` return reads.
    case "type_identifier":
      return { typeName: node.text };
    case "user_type": {
      const nominal = swiftUserTypeNominal(node);
      if (nominal === undefined) return undefined;
      const finalSegment = nominal.slice(nominal.lastIndexOf(".") + 1);
      if (!ELEMENT_NAMING_HEADS.has(finalSegment)) return { typeName: nominal };
      const args = node.namedChildren.at(-1);
      if (args?.type !== "type_arguments") return { typeName: nominal };
      const element = args.namedChildren[0];
      return elementOfCollection(
        element ? swiftAnnotationType(element) : undefined,
        SWIFT_SINGLE_ELEMENT_SEQUENCES.has(finalSegment),
      );
    }
    case "optional_type":
    case "existential_type":
    case "opaque_type":
    case "array_type": {
      const inner = node.namedChildren[0];
      return elementOfCollection(inner ? swiftAnnotationType(inner) : undefined, node.type === "array_type");
    }
    default:
      return undefined;
  }
}

/**
 * `Widget()` / `Foo.Bar()` (CapWords final segment) / `Protected<[T]>(…)` → the
 * constructed type, by its head even for a collection: `Array<Job>()` constructs
 * an `Array`.
 */
function swiftConstructorType(value: AstNode): IdentifierSyntacticType | undefined {
  if (value.type === "constructor_expression") {
    const constructed = value.namedChildren.find((child) => child.type === "user_type");
    const nominal = constructed ? swiftUserTypeNominal(constructed) : undefined;
    return nominal === undefined ? undefined : { typeName: nominal };
  }
  if (value.type !== "call_expression") return undefined;
  const callee = value.namedChildren.find((child) => child.type !== "call_suffix");
  if (callee?.type !== "simple_identifier" && callee?.type !== "navigation_expression") return undefined;
  if (!/^[\w.]+$/.test(callee.text)) return undefined;
  const finalSegment = callee.text.slice(callee.text.lastIndexOf(".") + 1);
  return /^_*[A-Z]/.test(finalSegment) ? { typeName: callee.text } : undefined;
}

/** `try f()` / `try? f()` / `await f()` / `try await f()` → the call `f()`. */
function swiftBoundCallee(value: AstNode): IdentifierBoundCallee | undefined {
  let call: AstNode | undefined = value;
  while (call?.type === "try_expression" || call?.type === "await_expression") {
    call = call.namedChildren.find((child) => child.type !== "try_operator");
  }
  return call === undefined ? undefined : boundCalleeFromCallShape(swiftCallSiteShape(call));
}

/** Returns that name no type a value could be named after: universal, empty, or uninhabited. */
const NAMELESS_RETURN_TYPES: ReadonlySet<string> = new Set(["Any", "AnyObject", "Never", "Void"]);

/** The generic parameter names `decl` declares (`<T, U: P>`), read positionally. */
function typeParameterNames(decl: AstNode | null | undefined): string[] {
  const parameters = decl?.children.find((child) => child.type === "type_parameters");
  if (parameters === undefined) return [];
  return parameters.namedChildren
    .filter((p) => p.type === "type_parameter")
    .map((p) => p.namedChildren.find((c) => c.type === "type_identifier")?.text)
    .filter((name): name is string => name !== undefined);
}

/**
 * `func f() -> T` — the func's return, as a `return` of the func itself (bd
 * tea-rags-mcp-4p3sb.21), the type the node after `->` names; an `async`
 * func's written type is already what `await` yields. `Self` in a class,
 * struct, enum or extension body names that declaration — the declaring type,
 * what `Store.make()` builds; in a protocol it names no type. A generic
 * parameter (the func's or its type's) and `Void` / `Never` / `Any` name none.
 */
function returnSites(node: AstNode): DeclaredIdentifierSite[] {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return [];
  const written = nodeAfter(node, "->");
  const declaring = node.parent && TYPE_BODY_TYPES.has(node.parent.type) ? node.parent.parent : null;
  const typeName = written === null ? undefined : swiftAnnotationType(written)?.typeName;
  let typeNode: AstNode | null = written;
  if (typeName === "Self") {
    typeNode = declaring?.type === "class_declaration" ? declaring.childForFieldName("name") : null;
  } else if (
    typeName === undefined ||
    NAMELESS_RETURN_TYPES.has(typeName) ||
    [...typeParameterNames(node), ...typeParameterNames(declaring)].includes(typeName)
  ) {
    typeNode = null;
  }
  return [{ nameNode, kind: "return", typeNode }];
}

export const SWIFT_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    rule("parameter", parameterSites),
    rule("lambda_parameter", parameterSites),
    rule("property_declaration", propertySites),
    rule("function_declaration", returnSites),
    rule("protocol_function_declaration", returnSites),
  ],
  annotationType: swiftAnnotationType,
  constructorType: swiftConstructorType,
  boundCalleeOf: swiftBoundCallee,
};
