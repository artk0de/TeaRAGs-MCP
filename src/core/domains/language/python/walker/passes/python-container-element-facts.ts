/**
 * Container element facts (bd tea-rags-mcp-m99j1.1.41) — what an UNANNOTATED
 * container holds, read off the writes into it and off the comprehension that
 * builds it, for the iteration fold (`python-iteration-types.ts`) to type a
 * loop target with.
 *
 * django's `Apps.populate` is the motivating shape: `self.app_configs = {}`,
 * then `self.app_configs[label] = app_config` with
 * `app_config = AppConfig.create(entry)`, then
 * `for app_config in self.app_configs.values():`. Nothing annotates the
 * mapping, and the written value's type is what `AppConfig.create` RETURNS — a
 * fact that lives in another file's return channel and the MRO, reachable only
 * at resolve time. So the walker does not type the element: it records the
 * element as a DERIVED binding the resolver folds, under the pseudo-name
 * {@link pythonContainerElementKey} of the iterable that yields it —
 * `self.app_configs.values()[]` for a mapping (a bare iteration yields the
 * KEYS, and `TypeRef`'s container form has no key slot, so a mapping's element
 * is only ever stated for its `.values()` view), `items[]` for a list or set.
 * No reader of real names sees the pseudo-name; only the iteration fold looks
 * it up, and only when the container itself carries no type.
 *
 * The element binding reuses the two derived kinds:
 *
 *   - `tupleElement`, no position — the VALUE of a spelling: `Item()` for a
 *     written `Item(row)`, `AppConfig.create()` for a written local whose
 *     binding in force is that call's result, `Operation()` for a written
 *     parameter annotated `Operation`;
 *   - `iterationElement` — the element iterating a spelling yields, for an
 *     identity comprehension `xs = [x for x in ys if p]`.
 *
 * Spellings are written to be read OUTSIDE the writer's scope: a field's fact
 * sits on the def line of every method that iterates the field, so a value
 * whose head is a local of the writing def (`factory.build()`) is declined —
 * the reader would fold it against its own locals.
 *
 * Precision rules — a fact is recorded only when:
 *
 *   - every assignment to the container is an empty display (`{}`, `[]`,
 *     `dict()`, `list()`, `set()`) or a comprehension; anything else
 *     (`self.f = load()`, an annotation, a parameter, a loop target, `+=`)
 *     refuses the container outright;
 *   - every write is one of `c[k] = v`, `c.append(v)`, `c.add(v)`,
 *     `c.setdefault(k, v)`, of a shape the container's display allows; a
 *     write the walker cannot spell (`extend`, `update`, `insert`, `c[k] += v`)
 *     refuses it, because an unseen element is not agreement;
 *   - every write spells the SAME value. Two spellings are a disagreement even
 *     when both might fold to one class — single nominal, never a union.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { LocalBinding } from "../../../../../contracts/types/codegraph.js";
import { pythonAnnotationExpression } from "./python-def-scope-walk.js";
import { pythonAnnotationIterationElement } from "./python-iteration-facts.js";

/** The pseudo-name an iterable's element fact is recorded under: `<iterable>[]`. */
export function pythonContainerElementKey(iterable: string): string {
  return `${iterable}[]`;
}

/** One element fact, joined to chunks by `binding.line` like every local-binding site. */
export interface PythonContainerElementSite {
  readonly name: string;
  readonly binding: LocalBinding;
}

/** Display shapes a container is initialised to; `mapping` iterates its keys. */
type PythonContainerShape = "mapping" | "list" | "set";

/**
 * The element, as a binding without its line: a DERIVED spelling the resolver
 * folds, or — for an identity comprehension over an annotated source — the
 * nominal the annotation already names.
 */
type PythonElementSpelling = Omit<LocalBinding, "line">;

/** What one container accumulated over its scope. */
interface PythonContainerState {
  shape?: PythonContainerShape;
  initLine?: number;
  refused: boolean;
  /** `valueKind|sourceExpression` of every write; agreement is a set of size one. */
  readonly spellings: Set<string>;
  /** Every write's shape, checked against the display once the scope is folded (a write may precede it). */
  readonly writes: Set<PythonContainerWrite>;
  /** Containers this one is reassigned from by `.pop()` — a save/restore stack. */
  readonly restores: Set<string>;
  /** Containers appended WHOLE into this one (`stash.append(c)`): it holds their snapshots, not elements. */
  readonly stashOf: Set<string>;
}

