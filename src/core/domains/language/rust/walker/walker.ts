/**
 * Rust extraction walker. Relocated from
 * `domains/ingest/pipeline/chunker/extraction/rust-walker.ts` into the native
 * Rust language provider per the `domains/language` consolidation (spec §3; bd
 * tea-rags-mcp-cen6, following ruby + typescript + javascript + python + go +
 * java). Behaviour-preserving.
 *
 * Rust imports use `use` declarations:
 *   use foo::bar;
 *   use foo::bar::Baz;
 *   use crate::foo::bar;
 *   use super::foo;
 *   use foo::{bar, baz};      // grouped
 *
 * Tree-sitter-rust emits these as `use_declaration` with a `path`
 * child that is either an `identifier`, `scoped_identifier`,
 * `scoped_use_list`, or `use_list`. We capture the full dotted form;
 * the resolver handles `crate::` / `super::` / `self::` prefixes.
 *
 * Calls are `call_expression`. Top-level symbols: `function_item`,
 * `impl_item` (with type_identifier name), `struct_item`,
 * `enum_item`, `trait_item`, `mod_item`.
 */

import type Parser from "tree-sitter";

import type { AstNode } from "../../../../contracts/types/ast.js";
import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";

export interface RustExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromRustFile(input: RustExtractInput): FileExtraction {
  const imports = collectRustImports(input.tree.rootNode);
  const calls = collectRustCalls(input.tree.rootNode);
  // bd tea-rags-mcp-q1pl — per-class struct field types for the
  // `self.field.method()` resolver path. Keyed by struct name (which
  // equals the impl type name carried in a method chunk's `scope`).
  const classFieldTypes = collectRustStructFieldTypes(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
    };
    // bd tea-rags-mcp-q1pl — per-chunk `varName → typeName` bindings so
    // the resolver's `localBindings[receiver]` branch fires for real.
    // Three sources, attributed to the innermost function chunk:
    // typed `let x: Foo`, associated-fn constructors (`Foo::new()`), and
    // parameter type annotations (`fn bar(p: Foo)`).
    const bindings = collectRustLocalBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine);
    if (Object.keys(bindings).length > 0) base.localBindings = bindings;
    return base;
  });
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
  if (Object.keys(classFieldTypes).length > 0) out.classFieldTypes = classFieldTypes;
  return out;
}

/**
 * Rust associated functions conventionally used as constructors. A
 * `let y = Worker::new()` binds `y` to `Worker` ONLY when the assoc-fn is
 * one of these well-known constructor names AND the receiving type is
 * CapWords. Any other assoc fn (`Worker::query()`, `Config::load()`)
 * returns a value whose type we can't know from the call alone — recording
 * it would fabricate a wrong binding, so we SKIP. `with_*` covers the
 * common `Foo::with_capacity(n)` builder shape.
 */
function isRustConstructorAssocFn(name: string): boolean {
  return name === "new" || name === "from" || name === "default" || name.startsWith("with_");
}

/**
 * PEP8-style CapWords gate, mirroring the Python walker's
 * `isCapWordsConstructor`. Rust types are UpperCamelCase
 * (`Worker`, `HashMap`); modules are snake_case (`mymod`). A lowercase
 * scoped-identifier path segment is a MODULE path (`mymod::new()`), not a
 * type constructor — recording it would attribute `Foo#method` to a module
 * name. Gate on the leading character of the receiving type segment.
 */
function isCapWordsType(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * Reduce a Rust type node to its bare base type name, mirroring the Go
 * walker's `readBareTypeNode`. Strips references (`&Foo`, `&mut Foo` →
 * `Foo`) and unwraps generics (`Vec<Thing>` → `Vec`). Returns null for
 * shapes with no single named base (tuple/array/slice/fn-pointer types,
 * trait objects) so the binding is skipped rather than guessed.
 *
 * tree-sitter-rust shapes:
 *   - `type_identifier`         → `Foo`           (read text)
 *   - `reference_type`          → `&Foo` / `&mut Foo` (descend to inner type)
 *   - `generic_type`            → `Vec<Thing>`    (read `type` field base)
 *   - `scoped_type_identifier`  → `mod::Foo`      (bare last segment)
 */
