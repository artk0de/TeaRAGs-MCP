/**
 * TypeScript extraction walker.
 *
 * Slice-1 design note: this walker is invoked **outside the chunker hook
 * chain** (which is per-container — see `.claude/rules/chunker-hooks.md`)
 * and outside the worker thread (`TreeSitterChunker` runs in a worker via
 * `ChunkerPool`; `ExtractionSink` lives in the main process at the
 * codegraph enrichment provider).
 *
 * Slice 1 wires the walker into the main-thread post-chunking pass
 * (T10 integration). The walker reuses the chunker's intent to walk the
 * AST exactly once per file, but it parses on its own to avoid the
 * non-serialisable function across the worker boundary. Slice 2 may
 * fold extraction into the worker response to eliminate the second
 * parse — at that point both sides return both artifacts and the
 * walker becomes the canonical extraction shape.
 */

import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type {
  CallRef,
  ChunkExtraction,
  DispatchRef,
  DispatchTable,
  FileExtraction,
  ImportRef,
  InheritanceEdgeDecl,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";

export interface ExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  /** Caller-provided chunk-range index, sorted by startLine ascending. */
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromTypescriptFile(input: ExtractInput): FileExtraction {
  const imports = collectImports(input.tree.rootNode);
  // bd tea-rags-mcp-n0zj — lookup-table dispatch. Collect module-level const
  // tables first so the call walk knows which subscript receivers are real
  // dispatch tables. The gate set unions in-file const tables with imported
  // names: an in-file `TABLE[k].field()` and an imported-table dispatch are
  // both tagged here (the resolver disambiguates run-global vs import map),
  // while a plain `arr[i].push()` on a local `let`/`var`/array is NOT tagged.
  const dispatchTables = collectDispatchTables(input.tree.rootNode);
  const dispatchTableNames = new Set<string>(Object.keys(dispatchTables));
  for (const imp of imports) for (const n of imp.importedNames ?? []) dispatchTableNames.add(n);
  const calls = collectCalls(input.tree.rootNode, dispatchTableNames);
  // Callback params keyed by the symbolId of the chunk that owns each
  // function/method body — feeds the resolver's bounded inter-proc join.
  const callbackParams = collectCallbackParams(input.tree.rootNode, input.chunks);
  const classFieldTypes = collectClassFieldTypes(input.tree.rootNode);
  const classExtends = collectClassExtends(input.tree.rootNode);
  // Convert nested Map → nested Record so the contract survives NDJSON
  // spill between walker emit and resolver consume.
  const classFieldTypesRecord: Record<string, Record<string, string>> = {};
  for (const [cls, fields] of classFieldTypes) {
    classFieldTypesRecord[cls] = Object.fromEntries(fields);
  }
  // Innermost-chunk attribution: assign each call to ONE chunk only — the
  // smallest containing range, ties broken by deeper scope length. Without
  // this guard, a call inside `class C { m() { foo() } }` lands on BOTH the
  // class chunk and the method chunk and inflates caller-edge counts by the
  // nesting depth (bd tea-rags-mcp-otjs — mirrors ruby tea-rags-mcp-8fnu).
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  // bd tea-rags-mcp-x6ta — record `paramName → type` bindings for typed
  // function / method / arrow parameters so the resolver can pin
  // `param.method()` to `<Type>#<method>` instead of dropping to the
  // ambiguous short-name fallback. Same `localBindings` field the
  // Python / Go walkers use. Each binding is attributed to the INNERMOST
  // chunk containing its declaration line — a method's parameter belongs
  // to the method chunk, not the enclosing class chunk that also spans
  // the `def` line (mirrors the innermost call-attribution discipline).
  const paramBindings = collectParamBindings(input.tree.rootNode);
  // bd tea-rags-mcp-2yfi — also bind concrete-class types from variable
  // declarations and re-assignments so the SAME `localBindings` channel (and
  // thus the existing ts-local-binding resolver strategy) resolves
  // `x.method()` for `const x = new T()` / `const x: T = …` / `x = new T()`.
  // Merged with the typed-parameter bindings and sorted by declaration line
  // so `resolveLocalBindingType` sees the bindings in source order (the
  // re-assignment / shadowing case relies on the most-recent line ≤ call).
  const variableBindings = collectVariableBindings(input.tree.rootNode);
  const allBindings = [...paramBindings, ...variableBindings].sort((a, b) => a.startLine - b.startLine);
  const bindingOwnership = assignParamBindingsToInnermostChunks(allBindings, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const chunk: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    const bindings = bindingOwnership.get(chunkIndex);
    if (bindings && Object.keys(bindings).length > 0) chunk.localBindings = bindings;
    return chunk;
  });
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
    classFieldTypes: classFieldTypesRecord,
  };
  if (classExtends.size > 0) {
    // Convert Map → Record so the field round-trips through the NDJSON
    // spill in the codegraph provider. Mirrors the same discipline as
    // ruby-walker's `classAncestors` / `classPrependedAncestors`.
    const classExtendsRecord: Record<string, string> = {};
    for (const [cls, parent] of classExtends) classExtendsRecord[cls] = parent;
    out.classExtends = classExtendsRecord;
  }
  if (Object.keys(dispatchTables).length > 0) out.dispatchTables = dispatchTables;
  if (Object.keys(callbackParams).length > 0) out.callbackParams = callbackParams;
  // bd tea-rags-mcp-f10y — unified hierarchy capture. Distinct from
  // `classExtends` (call-graph super dispatch, single parent): this records
  // ALL hierarchy edges incl. `implements` and interface heritage, which
  // classExtends deliberately omits as "type-only, no runtime dispatch".
  const inheritanceEdges = collectInheritanceEdges(input.tree.rootNode);
  if (inheritanceEdges.length > 0) out.inheritanceEdges = inheritanceEdges;
  return out;
}

