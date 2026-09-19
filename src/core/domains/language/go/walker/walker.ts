/**
 * Go extraction walker. Relocated from
 * `domains/ingest/pipeline/chunker/extraction/go-walker.ts` into the native Go
 * language provider per the `domains/language` consolidation (spec §3; bd
 * tea-rags-mcp-cen6, following ruby + typescript + javascript + python).
 * Behaviour-preserving.
 *
 * Go imports come in two shapes:
 *   import "foo/bar"
 *   import ( "a"; "b/c" )    // grouped
 *
 * Tree-sitter-go represents both as `import_declaration` nodes;
 * single-line uses `import_spec` directly, grouped uses
 * `import_spec_list` containing multiple `import_spec` children.
 *
 * Calls are `call_expression`. Receivers come from `selector_expression`
 * (`pkg.Func()` → receiver "pkg", member "Func"). Top-level symbols
 * are `function_declaration` and `method_declaration`. Go doesn't
 * have nested classes/methods so `descendsInto` stays false at the
 * top level.
 */

import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type {
  CallRef,
  CallResultBinding,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks } from "../../kernel/assign-calls-to-chunks.js";
import { goImportBoundName } from "../import-binding.js";
import { goLocalAt, type GoLocalChannels } from "../local-scope.js";

export interface GoExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromGoFile(input: GoExtractInput): FileExtraction {
  const imports = collectGoImports(input.tree.rootNode);
  const importNames = goImportBoundNames(imports);
  const { calls, bareCalleeHeads } = collectGoCalls(input.tree.rootNode);
  const functionReturnTypes = collectGoFunctionReturnTypes(input.tree.rootNode, imports);
  // bd tea-rags-mcp-f11nz — ONE owning chunk per call site: the smallest
  // containing range, ties broken by deeper scope. The pure-containment filter
  // this replaces gave a call to EVERY chunk spanning its line, so any enclosing
  // chunk produced a second copy under the container's scope (the defect python
  // fixed in bd tea-rags-mcp-invuy). `goNameOf` marks every Go symbol
  // `descendsInto: false`, so today's chunk set never nests and the emitted call
  // set is unmoved — the kernel call makes that a property of the walker rather
  // than of the current nameOf.
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    // bd tea-rags-mcp-e6xx / 6g9c — per-chunk bindings. `localBindings`
    // (varName → TYPE) covers receivers, params, `var x Foo`, `x := Foo{}`.
    // `callResultBindings` (varName → positioned CALLED FUNC) covers
    // `x := New()` where the return type can't be known in-chunk; the resolver
    // pairs it with the run-global `functionReturnTypes`. The resolver consults
    // both to turn typed/return-typed calls into qualified `Type#method` targets.
    const { types, calls: callBindings } = collectGoLocalBindingsForChunk(
      input.tree.rootNode,
      c.startLine,
      c.endLine,
      goShadowedNames(importNames, base.calls, bareCalleeHeads),
    );
    if (Object.keys(types).length > 0) base.localBindings = types;
    if (Object.keys(callBindings).length > 0) base.callResultBindings = callBindings;
    tagGoFuncValueCalls(base.calls, bareCalleeHeads, { localBindings: types, callResultBindings: callBindings });
    return base;
  });
  const extraction: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
  if (Object.keys(functionReturnTypes).length > 0) extraction.functionReturnTypes = functionReturnTypes;
  const buildConstraint = readGoBuildConstraint(input.tree.rootNode);
  if (buildConstraint !== undefined) extraction.buildConstraint = buildConstraint;
  return extraction;
}

const GO_BUILD_DIRECTIVE = /^\/\/go:build[ \t]+/;

/**
 * The file's `//go:build` expression, verbatim (bd tea-rags-mcp-e6xx): a
 * constraint is a line comment ABOVE the package clause, so the scan stops at
 * the clause and a directive-shaped comment below it is ordinary text. The
 * resolver evaluates it to tell build-tag twins apart.
 */
function readGoBuildConstraint(root: AstNode): string | undefined {
  for (const node of root.children) {
    if (node.type === "package_clause") return undefined;
    if (node.type !== "comment" || !GO_BUILD_DIRECTIVE.test(node.text)) continue;
    const expression = node.text.replace(GO_BUILD_DIRECTIVE, "").trim();
    return expression === "" ? undefined : expression;
  }
  return undefined;
}

