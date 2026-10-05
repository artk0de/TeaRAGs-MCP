/**
 * Python walker half of interprocedural parameter typing (K7, bd
 * tea-rags-mcp-m99j1.1.17) — the Python producer of the three channels the
 * language-agnostic fold in `trajectory/codegraph/symbols/call-arg-param-types.ts`
 * joins (Task 15A made it admit Python through `ChunkExtraction.paramCoordinate`).
 * Ruby's producer (`ruby/walker/param-arg-types.ts`) is the reference.
 *
 * The known-target call site in Python is the PYTHON_INIT_METHOD call: `View(x)` runs
 * `View.__init__`, whatever the rest of the program does, so its argument types
 * can be harvested in pass 1 and folded at the barrier before any call resolves.
 * Three facts, every key spelled with Python's file-qualified class key
 * `<relPath>::<dotted class FQ>` (the key `pythonClassKey` builds):
 *
 *   - `paramNames` on each `__init__` chunk — the leading positional run, the
 *     receiver dropped — with its `paramCoordinate` `<classKey>#__init__`, the
 *     coordinate the fold indexes it under and pass 2 seeds it back from (a
 *     Python symbolId `View#__init__` is NOT that coordinate);
 *   - `knownTargetCallArgs` — per-position argument types at a CapWords call
 *     whose name the file binds to a class: one it declares at module scope, or
 *     one a `from M import Name` names (the candidates are the files module `M`
 *     can live in; the fold keeps the first that is a real definition). An
 *     argument is typed when it is a constructor call, the receiver, a local
 *     bound only to one constructor, a parameter annotated with one nominal arm
 *     that the body never rebinds, `self.<field>` of a field the class declares
 *     or constructs as one class, or a module value the `moduleValueTypes`
 *     channel publishes (bd tea-rags-mcp-m99j1.1.52);
 *   - `classFieldParamLinks` — `self.<field> = <param>` verbatim copies.
 *
 * Every collector is SILENT where it cannot be exact: an argument whose type is
 * not conservatively known is a `null` slot, a field fed by two parameter
 * coordinates links nothing, and a re-exported class (`from django.http import
 * HttpRequest`, declared one package deeper) matches no candidate and derives
 * nothing rather than guessing.
 */

import { createIdentifierRecord } from "../../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type {
  ChunkExtraction,
  ClassFieldParamLink,
  FileExtraction,
  KnownTargetCallArgs,
} from "../../../../../contracts/types/codegraph.js";
import type { RubyTypeRef, TypeRef, WalkContext } from "../../../../../contracts/types/language.js";
import { symbolIdNames, TypeFactStore, typeRefReceiverForm, type ExtractionFacetPass } from "../../../kernel/index.js";
import { extractConstructorTypeName, isCapWordsConstructor } from "../walker.js";
import { PYTHON_TYPE_SOURCE_ORDER } from "./annotation-type-facts.js";
import { pythonAnnotationTypeSource, pythonTypedParameters } from "./python-annotation-type-source.js";
import { isPythonMethodDef, pythonBoundParamNames, pythonPositionalParamNames } from "./python-def-signatures.js";
import { pythonModuleValuesEnabled, pythonModuleValueTypeSource } from "./python-module-value-facts.js";
import { pythonTypeRefFromNode } from "./python-type-annotation.js";

/** The only Python callee the fold can address from syntax: the constructor. */
const PYTHON_INIT_METHOD = "__init__";

/** Nodes that open a new scope — a walk over one def's body stops at them. */
const SCOPE_NODES: ReadonlySet<string> = new Set(["function_definition", "class_definition", "lambda"]);

/** Argument nodes past which positions stop corresponding to parameters. */
const POSITION_BREAKERS: ReadonlySet<string> = new Set(["keyword_argument", "list_splat", "dictionary_splat"]);

/**
 * Python's file-qualified class key, `<relPath>::<dotted class FQ>` — the same
 * spelling `classAncestors` and `classFieldTypesByClassKey` carry
 * (`pythonClassKey` on the resolver side). Every key this pass emits goes
 * through here: the fold joins by string equality and never re-spells one.
 */
