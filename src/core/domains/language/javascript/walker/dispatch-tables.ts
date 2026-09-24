/**
 * Lookup-table dispatch extraction for JavaScript (bd tea-rags-mcp-hkj8) — the
 * port of the TypeScript walker's n0zj mechanism onto tree-sitter-javascript.
 *
 * JavaScript writes the same idiom TypeScript does — `const H = { a: fnA };
 * H[k](x)` and `const T = { a: { run: fnA } }; T[k].run(x)` — and the node
 * shapes the mechanism reads (`subscript_expression`, `member_expression`,
 * `pair`, `lexical_declaration`) are shared by both grammars. Three shapes are
 * JavaScript's own and are handled here rather than in the TypeScript walker:
 *
 *   - object SHORTHAND entries (`{ get, post }`) — the dominant way a JS module
 *     assembles a handler map; the key names the function it holds;
 *   - CommonJS bindings (`const t = require("./t")`, `const { T } = require(…)`)
 *     as table names, beside ES `import` bindings — the JS walker records no
 *     `importedNames`, so the gate set is built from the syntax directly;
 *   - parameter forms `tree-sitter-javascript` spells without TypeScript's
 *     `required_parameter` wrapper: a bare `identifier`, a default-valued
 *     `assignment_pattern`, and an arrow's single unparenthesized `parameter`.
 *
 * Output rides the shared `FileExtraction.dispatchTables` / `callbackParams` /
 * `CallRef.dispatch` / `CallRef.dispatchArgs` contract unchanged; the provider
 * aggregates it run-global and `JavascriptCallResolver#resolveDispatch` fans it
 * out.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { DispatchRef, DispatchTable } from "../../../../contracts/types/codegraph.js";

/**
 * Per-function dispatch-bound locals: a `const` whose initializer is a dispatch
 * expression (`TABLE[key]` entry-ref, or `TABLE[key].field` field-ref).
 */
export type JsDispatchScope = Map<string, DispatchRef>;

type ChunkRange = { symbolId: string; startLine: number; endLine: number; scope: string[] };

/**
 * Module-level `const NAME = { … }` dispatch tables. S1 wrapper-object entries
 * become a field→fn map; S2 direct-function entries (including shorthand
 * `{ fnA }`) become a fn name. Only plain-identifier values are recorded —
 * arrows, calls, spreads carry no symbol. Tables with zero usable entries (pure
 * config objects) are omitted.
 */
export function collectJsDispatchTables(root: AstNode): Record<string, DispatchTable> {
  const out: Record<string, DispatchTable> = createIdentifierRecord();
  const consider = (decl: AstNode): void => {
    if (decl.type !== "lexical_declaration" || !isConstDeclaration(decl)) return;
    for (const d of decl.children) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      const value = d.childForFieldName("value");
      if (name?.type !== "identifier" || value?.type !== "object") continue;
      const entries = objectToTableEntries(value);
      if (Object.keys(entries).length > 0) out[name.text] = { entries };
    }
  };
  // Top-level only: direct program children, and `export const` declarations.
  for (const child of root.children) {
    if (child.type === "lexical_declaration") consider(child);
    else if (child.type === "export_statement") for (const sub of child.children) consider(sub);
  }
  return out;
}

function objectToTableEntries(objNode: AstNode): Record<string, string | Record<string, string>> {
  const entries: Record<string, string | Record<string, string>> = createIdentifierRecord();
  for (const member of objNode.namedChildren) {
    if (member.type === "shorthand_property_identifier") {
      entries[member.text] = member.text; // S2 shorthand: `{ fnA }` ≡ `{ fnA: fnA }`
      continue;
    }
    if (member.type !== "pair") continue;
    const key = keyText(member.childForFieldName("key"));
    const value = member.childForFieldName("value");
    if (key === null || !value) continue;
    if (value.type === "identifier") {
      entries[key] = value.text; // S2: entry IS the function
    } else if (value.type === "object") {
      entries[key] = objectFieldsToMap(value); // S1: field→fn map (may be empty)
    }
    // arrow_function / call_expression / etc. → no symbol → skip entry.
  }
  return entries;
}

function objectFieldsToMap(objNode: AstNode): Record<string, string> {
  const map: Record<string, string> = createIdentifierRecord();
  for (const member of objNode.namedChildren) {
    if (member.type === "shorthand_property_identifier") {
      map[member.text] = member.text;
      continue;
    }
    if (member.type !== "pair") continue;
    const key = keyText(member.childForFieldName("key"));
    const value = member.childForFieldName("value");
    if (key !== null && value?.type === "identifier") map[key] = value.text;
  }
  return map;
}