/**
 * Collect `functionName → declaredReturnTypeName` for every top-level
 * `function_declaration` / `method_declaration` with a SINGLE concrete
 * named return type. bd tea-rags-mcp-6g9c.
 *
 * tree-sitter-go shapes of the `result` field:
 *   - `func f() Foo`        → `type_identifier` (read text)
 *   - `func f() *Foo`       → `pointer_type` (unwrap to inner type_identifier)
 *   - `func f() pkg.Foo`    → `qualified_type` (read its `name` field — bare
 *                             last segment; pkg-qualified externals naturally
 *                             miss the symbol table at resolve time)
 *   - `func f() (A, B)`     → `parameter_list` (multi-return) → SKIP: we don't
 *                             guess which return value feeds the variable.
 *   - `func f()`            → no `result` field → SKIP.
 *
 * Methods are keyed by the method name (`Build`), matching how the resolver
 * reads a call binding's bare callee name. Last-write-wins on duplicate names;
 * resolver-side ambiguity is gated by the symbol-table existence check.
 */
function collectGoFunctionReturnTypes(root: AstNode, imports: readonly ImportRef[]): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    if (node.type !== "function_declaration" && node.type !== "method_declaration") return;
    const name = node.childForFieldName("name");
    const result = node.childForFieldName("result");
    if (!name || !result) return;
    const typeName = readReturnTypeNode(result);
    if (typeName) out[name.text] = typeName;
  });
  collectGoFuncValueVarReturnTypes(root, imports, out);
  return out;
}

/** The standard library's lazy-singleton wrapper: `sync.OnceValue(f)` returns a func yielding what `f` returns. */
const GO_ONCE_VALUE_IMPORT_PATH = "sync";
const GO_ONCE_VALUE_FUNC = "OnceValue";

/**
 * What CALLING a package-level func-valued var returns, recorded beside the
 * declared functions' return types (bd tea-rags-mcp-e6xx) — gin's
 * `var engine = sync.OnceValue(func() *gin.Engine {…})` is called as
 * `engine().GET(…)` exactly like a function. Three shapes, single-name specs
 * only:
 *   - `var f func(…) T`                         — a var of a func type;
 *   - `var f = func(…) T {…}`                   — a function literal;
 *   - `var f = sync.OnceValue(func() T {…})`    — the standard library's
 *     `func OnceValue[T any](f func() T) func() T`, and only when `sync` is
 *     the file's import of the standard `sync` package.
 * A declared function of the same name keeps its entry.
 */
function collectGoFuncValueVarReturnTypes(
  root: AstNode,
  imports: readonly ImportRef[],
  out: Record<string, string>,
): void {
  const onceValueQualifier = imports.find((imp) => imp.importText === GO_ONCE_VALUE_IMPORT_PATH);
  const syncName = onceValueQualifier ? goImportBoundName(onceValueQualifier) : undefined;
  for (const declaration of root.children) {
    if (declaration.type !== "var_declaration") continue;
    const specs = declaration.children.flatMap((c) =>
      c.type === "var_spec" ? [c] : c.type === "var_spec_list" ? c.children.filter((s) => s.type === "var_spec") : [],
    );
    for (const spec of specs) {
      const names = spec.children.filter((c) => c.type === "identifier");
      if (names.length !== 1 || out[names[0].text] !== undefined) continue;
      const typeName = readFuncValueVarResultType(spec, syncName);
      if (typeName) out[names[0].text] = typeName;
    }
  }
}

function readFuncValueVarResultType(spec: AstNode, syncName: string | undefined): string | null {
  const declared = spec.childForFieldName("type");
  if (declared) return declared.type === "function_type" ? readFuncResultType(declared) : null;
  const values = spec.childForFieldName("value")?.namedChildren ?? [];
  if (values.length !== 1) return null;
  const [value] = values;
  if (value.type === "func_literal") return readFuncResultType(value);
  if (value.type !== "call_expression" || syncName === undefined) return null;
  const fn = value.childForFieldName("function");
  if (fn?.type !== "selector_expression") return null;
  if (
    fn.childForFieldName("operand")?.text !== syncName ||
    fn.childForFieldName("field")?.text !== GO_ONCE_VALUE_FUNC
  ) {
    return null;
  }
  const args = value.childForFieldName("arguments")?.namedChildren ?? [];
  return args.length === 1 && args[0].type === "func_literal" ? readFuncResultType(args[0]) : null;
}

/** The single nominal result type of a `function_type` / `func_literal`, else null. */
function readFuncResultType(fn: AstNode): string | null {
  const result = fn.childForFieldName("result");
  return result ? readReturnTypeNode(result) : null;
}

/**
 * Read the bare type name from a function/method `result` field node. Returns
 * null for multi-return (`parameter_list`) and any non-named-type shape — the
 * caller treats null as "not statically bindable". Multi-return is the key
 * SKIP: `func New() (*Engine, error)` must not bind, because we can't tell
 * which return value the variable receives.
 */