function fileQualifiedClassKey(relPath: string, classChain: readonly string[]): string {
  return `${relPath}::${classChain.join(".")}`;
}

/** One def as the collectors see it. */
interface PythonDefFrame {
  readonly node: AstNode;
  /** Dotted class chain of the class whose body declares the def, `[]` otherwise. */
  readonly classChain: readonly string[];
  /** Implicit `self` parameter name for an instance method, else `null`. */
  readonly receiver: string | null;
  /** Lazily computed constructor-typed locals of this def. */
  locals?: ReadonlyMap<string, string | null>;
  /** Lazily computed names the def's body statements bind in its own scope. */
  bound?: ReadonlySet<string>;
  /** Lazily computed `param → class` for parameters annotated with one nominal arm. */
  annotatedParams?: ReadonlyMap<string, string>;
}

/** A name a `from M import Source as Local` binds. `null` = bound twice, unusable. */
interface PythonFromImport {
  readonly module: string;
  readonly sourceName: string;
}

function decoratorNamesOf(defNode: AstNode): string[] {
  const outer = defNode.parent;
  if (outer?.type !== "decorated_definition") return [];
  return outer.namedChildren.filter((c) => c.type === "decorator").map((c) => c.text.replace(/^@/, "").trim());
}

/** Walk `node`'s subtree without entering a nested scope. */
function walkScope(node: AstNode, visit: (n: AstNode) => void): void {
  for (const child of node.namedChildren) {
    visit(child);
    if (!SCOPE_NODES.has(child.type)) walkScope(child, visit);
  }
}

function identifiersUnder(node: AstNode | null, out: Set<string>): void {
  if (node === null) return;
  if (node.type === "identifier") {
    out.add(node.text);
    return;
  }
  for (const child of node.namedChildren) identifiersUnder(child, out);
}

/**
 * Every `def` with its class chain and receiver, in source order. A class
 * nested inside a def is skipped together with its body: its run-global class
 * key carries the def in its FQ, which a class-only chain cannot spell.
 */
function collectDefFrames(root: AstNode): PythonDefFrame[] {
  const frames: PythonDefFrame[] = [];
  const visit = (node: AstNode, classChain: readonly string[], inDef: boolean): void => {
    for (const child of node.namedChildren) {
      const def = child.type === "decorated_definition" ? (child.childForFieldName("definition") ?? child) : child;
      if (def.type === "class_definition") {
        const name = def.childForFieldName("name")?.text;
        const body = def.childForFieldName("body");
        if (name !== undefined && body !== null && !inDef) visit(body, [...classChain, name], false);
        continue;
      }
      if (def.type === "function_definition") {
        const isMethod = isPythonMethodDef(def);
        const decorators = decoratorNamesOf(def);
        const instanceMethod = isMethod && !decorators.includes("staticmethod") && !decorators.includes("classmethod");
        const first = pythonBoundParamNames(def)[0];
        frames.push({ node: def, classChain, receiver: instanceMethod && first !== undefined ? first : null });
        const body = def.childForFieldName("body");
        if (body !== null) visit(body, classChain, true);
        continue;
      }
      visit(child, classChain, inDef);
    }
  };
  visit(root, [], false);
  return frames;
}

/** The constructor type a value expression is, or null (CapWords gate as the field channel). */
function constructorTypeOf(expr: AstNode | null, imports: ReadonlyMap<string, PythonFromImport | null>): string | null {
  if (expr?.type !== "call") return null;
  const fn = expr.childForFieldName("function");
  if (fn === null) return null;
  const typeName = extractConstructorTypeName(fn);
  if (typeName === null || !isCapWordsConstructor(typeName)) return null;
  // An aliased import spells the class under a name only THIS file knows; the
  // fact is read in the callee's file, so it carries the source name.
  if (fn.type === "identifier") return imports.get(typeName)?.sourceName ?? typeName;
  return typeName;
}

