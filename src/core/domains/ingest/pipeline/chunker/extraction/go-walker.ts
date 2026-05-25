/**
 * Go extraction walker.
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

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface GoExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromGoFile(input: GoExtractInput): FileExtraction {
  const imports = collectGoImports(input.tree.rootNode);
  const calls = collectGoCalls(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
    };
    // bd tea-rags-mcp-e6xx — per-chunk localBindings (receiver + params).
    // The resolver consults `ctx.localBindings[receiver]` to turn typed
    // calls like `c.JSON(...)` inside `(c *Context) Render(...)` into the
    // qualified `Context#JSON` target. Without this every method-call
    // site in a Go project stays unresolved.
    const bindings = collectGoLocalBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine);
    if (Object.keys(bindings).length > 0) base.localBindings = bindings;
    return base;
  });
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
}

function collectGoImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_spec") return;
    // import_spec has fields name (optional alias) and path (interpreted_string_literal).
    const path = node.childForFieldName("path");
    if (!path) return;
    const literal = path.text.replace(/^["`]|["`]$/g, "");
    out.push({ importText: literal, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectGoCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
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

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
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
 *
 * Constructor-return short decls `x := NewFoo()` are OUT OF SCOPE — the
 * return type can't be known statically without modelling every
 * constructor, and guessing reintroduces the false positives the m46z
 * receiver-drop removed. Go has no `self`/`this`: receivers AND local
 * vars are the only static type hints for `engine.Use()`-style calls.
 */
function collectGoLocalBindingsForChunk(
  root: Parser.SyntaxNode,
  startLine: number,
  endLine: number,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  // Find the function/method declaration node whose span matches the
  // chunk's [startLine, endLine] range. Tree-sitter rows are 0-indexed;
  // we use the start row as the match anchor (chunks are anchored at
  // the declaration's first line).
  let target: Parser.SyntaxNode | null = null;
  walk(root, (node) => {
    if (target) return;
    if (node.type !== "function_declaration" && node.type !== "method_declaration") return;
    const ns = node.startPosition.row + 1;
    const ne = node.endPosition.row + 1;
    // Container contains the chunk range (chunk equal or within node).
    if (ns <= startLine && ne >= endLine) target = node;
  });
  if (!target) return bindings;

  // Method receiver.
  const receiver = (target as Parser.SyntaxNode).childForFieldName("receiver");
  if (receiver) {
    for (const param of receiver.children) {
      if (param.type !== "parameter_declaration") continue;
      const name = readParamName(param);
      const typeName = readParamBareType(param);
      if (name && typeName) bindings[name] = typeName;
    }
  }

  // Parameter list.
  const params = (target as Parser.SyntaxNode).childForFieldName("parameters");
  if (params) {
    for (const param of params.children) {
      if (param.type !== "parameter_declaration") continue;
      const name = readParamName(param);
      const typeName = readParamBareType(param);
      if (name && typeName) bindings[name] = typeName;
    }
  }

  // Local variable declarations inside the body — `var x Foo`, `x :=
  // Foo{}`, `x := &Foo{}` (bd tea-rags-mcp-6g9c). Walk the target
  // declaration's descendants; both forms are nested in the function's
  // `block` / `statement_list` regardless of nesting depth.
  walk(target as Parser.SyntaxNode, (node) => {
    if (node.type === "var_declaration") {
      for (const spec of node.children) {
        if (spec.type !== "var_spec") continue;
        const name = spec.childForFieldName("name");
        const typeNode = spec.childForFieldName("type");
        const typeName = readBareTypeNode(typeNode);
        if (name && typeName) bindings[name.text] = typeName;
      }
      return;
    }
    if (node.type === "short_var_declaration") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (!left || !right) return;
      // Only single-name `x := Foo{}` / `x := &Foo{}` are knowable.
      const name = left.children.find((c) => c.type === "identifier");
      const value = right.children.find((c) => c.type === "composite_literal" || c.type === "unary_expression");
      if (!name || !value) return;
      const typeName = readCompositeLiteralType(value);
      if (typeName) bindings[name.text] = typeName;
    }
  });
  return bindings;
}

/**
 * Read the bare type name from a `var_spec` `type` field node. Mirrors
 * `readParamBareType` — unwraps `*Foo` pointer types and `Box[T]` generic
 * types down to the base `type_identifier`. Returns null for unsupported
 * shapes (interface types, map/slice/func types — no single class name).
 */
function readBareTypeNode(typeNode: Parser.SyntaxNode | null): string | null {
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
function readCompositeLiteralType(node: Parser.SyntaxNode): string | null {
  let literal: Parser.SyntaxNode | null = node;
  if (node.type === "unary_expression") {
    literal = node.childForFieldName("operand");
  }
  if (literal?.type !== "composite_literal") return null;
  const typeNode = literal.childForFieldName("type");
  return typeNode?.type === "type_identifier" ? typeNode.text : null;
}

function readParamName(param: Parser.SyntaxNode): string | null {
  // Go tree-sitter places multi-name `parameter_declaration` (e.g.
  // `func f(a, b int)`) with several `identifier` children before the
  // `type` field. Take the first identifier — multiple bindings of the
  // same type are uncommon for typed-receiver patterns and overlap
  // doesn't change resolution semantics.
  const ident = param.children.find((c) => c.type === "identifier");
  return ident?.text ?? null;
}

function readParamBareType(param: Parser.SyntaxNode): string | null {
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
