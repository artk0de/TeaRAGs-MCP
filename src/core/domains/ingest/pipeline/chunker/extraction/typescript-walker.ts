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

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface ExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  /** Caller-provided chunk-range index, sorted by startLine ascending. */
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromTypescriptFile(input: ExtractInput): FileExtraction {
  const imports = collectImports(input.tree.rootNode);
  const calls = collectCalls(input.tree.rootNode);
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
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    startLine: c.startLine,
    endLine: c.endLine,
    calls: callOwnership.get(chunkIndex) ?? [],
  }));
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

function collectImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_statement") return;
    // Skip top-level type-only imports (bd tea-rags-mcp-m19a):
    // `import type { X } from "./x"` is erased at compile time and
    // produces no runtime dependency. Including it in imports[] inflates
    // codegraph fanOut/fanIn for type-only relationships. The grammar
    // emits the `type` keyword as a direct child of `import_statement`
    // right after the `import` keyword for the statement-level type-only
    // form. Per-specifier `import { type X, Y }` is NOT filtered — the
    // statement is still a runtime import that loads `Y`.
    const importIdx = node.children.findIndex((c) => c.type === "import" || c.text === "import");
    if (importIdx >= 0) {
      const next = node.children[importIdx + 1];
      if (next && (next.type === "type" || next.text === "type")) return;
    }
    const src = node.children.find((c) => c.type === "string");
    if (!src) return;
    const text = src.text.replace(/^["']|["']$/g, "");
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
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
    if (callee.type === "member_expression") {
      const obj = callee.childForFieldName("object");
      const prop = callee.childForFieldName("property");
      if (!obj || !prop) return;
      out.push({ callText: node.text, receiver: obj.text, member: prop.text, startLine });
    } else if (callee.type === "super") {
      // Bare `super(arg)` in a constructor (bd tea-rags-mcp-3a84). The
      // tree-sitter grammar emits `super` as the callee node type (no
      // member access). Without this branch, the walker emitted
      // `{ receiver: null, member: "super" }` which the resolver then
      // tried to look up by short-name (always fails). Re-shape to the
      // super-method form so ts-resolver's `super.X()` branch routes
      // the call to `<EnclosingClass>#constructor` of the parent.
      out.push({ callText: node.text, receiver: "super", member: "constructor", startLine });
    } else {
      out.push({ callText: node.text, receiver: null, member: callee.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
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
function collectClassFieldTypes(root: Parser.SyntaxNode): ReadonlyMap<string, ReadonlyMap<string, string>> {
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
        const typeName = extractTypeNameFromAnnotation(member.children.find((c) => c.type === "type_annotation"));
        if (fieldName && typeName) fields.set(fieldName, typeName);
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
function collectClassExtends(root: Parser.SyntaxNode): ReadonlyMap<string, string> {
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
function extractTypeNameFromAnnotation(annotation: Parser.SyntaxNode | undefined): string | null {
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