/**
 * The def's locals bound ONLY to one constructor type. Any other binding form
 * (a tuple target, `for`, `with … as`, `:=`, `+=`, an import, `global`, a
 * parameter) or a second, different constructor poisons the name.
 */
function constructorTypedLocals(
  frame: PythonDefFrame,
  imports: ReadonlyMap<string, PythonFromImport | null>,
): ReadonlyMap<string, string | null> {
  const types = new Map<string, string | null>();
  const poisoned = new Set<string>(pythonBoundParamNames(frame.node));
  const body = frame.node.childForFieldName("body");
  if (body === null) return types;
  walkScope(body, (n) => {
    switch (n.type) {
      case "assignment": {
        const left = n.childForFieldName("left");
        if (left?.type === "identifier") {
          const type = constructorTypeOf(n.childForFieldName("right"), imports);
          const seen = types.get(left.text);
          if (type === null || (seen !== undefined && seen !== type)) poisoned.add(left.text);
          else types.set(left.text, type);
        } else if (left !== null && left.type !== "attribute" && left.type !== "subscript") {
          identifiersUnder(left, poisoned);
        }
        return;
      }
      case "augmented_assignment":
      case "for_statement":
      case "for_in_clause":
        identifiersUnder(n.childForFieldName("left"), poisoned);
        return;
      case "as_pattern":
        identifiersUnder(n.childForFieldName("alias"), poisoned);
        return;
      case "named_expression":
        identifiersUnder(n.childForFieldName("name"), poisoned);
        return;
      case "global_statement":
      case "nonlocal_statement":
      case "import_statement":
      case "import_from_statement":
        identifiersUnder(n, poisoned);
        break;
      default:
        break;
    }
  });
  for (const name of poisoned) types.set(name, null);
  return types;
}

/**
 * Every `from M import Name [as Alias]` the file makes, by LOCAL name. A local
 * name bound by two different imports is `null` — no single class to name.
 */