/** `property_identifier` → its text; quoted `string` key → stripped; computed
 *  keys (`[x]:`) and numeric keys → null (no stable string key). */
function keyText(node: AstNode | null): string | null {
  if (!node) return null;
  if (node.type === "property_identifier") return node.text;
  if (node.type === "string") return stripQuotes(node.text);
  return null;
}

/**
 * Local names a file binds to another MODULE — the second half of the dispatch
 * gate: a table defined elsewhere and reached through an import. ES `import`
 * clauses (default, namespace, named with alias) and CommonJS `require`
 * declarators (`const t = require(…)`, `const { T, U: V } = require(…)`).
 * Collected for the gate only; the walker's `imports[]` channel is untouched.
 */
export function collectJsModuleBindingNames(root: AstNode): Set<string> {
  const names = new Set<string>();
  walk(root, (node) => {
    if (node.type === "import_statement") {
      const clause = node.children.find((c) => c.type === "import_clause");
      if (clause) collectImportClauseNames(clause, names);
      return;
    }
    if (node.type !== "variable_declarator") return;
    const value = node.childForFieldName("value");
    if (!isRequireCall(value)) return;
    const target = node.childForFieldName("name");
    if (target?.type === "identifier") names.add(target.text);
    else if (target?.type === "object_pattern") collectObjectPatternNames(target, names);
  });
  return names;
}

function collectImportClauseNames(clause: AstNode, names: Set<string>): void {
  for (const child of clause.children) {
    if (child.type === "identifier") {
      names.add(child.text);
    } else if (child.type === "namespace_import") {
      const local = child.children.find((c) => c.type === "identifier");
      if (local) names.add(local.text);
    } else if (child.type === "named_imports") {
      for (const spec of child.children) {
        if (spec.type !== "import_specifier") continue;
        const local = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
        if (local) names.add(local.text);
      }
    }
  }
}

function collectObjectPatternNames(pattern: AstNode, names: Set<string>): void {
  for (const member of pattern.namedChildren) {
    if (member.type === "shorthand_property_identifier_pattern") {
      names.add(member.text);
    } else if (member.type === "pair_pattern") {
      const value = member.childForFieldName("value");
      if (value?.type === "identifier") names.add(value.text);
    }
  }
}

function isRequireCall(node: AstNode | null): boolean {
  if (node?.type !== "call_expression") return false;
  const fn = node.childForFieldName("function");
  return fn?.type === "identifier" && fn.text === "require";
}

/**
 * Abstract-interpret an expression to "which dispatch candidate set is this".
 * Composes through subscript / member / binding so all access patterns share
 * one path. Returns null when the expression is not a dispatch reference.
 */
export function jsExprToDispatchRef(
  node: AstNode,
  scopes: readonly JsDispatchScope[],
  tableNames: ReadonlySet<string>,
): DispatchRef | null {
  // A dispatch-bound local — `f` (field-ref) or `e` (entry-ref).
  if (node.type === "identifier") return lookupDispatchScope(scopes, node.text);
  // `TABLE[key]` — entry reference (field null). Only when TABLE is a known
  // dispatch table name (gated) and the object is a plain identifier.
  if (node.type === "subscript_expression") {
    const obj = node.childForFieldName("object");
    if (obj?.type !== "identifier" || !tableNames.has(obj.text)) return null;
    return { table: obj.text, field: null, key: staticKeyOf(node) };
  }
  // `<expr>.field` — narrows a candidate set to that field.
  if (node.type === "member_expression") {
    const obj = node.childForFieldName("object");
    const prop = node.childForFieldName("property");
    if (!obj || !prop) return null;
    if (obj.type === "subscript_expression") {
      const inner = jsExprToDispatchRef(obj, scopes, tableNames);
      return inner ? { table: inner.table, field: prop.text, key: inner.key } : null;
    }
    // `entryBoundLocal.field` — only an entry-ref (field === null) can be
    // field-narrowed; a field-bound local `.field` would be chaining (out of
    // scope — single field selection only).
    if (obj.type === "identifier") {
      const bound = lookupDispatchScope(scopes, obj.text);
      if (bound?.field === null) return { table: bound.table, field: prop.text, key: bound.key };
    }
  }
  return null;
}

/**
 * Register every `const NAME = <dispatchExpr>` of a `lexical_declaration` into
 * the innermost scope. `let` / `var` never bind — the m46z rule: a reassignable
 * binding may not hold the candidate set by the time it is called.
 */
