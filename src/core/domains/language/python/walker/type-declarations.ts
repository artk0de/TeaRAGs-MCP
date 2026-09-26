/**
 * Python type and constant declarations — the `typeDeclarations` channel
 * (bd tea-rags-mcp-vi0wx, spec §1b). Naming data only: the Python capability
 * does not set `resolverReadsTypeDeclarations`, so nothing here reaches call
 * resolution.
 *
 * One fact per:
 *   - `class` — an `enum` when a base names `Enum` / `IntEnum` / `StrEnum` /
 *     `Flag`, an `interface` when a base names `Protocol`, a `class` otherwise;
 *   - type alias — `X: TypeAlias = …`, PEP 695 `type X = …`, `X = NewType(…)`;
 *   - module-level constant — an UPPER_CASE assignment, or one annotated
 *     `Final` whatever its case. A class-body UPPER_CASE name is a class
 *     attribute (an enum member, a Django setting), not a file-level constant.
 *
 * A declaration inside a `def` or a `lambda` is a local and is skipped — the
 * same boundary `pyNameOf` draws, which composes no symbol there either. The
 * `typeId` is the name under every enclosing class, joined with `.`, as
 * `collectSymbols` composes a nested class (`Outer.Inner`).
 *
 * An UPPER_CASE name bound to `TypeVar(…)` / `ParamSpec(…)` / `TypeVarTuple(…)`
 * is a type parameter, not a constant, and is skipped. A name declared twice
 * at one scope (`try: X = 1 / except: X = 2`) keeps its FIRST declaration,
 * matching the first-occurrence dedup `collectSymbols` applies to symbols.
 */

import { isSameAstNode, type AstNode } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type { TypeDeclarationFact } from "../../../../contracts/types/codegraph.js";

const ENUM_BASES = new Set(["Enum", "IntEnum", "StrEnum", "Flag"]);
const PROTOCOL_BASE = "Protocol";
const TYPE_PARAMETER_FACTORIES = new Set(["TypeVar", "ParamSpec", "TypeVarTuple"]);
/** `MAX_RETRIES`, `_DEFAULT`, `T`; never a dunder (`__all__`) — it carries a lower-case letter. */
const UPPER_CASE = /^_*[A-Z][A-Z0-9_]*$/;
/** Scopes whose body is a function body — a declaration there is a LOCAL. */
const LOCAL_SCOPES = new Set(["function_definition", "lambda"]);

/**
 * The last dotted segment of a name as written, subscript dropped:
 * `mixins.Loggable` → `Loggable`, `Final[int]` → `Final`, `typing.TypeAlias` → `TypeAlias`.
 */
function lastSegment(text: string): string {
  const head = text.split("[", 1)[0] ?? "";
  const segments = head.split(".");
  return (segments[segments.length - 1] ?? "").trim();
}

/**
 * The names of the classes enclosing `node`, outermost first, or `null` when a
 * `def` / `lambda` encloses it — the declaration is then a local.
 */
function enclosingClasses(node: AstNode): string[] | null {
  const classes: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (LOCAL_SCOPES.has(current.type)) return null;
    if (current.type !== "class_definition") continue;
    const name = current.childForFieldName("name")?.text;
    if (name !== undefined) classes.unshift(name);
  }
  return classes;
}

/** The class's bases as written, last segment of a dotted base, generic arguments dropped; keyword arguments skipped. */
function pythonBaseNames(node: AstNode): string[] {
  const supers = node.childForFieldName("superclasses");
  if (!supers) return [];
  const out: string[] = [];
  for (const base of supers.namedChildren) {
    const named = base.type === "subscript" ? base.childForFieldName("value") : base;
    if (!named) continue;
    if (named.type !== "identifier" && named.type !== "attribute" && named.type !== "dotted_name") continue;
    const name = lastSegment(named.text);
    if (name.length > 0) out.push(name);
  }
  return out;
}

function classKind(conforms: readonly string[]): SymbolDefinitionKind {
  if (conforms.some((base) => ENUM_BASES.has(base))) return "enum";
  if (conforms.includes(PROTOCOL_BASE)) return "interface";
  return "class";
}

/** The callee's last segment when `node` is a call, else `undefined`: `typing.NewType("X", int)` → `NewType`. */
function calleeName(node: AstNode | null): string | undefined {
  if (node?.type !== "call") return undefined;
  const fn = node.childForFieldName("function");
  return fn ? lastSegment(fn.text) : undefined;
}

/**
 * Is `node` an assignment STATEMENT — its own `expression_statement`, or the
 * right side of a chained `A = B = 7`? An assignment nested anywhere else (a
 * keyword default, a comprehension) declares nothing at this scope.
 */