/** The write forms a container accepts. */
type PythonContainerWrite = "subscript" | "append" | "add" | "setdefault";

/** One assignment to a def-local, kept for the "binding in force at the write" read. */
interface PythonLocalAssignment {
  readonly line: number;
  /** The right-hand side, or `null` for a binding no spelling can come from (a loop target, a tuple). */
  readonly value: AstNode | null;
  /** The annotation, for a parameter or a PEP 526 statement. */
  readonly annotation?: AstNode;
}

/** The writing def: its locals, their assignments, and the name `self` goes by. */
interface PythonWriterScope {
  readonly params: ReadonlySet<string>;
  readonly locals: ReadonlySet<string>;
  readonly assignments: ReadonlyMap<string, readonly PythonLocalAssignment[]>;
  readonly selfName: string | undefined;
}

const PYTHON_SCOPE_OPENERS = new Set(["function_definition", "class_definition", "lambda"]);
const PYTHON_ELEMENT_COMPREHENSIONS = new Set(["list_comprehension", "set_comprehension", "generator_expression"]);
const PYTHON_UNSEEN_WRITES = new Set(["extend", "update", "insert", "appendleft", "extendleft", "__setitem__"]);
const PYTHON_DOTTED_NAME = /^[A-Za-z_][\w.]*$/;
const PYTHON_CAPWORDS_SEGMENT = /^_*[A-Z]/;
/** The longest spelling recorded; the derived-binding fold refuses anything longer anyway. */
const PYTHON_SPELLING_MAX = 200;

/** Pre-order over one scope's nodes, never entering a nested `def` / `class` / `lambda`. */
function forEachInScope(node: AstNode, visit: (node: AstNode) => void): void {
  for (const child of node.namedChildren) {
    visit(child);
    if (!PYTHON_SCOPE_OPENERS.has(child.type)) forEachInScope(child, visit);
  }
}

/** Every `function_definition` in the file, at any depth. */
function forEachDef(node: AstNode, visit: (def: AstNode) => void): void {
  for (const child of node.namedChildren) {
    if (child.type === "function_definition") visit(child);
    forEachDef(child, visit);
  }
}

/** The shape of an EMPTY display / constructor call, or `undefined` for any other value. */
function emptyDisplayShape(node: AstNode): PythonContainerShape | undefined {
  if (node.type === "dictionary" && node.namedChildren.length === 0) return "mapping";
  if (node.type === "list" && node.namedChildren.length === 0) return "list";
  if (node.type !== "call") return undefined;
  const fn = node.childForFieldName("function");
  const args = node.childForFieldName("arguments");
  if (fn?.type !== "identifier" || args === null || args.namedChildren.length > 0) return undefined;
  if (fn.text === "dict") return "mapping";
  if (fn.text === "list") return "list";
  return fn.text === "set" ? "set" : undefined;
}

/** The shape a comprehension builds, or `undefined` for a non-comprehension. */
function comprehensionShape(node: AstNode): PythonContainerShape | undefined {
  if (node.type === "dictionary_comprehension") return "mapping";
  if (node.type === "set_comprehension") return "set";
  return PYTHON_ELEMENT_COMPREHENSIONS.has(node.type) ? "list" : undefined;
}

/** Agreement is textual: two writes agree when their element bindings serialize identically. */
const spellingKey = (spelling: PythonElementSpelling): string => JSON.stringify(spelling);

const parseSpellingKey = (key: string): PythonElementSpelling => JSON.parse(key) as PythonElementSpelling;

const valueSpelling = (sourceExpression: string): PythonElementSpelling => ({
  type: "",
  valueKind: "tupleElement",
  sourceExpression,
});

/**
 * What iterating a def-local yields when its binding in force at `line` is an
 * ANNOTATION naming a container of one nominal (`metrics: list[type[M]]`) —
 * the iteration-facts pass's own reading, so the two cannot diverge.
 */
