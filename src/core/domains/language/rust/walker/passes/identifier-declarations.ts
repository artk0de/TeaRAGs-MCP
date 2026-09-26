/**
 * Rust's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.5) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: function and closure parameters, `let` locals,
 * named struct fields and each fn's return type (see `returnRule`). `self` is a `self_parameter`, not a `parameter`: the
 * language fixes its name, so it says nothing about how this project names
 * things.
 *
 * A plain `name` / `mut name` binding keeps its annotation and initializer; a
 * destructuring pattern (`(a, b)`, `Point { x, y }`) binds each name as its own
 * untyped site, since the annotation types the whole pattern.
 *
 * The annotation type strips `&`, `mut` and lifetimes and drops generic
 * arguments (`HashMap<K, V>` → `HashMap`), keeping a path as written
 * (`std::sync::Pool`) — except that a collection or wrapper
 * (`Vec / VecDeque / HashSet / BTreeSet / Option / Box / Rc / Arc<T>`) and a
 * slice (`&[T]`) name their ELEMENT (bd tea-rags-mcp-4p3sb.17): the lexicon
 * groups `items` with `Item`, and a collection or slice marks it `many` where
 * a wrapper of one value does not (bd tea-rags-mcp-4p3sb.26). A map keeps its head; an element with no nominal
 * name (a tuple, a `dyn` trait) gives no type. By constructor: a struct literal (`X { … }`) and a
 * `X::new(…)` call (the path before `::new`, turbofish dropped); any other
 * associated function (`Default::default()`) is joined at sink time. A `let`
 * bound to a call or macro carries its callee, split the way the walker splits
 * its `CallRef`, seen through `?`, `.await` and `&`.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierBoundCallee } from "../../../../../contracts/types/codegraph.js";
import {
  boundCalleeFromCallShape,
  elementOfCollection,
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "../../../kernel/index.js";
import { rustCallSiteShape } from "../walker.js";

/** Pattern nodes whose bound names sit below them; literals and paths bind nothing. */
const DESTRUCTURING_PATTERNS = new Set([
  "tuple_pattern",
  "tuple_struct_pattern",
  "struct_pattern",
  "field_pattern",
  "slice_pattern",
  "ref_pattern",
  "mut_pattern",
  "captured_pattern",
  "or_pattern",
  "reference_pattern",
]);

function boundNameNodes(pattern: AstNode): AstNode[] {
  const names: AstNode[] = [];
  const stack: AstNode[] = [pattern];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "identifier" || node.type === "shorthand_field_identifier") {
      names.push(node);
      continue;
    }
    if (!DESTRUCTURING_PATTERNS.has(node.type)) continue;
    // A tuple-struct / struct pattern's path (`Some`, `Point`) is its first child
    // and binds nothing; a `field_pattern` binds through its pattern, not its name.
    const children = node.namedChildren.filter(
      (child, i) =>
        !((node.type === "tuple_struct_pattern" || node.type === "struct_pattern") && i === 0) &&
        !(node.type === "field_pattern" && child.type === "field_identifier"),
    );
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return names;
}

function bindingSites(
  pattern: AstNode | null,
  kind: DeclaredIdentifierSite["kind"],
  typeNode: AstNode | null,
  valueNode: AstNode | null,
): DeclaredIdentifierSite[] {
  if (pattern === null) return [];
  if (pattern.type === "identifier") return [{ nameNode: pattern, kind, typeNode, valueNode }];
  return boundNameNodes(pattern).map((nameNode) => ({ nameNode, kind }));
}

function parameterSites(node: AstNode): DeclaredIdentifierSite[] {
  return bindingSites(node.childForFieldName("pattern"), "param", node.childForFieldName("type"), null);
}

const parameterRule: IdentifierDeclarationRule = { nodeType: "parameter", collect: parameterSites };

/**
 * `|k: Key, z|` — a typed closure param is a `parameter`, a bare one a pattern.
 * Both are read here, in order; the `parameter` rule meeting `k` again later is
 * a duplicate the pass drops.
 */
const closureParametersRule: IdentifierDeclarationRule = {
  nodeType: "closure_parameters",
  collect: (node) =>
    node.namedChildren.flatMap((child) =>
      child.type === "parameter" ? parameterSites(child) : bindingSites(child, "param", null, null),
    ),
};

const letRule: IdentifierDeclarationRule = {
  nodeType: "let_declaration",
  collect: (node) =>
    bindingSites(
      node.childForFieldName("pattern"),
      "local",
      node.childForFieldName("type"),
      node.childForFieldName("value"),
    ),
};

/**
 * Generic heads whose annotation names its first type argument, matched on the
 * final path segment: the collections, which hold MANY of it, and the wrappers
 * of one value.
 */
const COLLECTION_HEADS = new Set(["Vec", "VecDeque", "HashSet", "BTreeSet"]);
const ELEMENT_NAMING_HEADS = new Set([...COLLECTION_HEADS, "Option", "Box", "Rc", "Arc"]);

/** The first type argument of a `generic_type`, lifetimes skipped; read positionally. */
function firstTypeArgument(generic: AstNode): AstNode | null {
  const args = generic.namedChildren.find((child) => child.type === "type_arguments");
  return args?.namedChildren.find((child) => child.type !== "lifetime") ?? null;
}

