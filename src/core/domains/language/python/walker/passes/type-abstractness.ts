/**
 * Python type-abstractness census (bd tea-rags-mcp-r8hme.8). A class is
 * abstract when it declares itself so:
 *
 *   - a base named `ABC` or `Protocol` — bare, module-qualified
 *     (`abc.ABC`, `typing.Protocol`) or subscripted (`Protocol[T]`);
 *   - an `ABCMeta` metaclass (`metaclass=ABCMeta` / `abc.ABCMeta`);
 *   - a method of its own body decorated `@abstractmethod` (or the legacy
 *     `abstractproperty` / `abstractclassmethod` / `abstractstaticmethod`).
 *
 * Every other class is concrete. The reading is by NAME, as written: a class
 * inheriting its abstractness from a project base that is itself an `ABC`
 * declares nothing of its own and counts as concrete, which is what it is
 * unless it leaves an `@abstractmethod` open.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";

const ABSTRACT_BASE_NAMES: ReadonlySet<string> = new Set(["ABC", "Protocol"]);
const ABSTRACT_METACLASS_NAMES: ReadonlySet<string> = new Set(["ABCMeta"]);
const ABSTRACT_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  "abstractmethod",
  "abstractproperty",
  "abstractclassmethod",
  "abstractstaticmethod",
]);

/** The last segment of a name as written: `Protocol`, `typing.Protocol`, `Protocol[T]` → `Protocol`. */
function lastSegment(node: AstNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return node.childForFieldName("attribute")?.text;
  if (node.type === "subscript") return lastSegment(node.childForFieldName("value"));
  if (node.type === "call") return lastSegment(node.childForFieldName("function"));
  return undefined;
}

function declaresAbstractBase(superclasses: AstNode | null): boolean {
  if (!superclasses) return false;
  return superclasses.namedChildren.some((arg) => {
    if (arg.type === "keyword_argument") {
      return (
        arg.childForFieldName("name")?.text === "metaclass" &&
        ABSTRACT_METACLASS_NAMES.has(lastSegment(arg.childForFieldName("value")) ?? "")
      );
    }
    return ABSTRACT_BASE_NAMES.has(lastSegment(arg) ?? "");
  });
}

function declaresAbstractMethod(body: AstNode | null): boolean {
  if (!body) return false;
  return body.namedChildren.some(
    (statement) =>
      statement.type === "decorated_definition" &&
      statement.namedChildren.some(
        (d) => d.type === "decorator" && ABSTRACT_DECORATOR_NAMES.has(lastSegment(d.namedChildren[0]) ?? ""),
      ),
  );
}

export const readPythonTypeAbstractness: TypeAbstractnessReader = (node) => {
  if (node.type !== "class_definition") return null;
  return declaresAbstractBase(node.childForFieldName("superclasses")) ||
    declaresAbstractMethod(node.childForFieldName("body"))
    ? "abstract"
    : "concrete";
};

export const pythonTypeAbstractnessFacetPass: ExtractionFacetPass =
  typeAbstractnessFacetPass(readPythonTypeAbstractness);
