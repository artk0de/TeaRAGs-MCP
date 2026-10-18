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

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type { ModuleReexport, TypeDeclarationFact } from "../../../../contracts/types/codegraph-extraction.js";
import type { InheritanceEdgeDecl } from "../../../../contracts/types/codegraph-hierarchy.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks, symbolIdNames } from "../../kernel/index.js";
import { isCapWordsType, isRustConstructorAssocFn } from "../associated-constructor.js";
import { rustNameOf } from "./name-of.js";
import { rustOwnerItemOf, symbolKindOf } from "./symbol-kind.js";
import { isRustLocalScopeBoundary, rustTypeDeclarationFactOf } from "./type-declarations.js";

export interface RustExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromRustFile(input: RustExtractInput): FileExtraction {
  const imports = collectRustImports(input.tree.rootNode);
  const moduleReexports = collectRustModuleReexports(input.tree.rootNode);
  const inheritanceEdges = collectRustInheritanceEdges(input.tree.rootNode);
  const calls = collectRustCalls(input.tree.rootNode);
  // bd tea-rags-mcp-q1pl — per-class struct field types for the
  // `self.field.method()` resolver path. Keyed by struct name (which
  // equals the impl type name carried in a method chunk's `scope`).
  const classFieldTypes = collectRustStructFieldTypes(input.tree.rootNode);
  // bd tea-rags-mcp-f11nz — ONE owning chunk per call site: the smallest
  // containing range, ties broken by deeper scope (python bd tea-rags-mcp-invuy).
  // `rustNameOf` marks `impl_item` / `mod_item` / `struct_item` / `trait_item`
  // `descendsInto: true`, so the pure-containment filter this replaces emitted
  // every in-method call once per ENCLOSING chunk as well — an `impl` inside a
  // `mod` gave three copies, each resolving against a different caller scope.
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const { readings: symbolKindReadings, typeDeclarations } = collectRustDeclarationReadings(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    const symbolKind = symbolKindOfChunk(symbolKindReadings, c);
    if (symbolKind !== undefined) base.symbolKind = symbolKind;
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
  if (moduleReexports.length > 0) out.moduleReexports = moduleReexports;
  if (inheritanceEdges.length > 0) out.inheritanceEdges = inheritanceEdges;
  if (typeDeclarations.length > 0) out.typeDeclarations = typeDeclarations;
  return out;
}

interface RustSymbolKindReading {
  readonly name: string;
  readonly scopeKey: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Undefined for a node `rustNameOf` names but that declares nothing (`impl`, `macro_rules!`). */
  readonly kind: SymbolDefinitionKind | undefined;
}

interface RustDeclarationReadings {
  readonly readings: RustSymbolKindReading[];
  /** The `typeDeclarations` channel (spec §1b) — see `./type-declarations.ts`. */
  readonly typeDeclarations: TypeDeclarationFact[];
}

/**
 * Every node `rustNameOf` names, in the pre-order `collectSymbols` visits them,
 * with the scope (enclosing names) it composes and its declaration kind
 * (tea-rags-mcp-vi0wx). A chunk carries no node, only the range, scope and id
 * `collectSymbols` built from this same reading, so the kind joins back on
 * (range, scope, id names the reading's name). An `impl` block is recorded too,
 * with no kind: `collectSymbols` keeps the FIRST node per id, so `struct Foo;
 * impl Foo {}` on one line yields one `Foo` chunk, the struct's — and a lone
 * `impl Remote` yields a `Remote` chunk that must stay untagged.
 *
 * The same walk collects the file's type and constant declaration facts
 * (spec §1b) off the scope it already composes: `local` turns on below a `fn`,
 * a closure or a const/static initializer, whose declarations are not facts.
 */
function collectRustDeclarationReadings(root: AstNode): RustDeclarationReadings {
  const out: RustSymbolKindReading[] = [];
  const typeDeclarations: TypeDeclarationFact[] = [];
  const visit = (node: AstNode, scope: readonly string[], local: boolean): void => {
    if (!local) {
      const fact = rustTypeDeclarationFactOf(node, scope);
      if (fact !== null) typeDeclarations.push(fact);
    }
    const named = rustNameOf(node);
    if (named !== null) {
      out.push({
        name: named.name,
        scopeKey: scope.join("\u0000"),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        kind: symbolKindOf(node.type, { ownerItem: rustOwnerItemOf(node) }),
      });
    }
    const childScope = named === null ? scope : [...scope, named.name];
    const childLocal = local || isRustLocalScopeBoundary(node);
    for (const child of node.children) visit(child, childScope, childLocal);
  };
  visit(root, [], false);
  return { readings: out, typeDeclarations };
}

/** The kind of the first reading `chunk` was built from — first, as `collectSymbols` keeps the first node per id. */
function symbolKindOfChunk(
  readings: readonly RustSymbolKindReading[],
  chunk: RustExtractInput["chunks"][number],
): SymbolDefinitionKind | undefined {
  const scopeKey = chunk.scope.join("\u0000");
  return readings.find(
    (r) =>
      r.startLine === chunk.startLine &&
      r.endLine === chunk.endLine &&
      r.scopeKey === scopeKey &&
      symbolIdNames(chunk.symbolId, r.name),
  )?.kind;
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
  if (typeNode.type === "type_identifier" || typeNode.type === "identifier") return typeNode.text;
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

function rustGenericBounds(fn: AstNode): Record<string, string> {
  const bounds: Record<string, string> = createIdentifierRecord();
  const parameters = fn.childForFieldName("type_parameters");
  for (const parameter of parameters?.namedChildren ?? []) {
    if (parameter.type !== "type_parameter") continue;
    const name = parameter.childForFieldName("name")?.text;
    const traitBounds = parameter.childForFieldName("bounds");
    const candidates = traitBounds?.namedChildren ?? [];
    if (name === undefined || candidates.length !== 1) continue;
    const bound = readRustBareType(candidates[0]);
    if (bound !== null) bounds[name] = bound;
  }
  return bounds;
}

function rustTypeRefFor(
  typeNode: AstNode | null,
  genericBounds: Readonly<Record<string, string>>,
): { type: string; typeRef?: LocalBinding["typeRef"] } | null {
  const type = readRustBareType(typeNode);
  if (type === null) return null;
  const bound = genericBounds[type];
  return bound === undefined ? { type } : { type, typeRef: { form: "instance", name: bound, upperBound: true } };
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
function collectRustInheritanceEdges(root: AstNode): InheritanceEdgeDecl[] {
  const edges: InheritanceEdgeDecl[] = [];
  walk(root, (node) => {
    if (node.type !== "impl_item") return;
    const trait = node.childForFieldName("trait");
    const type = node.childForFieldName("type");
    if (!trait || !type) return;
    const source = rustTypeName(type);
    const ancestor = rustTypeName(trait);
    if (source !== null && ancestor !== null) {
      edges.push({ source, ancestor, kind: "implements", ordinal: 0 });
    }
  });
  return edges;
}

function rustTypeName(node: AstNode): string | null {
  if (node.type === "type_identifier" || node.type === "identifier") return node.text;
  if (node.type === "scoped_type_identifier" || node.type === "scoped_identifier") {
    const name = node.childForFieldName("name");
    return name?.text ?? null;
  }
  if (node.type === "generic_type") {
    const base = node.childForFieldName("type");
    return base ? rustTypeName(base) : null;
  }
  return null;
}

function collectRustStructFieldTypes(root: AstNode): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = createIdentifierRecord();
  walk(root, (node) => {
    if (node.type !== "struct_item") return;
    const nameNode = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!nameNode || body?.type !== "field_declaration_list") return;
    const fields: Record<string, string> = createIdentifierRecord();
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
  const bindings: Record<string, LocalBinding[]> = createIdentifierRecord();
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
  const genericBounds = rustGenericBounds(fn);
  const params = fn.childForFieldName("parameters");
  if (params) {
    for (const param of params.children) {
      if (param.type !== "parameter") continue;
      const pattern = param.childForFieldName("pattern");
      if (pattern?.type !== "identifier") continue;
      const typed = rustTypeRefFor(param.childForFieldName("type"), genericBounds);
      if (typed) (bindings[pattern.text] ??= []).push({ line: param.startPosition.row + 1, ...typed });
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
    // `Worker::new` — path is the receiving type, including a turbofish
    // generic (`Worker::<Token>`); strip only the generic arguments and keep
    // the constructor's nominal owner.
    if (!pathNode || fnNameNode?.type !== "identifier") return;
    const typeName = readRustBareType(pathNode);
    if (typeName && isRustConstructorAssocFn(fnNameNode.text) && isCapWordsType(typeName)) {
      (bindings[varName] ??= []).push({ line: node.startPosition.row + 1, type: typeName });
    }
  });
  return bindings;
}

function rustUseClause(node: AstNode): AstNode | null {
  return node.children.find((child) => child.type !== "visibility_modifier" && child.type !== "use") ?? null;
}

function rustUsePathParts(node: AstNode | null): string[] {
  return (
    node?.text
      .split("::")
      .map((part) => part.trim())
      .filter((part) => part.length > 0) ?? []
  );
}

function rustUsePathNode(node: AstNode): AstNode | null {
  return node.childForFieldName("path") ?? node.children[0] ?? null;
}

function rustUseAlias(node: AstNode): { sourceName: string; exportedName: string } | null {
  const path = rustUsePathNode(node);
  const alias = node.childForFieldName("alias") ?? node.children.at(-1);
  if (!path || !alias || alias === path) return null;
  const sourceParts = rustUsePathParts(path);
  return sourceParts.length > 0 ? { sourceName: sourceParts.at(-1) ?? "", exportedName: alias.text } : null;
}

function collectRustImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "use_declaration") return;
    const clause = rustUseClause(node);
    if (clause && clause.text.length > 0) out.push({ importText: clause.text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectRustModuleReexports(root: AstNode): ModuleReexport[] {
  const out: ModuleReexport[] = [];
  walk(root, (node) => {
    if (node.type !== "use_declaration" || !node.children.some((child) => child.type === "visibility_modifier")) return;
    const clause = rustUseClause(node);
    if (!clause) return;

    if (clause.type === "use_as_clause") {
      const path = rustUsePathNode(clause);
      const alias = rustUseAlias(clause);
      if (!path || !alias) return;
      const sourceParts = rustUsePathParts(path);
      out.push({
        exportedName: alias.exportedName,
        sourceModule: sourceParts.slice(0, -1).join("::"),
        sourceName: alias.sourceName,
      });
      return;
    }

    if (clause.type === "use_wildcard") {
      const sourceModule = rustUsePathNode(clause)?.text;
      if (sourceModule) out.push({ exportedName: "*", sourceModule });
      return;
    }

    if (clause.type === "scoped_use_list") {
      const sourceModule = rustUsePathNode(clause)?.text;
      const useList = clause.childForFieldName("list") ?? clause.children.find((child) => child.type === "use_list");
      if (!sourceModule || !useList) return;
      for (const member of useList.children) {
        if (member.type === "use_as_clause") {
          const alias = rustUseAlias(member);
          if (alias) out.push({ exportedName: alias.exportedName, sourceModule, sourceName: alias.sourceName });
          continue;
        }
        if (member.type === "use_wildcard") {
          out.push({ exportedName: "*", sourceModule });
          continue;
        }
        if (member.type === "identifier" || member.type === "scoped_identifier") {
          const sourceParts = rustUsePathParts(member);
          const sourceName = sourceParts.at(-1);
          if (sourceName) out.push({ exportedName: sourceName, sourceModule, sourceName });
        }
      }
      return;
    }

    const sourceParts = rustUsePathParts(clause);
    const sourceName = sourceParts.at(-1);
    if (sourceName) {
      out.push({
        exportedName: sourceName,
        sourceModule: sourceParts.slice(0, -1).join("::"),
        sourceName,
      });
    }
  });
  return out;
}

function collectRustCalls(root: AstNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    const shape = rustCallSiteShape(node);
    if (shape) {
      out.push({
        callText: node.text,
        ...shape,
        startLine: node.startPosition.row + 1,
        // The Node parser exposes UTF-16 code-unit columns. This is the
        // expression's start, not the callee token's range or a UTF-8 offset.
        startColumn: node.startPosition.column,
      });
    }
  });
  return out;
}

/** The `{ receiver, member }` pair a Rust `CallRef` carries. */
export interface RustCallShape {
  receiver: string | null;
  member: string;
}

/**
 * The `{ receiver, member }` of the `CallRef` {@link collectRustCalls} emits for
 * `node`, or null when it emits none. Read by the identifier-declaration pass
 * so a declaration's bound callee matches that `CallRef` by construction (bd
 * tea-rags-mcp-4p3sb.16).
 *
 * bd tea-rags-mcp-jyzb — `macro_invocation` (`println!()`, `my_macro!()`) is a
 * separate node type in tree-sitter-rust, not a `call_expression`. The macro
 * name lives on the `macro` field (an `identifier` or `scoped_identifier`) and
 * is treated as the call member — usually unresolvable (std-lib macros), but
 * user-defined `macro_rules!` symbols emit a definition (see `rustNameOf`) so
 * the resolver can link them. A call: `value.field()` → the value and field;
 * `foo::bar::baz()` → receiver `foo::bar`, member `baz`; a bare `f()` → `f`;
 * a `generic_function` adds type arguments without changing those shapes.
 * Expression callees (parenthesized values, dereferences, closures, call
 * results) stay omitted: their target needs callable-value identity, and
 * stripping them to a short name would let the resolver guess a namesake.
 */
export function rustCallSiteShape(node: AstNode): RustCallShape | null {
  if (node.type === "macro_invocation") {
    const macroField = node.childForFieldName("macro");
    if (!macroField) return null;
    if (macroField.type !== "scoped_identifier") return { receiver: null, member: macroField.text };
    const name = macroField.childForFieldName("name");
    return name ? { receiver: macroField.childForFieldName("path")?.text ?? null, member: name.text } : null;
  }
  if (node.type !== "call_expression") return null;
  let fn = node.childForFieldName("function");
  while (fn?.type === "generic_function") fn = fn.childForFieldName("function");
  if (fn?.type === "field_expression") {
    const value = fn.childForFieldName("value");
    const field = fn.childForFieldName("field");
    return value && field ? { receiver: value.text, member: field.text } : null;
  }
  if (fn?.type === "scoped_identifier") {
    const name = fn.childForFieldName("name");
    return name ? { receiver: fn.childForFieldName("path")?.text ?? null, member: name.text } : null;
  }
  return fn?.type === "identifier" ? { receiver: null, member: fn.text } : null;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
