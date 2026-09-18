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
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks } from "../../kernel/assign-calls-to-chunks.js";

export interface GoExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromGoFile(input: GoExtractInput): FileExtraction {
  const imports = collectGoImports(input.tree.rootNode);
  const calls = collectGoCalls(input.tree.rootNode);
  const functionReturnTypes = collectGoFunctionReturnTypes(input.tree.rootNode);
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
    // `localCallBindings` (varName → CALLED FUNC) covers `x := New()` where
    // the return type can't be known in-chunk; the resolver pairs it with
    // the file-level `functionReturnTypes`. The resolver consults both to
    // turn typed/return-typed calls into qualified `Type#method` targets.
    const { types, calls: callBindings } = collectGoLocalBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine);
    if (Object.keys(types).length > 0) base.localBindings = types;
    if (Object.keys(callBindings).length > 0) base.localCallBindings = callBindings;
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
  return extraction;
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
 * reads `localCallBindings` short names. Last-write-wins on duplicate names;
 * resolver-side ambiguity is gated by the symbol-table existence check.
 */
function collectGoFunctionReturnTypes(root: AstNode): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    if (node.type !== "function_declaration" && node.type !== "method_declaration") return;
    const name = node.childForFieldName("name");
    const result = node.childForFieldName("result");
    if (!name || !result) return;
    const typeName = readReturnTypeNode(result);
    if (typeName) out[name.text] = typeName;
  });
  return out;
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
    const inner = result.children.find((c) => c.type === "type_identifier");
    return inner?.text ?? null;
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

function collectGoCalls(root: AstNode): CallRef[] {
  const out: CallRef[] = [];
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
        out.push({ callText: node.text, receiver: null, member: type.text, startLine: node.startPosition.row + 1 });
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
    } else {
      out.push({ callText: node.text, receiver: null, member: fn.text, startLine });
    }
  });
  return out;
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
 *
 * Function-return short decls `x := New()` are captured into the SEPARATE
 * `calls` map (varName → called func short name), NOT `types` — the walker
 * can't know the return type from the chunk alone (the function may be
 * declared elsewhere). The resolver pairs `calls` with the file-level
 * `functionReturnTypes` map and applies the symbol-table existence gate; this
 * is SAFE because declared return types are static, not guesses, and only
 * concrete struct types that exist in the table ever bind. bd tea-rags-mcp-6g9c.
 * Go has no `self`/`this`: receivers, local vars, AND return-typed vars are
 * the only static type hints for `engine.Use()`-style calls.
 */
function collectGoLocalBindingsForChunk(
  root: AstNode,
  startLine: number,
  endLine: number,
): { types: Record<string, LocalBinding[]>; calls: Record<string, string> } {
  const bindings: Record<string, LocalBinding[]> = {};
  const callBindings: Record<string, string> = {};
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
  if (params) {
    for (const param of params.children) {
      if (param.type !== "parameter_declaration") continue;
      const name = readParamName(param);
      const typeName = readParamBareType(param);
      if (name && typeName) (bindings[name] ??= []).push({ line: param.startPosition.row + 1, type: typeName });
    }
  }

  // Function-literal parameters whose type binds nothing, settled AFTER the
  // walk: whether one must shadow depends on bindings the walk has not reached
  // yet (a `c := New()` later in the body is still an outer `c`).
  const untypedLiteralParams: UntypedLiteralParam[] = [];

  // Local variable declarations inside the body — `var x Foo`, `x :=
  // Foo{}`, `x := &Foo{}` (bd tea-rags-mcp-6g9c). Walk the target
  // declaration's descendants; both forms are nested in the function's
  // `block` / `statement_list` regardless of nesting depth.
  walk(target, (node) => {
    if (node.type === "func_literal") {
      bindFuncLiteralParams(node, bindings, untypedLiteralParams);
      return;
    }
    if (node.type === "var_declaration") {
      for (const spec of node.children) {
        if (spec.type !== "var_spec") continue;
        const name = spec.childForFieldName("name");
        const typeNode = spec.childForFieldName("type");
        const typeName = readBareTypeNode(typeNode);
        if (name && typeName) (bindings[name.text] ??= []).push({ line: name.startPosition.row + 1, type: typeName });
      }
      return;
    }
    if (node.type === "short_var_declaration") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (!left || !right) return;
      // Single-LHS only: `a, b := f(), g()` can't be paired var↔value
      // unambiguously. tree-sitter emits one `expression_list` per side;
      // require exactly one identifier on the left and one value on the right.
      const lhsIdents = left.children.filter((c) => c.type === "identifier");
      const rhsValues = right.children.filter((c) => c.type !== "," && c.type !== ":=");
      if (lhsIdents.length !== 1 || rhsValues.length !== 1) return;
      const name = lhsIdents[0];
      const value = rhsValues[0];
      // `x := Foo{}` / `x := &Foo{}` — directly-knowable type literal.
      if (value.type === "composite_literal" || value.type === "unary_expression") {
        const typeName = readCompositeLiteralType(value);
        if (typeName) (bindings[name.text] ??= []).push({ line: name.startPosition.row + 1, type: typeName });
        return;
      }
      // `x := New()` / `x := pkg.New()` — function-return assignment. Record
      // the called function's short name; the resolver maps it to the
      // declared return type. bd tea-rags-mcp-6g9c.
      if (value.type === "call_expression") {
        const funcName = readCalledFunctionName(value);
        if (funcName) callBindings[name.text] = funcName;
      }
    }
  });
  // An untyped literal parameter shadows only a name that means something else
  // in the chunk — a typed binding or a call binding (`c := New()`). With no
  // namesake it records nothing, so no binding key appears that was not there.
  for (const param of untypedLiteralParams) {
    if (bindings[param.name] === undefined && callBindings[param.name] === undefined) continue;
    (bindings[param.name] ??= []).push(param.shadow);
  }
  return { types: bindings, calls: callBindings };
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
 * settled after the walk (`untypedLiteralParams`).
 */
function bindFuncLiteralParams(
  literal: AstNode,
  bindings: Record<string, LocalBinding[]>,
  untypedLiteralParams: UntypedLiteralParam[],
): void {
  const params = literal.childForFieldName("parameters");
  if (!params) return;
  const scopeEndLine = literal.endPosition.row + 1;
  for (const param of params.children) {
    if (param.type !== "parameter_declaration") continue;
    const name = readParamName(param);
    if (!name) continue;
    const line = param.startPosition.row + 1;
    const type = readParamBareType(param);
    if (type) (bindings[name] ??= []).push({ line, type, scopeEndLine });
    else untypedLiteralParams.push({ name, shadow: { line, type: "", scopeEndLine } });
  }
}

/**
 * Read the called function's short name from a `call_expression` RHS, but
 * ONLY for the two statically-pairable shapes:
 *   - `New()`      → `function` field is an `identifier` → "New"
 *   - `pkg.New()`  → `function` field is a `selector_expression` whose
 *                    operand is a plain `identifier` (package qualifier) →
 *                    bare last segment "New".
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
    if (operand?.type === "identifier" && field?.type === "field_identifier") return field.text;
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

function readParamName(param: AstNode): string | null {
  // Go tree-sitter places multi-name `parameter_declaration` (e.g.
  // `func f(a, b int)`) with several `identifier` children before the
  // `type` field. Take the first identifier — multiple bindings of the
  // same type are uncommon for typed-receiver patterns and overlap
  // doesn't change resolution semantics.
  const ident = param.children.find((c) => c.type === "identifier");
  return ident?.text ?? null;
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