function readRustBareType(typeNode: AstNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "reference_type") {
    // `&Foo` / `&mut Foo` — the referent type is the only `type` field.
    const inner = typeNode.childForFieldName("type");
    return readRustBareType(inner);
  }
  if (typeNode.type === "generic_type") {
    // `Vec<Thing>`, `Box<dyn T>` — base type is the `type` field; could
    // itself be a `scoped_type_identifier`, so recurse to its bare name.
    const base = typeNode.childForFieldName("type");
    return readRustBareType(base);
  }
  if (typeNode.type === "scoped_type_identifier") {
    // `std::vec::Vec` / `module::Foo` — bare last segment.
    const name = typeNode.childForFieldName("name");
    return name?.type === "type_identifier" ? name.text : null;
  }
  return null;
}

/**
 * Collect `structName → fieldName → typeName` from every `struct_item`
 * with a `field_declaration_list` body. Field types are stripped to their
 * bare base name (`engine: Engine`, `items: Vec<Thing>` → `Vec`,
 * `parent: &Owner` → `Owner`). Tuple structs (`struct Foo(Bar)`) and
 * unit structs have no named fields and contribute nothing.
 *
 * Keyed by the struct name, which equals the impl type name carried in a
 * method chunk's `scope` (provider `rustNameOf` strips generics from the
 * `impl` type), so the resolver's `self.field` path looks the type up via
 * `classFieldTypes[callerScope.at(-1)][field]`. Mirrors the Python walker's
 * `collectPythonClassFieldTypes` channel.
 */
function collectRustStructFieldTypes(root: AstNode): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  walk(root, (node) => {
    if (node.type !== "struct_item") return;
    const nameNode = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!nameNode || body?.type !== "field_declaration_list") return;
    const fields: Record<string, string> = {};
    for (const fd of body.children) {
      if (fd.type !== "field_declaration") continue;
      const fieldName = fd.childForFieldName("name");
      const typeName = readRustBareType(fd.childForFieldName("type"));
      if (fieldName && typeName) fields[fieldName.text] = typeName;
    }
    if (Object.keys(fields).length > 0) {
      out[nameNode.text] = { ...(out[nameNode.text] ?? {}), ...fields };
    }
  });
  return out;
}

/**
 * Collect `varName → typeName` bindings for the function/method whose body
 * spans `[startLine, endLine]`. Mirrors the Go walker's
 * `collectGoLocalBindingsForChunk`. Three sources, all statically
 * determinable (no return-type guessing):
 *
 *   1. Parameters — `fn bar(p: Foo, q: &mut Bar)` → `{ p: "Foo", q: "Bar" }`.
 *      The `self_parameter` (`&self`) is skipped: it carries no named type
 *      and the resolver handles bare `self` via `callerScope`.
 *   2. Typed `let` — `let x: Engine = ...` → `{ x: "Engine" }`.
 *   3. Associated-fn constructors — `let y = Worker::new()` → `{ y: "Worker" }`
 *      gated on a constructor assoc-fn name (`new`/`from`/`default`/`with_*`)
 *      AND a CapWords receiving type. Non-ctor assoc fns and module-path
 *      receivers are SKIPPED — their return type isn't knowable here.
 *
 * Anything whose type isn't determinable (untyped `let x = build()`,
 * non-CapWords receiver, tuple/closure patterns) is skipped — no
 * fabrication. Innermost-function attribution: we anchor on the
 * `function_item` whose span tightly contains the chunk range.
 */
