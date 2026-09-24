/**
 * Python dict-table dispatch — the Python port of the lookup-table mechanism
 * the TypeScript walker ships (bd tea-rags-mcp-n0zj) and Ruby's registry
 * constants reuse (bd tea-rags-mcp-pq02v). bd tea-rags-mcp-pbwd, epic 542x.
 *
 * Three facts, one contract (`contracts/types/codegraph-dispatch.ts`):
 *
 *   1. `dispatchTables` — a MODULE-LEVEL `NAME = { … }` assigned exactly once,
 *      whose values name a callable: S2 `{"a": on_a}` (the entry IS the
 *      callable, spelled bare or dotted — `Cls.method`, `module.fn`) and S1
 *      `{"a": {"w": fn_a}}` (a field→callable map). A lambda, a call, a literal
 *      carries no symbol and is dropped per entry (m46z); a table left with no
 *      entry is not a table.
 *   2. `CallRef.dispatch` — a call whose CALLEE is a candidate set:
 *      `T[k](…)`, `T.get(k)(…)`, `T[k]["w"](…)`, or a local bound to one of
 *      those in the same function (`handler = T[k]; handler(…)`). S1 selects
 *      by SUBSCRIPT because a Python dict has no attribute access.
 *      `CallRef.dispatchArgs` — a candidate set passed positionally.
 *   3. `callbackParams` — the CALL-SITE positions a def invokes as `param(…)`.
 *      A method's `self` / `cls` is not a call-site argument, so its positions
 *      shift by one unless the def is a `@staticmethod`.
 *
 * Keys. Only a STRING literal is a static key — it narrows the fan to one
 * entry. Every other index is dynamic: `T[Kind.A]` and `T[self.kind]` are both
 * `attribute` nodes, and the walker cannot tell an enum member from a runtime
 * field. A non-string table key is kept under a bracketed spelling (`[Kind.A]`)
 * so it still joins a dynamic fan while no string key can ever select it.
 *
 * Gate. A subscript counts as a table read only when its base is a table this
 * file declares or a name a module-level `from m import NAME` binds — the same
 * gate the TypeScript walker takes (in-file tables ∪ imported names). A tagged
 * site skips the exact chain, so the gate is what keeps `handlers[k](x)` on a
 * PARAMETER out of the dispatch channel.
 *
 * Python dicts are mutable, so a table's entry set is a LOWER bound: an entry
 * added by `T["c"] = g` is missed, but no recorded entry is fabricated. A name
 * assigned twice at module level is ambiguous and dropped.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { DispatchRef, DispatchTable } from "../../../../../contracts/types/codegraph.js";

/** One visitor of the walker's flat pre-order descent (`walkOnce`). */
type PythonNodeVisitor = (node: AstNode) => void;

/** `scopeKey` of module scope — a function scope's key is its node's `startIndex`, never negative. */
const MODULE_SCOPE = -1;

/**
 * The per-file state the dispatch facets share during ONE descent: which names
 * gate a subscript as a table read, and which locals are bound to a candidate
 * set, per scope (`startIndex` of the enclosing def / lambda, or
 * {@link MODULE_SCOPE}). Keyed by offset, not by node identity, because a
 * non-materialized tree hands out a fresh node object per access.
 */
export interface PythonDispatchScope {
  readonly tableNames: ReadonlySet<string>;
  readonly bindings: Map<number, Map<string, DispatchRef>>;
}

/**
 * Module-level dict tables (fact 1). Direct children of the module only: a
 * table inside `if` / `try` or a function body is not a stable binding.
 */
