/**
 * Java extraction walker. Relocated from
 * `domains/ingest/pipeline/chunker/extraction/java-walker.ts` into the native
 * Java language provider per the `domains/language` consolidation (spec §3; bd
 * tea-rags-mcp-cen6, following ruby + typescript + javascript + python + go).
 * Behaviour-preserving.
 *
 * Java imports come as `import_declaration` nodes with a
 * scoped_identifier child whose dotted text gives the fully-qualified
 * type name:
 *   import com.foo.Bar;
 *   import com.foo.*;          // wildcard
 *   import static com.foo.Bar.method;
 *
 * Walker emits the full dotted name as importText (caller resolver
 * can strip wildcards). Calls are method_invocation; receivers come
 * from the `object` field. Top-level symbols are class_declaration,
 * interface_declaration, enum_declaration. method_declaration nests
 * under classes.
 *
 * bd tea-rags-mcp-cvv9 — receiver-type tracking (mirrors the TS walker's
 * `collectParamBindings` + `collectClassFieldTypes`):
 *   - per-method-chunk `localBindings` from method PARAMETER types
 *     (`(final CharSequence cs)` → `{ cs: "CharSequence" }`) and local
 *     variable declarations (`Bar b = …;` → `{ b: "Bar" }`);
 *   - file-level `classFieldTypes` from class FIELD declarations
 *     (`private Foo foo;` → `{ Owner: { foo: "Foo" } }`) so the resolver
 *     can pin `this.foo.method()` to `Foo#method`.
 * Generics strip to the base type (`List<String>` → `List`); primitive
 * types (`int`, `boolean`, …) and untyped declarations bind nothing.
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

export interface JavaExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromJavaFile(input: JavaExtractInput): FileExtraction {
  const imports = collectJavaImports(input.tree.rootNode);
  const calls = collectJavaCalls(input.tree.rootNode);
  // bd tea-rags-mcp-cvv9 — collect `name → type` bindings for typed
  // method parameters and local variable declarations, then attribute
  // each to the INNERMOST chunk whose line range contains the
  // declaration. Mirrors the TS walker's `collectParamBindings` +
  // innermost-chunk attribution discipline so a method's parameter lands
  // on the method chunk, not the enclosing class chunk that also spans
  // the declaration line.
  const localBindings = collectLocalBindings(input.tree.rootNode);
  const bindingOwnership = assignBindingsToInnermostChunks(localBindings, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const chunk: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
    };
    const bindings = bindingOwnership.get(chunkIndex);
    if (bindings && Object.keys(bindings).length > 0) chunk.localBindings = bindings;
    return chunk;
  });
  // bd tea-rags-mcp-cvv9 — file-level class field-type map for
  // `this.field.method()` resolution. Convert the nested Map → nested
  // Record so it survives the NDJSON spill between walker emit and
  // resolver consume (mirrors the TS walker's `classFieldTypesRecord`).
  const classFieldTypes = collectJavaClassFieldTypes(input.tree.rootNode);
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
  if (classFieldTypes.size > 0) {
    const record: Record<string, Record<string, string>> = {};
    for (const [cls, fields] of classFieldTypes) record[cls] = Object.fromEntries(fields);
    out.classFieldTypes = record;
  }
  return out;
}

function collectJavaImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_declaration") return;
    // The dotted path lives in scoped_identifier (and asterisk node for
    // wildcards). Use the node text minus `import`, `static`, `;`.
    const text = node.text
      .replace(/^import\s+(static\s+)?/, "")
      .replace(/;$/, "")
      .trim();
    if (text.length === 0) return;
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function collectJavaCalls(root: AstNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "method_invocation") return;
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name");
    if (!name) return;
    const startLine = node.startPosition.row + 1;
    if (object) {
      out.push({ callText: node.text, receiver: object.text, member: name.text, startLine });
    } else {
      out.push({ callText: node.text, receiver: null, member: name.text, startLine });
    }
  });
  return out;
}

interface JavaParamBinding {
  name: string;
  type: string;
  /** 1-based declaration line — used for innermost-chunk attribution. */
  startLine: number;
}