function readReturnTypeNode(result: AstNode): string | null {
  if (result.type === "type_identifier") return result.text;
  if (result.type === "pointer_type") {
    // `*Foo` → `Foo`; `*pkg.Foo` → `Foo`, exactly as the bare `pkg.Foo` reads
    // (bd tea-rags-mcp-e6xx — gin's `func() *gin.Engine` fell through).
    const inner = result.children.find((c) => c.type === "type_identifier" || c.type === "qualified_type");
    return inner ? readReturnTypeNode(inner) : null;
  }
  if (result.type === "qualified_type") {
    const name = result.childForFieldName("name");
    return name?.type === "type_identifier" ? name.text : null;
  }
  // `parameter_list` (multi-return), `interface_type`, `map_type`,
  // `slice_type`, `func_type`, generics with no single base — not bindable.
  return null;
}

function collectGoImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_spec") return;
    // import_spec has fields name (optional alias) and path (interpreted_string_literal).
    const path = node.childForFieldName("path");
    if (!path) return;
    const literal = path.text.replace(/^["`]|["`]$/g, "");
    const ref: ImportRef = { importText: literal, startLine: node.startPosition.row + 1 };
    // bd tea-rags-mcp-e6xx — the name the import binds, when the source spells
    // one: an alias is the only name a qualified call can use, `.` puts the
    // package's names in this file's scope, `_` binds nothing. A plain import
    // binds the package's own name, which the resolver reads off the path.
    const name = node.childForFieldName("name");
    if (name) ref.importedNames = [name.text];
    out.push(ref);
  });
  return out;
}

/** The qualifiers the file's imports bind — the names a local can shadow. */
function goImportBoundNames(imports: readonly ImportRef[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const imp of imports) {
    const name = goImportBoundName(imp);
    if (name) names.add(name);
  }
  return names;
}

/**
 * Index node types that can never be a type argument: literals, and
 * expressions no type is spelled as. `loadAll[0]()` is a call through a slice
 * element, not an instantiation. An identifier or selector (`f[T]`,
 * `f[pkg.T]`) may be either, and stays a candidate.
 */
const GO_NON_TYPE_INDEX_NODE_TYPES: ReadonlySet<string> = new Set([
  "int_literal",
  "float_literal",
  "imaginary_literal",
  "rune_literal",
  "interpreted_string_literal",
  "raw_string_literal",
  "true",
  "false",
  "nil",
  "iota",
  "binary_expression",
  "call_expression",
  "slice_expression",
  "type_assertion_expression",
  "composite_literal",
  "func_literal",
]);

/** Unary operators no type is spelled with — `*T` is a pointer type, `-1` and `&x` are values. */
const GO_VALUE_UNARY_OPERATORS: ReadonlySet<string> = new Set(["-", "+", "!", "^", "&", "<-"]);

/** Whether an index expression's `index` is certainly a value, so the callee is no instantiation. */
function isGoValueIndex(index: AstNode | null): boolean {
  if (!index) return false;
  if (GO_NON_TYPE_INDEX_NODE_TYPES.has(index.type)) return true;
  if (index.type !== "unary_expression") return false;
  const operator = index.childForFieldName("operator")?.text;
  return operator !== undefined && GO_VALUE_UNARY_OPERATORS.has(operator);
}

/** The file's call sites, and for each bare one the identifier it calls through (`helper`, `loadAll` in `loadAll[0]()`). */
interface GoCallSites {
  calls: CallRef[];
  bareCalleeHeads: Map<CallRef, string>;
}

function collectGoCalls(root: AstNode): GoCallSites {
  const out: CallRef[] = [];
  const bareCalleeHeads = new Map<CallRef, string>();
  walk(root, (node) => {
    // bd tea-rags-mcp-e6xx — a generic function called with ONE value argument
    // (`pair[int](x)`, `pkg.Pair[int](x)`) parses as a conversion to an
    // instantiated generic type; the grammar cannot tell the two apart. It is
    // emitted as a bare call whose member is the instantiated name as written —
    // the shape an index-expression callee (`getTyped[string](c, key)`) already
    // has — and the resolver decides whether the operand names a generic
    // declaration. A conversion to any other type (`[]byte(s)`) is left alone.
    if (node.type === "type_conversion_expression") {
      const type = node.childForFieldName("type");
      if (type?.type === "generic_type") {
        const ref: CallRef = {
          callText: node.text,
          receiver: null,
          member: type.text,
          startLine: node.startPosition.row + 1,
        };
        out.push(ref);
        const base = type.childForFieldName("type");
        if (base?.type === "type_identifier") bareCalleeHeads.set(ref, base.text);
      }
      return;
    }
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn) return;
    const startLine = node.startPosition.row + 1;
    if (fn.type === "selector_expression") {
      const operand = fn.childForFieldName("operand");
      const field = fn.childForFieldName("field");
      if (!operand || !field) return;
      out.push({ callText: node.text, receiver: operand.text, member: field.text, startLine });
      return;
    }
    const ref: CallRef = { callText: node.text, receiver: null, member: fn.text, startLine };
    if (fn.type === "identifier") bareCalleeHeads.set(ref, fn.text);
    if (fn.type === "index_expression") {
      const operand = fn.childForFieldName("operand");
      if (operand?.type === "identifier") bareCalleeHeads.set(ref, operand.text);
      // bd tea-rags-mcp-e6xx — `loadAll[0]()` calls whatever a slice element
      // holds: no instantiation candidate, and statically undeterminable (the
      // accounting TypeScript gives `obj[key]()`).
      if (isGoValueIndex(fn.childForFieldName("index"))) ref.dynamicSend = true;
    }
    out.push(ref);
  });
  return { calls: out, bareCalleeHeads };
}

/**
 * Tag every bare call made through a LOCAL in scope at its line — a func-typed
 * parameter (gin's `handle(c, rec)`), `helper := func() {}; helper()`, a
 * call-bound local, an indexed slice of funcs — `dynamicSend` (bd
 * tea-rags-mcp-e6xx). It calls a function VALUE, which no pass resolves; the
 * tag is what the miss classifier reads as statically undeterminable, so it
 * leaves the recall denominator instead of counting as a miss whenever some
 * type declares a METHOD of that name, which a bare Go call can never reach.
 */
function tagGoFuncValueCalls(
  chunkCalls: readonly CallRef[],
  bareCalleeHeads: ReadonlyMap<CallRef, string>,
  locals: GoLocalChannels,
): void {
  for (const call of chunkCalls) {
    const head = bareCalleeHeads.get(call);
    if (head !== undefined && goLocalAt(locals, head, call.startLine)) call.dynamicSend = true;
  }
}

/**
 * The names a local of this chunk must shadow even when nothing types it: the
 * file's import-bound names, and every identifier the chunk calls bare or
 * through an index (`helper()`, `loadAll[0]()`) — a local of that name makes
 * the call one of a function VALUE, never of the package-level declaration
 * the resolver would otherwise pick.
 */
function goShadowedNames(
  importNames: ReadonlySet<string>,
  chunkCalls: readonly CallRef[],
  bareCalleeHeads: ReadonlyMap<CallRef, string>,
): ReadonlySet<string> {
  let names: Set<string> | undefined;
  for (const call of chunkCalls) {
    const head = bareCalleeHeads.get(call);
    if (head === undefined || importNames.has(head)) continue;
    names ??= new Set(importNames);
    names.add(head);
  }
  return names ?? importNames;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Collect `varName → typeName` bindings for the function/method whose
 * body spans `[startLine, endLine]`. Two sources:
 *
 *   1. Method receiver — `func (c *Context) Foo()` → `{ c: "Context" }`.
 *      Pointer receivers are unwrapped; the receiver's name binding has
 *      the bare type (not `*Context`) so the resolver's
 *      `localBindings[receiver]` lookup composes `Context#Method`
 *      naturally.
 *   2. Parameter pointer-type declarations — `func f(c *Context, s
 *      string)` → `{ c: "Context" }`. Non-pointer parameters whose type
 *      is a `type_identifier` (e.g. value receivers / value params) are
 *      ALSO captured because Go method dispatch on a value receiver
 *      resolves the same way — `var s Service; s.Open()` should resolve
 *      to `Service#Open`.
 *   3. Local `var x Type` declarations (`var_declaration` → `var_spec`
 *      with a `type` field) — `func Default() { var engine Engine }` →
 *      `{ engine: "Engine" }`. bd tea-rags-mcp-6g9c.
 *   4. Short var decls whose RHS is a directly-knowable type literal —
 *      `x := Foo{}` (`composite_literal`) and `x := &Foo{}`
 *      (`unary_expression` wrapping `composite_literal`) →
 *      `{ x: "Foo" }`. bd tea-rags-mcp-6g9c.
 *   5. Function-literal parameters — `return func(c *Context) { ... }` binds
 *      `c` for the literal's lines only; see `bindFuncLiteralParams`. bd
 *      tea-rags-mcp-e6xx.
 *   6. Shadows (bd tea-rags-mcp-e6xx) — any other local or parameter whose
 *      name an import binds (`config, err := loadTwo()`,
 *      `func f(render io.Writer)`, `for _, render := range rs`) or the chunk
 *      calls bare (`helper := func() {}; helper()`,
 *      `func f(loadAll []func()) { loadAll[0]() }`) records an EMPTY-typed
 *      binding: a value no pass can type, never the package or the
 *      package-level declaration. A statement-declared one whose right-hand
 *      side names it carries `endLine` (in scope only after its statement —
 *      `goDeclarationEndLine`, read by `goLocalBindingAt`).
 *
 * A binding declared inside a block narrower than the function body carries
 * that block's last line as `scopeEndLine`.
 *
 * Function-return short decls `x := New()` are captured into the SEPARATE
 * `calls` map (varName → `CallResultBinding[]`: the callee as written, and the
 * same `endLine` / `scopeEndLine` positions), NOT `types` — the walker can't
 * know the return type from the chunk alone (the function may be declared
 * elsewhere). The resolver pairs the callee with the run-global
 * `functionReturnTypes` map and applies the symbol-table existence gate; this
 * is SAFE because declared return types are static, not guesses, and only
 * concrete struct types that exist in the table ever bind. bd tea-rags-mcp-6g9c.
 * Each declaration is its own positioned entry (bd tea-rags-mcp-e6xx) — the
 * chunk-wide `localCallBindings` map this replaces spoke for the name on every
 * line, a `config := config.Load()` right-hand side included.
 * Go has no `self`/`this`: receivers, local vars, AND return-typed vars are
 * the only static type hints for `engine.Use()`-style calls.
 */
function collectGoLocalBindingsForChunk(
  root: AstNode,
  startLine: number,
  endLine: number,
  shadowedNames: ReadonlySet<string>,
): { types: Record<string, LocalBinding[]>; calls: Record<string, CallResultBinding[]> } {
  const bindings: Record<string, LocalBinding[]> = {};
  const callBindings: Record<string, CallResultBinding[]> = {};
  // Find the function/method declaration node whose span matches the
  // chunk's [startLine, endLine] range. Tree-sitter rows are 0-indexed;
  // we use the start row as the match anchor (chunks are anchored at
  // the declaration's first line).
  let target: AstNode | null = null;
  walk(root, (node) => {
    if (target) return;
    if (node.type !== "function_declaration" && node.type !== "method_declaration") return;
    const ns = node.startPosition.row + 1;
    const ne = node.endPosition.row + 1;
    // Container contains the chunk range (chunk equal or within node).
    if (ns <= startLine && ne >= endLine) target = node;
  });
  if (!target) return { types: bindings, calls: callBindings };

  const sink: GoBindingSink = { types: bindings, calls: callBindings, shadowed: shadowedNames };

  // Method receiver.
  const receiver = (target as AstNode).childForFieldName("receiver");
  if (receiver) {
    for (const param of receiver.children) {
      if (param.type !== "parameter_declaration") continue;
      const name = readParamName(param);
      const typeName = readParamBareType(param);
      if (name && typeName) (bindings[name] ??= []).push({ line: param.startPosition.row + 1, type: typeName });
    }
  }

  // Parameter list.
  const params = (target as AstNode).childForFieldName("parameters");
  if (params) bindParameterList(params, sink);

  // Function-literal parameters whose type binds nothing, settled AFTER the
  // walk: whether one must shadow depends on bindings the walk has not reached
  // yet (a `c := New()` later in the body is still an outer `c`).
  const untypedLiteralParams: UntypedLiteralParam[] = [];

  // Local declarations inside the body — `var x Foo`, `x := Foo{}`,
  // `x := &Foo{}` (bd tea-rags-mcp-6g9c), and every other declared name an
  // import or a bare call makes ambiguous (bd tea-rags-mcp-e6xx), each scoped
  // to the block that declares it.
  const body = (target as AstNode).childForFieldName("body");
  if (body) visitGoScopes(body, undefined, body, sink, untypedLiteralParams);
  // An untyped literal parameter shadows only a name that means something else
  // in the chunk — a typed binding, a call binding (`c := New()`), an imported
  // package, or a declaration the chunk calls bare. With no namesake it records
  // nothing, so no binding key appears that was not there.
  for (const param of untypedLiteralParams) {
    const shadows =
      bindings[param.name] !== undefined || callBindings[param.name] !== undefined || shadowedNames.has(param.name);
    if (shadows) (bindings[param.name] ??= []).push(param.shadow);
  }
  return { types: bindings, calls: callBindings };
}

/** The per-chunk binding maps under construction, and the names an untyped local must shadow. */
interface GoBindingSink {
  readonly types: Record<string, LocalBinding[]>;
  readonly calls: Record<string, CallResultBinding[]>;
  /**
   * The names the file's imports bind (`goImportBoundName`) and the chunk
   * calls bare (`goShadowedNames`). A local of one of these names records an
   * EMPTY-typed binding even when nothing types it, so no reader takes the
   * receiver for the package, or the bare call for the declaration, it
   * shadows.
   */
  readonly shadowed: ReadonlySet<string>;
}

/**
 * Node types that open a Go block below the function body: an explicit
 * `{ … }`, the implicit block of an `if` / `for` / `switch` / `select` (its
 * header declarations live in it), and each clause of a `switch` / `select`.
 * A local declared inside one is out of scope past the block's last line (Go
 * spec, "Blocks").
 */
const GO_SCOPE_NODE_TYPES: ReadonlySet<string> = new Set([
  "block",
  "for_statement",
  "if_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
  "expression_case",
  "default_case",
  "type_case",
  "communication_case",
]);

/**
 * Walk a function body, binding each declaration against the innermost block
 * that holds it: `scopeEnd` is that block's last line, `undefined` directly in
 * the function body (the chunk is the scope, as every binding before block
 * scoping read it).
 */
function visitGoScopes(
  node: AstNode,
  scopeEnd: number | undefined,
  functionBody: AstNode,
  sink: GoBindingSink,
  untypedLiteralParams: UntypedLiteralParam[],
): void {
  bindGoDeclaration(node, scopeEnd, sink, untypedLiteralParams);
  const inner = node !== functionBody && GO_SCOPE_NODE_TYPES.has(node.type) ? node.endPosition.row + 1 : scopeEnd;
  for (const child of node.children) visitGoScopes(child, inner, functionBody, sink, untypedLiteralParams);
}

/** Bind the names `node` declares, if it is a declaration. */
function bindGoDeclaration(
  node: AstNode,
  scopeEnd: number | undefined,
  sink: GoBindingSink,
  untypedLiteralParams: UntypedLiteralParam[],
): void {
  switch (node.type) {
    case "func_literal":
      bindFuncLiteralParams(node, sink, untypedLiteralParams);
      break;
    case "var_declaration":
      bindVarDeclaration(node, scopeEnd, sink);
      break;
    case "short_var_declaration":
      bindShortVarDeclaration(node, scopeEnd, sink);
      break;
    case "range_clause":
    case "receive_statement":
      // `for k, v := range m` / `case v := <-ch:` — declared only with `:=`.
      if (declaresWithShortVarToken(node)) {
        shadowGoLocals(node.childForFieldName("left"), node.childForFieldName("right"), scopeEnd, sink);
      }
      break;
    case "type_switch_statement":
      // `switch v := x.(type)` — `v` lives in every clause, i.e. the statement.
      shadowGoLocals(node.childForFieldName("alias"), node.childForFieldName("value"), node.endPosition.row + 1, sink);
      break;
    default:
      break;
  }
}

function declaresWithShortVarToken(node: AstNode): boolean {
  return node.children.some((c) => c.type === ":=");
}

/** `binding`, visible only up to `scopeEnd` when the declaring block is narrower than the chunk. */
function scopedTo(binding: LocalBinding, scopeEnd: number | undefined): LocalBinding {
  if (scopeEnd !== undefined) binding.scopeEndLine = scopeEnd;
  return binding;
}

/** Node types whose text names an identifier in scope — a value, a package qualifier, or a type. */
const GO_NAME_REFERENCE_NODE_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "package_identifier",
  "type_identifier",
]);