function annotatedSourceElement(
  name: string,
  line: number,
  scope: PythonWriterScope,
): PythonElementSpelling | undefined {
  const annotation = assignmentInForce(name, line, scope)?.annotation;
  if (annotation === undefined) return undefined;
  const element = pythonAnnotationIterationElement(pythonAnnotationExpression(annotation), undefined, false);
  if (element?.form !== "instance" && element?.form !== "class") return undefined;
  return { type: element.name, ...(element.form === "class" ? { valueKind: "class" } : {}) };
}

/** The assignment to a def-local in force at `line` — the nearest at or above it. */
function assignmentInForce(name: string, line: number, scope: PythonWriterScope): PythonLocalAssignment | undefined {
  let inForce: PythonLocalAssignment | undefined;
  for (const assignment of scope.assignments.get(name) ?? []) {
    if (assignment.line > line) continue;
    if (inForce === undefined || assignment.line >= inForce.line) inForce = assignment;
  }
  return inForce;
}

/** The bare names a def binds — parameters, assignment / loop / `with` / walrus targets — never a nested scope's. */
function collectWriterScope(def: AstNode, selfName: string | undefined): PythonWriterScope {
  const params = new Set<string>();
  const locals = new Set<string>();
  const assignments = new Map<string, PythonLocalAssignment[]>();
  const record = (name: string, assignment: PythonLocalAssignment): void => {
    locals.add(name);
    const list = assignments.get(name) ?? [];
    assignments.set(name, list);
    list.push(assignment);
  };
  const defLine = def.startPosition.row + 1;
  for (const param of def.childForFieldName("parameters")?.namedChildren ?? []) {
    const nameNode =
      param.type === "identifier" ? param : (param.childForFieldName("name") ?? param.namedChild(0) ?? null);
    if (nameNode?.type !== "identifier") continue;
    const annotation = param.childForFieldName("type") ?? undefined;
    params.add(nameNode.text);
    record(nameNode.text, { line: defLine, value: null, ...(annotation === undefined ? {} : { annotation }) });
  }
  const recordTargets = (target: AstNode, line: number, value: AstNode | null, annotation?: AstNode): void => {
    if (target.type === "identifier") {
      record(target.text, { line, value, ...(annotation === undefined ? {} : { annotation }) });
      return;
    }
    if (target.type === "pattern_list" || target.type === "tuple_pattern" || target.type === "list_pattern") {
      for (const child of target.namedChildren) recordTargets(child, line, null);
    }
  };
  const body = def.childForFieldName("body");
  if (body !== null) {
    forEachInScope(body, (node) => {
      const line = node.startPosition.row + 1;
      if (node.type === "assignment" || node.type === "augmented_assignment") {
        const left = node.childForFieldName("left");
        const annotation = node.childForFieldName("type") ?? undefined;
        const value = node.type === "assignment" ? node.childForFieldName("right") : null;
        if (left !== null) recordTargets(left, line, value, annotation);
      } else if (node.type === "for_statement" || node.type === "for_in_clause") {
        const left = node.childForFieldName("left");
        if (left !== null) recordTargets(left, line, null);
      } else if (node.type === "as_pattern_target" || node.type === "named_expression") {
        const name = node.type === "named_expression" ? node.childForFieldName("name") : node.namedChild(0);
        if (name !== null) recordTargets(name, line, null);
      }
    });
  }
  if (selfName !== undefined) locals.delete(selfName);
  return { params, locals, assignments, selfName };
}

/** A call's callee spelled as a dotted name the reader can fold, or `null`. */
function callSpelling(node: AstNode, scope: PythonWriterScope, banned?: string): string | null {
  const fn = node.childForFieldName("function");
  if (fn === null || !PYTHON_DOTTED_NAME.test(fn.text)) return null;
  const head = fn.text.split(".")[0];
  if (head === banned || scope.locals.has(head)) return null;
  const spelled = `${fn.text}()`;
  return spelled.length > PYTHON_SPELLING_MAX ? null : spelled;
}

