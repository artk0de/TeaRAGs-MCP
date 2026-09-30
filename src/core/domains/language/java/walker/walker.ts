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

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
  TypeDeclarationFact,
} from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks, symbolIdNames } from "../../kernel/index.js";
import { javaNameOf } from "./name-of.js";
import { symbolKindOf } from "./symbol-kind.js";
import { isJavaTypeBody, javaConformedTypeNames, javaConstantNames } from "./type-declarations.js";

export interface JavaExtractInput {
  tree: MaterializedTree;
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
  // bd tea-rags-mcp-f11nz — the SAME innermost-chunk discipline for CALL sites,
  // via the kernel helper (python bd tea-rags-mcp-invuy). `javaNameOf` marks
  // `class_declaration` / `interface_declaration` / `enum_declaration`
  // `descendsInto: true`, so the pure-containment filter this replaces emitted
  // every in-method call TWICE: once from the method chunk under the method's
  // scope, once from the class chunk under the class's (or, for a top-level
  // class, an EMPTY) scope — the second copy resolving against the wrong caller.
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const { symbolKindsByLine: symbolKinds, typeDeclarations } = collectJavaDeclarationReadings(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const chunk: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    const symbolKind = symbolKinds.get(c.startLine)?.find((k) => symbolIdNames(c.symbolId, k.name))?.kind;
    if (symbolKind !== undefined) chunk.symbolKind = symbolKind;
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
    const record: Record<string, Record<string, string>> = createIdentifierRecord();
    for (const [cls, fields] of classFieldTypes) record[cls] = Object.fromEntries(fields);
    out.classFieldTypes = record;
  }
  if (typeDeclarations.length > 0) out.typeDeclarations = typeDeclarations;
  return out;
}

interface JavaSymbolKindReading {
  readonly name: string;
  readonly kind: SymbolDefinitionKind;
}

interface JavaDeclarationReadings {
  readonly symbolKindsByLine: Map<number, JavaSymbolKindReading[]>;
  readonly typeDeclarations: TypeDeclarationFact[];
}

/**
 * Where a node sits relative to the file's type declarations: `scope` is the
 * enclosing type-id path a nested type composes under, `owner` the id of the
 * type whose body the node is a member of (null outside any body). A node below
 * a method, an initializer or an anonymous class body gets no context — what it
 * declares is a local.
 */
interface JavaDeclarationContext {
  readonly scope: readonly string[];
  readonly owner: string | null;
}

/**
 * The file's declaration readings, in one traversal:
 *
 *   - `symbolKindsByLine` (tea-rags-mcp-vi0wx) — the declaration kind of every
 *     node `javaNameOf` names, keyed by its start line. A chunk carries no node,
 *     only the range and id `collectSymbols` built from that same `javaNameOf`
 *     reading, so the kind joins back on (start line, id names the reading's
 *     name) — the join the declared-visibility facet makes. Two declarations on
 *     one line (`class P { void a() {} void b() {} }`) are told apart by name.
 *   - `typeDeclarations` (spec §1b) — one fact per type declaration and per
 *     constant ({@link javaConstantNames}) reachable from the file scope through
 *     type bodies only, in source order. A nested type's id composes the way
 *     `collectSymbols` composes symbol ids — only a `javaNameOf` scope container
 *     (`descendsInto`) adds a segment — and a constant's id is its owning type's
 *     id plus its name. Enum constants are values of their enum, not constants.
 */
function collectJavaDeclarationReadings(root: AstNode): JavaDeclarationReadings {
  const symbolKindsByLine = new Map<number, JavaSymbolKindReading[]>();
  const typeDeclarations: TypeDeclarationFact[] = [];
  const visit = (node: AstNode, context: JavaDeclarationContext | null): void => {
    const named = javaNameOf(node);
    const kind = symbolKindOf(node.type);
    if (named !== null && kind !== undefined) {
      const line = node.startPosition.row + 1;
      const onLine = symbolKindsByLine.get(line);
      if (onLine === undefined) symbolKindsByLine.set(line, [{ name: named.name, kind }]);
      else onLine.push({ name: named.name, kind });
    }
    const childContext = declarationContextBelow(node, context, kind, named?.descendsInto === true, typeDeclarations);
    for (const child of node.children) visit(child, childContext);
  };
  visit(root, null);
  return { symbolKindsByLine, typeDeclarations };
}