/** Whether `node`'s subtree names `name` (a field selected on something else, `x.name`, does not). */
function goNodeNamesIdentifier(node: AstNode, name: string): boolean {
  if (GO_NAME_REFERENCE_NODE_TYPES.has(node.type)) return node.text === name;
  return node.children.some((child) => goNodeNamesIdentifier(child, name));
}

/**
 * The `endLine` a statement-declared local carries (bd tea-rags-mcp-e6xx): the
 * last line of the right-hand side `rhs` the declaring statement evaluates —
 * but ONLY when `rhs` names the identifier being declared, else `undefined`.
 *
 * Go scopes such a local from the END of its statement, so in
 * `config := config.Load()` the right-hand `config` is still the package, and
 * `goLocalBindingAt` reads `endLine` to keep the local out of those lines. A
 * call site carries a line and no column, though, so the same bound would also
 * hide the local from the rest of its line — and an `if` / `switch` / `for`
 * header uses its init declaration on that very line
 * (`if e := NewEngine(); e.Ready() {`). The bound is therefore set only where
 * the right-hand side can refer to the name at all; everywhere else the local
 * is visible from its `line`, which is what the header needs. What stays
 * unexpressible is the case holding both — `if config := config.Load();
 * config.Ok() {` reads the condition's `config` as the package.
 */
