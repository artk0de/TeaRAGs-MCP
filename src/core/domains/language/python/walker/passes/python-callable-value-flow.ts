/**
 * Python callable-value flow, walker half (P2, bd tea-rags-mcp-m99j1.1.19).
 *
 * `def csrf_exempt(view_func): def wrapped(*a): return view_func(*a)` calls
 * whatever was passed into `view_func`, and `@csrf_exempt def v()` passes `v`.
 * Two facts, joined run-global by the resolver
 * (`python/resolver/strategies/python-callable-param.ts`):
 *
 *   1. `CallRef.calleeParam` — a bare call whose callee names a PARAMETER of an
 *      enclosing def, seen through closures: the owning def's chunk symbolId
 *      and the parameter's CALL-SITE position (`pythonCallSitePositions`, the
 *      numbering `callbackParams` uses). Only a module-level owner: the passing
 *      side names its callee by a module-scope spelling, which cannot address
 *      a method or a nested def.
 *   2. `FileExtraction.callableArgSources` — every site passing a function
 *      reference positionally, keyed `<relPath>::<callee member>`. A decorator
 *      is the call `d(f)`; with stacked decorators only the INNERMOST one
 *      receives `f` itself — the outer ones receive whatever it returned.
 *
 * Both are SILENT where the name is not what it looks like: a parameter the
 * owner (or any def between the call and the owner) rebinds marks nothing, and
 * an argument whose head name any enclosing scope binds — a parameter, a
 * local, a loop variable — is not a module-scope reference and records
 * nothing. An argument must also name something the module could hand over as
 * a function: a def it declares, `Cls.method` of a class it declares, or a
 * lowercase name a `from` import binds (a CapWords one is a class, and a class
 * passed in is instantiated, not called).
 */

import { createIdentifierRecord } from "../../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { CallableArgSource, CallRef } from "../../../../../contracts/types/codegraph.js";
import { pythonBoundParamNames } from "./python-def-signatures.js";
import { pythonCallSitePositions } from "./python-dispatch-tables.js";

/** One visitor of the walker's flat pre-order descent (`walkOnce`). */
type PythonNodeVisitor = (node: AstNode) => void;

/** Nodes that open a scope of their own. */
const SCOPE_NODES: ReadonlySet<string> = new Set(["function_definition", "lambda", "class_definition"]);

/** Receivers that name an object, never a module the passing file imported. */
const OBJECT_RECEIVERS: ReadonlySet<string> = new Set(["self", "cls"]);

/**
 * Decorators that never invoke what they wrap as a plain parameter call —
 * skipped only to keep the channel small; none of them is a project def.
 */
const NON_CALLING_DECORATORS: ReadonlySet<string> = new Set([
  "property",
  "staticmethod",
  "classmethod",
  "setter",
  "getter",
  "deleter",
]);

/** `calleeParam` before its owner def line is joined to a chunk symbolId. */
interface PythonCalleeParamSite {
  readonly ownerLine: number;
  readonly position: number;
}

/** What the module scope can hand over as a function, read once per file. */
interface PythonModuleCallables {
  readonly functions: ReadonlySet<string>;
  readonly classes: ReadonlySet<string>;
  readonly fromImported: ReadonlySet<string>;
}

/** Per-file state of the two collectors. */
export interface PythonCallableValueFlow {
  /** Callee member → sources passed into it, in source order, deduplicated. */
  readonly sources: Map<string, CallableArgSource[]>;
  /** `<line>\0<callText>` of a bare call → its parameter owner, `null` when two sites disagree. */
  readonly calleeParams: Map<string, PythonCalleeParamSite | null>;
}

export function createPythonCallableValueFlow(): PythonCallableValueFlow {
  return { sources: new Map(), calleeParams: new Map() };
}

/**
 * Both collectors as one visitor of the flat descent. `root` is read once, up
 * front, for the module-scope names an argument may spell.
 */
