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
 * Every other class that declares behaviour of its own is concrete. A class
 * whose body is only an `__init__`, field assignments and property accessors
 * declares no behaviour (bd tea-rags-mcp-44cpv, decision c-1=a: an Exception
 * subclass, a dataclass, an enum of constants; `pass` is the degenerate case)
 * and counts as neither. The reading is by NAME, as written: a class
 * inheriting its abstractness from a project base that is itself an `ABC`
 * declares nothing of its own and counts as concrete, which is what it is
 * unless it leaves an `@abstractmethod` open.
 *
 * The behaviour-free member rule: `__init__` is the constructor, `@property` /
 * `@cached_property` / `@x.setter`-family accessors are data, and every other
 * def — `@classmethod`, `@staticmethod` included — is behaviour. A statement
 * that is not a def of its own can still hold one (`if` / `try` in a class
 * body conditionally define methods), so the scan recurses into statements,
 * stopping at def and class boundaries: their interiors belong to them.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { TypeAbstractnessCensus } from "../../../../../contracts/types/codegraph.js";
import {
  isBehaviourFreeClassBody,
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
const ACCESSOR_PROPERTY_NAMES: ReadonlySet<string> = new Set(["property", "cached_property"]);
const ACCESSOR_TWIN_MEMBERS: ReadonlySet<string> = new Set(["setter", "deleter", "getter"]);

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

/** `@property` / `@cached_property` / `@x.setter` / `@x.deleter` / `@x.getter` — an accessor, data not behaviour. */
function decoratorIsAccessor(decorator: AstNode): boolean {
  const name = lastSegment(decorator.namedChildren[0]);
  return ACCESSOR_PROPERTY_NAMES.has(name ?? "") || ACCESSOR_TWIN_MEMBERS.has(name ?? "");
}

/** Whether one class-body statement declares behaviour; see the module doc. */
function classMemberDeclaresBehaviour(member: AstNode): boolean {
  if (member.type === "function_definition") return member.childForFieldName("name")?.text !== "__init__";
  if (member.type === "decorated_definition") {
    const decorators = member.namedChildren.filter((c) => c.type === "decorator");
    if (decorators.some((d) => decoratorIsAccessor(d))) return false;
    const definition = member.childForFieldName("definition");
    if (definition?.type !== "function_definition") return false;
    return definition.childForFieldName("name")?.text !== "__init__";
  }
  if (member.type === "class_definition") return false;
  return member.namedChildren.some(classMemberDeclaresBehaviour);
}

export const readPythonTypeAbstractness: TypeAbstractnessReader = (node) => {
  if (node.type !== "class_definition") return null;
  if (
    declaresAbstractBase(node.childForFieldName("superclasses")) ||
    declaresAbstractMethod(node.childForFieldName("body"))
  ) {
    return "abstract";
  }
  return isBehaviourFreeClassBody(node.childForFieldName("body"), classMemberDeclaresBehaviour) ? null : "concrete";
};

/**
 * The census of a file the extraction gate calls inert, answered without a
 * traversal. {@link readPythonTypeAbstractness} counts `class_definition` alone,
 * an extraction-bearing node type, so an inert file holds no node it counts and
 * the walk's census over it is exactly 0/0 — still a census, which the store
 * keeps apart from NULL. The type-declarations walker test pins the premise over
 * every node type of the grammar, so the reader cannot start counting a
 * non-bearing type unnoticed.
 */
export function pythonInertFileTypeAbstractness(): TypeAbstractnessCensus {
  return { abstractTypeCount: 0, concreteTypeCount: 0 };
}

export const pythonTypeAbstractnessFacetPass: ExtractionFacetPass =
  typeAbstractnessFacetPass(readPythonTypeAbstractness);