/**
 * Publish what `node` declares under `context` and answer the context its
 * children see. The file root opens the top-level scope; a type declaration
 * opens its body; a type body passes its context through; anything else closes
 * it.
 */
function declarationContextBelow(
  node: AstNode,
  context: JavaDeclarationContext | null,
  kind: SymbolDefinitionKind | undefined,
  isScopeContainer: boolean,
  out: TypeDeclarationFact[],
): JavaDeclarationContext | null {
  if (node.type === "program") return { scope: [], owner: null };
  if (context === null) return null;
  const line = node.startPosition.row + 1;
  if (kind !== undefined && kind !== "method") {
    const name = node.childForFieldName("name")?.text;
    if (name === undefined) return null;
    const typeId = [...context.scope, name].join(".");
    const conforms = javaConformedTypeNames(node);
    out.push({ typeId, symbolKind: kind, line, reopens: false, ...(conforms.length > 0 ? { conforms } : {}) });
    return { scope: isScopeContainer ? [...context.scope, name] : context.scope, owner: typeId };
  }
  if (context.owner !== null) {
    for (const name of javaConstantNames(node)) {
      out.push({ typeId: `${context.owner}.${name}`, symbolKind: "constant", line, reopens: false });
    }
  }
  return isJavaTypeBody(node) ? context : null;
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
    const shape = javaCallSiteShape(node);
    if (shape) out.push({ callText: node.text, ...shape, startLine: node.startPosition.row + 1 });
  });
  return out;
}

/** The `{ receiver, member }` pair a Java `CallRef` carries. */
export interface JavaCallShape {
  receiver: string | null;
  member: string;
}

/**
 * The `{ receiver, member }` of the `CallRef` {@link collectJavaCalls} emits for
 * `node` — a `method_invocation` only: `obj.m()` → `obj` / `m`, a bare `m()` →
 * `m`. An object creation (`new X()`) emits no `CallRef`, so it answers null.
 * Read by the identifier-declaration pass so a declaration's bound callee
 * matches that `CallRef` by construction (bd tea-rags-mcp-4p3sb.16).
 */
export function javaCallSiteShape(node: AstNode): JavaCallShape | null {
  if (node.type !== "method_invocation") return null;
  const name = node.childForFieldName("name");
  if (!name) return null;
  return { receiver: node.childForFieldName("object")?.text ?? null, member: name.text };
}

/**
 * A method call whose receiver is an object creation — `new Latest().version()`,
 * parentheses allowed — binds that receiver, keyed by its text exactly as the
 * `CallRef` carries it, to the constructed type (bd tea-rags-mcp-52gqn). The
 * type is written in the expression itself, so this is the same evidence a
 * typed local (`Latest l = new Latest()`) gives the localBinding pass; without
 * it the receiver reached the resolver as an untyped parenthesized chain and
 * every pass dropped it.
 */
function constructedReceiverBinding(node: AstNode): JavaParamBinding | null {
  if (node.type !== "method_invocation") return null;
  const receiver = node.childForFieldName("object");
  if (!receiver) return null;
  let created: AstNode | null = receiver;
  while (created?.type === "parenthesized_expression") created = created.namedChildren[0] ?? null;
  if (created?.type !== "object_creation_expression") return null;
  const typeName = baseTypeName(created.childForFieldName("type"));
  if (!typeName) return null;
  return { name: receiver.text, type: typeName, startLine: node.startPosition.row + 1 };
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
    const constructed = constructedReceiverBinding(node);
    if (constructed) {
      out.push(constructed);
      return;
    }
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
      bucket = createIdentifierRecord();
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