function goDeclarationEndLine(rhs: AstNode | null, name: string): number | undefined {
  return rhs !== null && goNodeNamesIdentifier(rhs, name) ? rhs.endPosition.row + 1 : undefined;
}

/**
 * A local of a type the walker cannot know: recorded, with the EMPTY type,
 * only when its name is one the sink watches (`GoBindingSink.shadowed`) —
 * everywhere else nothing reads it. `rhs` is what the declaring statement
 * evaluates before the local exists: when it names the local, the local is in
 * scope only after it ends (`goDeclarationEndLine`), so its own right-hand
 * side still names the package. A parameter has no right-hand side and is in
 * scope from its line.
 */
function shadowGoLocal(ident: AstNode, rhs: AstNode | null, scopeEnd: number | undefined, sink: GoBindingSink): void {
  const name = ident.text;
  if (!sink.shadowed.has(name)) return;
  const binding: LocalBinding = { line: ident.startPosition.row + 1, type: "" };
  const endLine = goDeclarationEndLine(rhs, name);
  if (endLine !== undefined) binding.endLine = endLine;
  (sink.types[name] ??= []).push(scopedTo(binding, scopeEnd));
}

/** {@link shadowGoLocal} for every identifier of a declaration's left-hand `expression_list`. */
function shadowGoLocals(
  left: AstNode | null,
  rhs: AstNode | null,
  scopeEnd: number | undefined,
  sink: GoBindingSink,
): void {
  if (!left) return;
  for (const ident of left.children) if (ident.type === "identifier") shadowGoLocal(ident, rhs, scopeEnd, sink);
}