/**
 * Assign each call to exactly ONE chunk — the smallest containing line
 * range. Tie-breaker: deeper scope (longer `scope[]`) wins, so a method-
 * level chunk beats its enclosing class when both happen to span the same
 * number of lines.
 *
 * Returns a Map keyed by chunk index → CallRef[]. Chunks with no calls
 * have no entry (caller defaults to `[]`).
 *
 * Calls whose startLine falls outside every chunk are dropped silently —
 * matches the previous behaviour for unreachable call sites.
 */
function assignCallsToInnermostChunks(
  calls: CallRef[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, CallRef[]> {
  const out = new Map<number, CallRef[]>();
  for (const call of calls) {
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (call.startLine < c.startLine || call.startLine > c.endLine) continue;
      const span = c.endLine - c.startLine;
      const depth = c.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = i;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    if (bestIdx === -1) continue;
    const bucket = out.get(bestIdx);
    if (bucket) bucket.push(call);
    else out.set(bestIdx, [call]);
  }
  return out;
}

/**
 * Every runtime module dependency the file declares, in one channel.
 *
 * Three source shapes reach `imports[]`, each with its own collector:
 *   - `import … from "./y"` — ESM (`collectEsmImport`)
 *   - `export … from "./y"` — re-export (`collectReexport`, bd tea-rags-mcp-f2u54)
 *   - `require("./y")`      — CJS interop (`collectRequire`, bd tea-rags-mcp-f2u54)
 *
 * They share the channel because the graph asks one question of all three —
 * "which files does this file load at runtime" — and answers it identically.
 */
function collectImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type === "import_statement") collectEsmImport(node, out);
    else if (node.type === "export_statement") collectReexport(node, out);
    else if (node.type === "call_expression") collectRequire(node, out);
  });
  return out;
}

