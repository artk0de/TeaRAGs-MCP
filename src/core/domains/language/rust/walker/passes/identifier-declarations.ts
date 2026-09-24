/**
 * Rust's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.5) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: function and closure parameters, `let` locals and
 * named struct fields. `self` is a `self_parameter`, not a `parameter`: the
 * language fixes its name, so it says nothing about how this project names
 * things.
 *
 * A plain `name` / `mut name` binding keeps its annotation and initializer; a
 * destructuring pattern (`(a, b)`, `Point { x, y }`) binds each name as its own
 * untyped site, since the annotation types the whole pattern.
 *
 * The annotation type strips `&`, `mut` and lifetimes and drops generic
 * arguments (`Vec<Item>` → `Vec`), keeping a path as written
 * (`std::sync::Pool`). By constructor: a struct literal (`X { … }`) and a
 * `X::new(…)` call (the path before `::new`, turbofish dropped); any other
 * associated function (`Default::default()`) is joined at sink time.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";

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

/** `Repo` / `&'a mut Db` / `Vec<Item>` / `std::sync::Pool` → the nominal name; tuples, arrays, fns → none. */
function rustAnnotationTypeName(node: AstNode): string | undefined {
  switch (node.type) {
    case "type_identifier":
    case "primitive_type":
    case "scoped_type_identifier":
      return node.text;
    case "reference_type":
    case "generic_type": {
      const inner = node.childForFieldName("type");
      return inner ? rustAnnotationTypeName(inner) : undefined;
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

export const RUST_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    parameterRule,
    closureParametersRule,
    letRule,
    fieldRule("field_declaration", "field", { name: "name", type: "type" }),
  ],
  annotationTypeName: rustAnnotationTypeName,
  constructorTypeName: rustConstructorTypeName,
};