export function collectPythonDispatchTables(root: AstNode): Record<string, DispatchTable> {
  const assignCount = new Map<string, number>();
  const literals = new Map<string, AstNode>();
  for (const statement of root.children) {
    if (statement.type !== "expression_statement") continue;
    for (const assignment of statement.namedChildren) {
      if (assignment.type !== "assignment") continue;
      const left = assignment.childForFieldName("left");
      if (left?.type !== "identifier") continue;
      assignCount.set(left.text, (assignCount.get(left.text) ?? 0) + 1);
      const right = assignment.childForFieldName("right");
      if (right?.type === "dictionary") literals.set(left.text, right);
    }
  }
  const out: Record<string, DispatchTable> = {};
  for (const [name, literal] of literals) {
    if (assignCount.get(name) !== 1) continue;
    const entries = dictionaryToTableEntries(literal);
    if (Object.keys(entries).length > 0) out[name] = { entries };
  }
  return out;
}

/**
 * The gate set for this file: its own tables plus every name a module-level
 * `from m import …` binds (the table may live in the imported module). A star
 * import binds no single name and contributes nothing.
 */
export function createPythonDispatchScope(
  root: AstNode,
  tables: Readonly<Record<string, DispatchTable>>,
): PythonDispatchScope {
  const tableNames = new Set<string>(Object.keys(tables));
  for (const statement of root.children) {
    if (statement.type !== "import_from_statement") continue;
    const moduleField = statement.childForFieldName("module_name");
    for (const child of statement.namedChildren) {
      if (moduleField !== null && child.startIndex === moduleField.startIndex) continue;
      const local =
        child.type === "aliased_import"
          ? child.childForFieldName("alias")?.text
          : child.type === "dotted_name" || child.type === "identifier"
            ? child.text
            : undefined;
      if (local !== undefined && !isCapWords(local)) tableNames.add(local);
    }
  }
  return { tableNames, bindings: new Map() };
}

/**
 * PEP 8's class spelling. An IMPORTED CapWords name subscripted and called is a
 * generic instantiation — flask's `ConfigAttribute[bool]("TESTING")`, polar's
 * `TypeAdapter[FileRead](FileRead)` — and tagging it would take the call off
 * the chain that resolves it. An in-file table needs no such guard: its dict
 * literal is the evidence.
 */
function isCapWords(name: string): boolean {
  return /^_*[A-Z]/.test(name) && /[a-z]/.test(name);
}

/**
 * Track `local = <candidate set>` per scope, in source order. A later
 * assignment of anything else to the same name in the same scope UNBINDS it,
 * so `handler = T[k]; handler = other; handler()` is an ordinary call. Must be
 * listed before the call collector on the shared descent.
 */
export function collectPythonDispatchBindings(scope: PythonDispatchScope): PythonNodeVisitor {
  return (node) => {
    if (node.type !== "assignment") return;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left?.type !== "identifier" || !right) return;
    const key = enclosingScopeKey(node);
    const ref = pythonDispatchRefOf(right, scope);
    let bound = scope.bindings.get(key);
    if (ref) {
      if (!bound) scope.bindings.set(key, (bound = new Map<string, DispatchRef>()));
      bound.set(left.text, ref);
    } else {
      bound?.delete(left.text);
    }
  };
}

/**
 * Abstract-interpret an expression to the candidate set it denotes, or `null`.
 * Composes through subscript / `dict.get` / bound local so every access shape
 * shares one path (the TypeScript walker's `exprToDispatchRef`, Python forms).
 */
export function pythonDispatchRefOf(node: AstNode, scope: PythonDispatchScope): DispatchRef | null {
  if (node.type === "identifier") return lookupDispatchBinding(node, node.text, scope);
  if (node.type === "subscript") {
    const parts = node.namedChildren;
    if (parts.length !== 2) return null; // `T[a, b]` indexes by a tuple — no single key
    const [base, index] = parts;
    if (base.type === "identifier" && scope.tableNames.has(base.text)) {
      return { table: base.text, field: null, key: pythonStringLiteral(index) };
    }
    // `<entry>["w"]` — only an entry-ref can be field-narrowed, and only by a literal field.
    const field = pythonStringLiteral(index);
    if (field === null) return null;
    const inner = pythonDispatchRefOf(base, scope);
    return inner?.field === null ? { table: inner.table, field, key: inner.key } : null;
  }
  if (node.type === "call") {
    // `T.get(k)` / `T.get(k, default)` — the entry reference `dict.get` returns.
    const fn = node.childForFieldName("function");
    if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "get") return null;
    const base = fn.childForFieldName("object");
    if (base?.type !== "identifier" || !scope.tableNames.has(base.text)) return null;
    const first = node.childForFieldName("arguments")?.namedChildren[0];
    if (!first || first.type === "keyword_argument" || first.type === "list_splat") return null;
    return { table: base.text, field: null, key: pythonStringLiteral(first) };
  }
  return null;
}