/** An annotation naming one class, spelled as its construction — `Operation` → `Operation()`. */
function annotationSpelling(annotation: AstNode, scope: PythonWriterScope): string | null {
  const node = annotation.type === "type" ? (annotation.namedChild(0) ?? annotation) : annotation;
  if (node.type !== "identifier" && node.type !== "attribute") return null;
  if (!PYTHON_DOTTED_NAME.test(node.text)) return null;
  const segments = node.text.split(".");
  if (!PYTHON_CAPWORDS_SEGMENT.test(segments[segments.length - 1]) || scope.locals.has(segments[0])) return null;
  return `${node.text}()`;
}

/**
 * The value `node` (written at `line`) evaluates to, spelled for a reader in
 * another scope — or `null`. A def-local reads the assignment in force at the
 * write: the nearest one at or above it, exactly the binding the resolver's
 * own position-aware lookup would pick.
 */
function writtenValueSpelling(node: AstNode, line: number, scope: PythonWriterScope, depth = 0): string | null {
  if (node.type === "call") return callSpelling(node, scope);
  if (node.type !== "identifier" || depth > 1 || !scope.locals.has(node.text)) return null;
  const inForce = assignmentInForce(node.text, line, scope);
  if (inForce === undefined) return null;
  if (inForce.annotation !== undefined) return annotationSpelling(inForce.annotation, scope);
  if (inForce.value === null) return null;
  return writtenValueSpelling(inForce.value, inForce.line, scope, depth + 1);
}

/**
 * The element a comprehension yields, or `null`: one `for` clause over a
 * single-name target, whose element (a dict comprehension's VALUE) is the
 * target itself — the source's element — or a call the reader can spell.
 * `allowLocalSource` admits a source that names a def-local, which only a
 * reader in the same def at the same statement can evaluate.
 */
function comprehensionElement(
  node: AstNode,
  line: number,
  scope: PythonWriterScope,
  allowLocalSource: boolean,
): PythonElementSpelling | null {
  const clauses = node.namedChildren.filter((child) => child.type === "for_in_clause");
  if (clauses.length !== 1) return null;
  const target = clauses[0].childForFieldName("left");
  const source = clauses[0].childForFieldName("right");
  if (target?.type !== "identifier" || source === null) return null;
  let element = node.childForFieldName("body") ?? node.namedChild(0);
  if (element?.type === "pair") element = element.childForFieldName("value");
  if (element === null) return null;
  if (element.type === "identifier" && element.text === target.text) {
    const sourceExpression = source.text.replace(/\s*\n\s*/g, " ");
    if (sourceExpression.length > PYTHON_SPELLING_MAX) return null;
    const head = /^[A-Za-z_]\w*/.exec(sourceExpression)?.[0];
    if (head === undefined || (!allowLocalSource && scope.locals.has(head))) return null;
    // An annotated local source is typed HERE: the resolver reads no container
    // off a parameter annotation, only the iteration-facts pass does.
    const annotated = source.type === "identifier" ? annotatedSourceElement(source.text, line, scope) : undefined;
    return annotated ?? { type: "", valueKind: "iterationElement", sourceExpression };
  }
  if (element.type !== "call") return null;
  const spelled = callSpelling(element, scope, target.text);
  return spelled === null ? null : valueSpelling(spelled);
}

/** Shapes a write method / a subscript store is legal on. */
function writeFits(write: PythonContainerWrite, shape: PythonContainerShape): boolean {
  if (write === "subscript") return shape !== "set";
  if (write === "append") return shape === "list";
  if (write === "add") return shape === "set";
  return shape === "mapping";
}

/**
 * Folds one scope's statements into per-container states. `containerOf` maps
 * a node to the container spelling it denotes (`items`, `self.app_configs`),
 * or `undefined`.
 */