function collectRustLocalBindingsForChunk(
  root: AstNode,
  startLine: number,
  endLine: number,
): Record<string, LocalBinding[]> {
  const bindings: Record<string, LocalBinding[]> = {};
  // Find the innermost `function_item` whose span contains the chunk
  // range. Walk in document order tracking the tightest enclosing match
  // so nested functions attribute to the inner one.
  let target: AstNode | null = null;
  walk(root, (node) => {
    if (node.type !== "function_item") return;
    const ns = node.startPosition.row + 1;
    const ne = node.endPosition.row + 1;
    if (ns <= startLine && ne >= endLine) {
      if (!target || node.startPosition.row > target.startPosition.row) target = node;
    }
  });
  if (!target) return bindings;
  const fn = target as AstNode;

  // Parameters — `fn bar(&self, p: Foo)`. `self_parameter` is anonymous
  // and skipped; only `parameter` nodes with a `pattern` identifier and a
  // resolvable `type` contribute.
  const params = fn.childForFieldName("parameters");
  if (params) {
    for (const param of params.children) {
      if (param.type !== "parameter") continue;
      const pattern = param.childForFieldName("pattern");
      if (pattern?.type !== "identifier") continue;
      const typeName = readRustBareType(param.childForFieldName("type"));
      if (typeName) (bindings[pattern.text] ??= []).push({ line: param.startPosition.row + 1, type: typeName });
    }
  }

  // Local `let` declarations inside the body. Restrict to `let_declaration`
  // nodes nested within THIS function (the walk descends into nested
  // functions too, but those are attributed to their own chunk — guard by
  // re-checking the binding stays in [startLine, endLine]).
  walk(fn, (node) => {
    if (node.type !== "let_declaration") return;
    if (node.startPosition.row + 1 < startLine || node.startPosition.row + 1 > endLine) return;
    const pattern = node.childForFieldName("pattern");
    if (pattern?.type !== "identifier") return;
    const varName = pattern.text;

    // Typed `let x: Foo = ...` — explicit annotation wins.
    const typeNode = node.childForFieldName("type");
    if (typeNode) {
      const typeName = readRustBareType(typeNode);
      if (typeName) (bindings[varName] ??= []).push({ line: node.startPosition.row + 1, type: typeName });
      return;
    }

    // Untyped `let y = Foo::new()` — associated-fn constructor inference.
    const value = node.childForFieldName("value");
    if (value?.type !== "call_expression") return;
    const callee = value.childForFieldName("function");
    if (callee?.type !== "scoped_identifier") return;
    const pathNode = callee.childForFieldName("path");
    const fnNameNode = callee.childForFieldName("name");
    // `Worker::new` — path is the receiving type (single identifier), name
    // is the assoc fn. Multi-segment paths (`a::b::new`) and non-identifier
    // paths are skipped: the receiving type isn't unambiguous.
    if (pathNode?.type !== "identifier" || fnNameNode?.type !== "identifier") return;
    const typeName = pathNode.text;
    if (isRustConstructorAssocFn(fnNameNode.text) && isCapWordsType(typeName)) {
      (bindings[varName] ??= []).push({ line: node.startPosition.row + 1, type: typeName });
    }
  });
  return bindings;
}

function collectRustImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "use_declaration") return;
    // Strip `use`, trailing `;`, trim. Group lists (`use foo::{a, b}`)
    // are preserved verbatim — resolver expands as needed.
    const text = node.text
      .replace(/^use\s+/, "")
      .replace(/;$/, "")
      .trim();
    if (text.length === 0) return;
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectRustCalls(root: AstNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    // bd tea-rags-mcp-jyzb — macro_invocation (`println!()`, `my_macro!()`)
    // is a separate node type in tree-sitter-rust, not a `call_expression`.
    // The macro name lives on the `macro` field (an `identifier` or
    // `scoped_identifier`). We treat the macro name as the call member
    // with no receiver — usually unresolvable (std-lib macros), but
    // user-defined `macro_rules!` symbols emit a definition (see
    // `rustNameOf`) so the resolver can link them.
    if (node.type === "macro_invocation") {
      const macroField = node.childForFieldName("macro");
      if (!macroField) return;
      const startLine = node.startPosition.row + 1;
      if (macroField.type === "scoped_identifier") {
        const path = macroField.childForFieldName("path");
        const name = macroField.childForFieldName("name");
        if (!name) return;
        out.push({ callText: node.text, receiver: path?.text ?? null, member: name.text, startLine });
        return;
      }
      // Plain `identifier` — bare macro name.
      out.push({ callText: node.text, receiver: null, member: macroField.text, startLine });
      return;
    }
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn) return;
    const startLine = node.startPosition.row + 1;
    if (fn.type === "field_expression") {
      const value = fn.childForFieldName("value");
      const field = fn.childForFieldName("field");
      if (!value || !field) return;
      out.push({ callText: node.text, receiver: value.text, member: field.text, startLine });
    } else if (fn.type === "scoped_identifier") {
      // foo::bar::baz() — receiver = foo::bar, member = baz.
      const path = fn.childForFieldName("path");
      const name = fn.childForFieldName("name");
      if (!name) return;
      const receiver = path?.text ?? null;
      out.push({ callText: node.text, receiver, member: name.text, startLine });
    } else if (fn.type === "identifier") {
      out.push({ callText: node.text, receiver: null, member: fn.text, startLine });
    }
  });
  return out;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