export function collectPythonCallableValueFlow(root: AstNode, flow: PythonCallableValueFlow): PythonNodeVisitor {
  const callables = moduleCallablesOf(root);
  const bound = new ScopeBindings();
  return (node) => {
    if (node.type === "call") {
      recordPassedFunctions(node, callables, bound, flow.sources);
      recordCalleeParam(node, bound, flow.calleeParams);
    } else if (node.type === "decorated_definition") {
      recordDecoratorSource(node, flow.sources);
    }
  };
}

/**
 * Attach `calleeParam` to the bare calls the descent marked, joining each
 * owner's `def` line to the chunk declared there (the key `callbackParams`
 * joins by). A call whose owner has no chunk stays unmarked.
 */
export function annotatePythonCalleeParams(
  calls: readonly CallRef[],
  flow: PythonCallableValueFlow,
  chunks: readonly { symbolId: string; startLine: number }[],
): void {
  if (flow.calleeParams.size === 0) return;
  for (const call of calls) {
    if (call.receiver !== null) continue;
    const site = flow.calleeParams.get(calleeParamKey(call.startLine, call.callText));
    if (!site) continue;
    const owner = chunks.find((c) => c.startLine === site.ownerLine);
    if (owner) call.calleeParam = { ownerSymbolId: owner.symbolId, position: site.position };
  }
}

/** The channel as `FileExtraction` carries it, or `undefined` when the file passes nothing. */
export function pythonCallableArgSourcesOf(
  relPath: string,
  flow: PythonCallableValueFlow,
): Record<string, CallableArgSource[]> | undefined {
  if (flow.sources.size === 0) return undefined;
  const out: Record<string, CallableArgSource[]> = createIdentifierRecord();
  for (const [member, sources] of flow.sources) out[`${relPath}::${member}`] = sources;
  return out;
}

function calleeParamKey(line: number, callText: string): string {
  return `${line}\0${callText}`;
}

function recordCalleeParam(call: AstNode, bound: ScopeBindings, out: Map<string, PythonCalleeParamSite | null>): void {
  const callee = call.childForFieldName("function");
  if (callee?.type !== "identifier") return;
  const site = calleeParamSite(call, callee.text, bound);
  if (site === null) return;
  const key = calleeParamKey(call.startPosition.row + 1, call.text);
  const seen = out.get(key);
  if (seen === undefined) out.set(key, site);
  else if (seen !== null && (seen.ownerLine !== site.ownerLine || seen.position !== site.position)) out.set(key, null);
}

/**
 * The nearest scope binding `name`, walking out from the call. It must be a
 * module-level def binding `name` as a positional parameter and nothing else;
 * any other binder on the way — a local, a lambda parameter, a class-body
 * name — means the call does not invoke what was passed in.
 */
function calleeParamSite(call: AstNode, name: string, bound: ScopeBindings): PythonCalleeParamSite | null {
  for (let n = call.parent; n !== null; n = n.parent) {
    if (!SCOPE_NODES.has(n.type)) continue;
    const isParam = n.type !== "class_definition" && pythonBoundParamNames(n).includes(name);
    if (!isParam) {
      if (bound.rebinds(n, name)) return null;
      continue;
    }
    if (n.type === "lambda" || bound.rebinds(n, name) || !isModuleLevel(n)) return null;
    const position = pythonCallSitePositions(n).get(name);
    return position === undefined ? null : { ownerLine: n.startPosition.row + 1, position };
  }
  return null;
}

function recordPassedFunctions(
  call: AstNode,
  callables: PythonModuleCallables,
  bound: ScopeBindings,
  out: Map<string, CallableArgSource[]>,
): void {
  const callee = calleeSpelling(call.childForFieldName("function"));
  if (callee === null) return;
  const args = call.childForFieldName("arguments");
  if (args?.type !== "argument_list") return;
  let position = 0;
  for (const arg of args.namedChildren) {
    if (arg.type === "list_splat" || arg.type === "dictionary_splat") break;
    if (arg.type === "keyword_argument" || arg.type === "comment") continue;
    const argument = moduleFunctionSpelling(arg, callables);
    if (argument !== null && !boundInEnclosingScope(call, argument.head, bound)) {
      addSource(out, callee.member, { calleeReceiver: callee.receiver, argIndex: position, argument: argument.text });
    }
    position++;
  }
}

