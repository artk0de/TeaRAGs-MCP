/**
 * Python's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.3) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: def parameters (`self` included — it is a
 * declaration), locals and `self.<attr>` fields declared by a plain assignment.
 *
 * The annotation type is the written head, except that a sequence, a set, a
 * tuple and `Optional` name their ELEMENT (`list[Job]` → `Job`,
 * `Optional[Repo]` → `Repo`) — the lexicon groups `jobs` with `Job`, as Go's
 * slices and Java's arrays already do; a mapping keeps its head (`dict`). A
 * collection's element is marked `many`, as is a `*args` / `**kwargs` parameter,
 * which collects its annotation's values (bd tea-rags-mcp-4p3sb.26). A
 * local or field bound to a call carries that call's callee, split the way the
 * walker splits its `CallRef`, `await` seen through. A constructor is a call
 * whose final segment is
 * CapWords (`Document()`, `models.Invoice()`) — PEP 8's class spelling; a
 * lowercase callee's type is joined at sink time from the return-type channels.
 * Multiple assignment (`a, b = …`), augmented assignment and an attribute on
 * anything but `self` declare nothing.
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
import { pythonCalleeMemberReceiver } from "../walker.js";

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
      return nameNode ? { nameNode, kind: "param", typeMultiplicity: "many" } : null;
    }
    case "default_parameter":
    case "typed_default_parameter": {
      const nameNode = param.childForFieldName("name");
      return nameNode ? { nameNode, kind: "param", typeNode: param.childForFieldName("type") } : null;
    }
    case "typed_parameter": {
      // The name is the first named child, not a field: `repo: Repo`, `*args: int`.
      // A splat collects its annotation's values: `*args: Doc` holds many `Doc`s.
      const head = param.namedChild(0);
      const isSplat = head !== null && SPLAT_PATTERN_TYPES.has(head.type);
      const nameNode = isSplat ? splatName(head) : head;
      if (nameNode?.type !== "identifier") return null;
      const typeNode = param.childForFieldName("type");
      return isSplat
        ? { nameNode, kind: "param", typeNode, typeMultiplicity: "many" }
        : { nameNode, kind: "param", typeNode };
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

/**
 * Generic heads whose annotation names its first type argument, matched on the
 * final segment (`typing.List`): the collections, which hold MANY of it, and
 * `Optional`, which wraps one.
 */
const COLLECTION_HEADS = new Set(["list", "List", "Sequence", "Iterable", "set", "Set", "tuple", "Tuple"]);
const ELEMENT_NAMING_HEADS = new Set([...COLLECTION_HEADS, "Optional"]);

/** The first type argument: `generic_type`'s `type_parameter` list, or a `subscript`'s first index. */
function firstTypeArgument(node: AstNode): AstNode | null {
  if (node.type === "generic_type") {
    return node.namedChildren.find((child) => child.type === "type_parameter")?.namedChild(0) ?? null;
  }
  return node.namedChildren[1] ?? null;
}

/**
 * The type an annotation names: `Repo`, `models.Repo`, `"Repo"` → `Repo`, a
 * generic by its head (`dict[str, Job]` → `dict`) — except a sequence / set /
 * tuple / `Optional`, which names its element (`list[Job]` → `Job`) — many for
 * a collection, one for `Optional` (bd tea-rags-mcp-4p3sb.26).
 */
function pythonAnnotationType(typeNode: AstNode): IdentifierSyntacticType | undefined {
  const inner = typeNode.type === "type" ? typeNode.namedChild(0) : typeNode;
  if (inner === null) return undefined;
  switch (inner.type) {
    case "identifier":
    case "attribute":
    case "dotted_name":
      return { typeName: inner.text };
    case "subscript":
    case "generic_type": {
      const head = inner.childForFieldName("value") ?? inner.namedChild(0);
      const headRead = head === null ? undefined : pythonAnnotationType(head);
      if (headRead === undefined) return undefined;
      const finalSegment = headRead.typeName.slice(headRead.typeName.lastIndexOf(".") + 1);
      if (!ELEMENT_NAMING_HEADS.has(finalSegment)) return headRead;
      const element = firstTypeArgument(inner);
      return elementOfCollection(
        element === null ? undefined : pythonAnnotationType(element),
        COLLECTION_HEADS.has(finalSegment),
      );
    }
    case "string": {
      const unquoted = /^(["'])([A-Za-z_][\w.]*)(?:\[.*\])?\1$/.exec(inner.text);
      return unquoted === null ? undefined : { typeName: unquoted[2] };
    }
    default:
      return undefined;
  }
}

/** `Document()` / `models.Invoice()` → the callee as written, gated on a CapWords final segment. */
function pythonConstructorType(value: AstNode): IdentifierSyntacticType | undefined {
  if (value.type !== "call") return undefined;
  const callee = value.childForFieldName("function");
  if (callee?.type !== "identifier" && callee?.type !== "attribute") return undefined;
  const finalSegment = callee.text.slice(callee.text.lastIndexOf(".") + 1);
  return /^[A-Z]/.test(finalSegment) ? { typeName: callee.text } : undefined;
}

/** `f(x)` / `obj.m(x)` / `await obj.m(x)` → the callee as the walker's `CallRef` splits it. */
function pythonBoundCallee(value: AstNode): IdentifierBoundCallee | undefined {
  const call = value.type === "await" ? value.namedChild(0) : value;
  const fn = call?.type === "call" ? call.childForFieldName("function") : null;
  if (fn?.type !== "identifier" && fn?.type !== "attribute") return undefined;
  return boundCalleeFromCallShape(pythonCalleeMemberReceiver(fn));
}

/**
 * `def f(…) -> T:` — the def's return, read like a parameter annotation (bd
 * tea-rags-mcp-4p3sb.21). An `async def`'s annotation is already what `await
 * f()` yields, so it needs no unwrapping.
 */
const returnRule = fieldRule("function_definition", "return", { name: "name", type: "return_type" });

export const PYTHON_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    { nodeType: "parameters", collect: parameterSites },
    { nodeType: "lambda_parameters", collect: parameterSites },
    assignmentRule,
    returnRule,
  ],
  annotationType: pythonAnnotationType,
  constructorType: pythonConstructorType,
  boundCalleeOf: pythonBoundCallee,
};