function scanContainerStatements(
  body: AstNode,
  scope: PythonWriterScope,
  containerOf: (node: AstNode | null) => string | undefined,
  allowLocalSource: boolean,
  states: Map<string, PythonContainerState>,
): void {
  const stateOf = (spelling: string): PythonContainerState => {
    let state = states.get(spelling);
    if (state === undefined) {
      state = { refused: false, spellings: new Set(), writes: new Set(), restores: new Set(), stashOf: new Set() };
      states.set(spelling, state);
    }
    return state;
  };
  const write = (spelling: string, kind: PythonContainerWrite, element: PythonElementSpelling | null): void => {
    const state = stateOf(spelling);
    state.writes.add(kind);
    if (element === null) state.refused = true;
    else state.spellings.add(spellingKey(element));
  };
  forEachInScope(body, (node) => {
    const line = node.startPosition.row + 1;
    if (node.type === "assignment" || node.type === "augmented_assignment") {
      const left = node.childForFieldName("left");
      const container = containerOf(left);
      if (container !== undefined) {
        initialise(stateOf(container), node, line, { spelling: container, of: containerOf }, scope, allowLocalSource);
        return;
      }
      if (left?.type === "subscript") {
        const subscripted = containerOf(left.childForFieldName("value"));
        if (subscripted === undefined) return;
        const value = node.type === "assignment" ? node.childForFieldName("right") : null;
        if (value === null) stateOf(subscripted).refused = true;
        else write(subscripted, "subscript", spelledWrite(value, line, scope));
        return;
      }
      if (left !== null) {
        for (const target of left.namedChildren) {
          const unpacked = containerOf(target);
          if (unpacked !== undefined) stateOf(unpacked).refused = true;
        }
      }
      return;
    }
    if (node.type === "for_statement" || node.type === "for_in_clause") {
      const rebound = containerOf(node.childForFieldName("left"));
      if (rebound !== undefined) stateOf(rebound).refused = true;
      return;
    }
    if (node.type !== "call") return;
    const fn = node.childForFieldName("function");
    if (fn?.type !== "attribute") return;
    const container = containerOf(fn.childForFieldName("object"));
    const method = fn.childForFieldName("attribute")?.text;
    if (container === undefined || method === undefined) return;
    const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((arg) => arg.type !== "comment");
    if (PYTHON_UNSEEN_WRITES.has(method)) {
      stateOf(container).refused = true;
    } else if (method === "append" && args.length === 1 && args[0].type === "attribute" && containerOf(args[0])) {
      // Only a FIELD is stashed whole: a bare name appended is an element value,
      // and the local reading of `containerOf` matches every identifier.
      const state = stateOf(container);
      state.writes.add("append");
      state.stashOf.add(containerOf(args[0]) as string);
    } else if ((method === "append" || method === "add") && args.length === 1) {
      write(container, method, spelledWrite(args[0], line, scope));
    } else if (method === "setdefault" && args.length === 2) {
      write(container, "setdefault", spelledWrite(args[1], line, scope));
    } else if (method === "append" || method === "add" || method === "setdefault") {
      stateOf(container).refused = true;
    }
  });
}

/** A written value, as an element spelling. */
function spelledWrite(value: AstNode, line: number, scope: PythonWriterScope): PythonElementSpelling | null {
  if (value.type === "keyword_argument" || value.type === "list_splat") return null;
  const spelled = writtenValueSpelling(value, line, scope);
  return spelled === null ? null : valueSpelling(spelled);
}

/** An assignment TO the container: an empty display, a comprehension, or a refusal. */
function initialise(
  state: PythonContainerState,
  assignment: AstNode,
  line: number,
  container: { readonly spelling: string; readonly of: (node: AstNode | null) => string | undefined },
  scope: PythonWriterScope,
  allowLocalSource: boolean,
): void {
  const value = assignment.type === "assignment" ? assignment.childForFieldName("right") : null;
  if (value === null || assignment.childForFieldName("type") !== null) {
    state.refused = true;
    return;
  }
  const restoredFrom = stashRestoreSource(value, container.of);
  if (restoredFrom !== undefined) {
    state.restores.add(restoredFrom);
    return;
  }
  const display = emptyDisplayShape(value);
  const built = display === undefined ? comprehensionShape(value) : undefined;
  const shape = display ?? built;
  if (shape === undefined || (state.shape !== undefined && state.shape !== shape)) {
    state.refused = true;
    return;
  }
  state.shape = shape;
  // A filtering copy of the container itself adds no element it did not hold.
  if (built !== undefined && isSelfFilteringCopy(value, container.spelling, container.of)) return;
  state.initLine ??= line;
  if (built !== undefined) {
    const element = comprehensionElement(value, line, scope, allowLocalSource);
    if (element === null) state.refused = true;
    else state.spellings.add(spellingKey(element));
  }
}