/**
 * The declaring function's own parameters: every name of a declaration
 * (`a, b *Engine` binds both), typed when the type is one nominal type, else
 * a shadow when the name is watched. A variadic parameter is a slice and
 * types nothing.
 */
function bindParameterList(params: AstNode, sink: GoBindingSink): void {
  for (const param of params.children) {
    if (param.type !== "parameter_declaration" && param.type !== "variadic_parameter_declaration") continue;
    const typeName = param.type === "parameter_declaration" ? readParamBareType(param) : null;
    const line = param.startPosition.row + 1;
    for (const ident of readParamNames(param)) {
      if (typeName) (sink.types[ident.text] ??= []).push({ line, type: typeName });
      else shadowGoLocal(ident, null, undefined, sink);
    }
  }
}

/**
 * `var x Foo`, `var a, b Foo`, `var x = expr`, and the grouped `var ( … )`:
 * every name is typed when the spec declares one nominal type (bd
 * tea-rags-mcp-6g9c), else shadowed when its name is watched.
 */
function bindVarDeclaration(node: AstNode, scopeEnd: number | undefined, sink: GoBindingSink): void {
  const specs = node.children.flatMap((c) =>
    c.type === "var_spec" ? [c] : c.type === "var_spec_list" ? c.children.filter((s) => s.type === "var_spec") : [],
  );
  for (const spec of specs) {
    const typeName = readBareTypeNode(spec.childForFieldName("type"));
    for (const ident of spec.children) {
      if (ident.type !== "identifier" || ident.text === "_") continue;
      if (typeName) {
        const binding = scopedTo({ line: ident.startPosition.row + 1, type: typeName }, scopeEnd);
        (sink.types[ident.text] ??= []).push(binding);
      } else {
        shadowGoLocal(ident, spec.childForFieldName("value"), scopeEnd, sink);
      }
    }
  }
}