/**
 * Collect `{ name, type, startLine }` for every typed method parameter
 * and local variable declaration in the file.
 *
 *   - `formal_parameter` — `type` field carries the declared type,
 *     `name` field the identifier. The optional `final` modifier sits in
 *     a `modifiers` child and is tolerated (it does not affect the type).
 *   - `local_variable_declaration` — `type` field plus one or more
 *     `variable_declarator` children whose `name` field is the
 *     identifier. Multi-declarator forms (`Foo a, b;`) bind every name to
 *     the shared type.
 *
 * Generics strip to the base type via `baseTypeName` (`List<String>` →
 * `List`). Primitive types (`int`, `boolean`, …) and unnamed types bind
 * nothing — `baseTypeName` returns null and the entry is skipped.
 */
function collectLocalBindings(root: AstNode): JavaParamBinding[] {
  const out: JavaParamBinding[] = [];
  walk(root, (node) => {
    if (node.type === "formal_parameter") {
      const typeName = baseTypeName(node.childForFieldName("type"));
      const name = node.childForFieldName("name");
      if (typeName && name) out.push({ name: name.text, type: typeName, startLine: node.startPosition.row + 1 });
      return;
    }
    if (node.type === "local_variable_declaration") {
      const typeName = baseTypeName(node.childForFieldName("type"));
      if (!typeName) return;
      for (const declarator of node.children) {
        if (declarator.type !== "variable_declarator") continue;
        const name = declarator.childForFieldName("name");
        if (name) out.push({ name: name.text, type: typeName, startLine: node.startPosition.row + 1 });
      }
    }
  });
  return out;
}

/**
 * Attribute each binding to the INNERMOST chunk whose line range contains
 * the declaration line. Tie-breaker: deeper scope wins — identical
 * discipline to the TS walker's `assignParamBindingsToInnermostChunks`,
 * so a method parameter lands on the method chunk rather than the
 * enclosing class chunk that also spans the declaration line.
 *
 * Returns a Map keyed by chunk index → `Record<name, LocalBinding[]>`
 * (the position-aware contract shape: each name accumulates an array of
 * `{ line, type }` so a call site resolves against the most-recent binding
 * at or before its own line via `resolveLocalBindingType`). Bindings whose
 * line falls outside every chunk are dropped silently.
 */
function assignBindingsToInnermostChunks(
  bindings: JavaParamBinding[],
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
    let bucket = out.get(bestIdx);
    if (!bucket) {
      bucket = {};
      out.set(bestIdx, bucket);
    }
    (bucket[binding.name] ??= []).push({ line: binding.startLine, type: binding.type });
  }
  return out;
}

/**
 * Collect class field declarations with named types:
 * `className → fieldName → typeName`. A `field_declaration` inside a
 * `class_body` carries a `type` field plus `variable_declarator`
 * children whose `name` field is the field identifier. Generics strip to
 * the base type; primitive-typed fields bind nothing.
 *
 * Mirrors the TS walker's `collectClassFieldTypes` — the file-level
 * channel the resolver consults for `this.field.method()` cross-class
 * calls. Returns an empty Map when no class declares a named-type field.
 */
function collectJavaClassFieldTypes(root: AstNode): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const result = new Map<string, Map<string, string>>();
  walk(root, (node) => {
    if (node.type !== "class_declaration") return;
    const nameNode = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!nameNode || !body) return;
    const fields = new Map<string, string>();
    for (const member of body.children) {
      if (member.type !== "field_declaration") continue;
      const typeName = baseTypeName(member.childForFieldName("type"));
      if (!typeName) continue;
      for (const declarator of member.children) {
        if (declarator.type !== "variable_declarator") continue;
        const fieldName = declarator.childForFieldName("name");
        if (fieldName) fields.set(fieldName.text, typeName);
      }
    }
    if (fields.size > 0) result.set(nameNode.text, fields);
  });
  return result;
}

/**
 * Reduce a Java type node to its bare class name. Returns null for
 * primitive types and anything we can't pin to a single named type.
 *   - `type_identifier` — simple `Foo` → `Foo`.
 *   - `generic_type` — `List<String>` → first `type_identifier` (`List`).
 *   - `scoped_type_identifier` — `java.util.List` → keep the text intact.
 *   - primitive nodes (`integral_type`, `boolean_type`, `floating_point_type`,
 *     `void_type`) and array/other shapes → null (no class to bind).
 */
function baseTypeName(typeNode: AstNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "scoped_type_identifier") return typeNode.text;
  if (typeNode.type === "generic_type") {
    const base = typeNode.children.find((c) => c.type === "type_identifier" || c.type === "scoped_type_identifier");
    return base ? base.text : null;
  }
  return null;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