/** `T.pop()` / `T.pop(i)` — the container is restored from `T`; `T` is returned when it is a container spelling. */
function stashRestoreSource(
  value: AstNode,
  containerOf: (node: AstNode | null) => string | undefined,
): string | undefined {
  if (value.type !== "call") return undefined;
  const fn = value.childForFieldName("function");
  if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "pop") return undefined;
  if ((value.childForFieldName("arguments")?.namedChildren.length ?? 0) > 1) return undefined;
  return containerOf(fn.childForFieldName("object"));
}

/**
 * `{k: v for k, v in c.items() if p}` / `[x for x in c if p]` assigned back
 * to `c` — django's `set_available_apps` — keeps a subset of what `c` held.
 */
function isSelfFilteringCopy(
  value: AstNode,
  container: string,
  containerOf: (node: AstNode | null) => string | undefined,
): boolean {
  const clauses = value.namedChildren.filter((child) => child.type === "for_in_clause");
  if (clauses.length !== 1) return false;
  const target = clauses[0].childForFieldName("left");
  const source = clauses[0].childForFieldName("right");
  const body = value.childForFieldName("body") ?? value.namedChild(0);
  if (target === null || source === null || body === null) return false;
  if (value.type !== "dictionary_comprehension") {
    return target.type === "identifier" && body.text === target.text && containerOf(source) === container;
  }
  const names = target.namedChildren;
  if ((target.type !== "pattern_list" && target.type !== "tuple_pattern") || names.length !== 2) return false;
  if (body.type !== "pair" || body.childForFieldName("value")?.text !== names[1].text) return false;
  const viewFn = source.type === "call" ? source.childForFieldName("function") : null;
  return (
    viewFn?.type === "attribute" &&
    viewFn.childForFieldName("attribute")?.text === "items" &&
    containerOf(viewFn.childForFieldName("object")) === container
  );
}

/**
 * The fact a settled container states, or `undefined`. A restore from a stash
 * (`c = stash.pop()`) is neutral only when the stash holds nothing but
 * snapshots of `c` (`stash.append(c)`, every write).
 */
function settledElement(
  container: string,
  state: PythonContainerState,
  states: ReadonlyMap<string, PythonContainerState>,
): { readonly shape: PythonContainerShape; readonly element: PythonElementSpelling } | undefined {
  if (state.refused || state.shape === undefined || state.spellings.size !== 1) return undefined;
  for (const write of state.writes) if (!writeFits(write, state.shape)) return undefined;
  for (const stashName of state.restores) {
    const stash = states.get(stashName);
    if (stash === undefined || stash.refused || stash.spellings.size > 0) return undefined;
    if (stash.stashOf.size !== 1 || !stash.stashOf.has(container)) return undefined;
  }
  const [key] = state.spellings;
  return { shape: state.shape, element: parseSpellingKey(key) };
}

/** The iterable spelling whose element the fact states. */
const factIterable = (container: string, shape: PythonContainerShape): string =>
  shape === "mapping" ? `${container}.values()` : container;

/** A def's first parameter when the def is a method of `classNode` (its body's direct child). */
function methodSelfName(def: AstNode): string | undefined {
  const first = def.childForFieldName("parameters")?.namedChildren[0];
  return first?.type === "identifier" ? first.text : undefined;
}

/** `def` statements directly in a class body, through decorators. */
function classMethods(classNode: AstNode): AstNode[] {
  const methods: AstNode[] = [];
  for (const child of classNode.childForFieldName("body")?.namedChildren ?? []) {
    const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    if (def?.type === "function_definition") methods.push(def);
  }
  return methods;
}

