/**
 * Python's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.3) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: def parameters (`self` included — it is a
 * declaration), locals and `self.<attr>` fields declared by a plain assignment.
 *
 * The annotation type is the WRITTEN head: `list[Job]` names `list`, the way the
 * lexicon groups names by the type a reader sees, not by the element the
 * resolver would unwrap. A constructor is a call whose final segment is
 * CapWords (`Document()`, `models.Invoice()`) — PEP 8's class spelling; a
 * lowercase callee's type is joined at sink time from the return-type channels.
 * Multiple assignment (`a, b = …`), augmented assignment and an attribute on
 * anything but `self` declare nothing.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";

/** Splat patterns wrap their identifier with no field name. */
const SPLAT_PATTERN_TYPES = new Set(["list_splat_pattern", "dictionary_splat_pattern"]);

function splatName(node: AstNode): AstNode | null {
  return node.namedChildren.find((child) => child.type === "identifier") ?? null;
}

/** A parameter list entry → its declared-name node and annotation, or null for `*` / `/` separators. */
function parameterSite(param: AstNode): DeclaredIdentifierSite | null {
  switch (param.type) {
    case "identifier":
      return { nameNode: param, kind: "param" };
    case "list_splat_pattern":
    case "dictionary_splat_pattern": {
      const nameNode = splatName(param);
      return nameNode ? { nameNode, kind: "param" } : null;
    }
    case "default_parameter":
    case "typed_default_parameter": {
      const nameNode = param.childForFieldName("name");
      return nameNode ? { nameNode, kind: "param", typeNode: param.childForFieldName("type") } : null;
    }
    case "typed_parameter": {
      // The name is the first named child, not a field: `repo: Repo`, `*args: int`.
      const head = param.namedChild(0);
      const nameNode = head && SPLAT_PATTERN_TYPES.has(head.type) ? splatName(head) : head;
      return nameNode?.type === "identifier"
        ? { nameNode, kind: "param", typeNode: param.childForFieldName("type") }
        : null;
    }
    default:
      return null;
  }
}

function parameterSites(list: AstNode): DeclaredIdentifierSite[] {
  return list.namedChildren.map(parameterSite).filter((site) => site !== null);
}

const localAssignmentRule = fieldRule("assignment", "local", { name: "left", type: "type", value: "right" });

const assignmentRule: IdentifierDeclarationRule = {
  nodeType: "assignment",
  collect: (node) => {
    const left = node.childForFieldName("left");
    if (left?.type === "identifier") return localAssignmentRule.collect(node);
    if (left?.type !== "attribute" || left.childForFieldName("object")?.text !== "self") return [];
    const nameNode = left.childForFieldName("attribute");
    return nameNode ? [{ nameNode, kind: "field", valueNode: node.childForFieldName("right") }] : [];
  },
};

/** The written head of an annotation: `Repo`, `models.Repo`, `list[Job]` → `list`, `"Repo"` → `Repo`. */
function pythonAnnotationTypeName(typeNode: AstNode): string | undefined {
  const inner = typeNode.type === "type" ? typeNode.namedChild(0) : typeNode;
  if (inner === null) return undefined;
  switch (inner.type) {
    case "identifier":
    case "attribute":
    case "dotted_name":
      return inner.text;
    case "subscript":
    case "generic_type": {
      const head = inner.childForFieldName("value") ?? inner.namedChild(0);
      return head === null ? undefined : pythonAnnotationTypeName(head);
    }
    case "string": {
      const unquoted = /^(["'])([A-Za-z_][\w.]*)(?:\[.*\])?\1$/.exec(inner.text);
      return unquoted?.[2];
    }
    default:
      return undefined;
  }
}

/** `Document()` / `models.Invoice()` → the callee as written, gated on a CapWords final segment. */
function pythonConstructorTypeName(value: AstNode): string | undefined {
  if (value.type !== "call") return undefined;
  const callee = value.childForFieldName("function");
  if (callee?.type !== "identifier" && callee?.type !== "attribute") return undefined;
  const finalSegment = callee.text.slice(callee.text.lastIndexOf(".") + 1);
  return /^[A-Z]/.test(finalSegment) ? callee.text : undefined;
}

export const PYTHON_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    { nodeType: "parameters", collect: parameterSites },
    { nodeType: "lambda_parameters", collect: parameterSites },
    assignmentRule,
  ],
  annotationTypeName: pythonAnnotationTypeName,
  constructorTypeName: pythonConstructorTypeName,
};