/**
 * Candidate sets passed POSITIONALLY at a call site (fact 2's `dispatchArgs`).
 * A keyword argument has no position; a `*splat` makes every later position
 * unknowable, so the scan stops there.
 */
export function pythonDispatchArgs(
  callNode: AstNode,
  scope: PythonDispatchScope,
): { argIndex: number; candidate: DispatchRef }[] {
  const out: { argIndex: number; candidate: DispatchRef }[] = [];
  const args = callNode.childForFieldName("arguments");
  if (args?.type !== "argument_list") return out;
  let position = 0;
  for (const arg of args.namedChildren) {
    if (arg.type === "list_splat" || arg.type === "dictionary_splat") break;
    if (arg.type === "keyword_argument" || arg.type === "comment") continue;
    const candidate = pythonDispatchRefOf(arg, scope);
    if (candidate) out.push({ argIndex: position, candidate });
    position++;
  }
  return out;
}

/**
 * Record, per def, the call-site positions it invokes as `param(…)` (fact 3).
 * Keyed by the def's 1-based line — the join key the walker already uses for
 * def signatures — and mapped to a chunk symbolId by
 * {@link pythonCallbackParamsBySymbol}. Only the NEAREST enclosing def counts:
 * a param invoked inside a nested def is a closure the nested def owns.
 */
export function collectPythonCallbackParams(out: Map<number, Set<number>>): PythonNodeVisitor {
  const positionsByDef = new Map<number, ReadonlyMap<string, number>>();
  return (node) => {
    if (node.type !== "call") return;
    const callee = node.childForFieldName("function");
    if (callee?.type !== "identifier") return;
    const def = enclosingDef(node);
    if (!def) return;
    let positions = positionsByDef.get(def.startIndex);
    if (!positions) positionsByDef.set(def.startIndex, (positions = callSitePositions(def)));
    const position = positions.get(callee.text);
    if (position === undefined) return;
    const line = def.startPosition.row + 1;
    let invoked = out.get(line);
    if (!invoked) out.set(line, (invoked = new Set()));
    invoked.add(position);
  };
}

/** Join the per-def-line positions onto the chunk declared on that line. */
export function pythonCallbackParamsBySymbol(
  byDefLine: ReadonlyMap<number, ReadonlySet<number>>,
  chunks: readonly { symbolId: string; startLine: number }[],
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [line, positions] of byDefLine) {
    const chunk = chunks.find((c) => c.startLine === line);
    if (!chunk) continue;
    out[chunk.symbolId] = [...positions].sort((a, b) => a - b);
  }
  return out;
}

function dictionaryToTableEntries(dict: AstNode): Record<string, string | Record<string, string>> {
  const entries: Record<string, string | Record<string, string>> = {};
  for (const pair of dict.namedChildren) {
    if (pair.type !== "pair") continue; // `**other` splat, comment
    const keyNode = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (!keyNode || !value) continue;
    const key = pythonStringLiteral(keyNode) ?? `[${keyNode.text}]`;
    if (value.type === "dictionary") {
      const fields = dictionaryToFieldMap(value);
      if (Object.keys(fields).length > 0) entries[key] = fields;
      continue;
    }
    const callable = pythonCallableSpelling(value);
    if (callable !== null) entries[key] = callable;
  }
  return entries;
}