function collectFromImports(root: AstNode): Map<string, PythonFromImport | null> {
  const out = new Map<string, PythonFromImport | null>();
  const visit = (node: AstNode): void => {
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (moduleNode === null) return;
      const module = moduleNode.text;
      const names = node.namedChildren.filter(
        (c) => (c.type === "dotted_name" || c.type === "aliased_import") && c.startIndex !== moduleNode.startIndex,
      );
      for (const nameNode of names) {
        const aliased = nameNode.type === "aliased_import";
        const sourceName = aliased ? nameNode.childForFieldName("name")?.text : nameNode.text;
        const localName = aliased ? nameNode.childForFieldName("alias")?.text : nameNode.text;
        if (sourceName === undefined || localName === undefined || sourceName.includes(".")) continue;
        const seen = out.get(localName);
        if (seen === undefined) out.set(localName, { module, sourceName });
        else if (seen !== null && (seen.module !== module || seen.sourceName !== sourceName)) out.set(localName, null);
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

/** Module-scope class names → declared once (true) or twice (false). */
function collectModuleClasses(root: AstNode): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const child of root.namedChildren) {
    const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    if (def?.type !== "class_definition") continue;
    const name = def.childForFieldName("name")?.text;
    if (name !== undefined) out.set(name, !out.has(name));
  }
  return out;
}

/**
 * The files module `moduleText` can be, as the importer at `relPath` spells it.
 * A relative module resolves against the importer's package; an absolute one
 * against EVERY ancestor directory of the importer, outermost first, because the
 * walker does not know the project's source roots (`src/flask/app.py` imports
 * `flask.helpers`). The fold's existence gate keeps only a real definition.
 */
export function pythonModuleFileCandidates(relPath: string, moduleText: string): string[] {
  const dirParts = relPath.split("/").slice(0, -1);
  const dots = /^\.*/.exec(moduleText)?.[0].length ?? 0;
  const segments = moduleText
    .slice(dots)
    .split(".")
    .filter((s) => s.length > 0);
  const bases: string[][] = [];
  if (dots > 0) {
    if (dots - 1 > dirParts.length) return [];
    bases.push(dirParts.slice(0, dirParts.length - (dots - 1)));
  } else {
    for (let depth = 0; depth <= dirParts.length; depth++) bases.push(dirParts.slice(0, depth));
  }
  const out: string[] = [];
  for (const base of bases) {
    const path = [...base, ...segments].join("/");
    if (segments.length > 0) out.push(`${path}.py`);
    out.push(path.length > 0 ? `${path}/__init__.py` : "__init__.py");
  }
  return out;
}

/** The file's resolution context for constructor calls. */
interface PythonCallSiteScope {
  readonly root: AstNode;
  readonly relPath: string;
  readonly imports: ReadonlyMap<string, PythonFromImport | null>;
  readonly moduleClasses: ReadonlyMap<string, boolean>;
  /** The frame of a def node, by `startIndex` — the enclosing defs of a module-value read. */
  readonly frameByStart: ReadonlyMap<number, PythonDefFrame>;
  /** Lazily computed `<dotted class chain> → field → class` (`null` = contested). */
  fieldTypes?: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  /** Lazily computed module-scope value → class, as the `moduleValueTypes` channel publishes it. */
  moduleValues?: ReadonlyMap<string, string>;
}

/** `<classKey>#__init__` candidates for a constructor call spelled `name`, or `[]`. */
function constructorTargets(name: string, scope: PythonCallSiteScope): string[] {
  const declared = scope.moduleClasses.get(name);
  if (declared === true) return [`${fileQualifiedClassKey(scope.relPath, [name])}#${PYTHON_INIT_METHOD}`];
  if (declared === false) return [];
  const imported = scope.imports.get(name);
  if (imported === undefined || imported === null) return [];
  return pythonModuleFileCandidates(scope.relPath, imported.module).map(
    (file) => `${fileQualifiedClassKey(file, [imported.sourceName])}#${PYTHON_INIT_METHOD}`,
  );
}

/** Expression nodes that bind their own `for … in` variables (Python 3 comprehension scope). */
const COMPREHENSION_NODES: ReadonlySet<string> = new Set([
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);

/** Add the names an assignment TARGET binds; `obj.x` / `obj[k]` targets bind no name. */
function targetNames(node: AstNode | null, out: Set<string>): void {
  if (node === null || node.type === "attribute" || node.type === "subscript") return;
  if (node.type === "identifier") {
    out.add(node.text);
    return;
  }
  for (const child of node.namedChildren) targetNames(child, out);
}

/**
 * Every name a def's body STATEMENTS bind in the def's own scope,
 * flow-insensitively: a name rebound anywhere in the body is not the parameter
 * or the module value at any call site of that body. Comprehension and lambda
 * variables are not here — they shadow only inside their own expression, which
 * {@link isShadowedAt} answers at the argument's position.
 */
function bodyBindingsOf(frame: PythonDefFrame): ReadonlySet<string> {
  if (frame.bound !== undefined) return frame.bound;
  const bound = new Set<string>();
  const body = frame.node.childForFieldName("body");
  if (body !== null) {
    walkScope(body, (n) => {
      switch (n.type) {
        case "assignment":
        case "augmented_assignment":
        case "for_statement":
          targetNames(n.childForFieldName("left"), bound);
          return;
        case "as_pattern":
          targetNames(n.childForFieldName("alias"), bound);
          return;
        case "named_expression":
          targetNames(n.childForFieldName("name"), bound);
          return;
        case "function_definition":
        case "class_definition":
          targetNames(n.childForFieldName("name"), bound);
          return;
        case "global_statement":
        case "nonlocal_statement":
        case "import_statement":
        case "import_from_statement":
        case "case_pattern":
          identifiersUnder(n, bound);
          break;
        default:
          break;
      }
    });
  }
  frame.bound = bound;
  return bound;
}

/** Does a lambda or comprehension between `node` and `scopeNode` bind `name`? */
function isShadowedAt(node: AstNode, name: string, scopeNode: AstNode | null): boolean {
  for (let at = node.parent; at !== null && at !== scopeNode; at = at.parent) {
    if (at.type === "lambda") {
      const names = new Set<string>();
      identifiersUnder(at.childForFieldName("parameters"), names);
      if (names.has(name)) return true;
    } else if (COMPREHENSION_NODES.has(at.type)) {
      const names = new Set<string>();
      for (const clause of at.namedChildren) {
        if (clause.type === "for_in_clause") targetNames(clause.childForFieldName("left"), names);
      }
      if (names.has(name)) return true;
    }
  }
  return false;
}

/**
 * The class a reference spells, as the callee's file can read it: an aliased
 * `from M import Source as Local` carries `Source`, as {@link constructorTypeOf}
 * does for a constructor. `null` for a name the constructor arm's CapWords gate
 * would refuse (`str`, `int`, `dict`): no fold consumer types a builtin, so the
 * widened arms feed none either.
 */
function sourceClassName(name: string, scope: PythonCallSiteScope): string | null {
  if (!isCapWordsConstructor(name)) return null;
  return scope.imports.get(name)?.sourceName ?? name;
}

/** The one nominal INSTANCE arm of an annotation (`Optional[A]` / `A | None` → `A`), or undefined. */
function nominalInstanceName(ref: TypeRef | undefined): string | undefined {
  const receiver = typeRefReceiverForm(ref);
  return receiver?.form === "instance" ? receiver.name : undefined;
}

/** `param → class` for the def's parameters annotated with one nominal instance arm. */
function annotatedParamsOf(frame: PythonDefFrame, scope: PythonCallSiteScope): ReadonlyMap<string, string> {
  if (frame.annotatedParams !== undefined) return frame.annotatedParams;
  const selfClass = frame.classChain[frame.classChain.length - 1];
  const out = new Map<string, string>();
  for (const param of pythonTypedParameters(frame.node)) {
    const name = nominalInstanceName(pythonTypeRefFromNode(param.annotation, selfClass));
    const type = name === undefined ? null : sourceClassName(name, scope);
    if (type !== null) out.set(param.name, type);
  }
  frame.annotatedParams = out;
  return out;
}

function agree(fields: Map<string, string | null>, field: string, type: string | null): void {
  const seen = fields.get(field);
  fields.set(field, seen === undefined || seen === type ? type : null);
}

/**
 * `<dotted class chain> → field → class` for the file's classes. A field the
 * annotation source types (class-body `x: T`, `self.x: T`, `self.x = <annotated
 * param>`) takes its DECLARED type; otherwise every `self.x = …` in the class's
 * instance methods must construct one class. Two disagreeing declarations, or
 * any non-constructor write of an undeclared field, leave the field `null`.
 */
function classFieldTypesOf(scope: PythonCallSiteScope): ReadonlyMap<string, ReadonlyMap<string, string | null>> {
  const declared = new Map<string, Map<string, string | null>>();
  for (const fact of pythonAnnotationTypeSource.extract({ root: scope.root, trackLocalTypes: false })) {
    if (fact.kind !== "ivar" || fact.name === undefined || fact.type.form !== "instance") continue;
    const key = fact.symbolScope.join(".");
    const fields = declared.get(key) ?? new Map<string, string | null>();
    declared.set(key, fields);
    agree(fields, fact.name, sourceClassName(fact.type.name, scope));
  }
  const constructed = new Map<string, Map<string, string | null>>();
  for (const frame of scope.frameByStart.values()) {
    const { receiver } = frame;
    const body = frame.node.childForFieldName("body");
    if (receiver === null || frame.classChain.length === 0 || body === null) continue;
    const key = frame.classChain.join(".");
    const fields = constructed.get(key) ?? new Map<string, string | null>();
    constructed.set(key, fields);
    const fieldOf = (target: AstNode): string | undefined => {
      const fieldOwner = target.childForFieldName("object");
      return fieldOwner?.type === "identifier" && fieldOwner.text === receiver
        ? target.childForFieldName("attribute")?.text
        : undefined;
    };
    walkScope(body, (n) => {
      if (n.type !== "assignment" && n.type !== "augmented_assignment" && n.type !== "for_statement") return;
      const left = n.childForFieldName("left");
      if (left === null) return;
      if (left.type === "attribute") {
        const field = fieldOf(left);
        if (field === undefined) return;
        const type = n.type === "assignment" ? constructorTypeOf(n.childForFieldName("right"), scope.imports) : null;
        agree(fields, field, type);
        return;
      }
      // A tuple / list target writing `self.x` gives it an unknowable element.
      walkScope(left, (t) => {
        const field = t.type === "attribute" ? fieldOf(t) : undefined;
        if (field !== undefined) agree(fields, field, null);
      });
    });
  }
  const out = new Map<string, Map<string, string | null>>(constructed);
  for (const [key, fields] of declared) out.set(key, new Map([...(constructed.get(key) ?? []), ...fields]));
  return out;
}

/** Module-scope value → class, exactly as the `moduleValueTypes` channel publishes it. */
function moduleValuesOf(scope: PythonCallSiteScope): ReadonlyMap<string, string> {
  const facts = pythonModuleValueTypeSource.extract({
    root: scope.root,
    trackLocalTypes: false,
    moduleValues: pythonModuleValuesEnabled(),
  });
  const out = new Map<string, string>();
  if (facts.length === 0) return out;
  const published = TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER).moduleValueTypesMap();
  for (const [name, ref] of Object.entries(published)) {
    const nominal = nominalInstanceName(ref);
    const type = nominal === undefined ? null : sourceClassName(nominal, scope);
    if (type !== null) out.set(name, type);
  }
  return out;
}

/**
 * Does `name` at `node` read the MODULE binding? Not when an enclosing def binds
 * it (its own or an outer def's — a closure reads the outer local), nor a class
 * body the read sits in directly, nor a lambda / comprehension around it.
 */
function readsModuleBinding(node: AstNode, name: string, scope: PythonCallSiteScope): boolean {
  let crossedDef = false;
  for (let at = node.parent; at !== null; at = at.parent) {
    if (at.type === "function_definition") {
      const frame = scope.frameByStart.get(at.startIndex);
      if (frame === undefined || pythonBoundParamNames(at).includes(name) || bodyBindingsOf(frame).has(name)) {
        return false;
      }
      crossedDef = true;
    } else if (at.type === "class_definition" && !crossedDef) {
      const classNames = new Set<string>();
      const body = at.childForFieldName("body");
      if (body !== null) {
        for (const stmt of body.namedChildren) {
          if (stmt.type === "expression_statement") {
            for (const e of stmt.namedChildren) {
              if (e.type === "assignment" || e.type === "augmented_assignment") {
                targetNames(e.childForFieldName("left"), classNames);
              }
            }
          }
        }
      }
      if (classNames.has(name)) return false;
    } else if (at.type === "lambda") {
      const names = new Set<string>();
      identifiersUnder(at.childForFieldName("parameters"), names);
      if (names.has(name)) return false;
    }
  }
  return !isShadowedAt(node, name, null);
}

/** The conservatively known type of ONE argument expression, or null. */
function argTypeOf(arg: AstNode, frame: PythonDefFrame | null, scope: PythonCallSiteScope): RubyTypeRef | null {
  const ctor = constructorTypeOf(arg, scope.imports);
  if (ctor !== null) return { form: "instance", name: ctor };
  const type = arg.type === "attribute" ? selfFieldTypeOf(arg, frame, scope) : identifierTypeOf(arg, frame, scope);
  return type === null ? null : { form: "instance", name: type };
}

/** `self.<field>` of the enclosing class, typed by {@link classFieldTypesOf}. */
function selfFieldTypeOf(arg: AstNode, frame: PythonDefFrame | null, scope: PythonCallSiteScope): string | null {
  const fieldOwner = arg.childForFieldName("object");
  const field = arg.childForFieldName("attribute")?.text;
  const receiver = frame?.receiver ?? null;
  if (frame === null || receiver === null || fieldOwner?.type !== "identifier" || fieldOwner.text !== receiver) {
    return null;
  }
  if (field === undefined || bodyBindingsOf(frame).has(receiver) || isShadowedAt(arg, receiver, frame.node)) {
    return null;
  }
  scope.fieldTypes ??= classFieldTypesOf(scope);
  return scope.fieldTypes.get(frame.classChain.join("."))?.get(field) ?? null;
}

/** A bare name: the receiver, a constructor-typed local, an annotated parameter, or a module value. */
function identifierTypeOf(arg: AstNode, frame: PythonDefFrame | null, scope: PythonCallSiteScope): string | null {
  if (arg.type !== "identifier") return null;
  const name = arg.text;
  if (frame !== null) {
    if (isShadowedAt(arg, name, frame.node)) return null;
    if (frame.receiver !== null && name === frame.receiver) {
      return frame.classChain[frame.classChain.length - 1] ?? null;
    }
    frame.locals ??= constructorTypedLocals(frame, scope.imports);
    const local = frame.locals.get(name);
    if (local !== undefined && local !== null) return local;
    const annotated = annotatedParamsOf(frame, scope).get(name);
    // A parameter the body never rebinds is the parameter at every site.
    if (annotated !== undefined) return bodyBindingsOf(frame).has(name) ? null : annotated;
  }
  if (!readsModuleBinding(arg, name, scope)) return null;
  scope.moduleValues ??= moduleValuesOf(scope);
  return scope.moduleValues.get(name) ?? null;
}

function collectSiteArgs(
  callNode: AstNode,
  frame: PythonDefFrame | null,
  scope: PythonCallSiteScope,
  out: KnownTargetCallArgs[],
): void {
  const fn = callNode.childForFieldName("function");
  const args = callNode.childForFieldName("arguments");
  if (fn?.type !== "identifier" || args?.type !== "argument_list" || !isCapWordsConstructor(fn.text)) return;
  if (frame !== null && pythonBoundParamNames(frame.node).includes(fn.text)) return; // shadowed by a parameter
  const targets = constructorTargets(fn.text, scope);
  if (targets.length === 0) return;
  const argTypes: (RubyTypeRef | null)[] = [];
  let known = false;
  for (const arg of args.namedChildren) {
    if (arg.type === "comment") continue;
    if (POSITION_BREAKERS.has(arg.type)) break;
    const type = argTypeOf(arg, frame, scope);
    if (type !== null) known = true;
    argTypes.push(type);
  }
  if (known) out.push({ targets, argTypes });
}

/** Per-position argument types at the file's constructor call sites. */
function collectPythonKnownTargetCallArgs(
  root: AstNode,
  frames: readonly PythonDefFrame[],
  scope: PythonCallSiteScope,
): KnownTargetCallArgs[] {
  const out: KnownTargetCallArgs[] = [];
  const visit = (node: AstNode, frame: PythonDefFrame | null): void => {
    for (const child of node.namedChildren) {
      if (child.type === "call") collectSiteArgs(child, frame, scope, out);
      const inner = child.type === "function_definition" ? (scope.frameByStart.get(child.startIndex) ?? null) : frame;
      // A class nested in a def has no frame; its methods' calls are skipped
      // with it (their `self` cannot be spelled), module-level code is `null`.
      if (child.type === "function_definition" && inner === null) continue;
      visit(child, inner);
    }
  };
  visit(root, null);
  return out;
}

/**
 * `<classKey> → field → (method, param)` for `self.<field> = <param>` in an
 * instance method. A field fed by two different coordinates is dropped, as in
 * Ruby: two origins are two candidate types and the fold never picks one.
 */
function collectPythonClassFieldParamLinks(
  frames: readonly PythonDefFrame[],
  relPath: string,
): Record<string, Record<string, ClassFieldParamLink>> {
  const links = new Map<string, Map<string, ClassFieldParamLink>>();
  const poisoned = new Set<string>();
  for (const frame of frames) {
    if (frame.receiver === null || frame.classChain.length === 0) continue;
    const method = frame.node.childForFieldName("name")?.text;
    const body = frame.node.childForFieldName("body");
    if (method === undefined || body === null) continue;
    const params = new Set(pythonBoundParamNames(frame.node).slice(1));
    const classKey = fileQualifiedClassKey(relPath, frame.classChain);
    walkScope(body, (n) => {
      if (n.type !== "assignment" || n.childForFieldName("type") !== null) return;
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left?.type !== "attribute" || right?.type !== "identifier" || !params.has(right.text)) return;
      const fieldOwner = left.childForFieldName("object");
      const field = left.childForFieldName("attribute")?.text;
      if (fieldOwner?.type !== "identifier" || fieldOwner.text !== frame.receiver || field === undefined) return;
      const fields = links.get(classKey) ?? new Map<string, ClassFieldParamLink>();
      links.set(classKey, fields);
      const existing = fields.get(field);
      if (existing === undefined) fields.set(field, { method, param: right.text });
      else if (existing.method !== method || existing.param !== right.text) poisoned.add(`${classKey}|${field}`);
    });
  }
  const out: Record<string, Record<string, ClassFieldParamLink>> = createIdentifierRecord();
  for (const [classKey, fields] of links) {
    const kept: Record<string, ClassFieldParamLink> = createIdentifierRecord();
    for (const [field, link] of fields) if (!poisoned.has(`${classKey}|${field}`)) kept[field] = link;
    if (Object.keys(kept).length > 0) out[classKey] = kept;
  }
  return out;
}