function isAssignmentStatement(node: AstNode): boolean {
  const { parent } = node;
  if (!parent) return false;
  if (parent.type === "expression_statement") return true;
  if (parent.type !== "assignment") return false;
  return isSameAstNode(parent.childForFieldName("right"), node);
}

/** The kind an `assignment` declares, or `undefined` when it declares no fact. */
function assignmentKind(node: AstNode, name: string, atModuleLevel: boolean): SymbolDefinitionKind | undefined {
  const annotation = node.childForFieldName("type");
  const annotationHead = annotation ? lastSegment(annotation.text) : undefined;
  if (annotationHead === "TypeAlias") return "type_alias";
  const right = node.childForFieldName("right");
  if (right === null) return undefined;
  const callee = calleeName(right);
  if (callee === "NewType") return "type_alias";
  if (!atModuleLevel) return undefined;
  if (annotationHead === "Final") return "constant";
  if (!UPPER_CASE.test(name)) return undefined;
  if (callee !== undefined && TYPE_PARAMETER_FACTORIES.has(callee)) return undefined;
  return "constant";
}

/** The fact `node` declares, or `null` for a node that declares none. */
function typeDeclarationOf(node: AstNode): TypeDeclarationFact | null {
  if (node.type !== "class_definition" && node.type !== "type_alias_statement" && node.type !== "assignment") {
    return null;
  }
  if (node.type === "assignment" && !isAssignmentStatement(node)) return null;
  const enclosing = enclosingClasses(node);
  if (enclosing === null) return null;
  const line = node.startPosition.row + 1;
  if (node.type === "class_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name === undefined) return null;
    const conforms = pythonBaseNames(node);
    return {
      typeId: [...enclosing, name].join("."),
      symbolKind: classKind(conforms),
      line,
      reopens: false,
      ...(conforms.length > 0 ? { conforms } : {}),
    };
  }
  if (node.type === "type_alias_statement") {
    const left = node.childForFieldName("left");
    const name = left ? lastSegment(left.text) : "";
    if (name.length === 0) return null;
    return { typeId: [...enclosing, name].join("."), symbolKind: "type_alias", line, reopens: false };
  }
  const left = node.childForFieldName("left");
  if (left?.type !== "identifier") return null;
  const kind = assignmentKind(node, left.text, enclosing.length === 0);
  if (kind === undefined) return null;
  return { typeId: [...enclosing, left.text].join("."), symbolKind: kind, line, reopens: false };
}

/**
 * A flat-descent visitor for `walkOnce` filling `out` with the file's type and
 * constant declarations in source (pre-)order, first declaration of an id kept.
 */
export function collectPythonTypeDeclarations(out: TypeDeclarationFact[]): (node: AstNode) => void {
  const seen = new Set<string>();
  return (node) => {
    const fact = typeDeclarationOf(node);
    if (fact === null || seen.has(fact.typeId)) return;
    seen.add(fact.typeId);
    out.push(fact);
  };
}

/**
 * A statement container the module scope reaches through: a `block`, a clause
 * (`else_clause`, `except_clause`, …), or a compound statement (`if_statement`,
 * `try_statement`, `with_statement`, …). A `def` / `class` cannot occur in a
 * file this answers for — both are extraction-bearing — so no local scope is
 * ever entered.
 */
function isStatementContainer(type: string): boolean {
  return type === "block" || type.endsWith("_clause") || type.endsWith("_statement");
}

/**
 * The module-scope declarations of a file the extraction gate calls INERT —
 * the `typeDeclarations` half of `LanguageWalker.inertFileExtraction`
 * (`pythonInertFileExtraction`), read off the NATIVE root so the file is never
 * materialized (netbox's 111k-line `un_locode.py` is one such
 * file, and materializing it is what the gate exists to avoid).
 *
 * It visits statements only: the root's children and, through a module-level
 * `if` / `try` / `with` / `for`, their blocks — never an expression, so a data
 * table's right-hand side costs nothing. Each assignment statement (with the
 * `A = B = …` chain) and each `type X = …` is handed, in pre-order, to the SAME
 * visitor {@link collectPythonTypeDeclarations} gives the full walk, so the two
 * paths share one owner of the rules and answer alike for any inert file.
 */
export function collectPythonModuleTypeDeclarations(root: AstNode): TypeDeclarationFact[] {
  const out: TypeDeclarationFact[] = [];
  const visit = collectPythonTypeDeclarations(out);
  const scan = (container: AstNode): void => {
    for (const child of container.namedChildren) {
      if (child.type === "expression_statement") {
        for (const expression of child.namedChildren) {
          for (let link: AstNode | null = expression; link?.type === "assignment"; ) {
            visit(link);
            link = link.childForFieldName("right");
          }
        }
      } else if (child.type === "type_alias_statement") {
        visit(child);
      } else if (isStatementContainer(child.type)) {
        scan(child);
      }
    }
  };
  scan(root);
  return out;
}