function dictionaryToFieldMap(dict: AstNode): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const pair of dict.namedChildren) {
    if (pair.type !== "pair") continue;
    const keyNode = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    const field = keyNode ? pythonStringLiteral(keyNode) : null;
    const callable = value ? pythonCallableSpelling(value) : null;
    if (field !== null && callable !== null) fields[field] = callable;
  }
  return fields;
}

/** `on_a` / `Cls.method` / `pkg.mod.fn` — a plain or dotted name, nothing computed. */
function pythonCallableSpelling(node: AstNode): string | null {
  return isDottedName(node) ? node.text : null;
}

function isDottedName(node: AstNode): boolean {
  if (node.type === "identifier") return true;
  if (node.type !== "attribute") return false;
  const object = node.childForFieldName("object");
  return object !== null && node.childForFieldName("attribute")?.type === "identifier" && isDottedName(object);
}

/** A plain string literal's value; `null` for an f-string with interpolation or any other node. */
function pythonStringLiteral(node: AstNode): string | null {
  if (node.type !== "string") return null;
  let value = "";
  for (const child of node.namedChildren) {
    if (child.type === "interpolation") return null;
    if (child.type === "string_content") value += child.text;
  }
  return value;
}

/** A bound local, looked up in its own def scope first, then at module scope. */
function lookupDispatchBinding(node: AstNode, name: string, scope: PythonDispatchScope): DispatchRef | null {
  if (scope.bindings.size === 0) return null;
  const key = enclosingScopeKey(node);
  return scope.bindings.get(key)?.get(name) ?? scope.bindings.get(MODULE_SCOPE)?.get(name) ?? null;
}

function enclosingScopeKey(node: AstNode): number {
  for (let n = node.parent; n !== null; n = n.parent) {
    if (n.type === "function_definition" || n.type === "lambda") return n.startIndex;
  }
  return MODULE_SCOPE;
}

function enclosingDef(node: AstNode): AstNode | null {
  for (let n = node.parent; n !== null; n = n.parent) {
    if (n.type === "function_definition") return n;
    if (n.type === "class_definition") return null;
  }
  return null;
}

/**
 * Parameter name → CALL-SITE position. The `/` marker is not a parameter; a
 * `*args`, a bare `*` or a `**kwargs` ends the positional run. A method's
 * receiver parameter occupies no call-site position.
 */
function callSitePositions(def: AstNode): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  const params = def.childForFieldName("parameters");
  if (!params) return positions;
  const receiverSlots = isMethodDef(def) && !isStaticMethodDef(def) ? 1 : 0;
  let slot = 0;
  for (const param of params.namedChildren) {
    if (param.type === "positional_separator" || param.type === "comment") continue;
    if (
      param.type === "list_splat_pattern" ||
      param.type === "keyword_separator" ||
      param.type === "dictionary_splat_pattern"
    ) {
      break;
    }
    const name = parameterName(param);
    const position = slot - receiverSlots;
    if (name !== null && position >= 0) positions.set(name, position);
    slot++;
  }
  return positions;
}

function parameterName(param: AstNode): string | null {
  if (param.type === "identifier") return param.text;
  if (param.type === "typed_parameter") {
    const head = param.namedChildren[0];
    return head?.type === "identifier" ? head.text : null;
  }
  if (param.type === "default_parameter" || param.type === "typed_default_parameter") {
    const name = param.childForFieldName("name");
    return name?.type === "identifier" ? name.text : null;
  }
  return null;
}

function isMethodDef(def: AstNode): boolean {
  const holder = def.parent?.type === "decorated_definition" ? def.parent : def;
  return holder.parent?.type === "block" && holder.parent.parent?.type === "class_definition";
}

function isStaticMethodDef(def: AstNode): boolean {
  if (def.parent?.type !== "decorated_definition") return false;
  return def.parent.namedChildren.some(
    (child) => child.type === "decorator" && child.namedChildren[0]?.text === "staticmethod",
  );
}