/**
 * `x := Foo{}` / `x := &Foo{}` types `x` (bd tea-rags-mcp-6g9c); `x := New()`
 * / `x := pkg.New()` records the called function for the resolver to pair
 * with its declared return type. Only a single-LHS, single-value declaration
 * can be paired var↔value; every other name it declares — `a, err := f()`,
 * `x := y`, `x := func() {}` — is a local of unknown type, shadowed when its
 * name is watched (bd tea-rags-mcp-e6xx).
 */
function bindShortVarDeclaration(node: AstNode, scopeEnd: number | undefined, sink: GoBindingSink): void {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) return;
  const lhsIdents = left.children.filter((c) => c.type === "identifier");
  const rhsValues = right.children.filter((c) => c.type !== "," && c.type !== ":=");
  if (lhsIdents.length === 1 && rhsValues.length === 1) {
    const name = lhsIdents[0];
    const value = rhsValues[0];
    if (value.type === "composite_literal" || value.type === "unary_expression") {
      const typeName = readCompositeLiteralType(value);
      if (typeName) {
        (sink.types[name.text] ??= []).push(scopedTo({ line: name.startPosition.row + 1, type: typeName }, scopeEnd));
        return;
      }
    } else if (value.type === "call_expression") {
      const callee = readCalledFunctionName(value);
      if (callee) {
        const endLine = goDeclarationEndLine(right, name.text);
        const binding: CallResultBinding = {
          line: name.startPosition.row + 1,
          callee,
          ...(endLine === undefined ? {} : { endLine }),
          ...(scopeEnd === undefined ? {} : { scopeEndLine: scopeEnd }),
        };
        (sink.calls[name.text] ??= []).push(binding);
        return;
      }
    }
  }
  for (const ident of lhsIdents) shadowGoLocal(ident, right, scopeEnd, sink);
}

/** A function-literal parameter whose type binds nothing, and the shadow it would record. */
interface UntypedLiteralParam {
  name: string;
  shadow: LocalBinding;
}

/**
 * Bind a `func_literal`'s parameters for the literal's own lines (bd
 * tea-rags-mcp-e6xx) — gin's middlewares are `return func(c *Context) { ... }`,
 * and every call on that `c` went unresolved without it.
 *
 * Each binding carries `scopeEndLine` = the literal's last line, so the shared
 * lookup skips it past the literal and the name denotes whatever it denoted
 * before — a typed outer binding, the `c := New()` call binding, or nothing.
 *
 * A parameter whose type binds nothing (`w http.ResponseWriter`,
 * `c interface{ Use() }`) is a local of UNKNOWN type for the literal's lines: it
 * is recorded with the EMPTY type, which Go's readers take as "a local no pass
 * can type" — so neither an outer binding, a call binding of the same name, nor
 * an import it shadows speaks for it. Whether it needs recording at all is
 * settled after the walk (`untypedLiteralParams`). Every name of a
 * declaration binds (`func(w, render io.Writer)`).
 */