/** `@d def f` / `@mod.d def f` — the innermost decorator receives `f` itself. */
function recordDecoratorSource(decorated: AstNode, out: Map<string, CallableArgSource[]>): void {
  const def = decorated.childForFieldName("definition");
  if (def?.type !== "function_definition") return;
  const decorators = decorated.namedChildren.filter((c) => c.type === "decorator");
  const innermost = decorators[decorators.length - 1]?.namedChildren[0];
  const callee = calleeSpelling(innermost ?? null);
  if (callee === null || NON_CALLING_DECORATORS.has(callee.member)) return;
  const argument = decoratedDefSpelling(decorated, def);
  if (argument !== null) addSource(out, callee.member, { calleeReceiver: callee.receiver, argIndex: 0, argument });
}

/** `v` for a module-level def, `C.m` for a def in a module-level class body, else `null`. */
function decoratedDefSpelling(decorated: AstNode, def: AstNode): string | null {
  const name = def.childForFieldName("name")?.text;
  if (name === undefined) return null;
  const holder = decorated.parent;
  if (holder?.type === "module") return name;
  const cls = holder?.type === "block" ? holder.parent : null;
  if (cls?.type !== "class_definition" || !isModuleLevel(cls)) return null;
  const className = cls.childForFieldName("name")?.text;
  return className === undefined ? null : `${className}.${name}`;
}

function addSource(out: Map<string, CallableArgSource[]>, member: string, source: CallableArgSource): void {
  let list = out.get(member);
  if (!list) out.set(member, (list = []));
  const duplicate = list.some(
    (s) =>
      s.calleeReceiver === source.calleeReceiver && s.argIndex === source.argIndex && s.argument === source.argument,
  );
  if (!duplicate) list.push(source);
}

/** A bare callee, or `alias.member` on a plain name that is not an object receiver. */
function calleeSpelling(node: AstNode | null): { receiver: string | null; member: string } | null {
  if (node?.type === "identifier") return { receiver: null, member: node.text };
  if (node?.type !== "attribute") return null;
  const object = node.childForFieldName("object");
  const attribute = node.childForFieldName("attribute");
  if (object?.type !== "identifier" || attribute?.type !== "identifier") return null;
  if (OBJECT_RECEIVERS.has(object.text)) return null;
  return { receiver: object.text, member: attribute.text };
}

/**
 * `f` / `Cls.m` / `mod.f` when the module scope can name it as a function;
 * `head` is the name an enclosing scope could shadow.
 */
function moduleFunctionSpelling(arg: AstNode, callables: PythonModuleCallables): { head: string; text: string } | null {
  if (arg.type === "identifier") {
    const name = arg.text;
    const isFunction = callables.functions.has(name) || (callables.fromImported.has(name) && !isCapWords(name));
    return isFunction ? { head: name, text: name } : null;
  }
  if (arg.type !== "attribute") return null;
  const object = arg.childForFieldName("object");
  const attribute = arg.childForFieldName("attribute");
  if (object?.type !== "identifier" || attribute?.type !== "identifier") return null;
  const head = object.text;
  const known = callables.classes.has(head) || callables.fromImported.has(head);
  return known ? { head, text: `${head}.${attribute.text}` } : null;
}

function boundInEnclosingScope(node: AstNode, name: string, bound: ScopeBindings): boolean {
  for (let n = node.parent; n !== null; n = n.parent) {
    if (!SCOPE_NODES.has(n.type)) continue;
    if (n.type !== "class_definition" && pythonBoundParamNames(n).includes(name)) return true;
    if (bound.rebinds(n, name)) return true;
  }
  return false;
}