/** Field names a class BODY binds or annotates — a class attribute is not an instance container. */
function classBodyNames(classNode: AstNode): Set<string> {
  const names = new Set<string>();
  for (const statement of classNode.childForFieldName("body")?.namedChildren ?? []) {
    const assignment = statement.type === "expression_statement" ? statement.namedChild(0) : null;
    const left = assignment?.type === "assignment" ? assignment.childForFieldName("left") : null;
    if (left?.type === "identifier") names.add(left.text);
  }
  return names;
}

/** Element facts for the def-locals of one def, at each container's first display. */
function localContainerSites(def: AstNode): PythonContainerElementSite[] {
  const body = def.childForFieldName("body");
  if (body === null) return [];
  const scope = collectWriterScope(def, undefined);
  const states = new Map<string, PythonContainerState>();
  const containerOf = (node: AstNode | null): string | undefined =>
    node?.type === "identifier" ? node.text : undefined;
  scanContainerStatements(body, scope, containerOf, true, states);
  const sites: PythonContainerElementSite[] = [];
  for (const [name, state] of states) {
    // A parameter's contents were filled by the caller, out of sight.
    if (scope.params.has(name) || state.initLine === undefined) continue;
    const settled = settledElement(name, state, states);
    if (settled === undefined) continue;
    sites.push({
      name: pythonContainerElementKey(factIterable(name, settled.shape)),
      binding: { line: state.initLine, ...settled.element },
    });
  }
  return sites;
}

/** Element facts for one class's `self.<field>` containers, on the def line of each method iterating one. */
function fieldContainerSites(classNode: AstNode): PythonContainerElementSite[] {
  const methods = classMethods(classNode);
  if (methods.length === 0) return [];
  const states = new Map<string, PythonContainerState>();
  const iterablesByMethod = new Map<AstNode, string[]>();
  for (const method of methods) {
    const selfName = methodSelfName(method);
    const body = method.childForFieldName("body");
    if (selfName === undefined || body === null) continue;
    const scope = collectWriterScope(method, selfName);
    const containerOf = (node: AstNode | null): string | undefined => {
      if (node?.type !== "attribute") return undefined;
      const object = node.childForFieldName("object");
      const attribute = node.childForFieldName("attribute");
      return object?.type === "identifier" && object.text === selfName && attribute !== null
        ? `self.${attribute.text}`
        : undefined;
    };
    scanContainerStatements(body, scope, containerOf, false, states);
    const iterables: string[] = [];
    forEachInScope(body, (node) => {
      if (node.type !== "for_statement" && node.type !== "for_in_clause") return;
      const right = node.childForFieldName("right");
      if (right !== null) {
        iterables.push(selfName === "self" ? right.text : right.text.replaceAll(`${selfName}.`, "self."));
      }
    });
    iterablesByMethod.set(method, iterables);
  }
  const bodyNames = classBodyNames(classNode);
  const sites: PythonContainerElementSite[] = [];
  for (const [field, state] of states) {
    if (state.initLine === undefined || bodyNames.has(field.slice("self.".length))) continue;
    const settled = settledElement(field, state, states);
    if (settled === undefined) continue;
    const fieldPattern = new RegExp(`(^|[^\\w.])${field.replace(".", "\\.")}(?!\\w)`);
    for (const [method, iterables] of iterablesByMethod) {
      if (!iterables.some((iterable) => fieldPattern.test(iterable))) continue;
      sites.push({
        name: pythonContainerElementKey(factIterable(field, settled.shape)),
        binding: { line: method.startPosition.row + 1, ...settled.element },
      });
    }
  }
  return sites;
}

/**
 * Every container element fact of one file — def-local containers at their
 * first display, `self.<field>` containers at each iterating method's def
 * line. Document order is not significant: each fact rides its own
 * pseudo-name, which no other site binds.
 */
export function collectPythonContainerElementSites(root: AstNode): PythonContainerElementSite[] {
  const sites: PythonContainerElementSite[] = [];
  forEachDef(root, (def) => sites.push(...localContainerSites(def)));
  const visitClasses = (node: AstNode): void => {
    for (const child of node.namedChildren) {
      if (child.type === "class_definition") sites.push(...fieldContainerSites(child));
      visitClasses(child);
    }
  };
  visitClasses(root);
  return sites;
}