/** Strip the surrounding quotes from a tree-sitter `string` node's text. */
function stringLiteralText(node: AstNode): string {
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

function collectEsmImport(node: AstNode, out: ImportRef[]): void {
  // Skip top-level type-only imports (bd tea-rags-mcp-m19a):
  // `import type { X } from "./x"` is erased at compile time and
  // produces no runtime dependency. Including it in imports[] inflates
  // codegraph fanOut/fanIn for type-only relationships. The grammar
  // emits the `type` keyword as a direct child of `import_statement`
  // right after the `import` keyword for the statement-level type-only
  // form. Per-specifier `import { type X, Y }` is NOT filtered — the
  // statement is still a runtime import that loads `Y`.
  if (hasTypeOnlyModifier(node, "import")) return;
  const src = node.children.find((c) => c.type === "string");
  if (!src) return;
  // bd tea-rags-mcp-2v16 — capture the LOCAL binding names this import
  // introduces so the resolver can map `Receiver.method()` straight to
  // this module by exact name. Populated in this ONE place (colocation):
  // default import, `* as ns` namespace, and each named specifier's
  // local name (alias when present, else the imported name). Bare
  // side-effect imports have no `import_clause` → undefined.
  const importedNames = collectImportedNames(node);
  const ref: ImportRef = { importText: stringLiteralText(src), startLine: node.startPosition.row + 1 };
  if (importedNames.length > 0) ref.importedNames = importedNames;
  out.push(ref);
}

/**
 * Statement-level `type` modifier — `import type { X } from …` /
 * `export type { X } from …`. The grammar emits the keyword as a direct child
 * right after the `import` / `export` keyword. Per-specifier `{ type X, Y }`
 * is deliberately NOT matched: that statement still loads `Y` at runtime.
 */
function hasTypeOnlyModifier(node: AstNode, keyword: "import" | "export"): boolean {
  const idx = node.children.findIndex((c) => c.type === keyword || c.text === keyword);
  if (idx < 0) return false;
  const next = node.children[idx + 1];
  return next !== undefined && (next.type === "type" || next.text === "type");
}

/**
 * Re-export with a source module (bd tea-rags-mcp-f2u54): `export { X } from
 * "./y"`, `export * from "./y"` (the index.ts barrel), `export * as ns from
 * "./y"`. All three load the source module at runtime, so they are file
 * dependencies exactly like an import — without this a barrel file looked
 * like a leaf with zero fan-out.
 *
 * No `importedNames`: a re-export introduces NO local binding. `X` in
 * `export { X } from "./y"` is not in scope in this file, so recording it as
 * a receiver name the resolver can match would be a lie. Consumers reach `X`
 * by importing THIS file, and that hop is the resolver's to make.
 *
 * The `source` FIELD is what gates the emit, not the presence of a string
 * child: `export default "literal"` has a direct string child and no source.
 * Type-only re-exports are erased at compile time and excluded, mirroring the
 * import-side filter (bd tea-rags-mcp-m19a).
 */
function collectReexport(node: AstNode, out: ImportRef[]): void {
  const src = node.childForFieldName("source");
  if (src?.type !== "string") return;
  if (hasTypeOnlyModifier(node, "export")) return;
  out.push({ importText: stringLiteralText(src), startLine: node.startPosition.row + 1 });
}

/**
 * CommonJS `require("./y")` (bd tea-rags-mcp-f2u54). Mixed ESM/CJS files are
 * ordinary in real repos, and before this the whole CJS half of a file's
 * dependencies was invisible to the graph.
 *
 * The local binding comes from the enclosing declarator, so the same
 * receiver→module match the ESM `importedNames` channel enables works for
 * `const helper = require("./helper"); helper.run()`. A non-literal specifier
 * (`require(path)`) is not a knowable dependency and contributes nothing.
 */
function collectRequire(node: AstNode, out: ImportRef[]): void {
  const callee = node.childForFieldName("function");
  if (callee?.type !== "identifier" || callee.text !== "require") return;
  const first = node.childForFieldName("arguments")?.namedChildren[0];
  if (first?.type !== "string") return;
  const ref: ImportRef = { importText: stringLiteralText(first), startLine: node.startPosition.row + 1 };
  const names = requireBindingNames(node.parent);
  if (names.length > 0) ref.importedNames = names;
  out.push(ref);
}

/**
 * Local names a `require()` call binds, read from the declarator that owns it.
 * Mirrors {@link collectImportedNames}' alias discipline — the LOCAL name wins
 * (`const { a: local } = require(…)` binds `local`, exactly as `import { a as
 * local }` does). A bare side-effect `require("./polyfill")` has no declarator
 * parent and binds nothing.
 */
function requireBindingNames(declarator: AstNode | null): string[] {
  if (declarator?.type !== "variable_declarator") return [];
  const target = declarator.childForFieldName("name");
  if (!target) return [];
  if (target.type === "identifier") return [target.text];
  if (target.type !== "object_pattern") return [];
  const names: string[] = [];
  for (const child of target.namedChildren) {
    if (child.type === "shorthand_property_identifier_pattern") names.push(child.text);
    else if (child.type === "pair_pattern") {
      const local = child.childForFieldName("value");
      if (local?.type === "identifier") names.push(local.text);
    }
  }
  return names;
}

/**
 * Read the local binding names introduced by an `import_statement`.
 *
 * tree-sitter-typescript shapes inside `import_clause`:
 *   - default import:   `identifier "Foo"`                  → "Foo"
 *   - namespace import: `namespace_import ("*" "as" name)`  → local name
 *   - named imports:    `named_imports → import_specifier`  → alias if
 *     present (`{ A as B }` → "B"), else the imported `name` (`{ A }` → "A").
 *
 * Returns the names in source order. Empty when the statement is a bare
 * side-effect import (`import "./x"`) — no `import_clause` child.
 */
function collectImportedNames(node: AstNode): string[] {
  const clause = node.children.find((c) => c.type === "import_clause");
  if (!clause) return [];
  const names: string[] = [];
  for (const child of clause.children) {
    if (child.type === "identifier") {
      // Default import binding — `import Foo from "..."`.
      names.push(child.text);
    } else if (child.type === "namespace_import") {
      // `* as ns` — the local binding is the identifier after `as`.
      const local = child.children.find((c) => c.type === "identifier");
      if (local) names.push(local.text);
    } else if (child.type === "named_imports") {
      for (const spec of child.children) {
        if (spec.type !== "import_specifier") continue;
        // `alias` field is the local name for `{ A as B }`; otherwise the
        // `name` field is both the imported and the local name.
        const alias = spec.childForFieldName("alias");
        const name = spec.childForFieldName("name");
        const local = alias ?? name;
        if (local) names.push(local.text);
      }
    }
  }
  return names;
}

/**
 * Per-chunk dispatch-bound local: a `const` whose initializer is a dispatch
 * expression (`TABLE[key]` entry-ref, or `TABLE[key].field` field-ref).
 * Tracked function-scoped so `const f = T[k].w; f(x)` and
 * `const e = T[k]; e.w(x)` resolve uniformly.
 */
type DispatchScope = Map<string, DispatchRef>;

/**
 * Scope-aware call collection (bd tea-rags-mcp-n0zj). Replaces the previous
 * flat `walk`: a recursive pass that maintains a stack of dispatch-bound
 * `const` locals per function body so dispatch composes through
 * `subscript → member → binding → call`. Non-dispatch calls behave exactly
 * as before. `tableNames` gates which subscript receivers count as dispatch
 * tables (in-file const tables ∪ imported names).
 */
function collectCalls(root: AstNode, tableNames: ReadonlySet<string>): CallRef[] {
  const out: CallRef[] = [];
  walkCalls(root, [new Map<string, DispatchRef>()], tableNames, out);
  return out;
}

function walkCalls(node: AstNode, scopes: DispatchScope[], tableNames: ReadonlySet<string>, out: CallRef[]): void {
  // Function-like nodes open a fresh binding scope; everything else (blocks,
  // statements) shares the enclosing function's scope — function-scoped
  // tracking matches `var` semantics and the real dispatcher shape.
  const localScopes = isFunctionLike(node) ? [...scopes, new Map<string, DispatchRef>()] : scopes;

  // Register `const NAME = <dispatchExpr>` BEFORE recursing into siblings.
  // Pre-order visit + in-order children means a declaration is seen before
  // any later-sibling call that uses it (const has no TDZ-defying use).
  if (node.type === "lexical_declaration" && isConstDeclaration(node)) {
    for (const decl of node.children) {
      if (decl.type !== "variable_declarator") continue;
      const name = decl.childForFieldName("name");
      const value = decl.childForFieldName("value");
      if (name?.type !== "identifier" || !value) continue;
      const ref = exprToDispatchRef(value, localScopes, tableNames);
      if (ref) localScopes[localScopes.length - 1].set(name.text, ref);
    }
  }

  emitCall(node, localScopes, tableNames, out);
  for (const child of node.children) walkCalls(child, localScopes, tableNames, out);
}

function emitCall(node: AstNode, scopes: DispatchScope[], tableNames: ReadonlySet<string>, out: CallRef[]): void {
  // `new ClassName(args)` (bd tea-rags-mcp-i252). The grammar emits a
  // dedicated `new_expression` node whose `constructor` field is the
  // class identifier (plain identifier or member_expression for
  // qualified names like `ns.SubNS.Foo`). Without this branch the
  // walker emitted no edge for `new` expressions at all, so
  // blastRadius / fanIn metrics under-counted every instantiation.
  // The resolver routes `{receiver: "ClassName", member: "constructor"}`
  // via the capitalized-receiver branch to `ClassName#constructor`.
  if (node.type === "new_expression") {
    const ctorNode = node.childForFieldName("constructor");
    if (!ctorNode) return;
    out.push({
      callText: node.text,
      receiver: ctorNode.text,
      member: "constructor",
      startLine: node.startPosition.row + 1,
    });
    return;
  }
  if (node.type !== "call_expression") return;
  const callee = node.childForFieldName("function");
  if (!callee) return;
  const startLine = node.startPosition.row + 1;

  // Dispatch call: the callee itself resolves to a candidate set
  // (`TABLE[k](x)`, `TABLE[k].field(x)`, a field-bound local `f(x)`, or an
  // entry-bound `e.field(x)`). The resolver fans this out and SKIPS normal
  // receiver resolution, so receiver/member are best-effort only.
  const dispatch = exprToDispatchRef(callee, scopes, tableNames);
  if (dispatch) {
    out.push({
      callText: node.text,
      receiver: null,
      member: dispatch.field ?? dispatch.table,
      startLine,
      dispatch,
    });
    return;
  }

  if (emitFunctionInvokerUnwrap(node, callee, startLine, out)) return;

  // Normal call — plus a scan of its arguments for dispatch candidate-sets
  // passed positionally (the callback-param channel).
  const shape = calleeToCallShape(callee);
  let ref: CallRef;
  if (shape) {
    ref = { callText: node.text, receiver: shape.receiver, member: shape.member, startLine };
  } else if (callee.type === "member_expression") {
    // Malformed member access (a partial parse with no object or property):
    // no receiver, no member, nothing to emit. Dropped, as before.
    return;
  } else if (callee.type === "subscript_expression") {
    // A computed callee whose index is not a string literal (`obj[key]()`) is
    // the one callee shape with no knowable member (bd tea-rags-mcp-f2u54).
    // Keep the edge but tag it `dynamicSend` so it leaves the
    // resolveSuccessRate denominator instead of sitting in the bare-call
    // bucket as an unresolvable `obj[key]` short name — the same accounting
    // the Ruby walker gives `send(var)`.
    ref = { callText: node.text, receiver: null, member: callee.text, startLine, dynamicSend: true };
  } else {
    ref = { callText: node.text, receiver: null, member: callee.text, startLine };
  }

  const argsNode = node.childForFieldName("arguments");
  if (argsNode) {
    const dispatchArgs: { argIndex: number; candidate: DispatchRef }[] = [];
    argsNode.namedChildren.forEach((arg, i) => {
      const candidate = exprToDispatchRef(arg, scopes, tableNames);
      if (candidate) dispatchArgs.push({ argIndex: i, candidate });
    });
    if (dispatchArgs.length > 0) ref.dispatchArgs = dispatchArgs;
  }
  out.push(ref);
  if (argsNode) emitMethodReferenceArgs(ref.member, argsNode, out);
}

/**
 * Callees that INVOKE a function they are handed (bd tea-rags-mcp-f2u54).
 * The vocabulary is the precision gate for {@link emitMethodReferenceArgs}:
 * a method passed as a value is a real call edge, but `f(a.b)` in general is
 * a data argument, and emitting an edge for every one of those would bury the
 * resolve denominator under property reads. Inside a callback position of one
 * of these, a member expression is a function reference by construction.
 *
 * Array iteration, promise continuations, scheduling, and event registration
 * — the four families that account for nearly every method-as-value site in
 * ECMAScript. Project-defined higher-order functions are deliberately NOT
 * covered: recognising them needs the callee's own signature, which is a
 * resolver-side fact, not something the walker can see.
 */
const HIGHER_ORDER_CALLEE_MEMBERS = new Set([
  // Array iteration callbacks
  "map",
  "forEach",
  "filter",
  "reduce",
  "reduceRight",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "flatMap",
  "sort",
  // Promise continuations
  "then",
  "catch",
  "finally",
  // Scheduling
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  // Event registration
  "addEventListener",
  "removeEventListener",
  "on",
  "once",
  "off",
]);

/**
 * A method handed to a higher-order callee as a VALUE — `arr.map(this.foo)`,
 * `setTimeout(this.tick, 100)`, `emitter.on("x", handler.run)` — is called,
 * just not on this line. Before this the edge existed nowhere: the argument is
 * not a `call_expression`, so nothing in the walk ever looked at it, and the
 * method appeared to have no callers at all (bd tea-rags-mcp-f2u54).
 *
 * Only member expressions qualify. A bare identifier argument
 * (`arr.reduce(merge, seed)`) is deliberately skipped — `seed` is as plausible
 * a value as `merge` is a function, and one phantom edge per accumulator is a
 * worse trade than the recall it would buy.
 */
function emitMethodReferenceArgs(calleeMember: string, argsNode: AstNode, out: CallRef[]): void {
  if (!HIGHER_ORDER_CALLEE_MEMBERS.has(calleeMember)) return;
  for (const arg of argsNode.namedChildren) {
    if (arg.type !== "member_expression") continue;
    const obj = arg.childForFieldName("object");
    const prop = arg.childForFieldName("property");
    if (!obj || !prop) continue;
    out.push({
      callText: arg.text,
      receiver: obj.text,
      member: prop.text,
      startLine: arg.startPosition.row + 1,
    });
  }
}

/**
 * `Function.prototype` members that invoke (or bind) their RECEIVER rather
 * than being the target themselves (bd tea-rags-mcp-f2u54).
 */
const FUNCTION_INVOKER_MEMBERS = new Set(["call", "apply", "bind"]);

/**
 * `f.call(obj, …)` / `f.apply(obj, args)` / `f.bind(obj)` — the function that
 * runs is `f`, the RECEIVER of the invoker, not the invoker itself. Emit the
 * unwrapped edge and report `true` so the caller drops the literal `.call`
 * edge: one logical call, one edge. Direct mirror of the Ruby walker's
 * `send`-unwrap (`emitDynamicSendUnwrap`), which likewise pushes the real
 * target and suppresses the meta-call.
 *
 * `.bind` does not invoke at this site, but the bound function is reachable
 * only through `f`, so the edge is the same edge one hop later. Recording it
 * as a call keeps the graph connected without a second edge vocabulary.
 *
 * When the invoked expression carries no static name (`registry[k].call(x)`,
 * `getFn().call(x)`) there is nothing to unwrap TO: keep the literal edge and
 * tag it `dynamicSend`, so the site is accounted as statically undeterminable
 * rather than counted as a resolution miss — Ruby's "dynamic" branch exactly.
 */
function emitFunctionInvokerUnwrap(node: AstNode, callee: AstNode, startLine: number, out: CallRef[]): boolean {
  if (callee.type !== "member_expression") return false;
  const obj = callee.childForFieldName("object");
  const prop = callee.childForFieldName("property");
  if (!obj || !prop || !FUNCTION_INVOKER_MEMBERS.has(prop.text)) return false;
  const invoked = calleeToCallShape(obj);
  out.push(
    invoked
      ? { callText: node.text, receiver: invoked.receiver, member: invoked.member, startLine }
      : { callText: node.text, receiver: obj.text, member: prop.text, startLine, dynamicSend: true },
  );
  return true;
}

/** The `{ receiver, member }` pair a `CallRef` carries for one call site. */
interface CallShape {
  receiver: string | null;
  member: string;
}

/**
 * Reduce a callee expression to the receiver/member pair that names its
 * target. One shaper, two callers: the ordinary call path, and the
 * `.call` / `.apply` / `.bind` unwrap, which shapes the INVOKED expression
 * rather than the invoker (bd tea-rags-mcp-f2u54) — the two have always
 * needed the same answer to the same question.
 *
 * Returns null when no static target name exists, which is the caller's cue
 * to tag the site rather than invent a member:
 *   - `obj[key]()`  — computed index that is not a string literal
 *   - `getFn()()`   — the callee is itself a call result
 *   - `(a || b)()`  — a parenthesized / conditional expression
 *
 * `obj["foo"]()` DOES shape, to `{ receiver: "obj", member: "foo" }`: a
 * string-literal computed access is exactly as knowable as `obj.foo()`, only
 * the AST shape differs. `arr[i].foo()` keeps its brackets in the receiver
 * text (`"arr[i]"`) — that is what puts the call in the `index` receiver-kind
 * bucket rather than fabricating a receiver the source never named.
 */
function calleeToCallShape(callee: AstNode): CallShape | null {
  if (callee.type === "member_expression") {
    const obj = callee.childForFieldName("object");
    const prop = callee.childForFieldName("property");
    if (!obj || !prop) return null;
    return { receiver: obj.text, member: prop.text };
  }
  if (callee.type === "super") {
    // Bare `super(arg)` in a constructor (bd tea-rags-mcp-3a84). The
    // tree-sitter grammar emits `super` as the callee node type (no
    // member access). Without this branch, the walker emitted
    // `{ receiver: null, member: "super" }` which the resolver then
    // tried to look up by short-name (always fails). Re-shape to the
    // super-method form so ts-resolver's `super.X()` branch routes
    // the call to `<EnclosingClass>#constructor` of the parent.
    return { receiver: "super", member: "constructor" };
  }
  if (callee.type === "subscript_expression") {
    const obj = callee.childForFieldName("object");
    const key = staticKeyOf(callee);
    return obj && key !== null ? { receiver: obj.text, member: key } : null;
  }
  if (callee.type === "identifier") return { receiver: null, member: callee.text };
  return null;
}

/**
 * Abstract-interpret an expression to "which dispatch candidate set is this".
 * Composes through subscript / member / binding so all access patterns share
 * one path. Returns null when the expression is not a dispatch reference.
 */
function exprToDispatchRef(
  node: AstNode,
  scopes: DispatchScope[],
  tableNames: ReadonlySet<string>,
): DispatchRef | null {
  // A dispatch-bound local — `f` (field-ref) or `e` (entry-ref).
  if (node.type === "identifier") {
    return lookupDispatchScope(scopes, node.text);
  }
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
    // `TABLE[key].field`
    if (obj.type === "subscript_expression") {
      const inner = exprToDispatchRef(obj, scopes, tableNames);
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

function lookupDispatchScope(scopes: DispatchScope[], name: string): DispatchRef | null {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const hit = scopes[i].get(name);
    if (hit) return hit;
  }
  return null;
}

/** Static string-literal key (`TABLE["ts"]`) → `"ts"`; dynamic key → null. */
function staticKeyOf(subscript: AstNode): string | null {
  const index = subscript.childForFieldName("index");
  if (index?.type !== "string") return null;
  return index.text.replace(/^['"`]|['"`]$/g, "");
}

function isConstDeclaration(node: AstNode): boolean {
  // `let`/`const` are both lexical_declaration; only const qualifies (the
  // table / binding must be non-reassignable per the m46z safety rule).
  return node.children.some((c) => c.type === "const");
}

function isFunctionLike(node: AstNode): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "function_expression" ||
    node.type === "arrow_function" ||
    node.type === "method_definition" ||
    node.type === "generator_function" ||
    node.type === "generator_function_declaration"
  );
}

/**
 * Collect module/file-level `const NAME = { … }` dispatch tables
 * (bd tea-rags-mcp-n0zj). S1 wrapper-object entries become a field→fn map;
 * S2 direct-function entries become a fn name. Only plain-identifier values
 * are recorded — arrows, calls, spreads carry no symbol. Tables with zero
 * usable entries (pure config objects) are omitted.
 */
function collectDispatchTables(root: AstNode): Record<string, DispatchTable> {
  const out: Record<string, DispatchTable> = {};
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
  const entries: Record<string, string | Record<string, string>> = {};
  for (const pair of objNode.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = keyText(pair.childForFieldName("key"));
    const value = pair.childForFieldName("value");
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
  const map: Record<string, string> = {};
  for (const pair of objNode.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = keyText(pair.childForFieldName("key"));
    const value = pair.childForFieldName("value");
    if (key !== null && value?.type === "identifier") map[key] = value.text;
  }
  return map;
}

/** `property_identifier` → its text; quoted `string` key → stripped; computed
 *  keys (`[x]:`) and numeric keys → null (no stable string key). */
function keyText(node: AstNode | null): string | null {
  if (!node) return null;
  if (node.type === "property_identifier") return node.text;
  if (node.type === "string") return node.text.replace(/^['"`]|['"`]$/g, "");
  return null;
}

/**
 * Collect `fnSymbolId → invokedParamIndices` for the bounded inter-proc join
 * (bd tea-rags-mcp-n0zj). For each function/method, record which parameter
 * positions are invoked as `param(...)` inside its body, attributed to the
 * innermost chunk that owns the function declaration line.
 */
function collectCallbackParams(
  root: AstNode,
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[],
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  walk(root, (node) => {
    if (!isFunctionLike(node)) return;
    const params = node.childForFieldName("parameters");
    const body = node.childForFieldName("body");
    if (!params || !body) return;
    // paramName → positional index. Every named child advances the index so
    // destructured / rest params (which yield no name) keep positions aligned
    // with call-site argument positions.
    const nameToIndex = new Map<string, number>();
    params.namedChildren.forEach((p, i) => {
      const name = paramName(p);
      if (name !== null) nameToIndex.set(name, i);
    });
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

function paramName(node: AstNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "required_parameter" || node.type === "optional_parameter") {
    const pattern = node.childForFieldName("pattern");
    return pattern?.type === "identifier" ? pattern.text : null;
  }
  return null;
}

/** symbolId of the innermost chunk whose line range contains `line`
 *  (smallest span, deeper scope wins ties) — same discipline as
 *  `assignCallsToInnermostChunks`. */
function innermostSymbolId(
  line: number,
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[],
): string | undefined {
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

/**
 * Collect class field declarations with type annotations: `className → fieldName → typeName`.
 * Covers two TS patterns:
 *   1. Constructor parameter properties — `constructor(private readonly foo: Bar)`
 *      The `required_parameter` has both an `accessibility_modifier` (or
 *      `readonly`) and a `type_annotation`. The presence of either marks
 *      this as a field; without one it's just a plain parameter.
 *   2. Class field declarations — `public_field_definition` with a `type_annotation`.
 *
 * Returns an empty Map when no class declarations are found.
 */
function collectClassFieldTypes(root: AstNode): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const result = new Map<string, Map<string, string>>();
  walk(root, (node) => {
    // bd tea-rags-mcp-q3o2 — same abstract-class shape as collectClassExtends.
    // Abstract bases declared with `protected readonly` constructor
    // parameters still create class fields; without this branch the
    // `this.field.method()` resolver path lost type info on every
    // abstract-base field.
    if (node.type !== "class_declaration" && node.type !== "abstract_class_declaration") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nameNode.text;
    const body = node.childForFieldName("body");
    if (!body) return;
    const fields = new Map<string, string>();

    for (const member of body.children) {
      // Pattern 2: public/private/protected/readonly field declaration
      if (member.type === "public_field_definition") {
        const fieldName = member.childForFieldName("name")?.text;
        // Annotated field wins: `field: T`.
        const annotated = extractTypeNameFromAnnotation(member.children.find((c) => c.type === "type_annotation"));
        if (fieldName && annotated) {
          fields.set(fieldName, annotated);
          continue;
        }
        // bd tea-rags-mcp-2yfi — un-annotated field initialized from a
        // constructor: `private reg = new CollectionRegistry()`. The
        // `new_expression`'s constructor name IS the field type, so the
        // ts-field-type resolver strategy can pin `this.reg.method()` even
        // without a written annotation.
        const initialized = constructorTypeName(member.childForFieldName("value"));
        if (fieldName && initialized) fields.set(fieldName, initialized);
        continue;
      }
      // Pattern 1: constructor parameter properties
      if (member.type === "method_definition") {
        const methodName = member.childForFieldName("name")?.text;
        if (methodName !== "constructor") continue;
        const params = member.childForFieldName("parameters");
        if (!params) continue;
        for (const param of params.children) {
          if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
          // Must have an accessibility modifier OR readonly to count as a field
          const hasAccess = param.children.some(
            (c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.text === "readonly",
          );
          if (!hasAccess) continue;
          const pattern = param.childForFieldName("pattern");
          const fieldName = pattern?.text;
          const typeName = extractTypeNameFromAnnotation(param.children.find((c) => c.type === "type_annotation"));
          if (fieldName && typeName) fields.set(fieldName, typeName);
        }
      }
    }

    if (fields.size > 0) result.set(className, fields);
  });
  return result;
}

interface ParamBinding {
  name: string;
  type: string;
  /** 1-based declaration line — used for innermost-chunk attribution. */
  startLine: number;
}

/**
 * Collect `{ name, type, startLine }` for every typed function / method /
 * arrow parameter in the file.
 *
 * Mirrors the Python walker's `collectLocalBindingsForChunk` (function
 * argument type hints) but for TS's static parameter annotations. The
 * grammar emits a `required_parameter` / `optional_parameter` node for
 * each parameter; its `pattern` field is the identifier and its
 * `type_annotation` child carries the declared type. This shape is the
 * same for top-level functions, class methods, and arrow functions, so
 * one walk covers all three.
 *
 * Reuses `extractTypeNameFromAnnotation` so generics (`Repo<User>` →
 * `Repo`) and qualified names (`ns.Foo`) strip identically to the
 * `classFieldTypes` path. Skips constructor parameter properties (those
 * with an accessibility modifier / `readonly`) — those are class fields
 * owned by `collectClassFieldTypes`, not local parameter bindings.
 * Untyped or destructured / rest parameters contribute nothing.
 */
function collectParamBindings(root: AstNode): ParamBinding[] {
  const out: ParamBinding[] = [];
  walk(root, (node) => {
    if (node.type !== "required_parameter" && node.type !== "optional_parameter") return;
    const hasAccess = node.children.some(
      (c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.text === "readonly",
    );
    if (hasAccess) return;
    const pattern = node.childForFieldName("pattern");
    // Only bare-identifier patterns bind cleanly — destructured / rest
    // patterns (`{ a }`, `...rest`) have no single receiver name.
    if (pattern?.type !== "identifier") return;
    const typeName = extractTypeNameFromAnnotation(node.children.find((c) => c.type === "type_annotation"));
    if (typeName) out.push({ name: pattern.text, type: typeName, startLine: node.startPosition.row + 1 });
  });
  return out;
}

/**
 * Collect `{ name, type, startLine }` for concrete-class type bindings from
 * variable declarations and re-assignments (bd tea-rags-mcp-2yfi). Three
 * deterministic single-target forms feed the SAME `localBindings` channel the
 * typed-parameter path uses, so the existing ts-local-binding resolver
 * strategy resolves `x.method()` without a new strategy:
 *
 *   A. `const x = new T()` / `let x = new T()` / `x = new T()`
 *      → bind `x → T` (the `new_expression`'s constructor name).
 *   B. `const x: T = …` → bind `x → T` via the declarator's `type_annotation`.
 *
 * Only bare-identifier targets bind — destructuring patterns
 * (`const { a } = new T()`) have no single receiver name and are skipped
 * (mirrors the param-binding SAFE boundary). Form B reuses
 * `extractTypeNameFromAnnotation`; Form A reuses `baseTypeName` so generics
 * (`new Map<K,V>()`) and qualified names (`new ns.Foo()`) normalise
 * identically to the field-type / extends paths.
 */
function collectVariableBindings(root: AstNode): ParamBinding[] {
  const out: ParamBinding[] = [];
  walk(root, (node) => {
    // `const/let x = …` — one or more `variable_declarator` children.
    if (node.type === "variable_declaration" || node.type === "lexical_declaration") {
      for (const decl of node.children) {
        if (decl.type !== "variable_declarator") continue;
        const name = decl.childForFieldName("name");
        if (name?.type !== "identifier") continue; // skip destructuring patterns
        // Form B precedence: an explicit `: T` annotation pins the type even
        // when the initializer is a call / cast we can't read.
        const annotated = extractTypeNameFromAnnotation(decl.children.find((c) => c.type === "type_annotation"));
        if (annotated) {
          out.push({ name: name.text, type: annotated, startLine: decl.startPosition.row + 1 });
          continue;
        }
        // Form A: `= new T()`.
        const value = decl.childForFieldName("value");
        const ctor = constructorTypeName(value);
        if (ctor) out.push({ name: name.text, type: ctor, startLine: decl.startPosition.row + 1 });
      }
      return;
    }
    // Form A re-assignment: `x = new T()` — a bare-identifier left side.
    if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      if (left?.type !== "identifier") return;
      const ctor = constructorTypeName(node.childForFieldName("right"));
      if (ctor) out.push({ name: left.text, type: ctor, startLine: node.startPosition.row + 1 });
    }
  });
  return out;
}

/**
 * Reduce a `new_expression` to its base constructor type name (or null when
 * the node is not a `new T()`). Type arguments live in a sibling
 * `type_arguments` node, so the `constructor` field is already the base name;
 * `baseTypeName` additionally tolerates a `generic_type` constructor shape and
 * keeps qualified `ns.Foo` chains intact.
 */
function constructorTypeName(node: AstNode | null): string | null {
  if (node?.type !== "new_expression") return null;
  return baseTypeName(node.childForFieldName("constructor") ?? undefined);
}

/**
 * Attribute each parameter binding to the INNERMOST chunk whose line
 * range contains the binding's declaration line. Tie-breaker: deeper
 * scope wins — identical discipline to `assignCallsToInnermostChunks`,
 * so a method parameter lands on the method chunk rather than the
 * enclosing class chunk that also spans the `def` line.
 *
 * Returns a Map keyed by chunk index → `Record<paramName, LocalBinding[]>`.
 * Each binding is pushed as a position-aware `{ line, type }` entry (a
 * variable may accumulate several across its path) so a call site resolves
 * against the most-recent binding at or before its own line. Chunks with no
 * bindings have no entry. Bindings whose line falls outside every chunk are
 * dropped silently.
 */
function assignParamBindingsToInnermostChunks(
  bindings: ParamBinding[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, Record<string, LocalBinding[]>> {
  const out = new Map<number, Record<string, LocalBinding[]>>();
  for (const binding of bindings) {
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (binding.startLine < c.startLine || binding.startLine > c.endLine) continue;
      const span = c.endLine - c.startLine;
      const depth = c.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = i;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    if (bestIdx === -1) continue;
    const bucket = out.get(bestIdx) ?? {};
    (bucket[binding.name] ??= []).push({ line: binding.startLine, type: binding.type });
    out.set(bestIdx, bucket);
  }
  return out;
}

/**
 * Collect `class Child extends Parent` relationships: `className → parent`.
 * Only the explicit `extends` clause populates the map; `implements I`
 * heritage is type-only and contributes nothing (interfaces have no
 * runtime methods to dispatch `super()` to).
 *
 * Tree-sitter-typescript shape for `class B extends A {}`:
 *
 *   class_declaration
 *     type_identifier "B"
 *     class_heritage
 *       extends_clause
 *         "extends"
 *         identifier "A"            // OR member_expression "A.B.C"
 *     class_body
 *
 * The walker reads `extends_clause`'s first non-keyword child as the
 * parent reference. Qualified parents (`extends A.B.C`) appear as a
 * `member_expression` whose `.text` is the full chain — we keep it intact
 * so the resolver can look up the qualified name directly.
 *
 * Bug `tea-rags-mcp-d29r`: without this map, the resolver's super branch
 * has no way to find the parent class and self-loops to the enclosing
 * class's own method. Returns an empty map when the file has no class
 * declarations or no class extends anything.
 */
/**
 * Reduce an `extends`/`implements` heritage child to its base type name.
 * Handles plain identifiers (`A`), qualified names (`A.B.C`), and generic
 * instantiations (`Base<T>` → `Base`). Returns null for punctuation
 * (`,` / `extends` / `implements` keywords) so callers can `.filter` cleanly.
 */
function baseTypeName(node: AstNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "type_identifier" || node.type === "member_expression") {
    return node.text;
  }
  if (node.type === "generic_type") {
    const base = node.children.find(
      (c) => c.type === "identifier" || c.type === "member_expression" || c.type === "type_identifier",
    );
    return base ? base.text : null;
  }
  return null;
}

/**
 * Collect all class-hierarchy edges (bd tea-rags-mcp-f10y): class `extends`
 * (kind `super`), class `implements` (kind `implements`), and interface
 * `extends` (kind `implements` — interface heritage is structural, treated as
 * the implements channel for the hierarchy graph). `ordinal` preserves
 * declaration order within each clause for MRO reconstruction.
 */
function collectInheritanceEdges(root: AstNode): InheritanceEdgeDecl[] {
  const edges: InheritanceEdgeDecl[] = [];
  walk(root, (node) => {
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
      const className = node.childForFieldName("name")?.text;
      if (!className) return;
      const heritage = node.children.find((c) => c.type === "class_heritage");
      if (!heritage) return;
      const ext = heritage.children.find((c) => c.type === "extends_clause");
      if (ext) {
        const parent = baseTypeName(
          ext.children.find(
            (c) => c.type === "identifier" || c.type === "member_expression" || c.type === "generic_type",
          ),
        );
        if (parent) edges.push({ source: className, ancestor: parent, kind: "super", ordinal: 0 });
      }
      const impl = heritage.children.find((c) => c.type === "implements_clause");
      if (impl) {
        let i = 0;
        for (const child of impl.children) {
          const name = baseTypeName(child);
          if (name) edges.push({ source: className, ancestor: name, kind: "implements", ordinal: i++ });
        }
      }
    } else if (node.type === "interface_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;
      const ext = node.children.find((c) => c.type === "extends_type_clause");
      if (!ext) return;
      let i = 0;
      for (const child of ext.children) {
        const base = baseTypeName(child);
        if (base) edges.push({ source: name, ancestor: base, kind: "implements", ordinal: i++ });
      }
    }
  });
  return edges;
}

function collectClassExtends(root: AstNode): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  walk(root, (node) => {
    // bd tea-rags-mcp-q3o2 — abstract classes declare via
    // `abstract_class_declaration`, NOT `class_declaration`. Both shapes
    // expose `name` / `body` / `class_heritage` identically; without
    // this branch every `abstract class Child extends Parent` was
    // missing from classExtends and the resolver could not walk super()
    // calls back to the parent.
    if (node.type !== "class_declaration" && node.type !== "abstract_class_declaration") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nameNode.text;
    // class_heritage wraps extends_clause + optional implements_clause.
    const heritage = node.children.find((c) => c.type === "class_heritage");
    if (!heritage) return;
    const extendsClause = heritage.children.find((c) => c.type === "extends_clause");
    if (!extendsClause) return;
    // First non-`extends` child is the parent reference — either a plain
    // identifier (`A`), a member_expression (`A.B.C`), or a generic_type
    // (`Base<T>`). Keep the textual form so qualified namespace chains
    // survive intact for the resolver's lookup.
    const parentNode = extendsClause.children.find(
      (c) => c.type === "identifier" || c.type === "member_expression" || c.type === "generic_type",
    );
    if (!parentNode) return;
    // For `generic_type` (`extends Base<T>`), the base name is its first
    // identifier / member_expression child. The angle-bracketed type args
    // are not part of the parent class identity.
    let parentText: string;
    if (parentNode.type === "generic_type") {
      const base = parentNode.children.find(
        (c) => c.type === "identifier" || c.type === "member_expression" || c.type === "type_identifier",
      );
      if (!base) return;
      parentText = base.text;
    } else {
      parentText = parentNode.text;
    }
    if (parentText.length > 0) result.set(className, parentText);
  });
  return result;
}

/**
 * Extract the bare type name from a `type_annotation` node. Strips generics
 * (`Foo<T>` → `Foo`) and qualified names (`Namespace.Foo` → keeps `Namespace.Foo`).
 * Returns null for union types, function types, or anything we can't pin
 * to a single class name.
 */
function extractTypeNameFromAnnotation(annotation: AstNode | undefined): string | null {
  if (!annotation) return null;
  // type_annotation has form `: <type>` — first non-`:` child is the type
  const typeNode = annotation.children.find((c) => c.type !== ":");
  if (!typeNode) return null;
  // type_identifier — simple `Foo`
  if (typeNode.type === "type_identifier") return typeNode.text;
  // generic_type — `Foo<T>`: take the base type name
  if (typeNode.type === "generic_type") {
    const base = typeNode.children.find((c) => c.type === "type_identifier" || c.type === "nested_type_identifier");
    if (base) return base.text;
  }
  // nested_type_identifier — `Namespace.Foo`
  if (typeNode.type === "nested_type_identifier") return typeNode.text;
  return null;
}