function bindFuncLiteralParams(
  literal: AstNode,
  sink: GoBindingSink,
  untypedLiteralParams: UntypedLiteralParam[],
): void {
  const params = literal.childForFieldName("parameters");
  if (!params) return;
  const scopeEndLine = literal.endPosition.row + 1;
  for (const param of params.children) {
    if (param.type !== "parameter_declaration" && param.type !== "variadic_parameter_declaration") continue;
    const line = param.startPosition.row + 1;
    const type = param.type === "parameter_declaration" ? readParamBareType(param) : null;
    for (const ident of readParamNames(param)) {
      const name = ident.text;
      if (type) (sink.types[name] ??= []).push({ line, type, scopeEndLine });
      else untypedLiteralParams.push({ name, shadow: { line, type: "", scopeEndLine } });
    }
  }
}

/**
 * Read the called function's spelling from a `call_expression` RHS, but ONLY
 * for the two statically-pairable shapes:
 *   - `New()`      → `function` field is an `identifier` → "New"
 *   - `pkg.New()`  → `function` field is a `selector_expression` whose
 *                    operand is a plain `identifier` (package qualifier) →
 *                    "pkg.New"; the resolver keys `functionReturnTypes` by the
 *                    bare last segment.
 * Returns null for chained calls (`New().Configure()` — selector operand is
 * itself a `call_expression`) and any other shape; the var↔return pairing is
 * only sound when the RHS is a direct call to a named function.
 */
function readCalledFunctionName(call: AstNode): string | null {
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "selector_expression") {
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    // Only `pkg.New()` (operand is a bare package identifier), not
    // `New().Configure()` (operand is a call) nor `a.b.New()` (chained).
    if (operand?.type === "identifier" && field?.type === "field_identifier") return `${operand.text}.${field.text}`;
  }
  return null;
}

/**
 * Read the bare type name from a `var_spec` `type` field node. Mirrors
 * `readParamBareType` — unwraps `*Foo` pointer types and `Box[T]` generic
 * types down to the base `type_identifier`. Returns null for unsupported
 * shapes (interface types, map/slice/func types — no single class name).
 */
function readBareTypeNode(typeNode: AstNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === "pointer_type") {
    const inner = typeNode.children.find((c) => c.type === "type_identifier");
    return inner?.text ?? null;
  }
  if (typeNode.type === "generic_type") {
    const base = typeNode.childForFieldName("type");
    return base?.text ?? null;
  }
  if (typeNode.type === "type_identifier") return typeNode.text;
  return null;
}

/**
 * Read the struct type from a short-var-decl RHS literal: `Foo{}`
 * (`composite_literal` whose `type` field is a `type_identifier`) or
 * `&Foo{}` (`unary_expression` whose `operand` is the composite literal).
 * Returns null for any RHS whose type isn't a bare `type_identifier`
 * (e.g. `map[K]V{}`, anonymous struct literals).
 */
function readCompositeLiteralType(node: AstNode): string | null {
  let literal: AstNode | null = node;
  if (node.type === "unary_expression") {
    literal = node.childForFieldName("operand");
  }
  if (literal?.type !== "composite_literal") return null;
  const typeNode = literal.childForFieldName("type");
  return typeNode?.type === "type_identifier" ? typeNode.text : null;
}

/** The receiver's name — the first identifier of its declaration. */
function readParamName(param: AstNode): string | null {
  const ident = param.children.find((c) => c.type === "identifier");
  return ident?.text ?? null;
}

/**
 * Every name of a parameter declaration: tree-sitter-go puts `func f(a, b int)`
 * in ONE `parameter_declaration` with several `identifier` children before the
 * `type` field. The blank `_` declares nothing.
 */
function readParamNames(param: AstNode): AstNode[] {
  return param.children.filter((c) => c.type === "identifier" && c.text !== "_");
}

function readParamBareType(param: AstNode): string | null {
  const typeNode = param.childForFieldName("type");
  if (!typeNode) return null;
  // `*Receiver` → unwrap pointer, read identifier.
  if (typeNode.type === "pointer_type") {
    const inner = typeNode.children.find((c) => c.type === "type_identifier");
    return inner?.text ?? null;
  }
  // `Box[T]` → strip type parameters, read base identifier.
  if (typeNode.type === "generic_type") {
    const base = typeNode.childForFieldName("type");
    return base?.text ?? null;
  }
  if (typeNode.type === "type_identifier") return typeNode.text;
  return null;
}