/**
 * `Repo` / `&'a mut Db` / `HashMap<K, V>` → `HashMap` / `std::sync::Pool` → the
 * nominal name; a collection or wrapper (`Vec<Item>`, `Option<Box<Repo>>`) and a
 * slice (`&[Item]`) → the element, many for a collection or a slice (bd
 * tea-rags-mcp-4p3sb.26); tuples, fixed arrays, fns → none.
 */
function rustAnnotationType(node: AstNode): IdentifierSyntacticType | undefined {
  switch (node.type) {
    case "type_identifier":
    case "primitive_type":
    case "scoped_type_identifier":
      return { typeName: node.text };
    case "reference_type": {
      const inner = node.childForFieldName("type");
      return inner ? rustAnnotationType(inner) : undefined;
    }
    case "generic_type": {
      const base = node.childForFieldName("type");
      const head = base ? rustAnnotationType(base)?.typeName : undefined;
      if (head === undefined) return undefined;
      const finalSegment = head.slice(head.lastIndexOf(":") + 1);
      if (!ELEMENT_NAMING_HEADS.has(finalSegment)) return { typeName: head };
      const element = firstTypeArgument(node);
      return elementOfCollection(element ? rustAnnotationType(element) : undefined, COLLECTION_HEADS.has(finalSegment));
    }
    case "array_type": {
      // A slice `[T]` only — a fixed array `[T; N]` carries its `;`. The element
      // is read by position, not as the `element` field, for the same reason
      // Java's `array_type` is: the materialization guard surveys field names
      // across every grammar.
      if (node.children.some((child) => child.type === ";")) return undefined;
      const element = node.namedChildren[0];
      return elementOfCollection(element ? rustAnnotationType(element) : undefined, true);
    }
    default:
      return undefined;
  }
}

/** A path used as a constructor owner: `Widget`, `crate::ui::Panel`, `Wrapper::<u8>` → `Wrapper`. */
function constructorPathName(path: AstNode): string | undefined {
  switch (path.type) {
    case "identifier":
    case "type_identifier":
    case "scoped_identifier":
    case "scoped_type_identifier":
      return path.text;
    case "generic_type":
    case "generic_type_with_turbofish": {
      const base = path.childForFieldName("type");
      return base ? constructorPathName(base) : undefined;
    }
    default:
      return undefined;
  }
}

/** The constructed type, by its path — `Vec::new()` constructs a `Vec`, never a collection's element. */
function rustConstructorType(value: AstNode): IdentifierSyntacticType | undefined {
  const typeName = rustConstructorTypeName(value);
  return typeName === undefined ? undefined : { typeName };
}

function rustConstructorTypeName(value: AstNode): string | undefined {
  switch (value.type) {
    case "reference_expression": {
      const inner = value.childForFieldName("value");
      return inner ? rustConstructorTypeName(inner) : undefined;
    }
    case "struct_expression": {
      const name = value.childForFieldName("name");
      return name ? constructorPathName(name) : undefined;
    }
    case "call_expression": {
      const callee = value.childForFieldName("function");
      if (callee?.type !== "scoped_identifier" || callee.childForFieldName("name")?.text !== "new") return undefined;
      const path = callee.childForFieldName("path");
      return path ? constructorPathName(path) : undefined;
    }
    default:
      return undefined;
  }
}

/** Wrappers a call's value passes through unchanged in kind: `f()?`, `f().await`, `&f()`. */
const CALL_WRAPPER_TYPES = new Set(["try_expression", "await_expression", "reference_expression"]);

function rustBoundCallee(value: AstNode): IdentifierBoundCallee | undefined {
  let call: AstNode | null = value;
  while (call !== null && CALL_WRAPPER_TYPES.has(call.type)) {
    // `&mut f()` — the operand is the last named child, after any `mutable_specifier`.
    call = call.namedChildren.at(-1) ?? null;
  }
  return call === null ? undefined : boundCalleeFromCallShape(rustCallSiteShape(call));
}

/** The implementing type of the `impl` block `fn` sits directly in; null outside one (a trait's `Self` is open). */
function enclosingImplType(fn: AstNode): AstNode | null {
  const impl = fn.parent?.parent;
  return impl?.type === "impl_item" ? impl.childForFieldName("type") : null;
}

/**
 * `fn f(…) -> T` — the fn's return, as a `return` of the fn itself (bd
 * tea-rags-mcp-4p3sb.21). An `async fn`'s written type is already what
 * `.await` yields. A return naming `Self` (`-> Self`, `-> Option<Self>`) names
 * the impl's type instead — `Svc::with_config(c)` builds a `Svc`, the most
 * common constructor shape after `new`. A `Result<T, E>` keeps its head, as a
 * `Result` parameter does: the join cannot see a `?`.
 */
const returnRule: IdentifierDeclarationRule = {
  nodeType: "function_item",
  collect: (node) => {
    const nameNode = node.childForFieldName("name");
    if (nameNode === null) return [];
    const written = node.childForFieldName("return_type");
    const typeNode =
      written !== null && rustAnnotationType(written)?.typeName === "Self" ? enclosingImplType(node) : written;
    return [{ nameNode, kind: "return", typeNode }];
  },
};

export const RUST_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    parameterRule,
    closureParametersRule,
    letRule,
    fieldRule("field_declaration", "field", { name: "name", type: "type" }),
    returnRule,
  ],
  annotationType: rustAnnotationType,
  constructorType: rustConstructorType,
  boundCalleeOf: rustBoundCallee,
};