/**
 * `paramNames` + `paramCoordinate` records for the `__init__` chunks, matched
 * by def line and name. Only `__init__`: it is the one def a known-target call
 * site addresses, so another method's names would index nothing.
 */
function constructorParamNameChunks(
  frames: readonly PythonDefFrame[],
  chunks: WalkContext["chunks"],
  relPath: string,
): ChunkExtraction[] {
  const initChunks: ChunkExtraction[] = [];
  for (const frame of frames) {
    if (frame.receiver === null || frame.node.childForFieldName("name")?.text !== PYTHON_INIT_METHOD) continue;
    const names = pythonPositionalParamNames(frame.node, true);
    if (names.length === 0) continue;
    const line = frame.node.startPosition.row + 1;
    const chunk = chunks.find((c) => c.startLine === line && symbolIdNames(c.symbolId, PYTHON_INIT_METHOD));
    if (chunk === undefined) continue;
    initChunks.push({
      symbolId: chunk.symbolId,
      scope: chunk.scope,
      calls: [],
      paramNames: names,
      paramCoordinate: `${fileQualifiedClassKey(relPath, frame.classChain)}#${PYTHON_INIT_METHOD}`,
    });
  }
  return initChunks;
}

export const pythonParamArgTypesFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    const frames = collectDefFrames(root);
    const scope: PythonCallSiteScope = {
      root,
      relPath: ctx.relPath,
      imports: collectFromImports(root),
      moduleClasses: collectModuleClasses(root),
      frameByStart: new Map(frames.map((f) => [f.node.startIndex, f])),
    };
    const out: Partial<FileExtraction> = {};
    const chunks = constructorParamNameChunks(frames, ctx.chunks, ctx.relPath);
    if (chunks.length > 0) out.chunks = chunks;
    const knownTargetCallArgs = collectPythonKnownTargetCallArgs(root, frames, scope);
    if (knownTargetCallArgs.length > 0) out.knownTargetCallArgs = knownTargetCallArgs;
    const links = collectPythonClassFieldParamLinks(frames, ctx.relPath);
    if (Object.keys(links).length > 0) out.classFieldParamLinks = links;
    return out;
  },
};
