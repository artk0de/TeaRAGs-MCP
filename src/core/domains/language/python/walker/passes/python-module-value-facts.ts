/**
 * Module-level value facts (P4, bd tea-rags-mcp-m99j1.1.15).
 *
 * `apps = Apps(installed_apps=None)` at the bottom of `django/apps/registry.py`
 * is what `from django.apps import apps` binds in every caller, and
 * `connections = ConnectionHandler()` in `django/db/__init__.py` is what every
 * function of that module reads as a global. No symbol carries either name and
 * the per-chunk `localBindings` reach only the chunk that holds the statement,
 * so `apps.populate(x)` had no receiver type anywhere. This source emits a
 * `moduleValue` fact for each MODULE-scope assignment the walker's own rule
 * types ({@link pythonAssignmentBoundType} — a PEP 526 annotation, else a
 * CapWords constructor call); `pythonTypeChannels` publishes them run-global as
 * `moduleValueTypes["<relPath>::<name>"]`.
 *
 * Module scope is the file's statements and every block that does not open a
 * scope — `if` / `try` / `with` / `for` bodies. A `def`, `class` or `lambda`
 * body is never read: an assignment there is a local or a class attribute.
 *
 * A name is published only when module scope binds it to ONE knowable type.
 * Every other way a module rebinds a name REFUSES it outright, because the
 * fact is read from functions that run at an unknown point after import:
 * `client = None` beside `client = Client()`, an augmented assignment, a `for`
 * / `with` / tuple target, an import, a `def` / `class` of the same name, or a
 * `global client` in any function. Two typed assignments that disagree are
 * the store's to refuse (`TypeFactStore#moduleValueTypesMap`), since an
 * annotation outranks a constructor on precedence rather than on order.
 *
 * An ANNOTATED name is published only when the annotation's head is a name
 * module scope binds to a class or a module — an import or a `class`
 * statement. `TIMEOUT: int = 5` and `X: Final = ...` type nothing a resolver
 * can reach, and the rule keeps an inert module (no import, no class, no call)
 * factless, which the walker's inert fast path relies on.
 *
 * Gated by `CODEGRAPH_PY_MODULE_VALUES` (default on), read once per file by
 * the facet pass and handed in as `PythonTypeSourceInput.moduleValues`.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/index.js";
import { pythonAssignmentBoundType } from "../walker.js";
import { PYTHON_ANNOTATION_SOURCE, type PythonTypeSourceInput } from "./python-annotation-type-source.js";
import { PYTHON_AST_SOURCE } from "./python-ast-type-source.js";

export const PYTHON_MODULE_VALUES_ENV = "CODEGRAPH_PY_MODULE_VALUES";

/** `CODEGRAPH_PY_MODULE_VALUES` — default ON; `false` / `0` switch the channel off. */
export function pythonModuleValuesEnabled(): boolean {
  const raw = process.env[PYTHON_MODULE_VALUES_ENV];
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

/** Nodes whose body is a NEW scope — nothing assigned inside binds a module name. */
const SCOPE_OPENERS: ReadonlySet<string> = new Set(["function_definition", "class_definition", "lambda"]);

/** Statements whose identifiers all count as bound: imports bind names, and over-refusing one is harmless. */
const IMPORT_STATEMENTS: ReadonlySet<string> = new Set([
  "import_statement",
  "import_from_statement",
  "future_import_statement",
]);

/** The modules whose names are typing special forms rather than classes. */
const PYTHON_TYPING_MODULES: ReadonlySet<string> = new Set(["typing", "typing_extensions"]);

/**
 * Does a site's type name a class? Never a typing special form — an annotation
 * `Headers: TypeAlias = ...` / `X: typing.Final = 3`, or a typing factory a
 * constructor reading mistakes for a class (`UserId = NewType("UserId", int)`,
 * `T = TypeVar("T")`). An ANNOTATION must also name something this file binds
 * (see the module docblock); a constructor call is its own evidence.
 */
function siteNamesAClass(site: PythonModuleAssignment, scan: PythonModuleScopeScan): boolean {
  const head = site.type.split(".")[0];
  if (PYTHON_TYPING_MODULES.has(head) || scan.typingNames.has(head)) return false;
  return !site.annotated || scan.typeNames.has(head);
}

interface PythonModuleAssignment {
  readonly name: string;
  readonly line: number;
  readonly type: string;
  readonly annotated: boolean;
}

/** Accumulator for one file's module scope. */
interface PythonModuleScopeScan {
  readonly typed: PythonModuleAssignment[];
  readonly refused: Set<string>;
  /** Names module scope binds to a class or a module: imports and `class` statements. */
  readonly typeNames: Set<string>;
  /** Names `from typing import ...` binds — special forms (`TypeAlias`, `Final`), never a value's class. */
  readonly typingNames: Set<string>;
}

function extractPythonModuleValueFacts(input: PythonTypeSourceInput): TypeFact[] {
  if (input.moduleValues !== true) return [];
  const scan: PythonModuleScopeScan = { typed: [], refused: new Set(), typeNames: new Set(), typingNames: new Set() };
  for (const child of input.root.namedChildren) visitModuleScope(child, scan);
  if (scan.typed.length === 0) return [];
  collectGlobalDeclarations(input.root, scan.refused);
  return scan.typed
    .filter((site) => !scan.refused.has(site.name))
    .filter((site) => siteNamesAClass(site, scan))
    .map((site) => ({
      kind: "moduleValue",
      source: site.annotated ? PYTHON_ANNOTATION_SOURCE : PYTHON_AST_SOURCE,
      symbolScope: [],
      name: site.name,
      line: site.line,
      type: { form: "instance", name: site.type },
    }));
}

function visitModuleScope(node: AstNode, scan: PythonModuleScopeScan): void {
  if (SCOPE_OPENERS.has(node.type)) {
    const name = node.childForFieldName("name");
    if (name !== null) scan.refused.add(name.text);
    if (name !== null && node.type === "class_definition") scan.typeNames.add(name.text);
    return;
  }
  if (IMPORT_STATEMENTS.has(node.type)) {
    collectIdentifiers(node, scan.refused);
    collectIdentifiers(node, scan.typeNames);
    const from = node.childForFieldName("module_name")?.text;
    if (from !== undefined && PYTHON_TYPING_MODULES.has(from)) collectIdentifiers(node, scan.typingNames);
    return;
  }
  switch (node.type) {
    case "assignment":
      visitModuleAssignment(node, scan);
      return;
    case "augmented_assignment":
      collectIdentifiers(node.childForFieldName("left"), scan.refused);
      return;
    case "for_statement":
      collectIdentifiers(node.childForFieldName("left"), scan.refused);
      break;
    case "as_pattern_target":
      collectIdentifiers(node, scan.refused);
      return;
    default:
      break;
  }
  for (const child of node.namedChildren) visitModuleScope(child, scan);
}

function visitModuleAssignment(node: AstNode, scan: PythonModuleScopeScan): void {
  const left = node.childForFieldName("left") ?? node.namedChild(0);
  const right = node.childForFieldName("right");
  // `a = b = Cls()` — the inner assignment is the right-hand side; it binds `b`.
  if (right?.type === "assignment") visitModuleAssignment(right, scan);
  if (left?.type !== "identifier") {
    collectIdentifiers(left, scan.refused);
    return;
  }
  const typed = pythonAssignmentBoundType(node);
  if (typed === null) {
    scan.refused.add(left.text);
    return;
  }
  scan.typed.push({ name: left.text, line: node.startPosition.row + 1, ...typed });
}

function collectIdentifiers(node: AstNode | null, into: Set<string>): void {
  if (node === null) return;
  if (node.type === "identifier") {
    into.add(node.text);
    return;
  }
  for (const child of node.namedChildren) collectIdentifiers(child, into);
}

/** `global x` anywhere in the file — a function that rebinds the module name. */
function collectGlobalDeclarations(node: AstNode, refused: Set<string>): void {
  if (node.type === "global_statement") {
    collectIdentifiers(node, refused);
    return;
  }
  for (const child of node.namedChildren) collectGlobalDeclarations(child, refused);
}

export const pythonModuleValueTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_AST_SOURCE,
  extract: extractPythonModuleValueFacts,
};