export function bindJsDispatchLocals(
  node: AstNode,
  scopes: readonly JsDispatchScope[],
  tableNames: ReadonlySet<string>,
): void {
  if (node.type !== "lexical_declaration" || !isConstDeclaration(node)) return;
  for (const decl of node.children) {
    if (decl.type !== "variable_declarator") continue;
    const name = decl.childForFieldName("name");
    const value = decl.childForFieldName("value");
    if (name?.type !== "identifier" || !value) continue;
    const ref = jsExprToDispatchRef(value, scopes, tableNames);
    if (ref) scopes[scopes.length - 1].set(name.text, ref);
  }
}

function lookupDispatchScope(scopes: readonly JsDispatchScope[], name: string): DispatchRef | null {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const hit = scopes[i].get(name);
    if (hit) return hit;
  }
  return null;
}

/** Static string-literal key (`TABLE["js"]`) → `"js"`; dynamic key → null. */
function staticKeyOf(subscript: AstNode): string | null {
  const index = subscript.childForFieldName("index");
  if (index?.type !== "string") return null;
  return stripQuotes(index.text);
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

function isConstDeclaration(node: AstNode): boolean {
  // `let` / `const` are both `lexical_declaration`; only const qualifies.
  return node.children.some((c) => c.type === "const");
}

/**
 * Function-like nodes open a fresh dispatch binding scope. `function` is the
 * pre-0.21 spelling of `function_expression` — accepted so a grammar bump in
 * either direction keeps the scope boundary.
 */
export function isJsFunctionLike(node: AstNode): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "function_expression" ||
    node.type === "function" ||
    node.type === "arrow_function" ||
    node.type === "method_definition" ||
    node.type === "generator_function" ||
    node.type === "generator_function_declaration"
  );
}

/**
 * `fnSymbolId → invokedParamIndices` for the bounded inter-proc join. For each
 * function / method, the parameter positions invoked as `param(...)` inside its
 * body, attributed to the innermost chunk that owns the declaration line.
 */
export function collectJsCallbackParams(root: AstNode, chunks: readonly ChunkRange[]): Record<string, number[]> {
  const out: Record<string, number[]> = createIdentifierRecord();
  walk(root, (node) => {
    if (!isJsFunctionLike(node)) return;
    const body = node.childForFieldName("body");
    if (!body) return;
    const nameToIndex = parameterPositions(node);
    if (nameToIndex.size === 0) return;
    const invoked = new Set<number>();
    walk(body, (n) => {
      if (n.type !== "call_expression") return;
      const callee = n.childForFieldName("function");
      if (callee?.type !== "identifier") return;
      const idx = nameToIndex.get(callee.text);
      if (idx !== undefined) invoked.add(idx);
    });
    if (invoked.size === 0) return;
    const symbolId = innermostSymbolId(node.startPosition.row + 1, chunks);
    if (!symbolId) return;
    const merged = new Set<number>(out[symbolId] ?? []);
    for (const i of invoked) merged.add(i);
    out[symbolId] = [...merged].sort((a, b) => a - b);
  });
  return out;
}

/**
 * paramName → positional index. Every named child advances the index so a
 * destructured / rest param (which yields no name) keeps later positions
 * aligned with call-site argument positions. An arrow's single
 * unparenthesized param sits in the `parameter` field, not `parameters`.
 */
function parameterPositions(fn: AstNode): Map<string, number> {
  const nameToIndex = new Map<string, number>();
  const single = fn.childForFieldName("parameter");
  if (single?.type === "identifier") {
    nameToIndex.set(single.text, 0);
    return nameToIndex;
  }
  const params = fn.childForFieldName("parameters");
  if (!params) return nameToIndex;
  params.namedChildren.forEach((p, i) => {
    const name = paramName(p);
    if (name !== null) nameToIndex.set(name, i);
  });
  return nameToIndex;
}

function paramName(node: AstNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "assignment_pattern") {
    const left = node.childForFieldName("left");
    return left?.type === "identifier" ? left.text : null;
  }
  return null;
}

/** symbolId of the innermost chunk whose line range contains `line`
 *  (smallest span, deeper scope wins ties) — same discipline as
 *  `assignCallsToInnermostChunks`. */
function innermostSymbolId(line: number, chunks: readonly ChunkRange[]): string | undefined {
  let best: { symbolId: string; span: number; depth: number } | undefined;
  for (const c of chunks) {
    if (line < c.startLine || line > c.endLine) continue;
    const span = c.endLine - c.startLine;
    const depth = c.scope.length;
    if (!best || span < best.span || (span === best.span && depth > best.depth)) {
      best = { symbolId: c.symbolId, span, depth };
    }
  }
  return best?.symbolId;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