function isModuleLevel(scope: AstNode): boolean {
  const holder = scope.parent?.type === "decorated_definition" ? scope.parent : scope;
  return holder.parent?.type === "module";
}

function isCapWords(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90;
}

function moduleCallablesOf(root: AstNode): PythonModuleCallables {
  const functions = new Set<string>();
  const classes = new Set<string>();
  const fromImported = new Set<string>();
  for (const child of root.namedChildren) {
    const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    const name = def?.childForFieldName("name")?.text;
    if (def?.type === "function_definition" && name !== undefined) functions.add(name);
    else if (def?.type === "class_definition" && name !== undefined) classes.add(name);
    else if (child.type === "import_from_statement") addFromImportNames(child, fromImported);
  }
  return { functions, classes, fromImported };
}

function addFromImportNames(statement: AstNode, out: Set<string>): void {
  const moduleNode = statement.childForFieldName("module_name");
  for (const child of statement.namedChildren) {
    if (moduleNode !== null && child.startIndex === moduleNode.startIndex) continue;
    if (child.type === "dotted_name" && !child.text.includes(".")) out.add(child.text);
    else if (child.type === "aliased_import") {
      const alias = child.childForFieldName("alias")?.text;
      if (alias !== undefined) out.add(alias);
    }
  }
}

/**
 * Names a scope binds in its OWN body — parameters excluded, they are read
 * separately — memoized by the scope's offset (a non-materialized tree hands
 * out a fresh node object per access). Every binding form counts: assignment
 * and augmented-assignment targets, `for` / comprehension targets, `with … as`,
 * `except … as`, `:=`, imports, `global` / `nonlocal`, and the names of nested
 * defs and classes.
 */
class ScopeBindings {
  private readonly memo = new Map<number, ReadonlySet<string>>();

  rebinds(scope: AstNode, name: string): boolean {
    let names = this.memo.get(scope.startIndex);
    if (!names) this.memo.set(scope.startIndex, (names = bindingsOf(scope)));
    return names.has(name);
  }
}

function bindingsOf(scope: AstNode): ReadonlySet<string> {
  const names = new Set<string>();
  const body = scope.childForFieldName("body");
  if (body === null) return names;
  const visit = (node: AstNode): void => {
    for (const child of node.namedChildren) {
      if (SCOPE_NODES.has(child.type)) {
        const nested = child.childForFieldName("name");
        if (nested?.type === "identifier") names.add(nested.text);
        continue;
      }
      addBoundNames(child, names);
      visit(child);
    }
  };
  visit(body);
  return names;
}

/** Binding statements whose whole subtree is the target. */
const WHOLE_STATEMENT_BINDERS: ReadonlySet<string> = new Set([
  "global_statement",
  "nonlocal_statement",
  "import_statement",
  "import_from_statement",
]);

/** Binding statements whose target is the `left` field. */
const LEFT_FIELD_BINDERS: ReadonlySet<string> = new Set([
  "assignment",
  "augmented_assignment",
  "for_statement",
  "for_in_clause",
]);

/**
 * Every field name is a LITERAL argument of `childForFieldName`: the
 * materialization field-loss guard reads them off the source.
 */
function addBoundNames(node: AstNode, names: Set<string>): void {
  if (LEFT_FIELD_BINDERS.has(node.type)) targetNames(node.childForFieldName("left"), names);
  else if (node.type === "named_expression") targetNames(node.childForFieldName("name"), names);
  else if (node.type === "as_pattern") targetNames(node.childForFieldName("alias"), names);
  else if (WHOLE_STATEMENT_BINDERS.has(node.type)) targetNames(node, names);
}

/** Identifiers of a binding target — an attribute or subscript target binds no name. */
function targetNames(node: AstNode | null, names: Set<string>): void {
  if (node === null || node.type === "attribute" || node.type === "subscript") return;
  if (node.type === "identifier") {
    names.add(node.text);
    return;
  }
  for (const child of node.namedChildren) targetNames(child, names);
}
