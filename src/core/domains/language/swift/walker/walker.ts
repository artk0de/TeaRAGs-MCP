/**
 * Swift extraction walker — tier 2 of the Swift vertical (the tier-1 vertical
 * shipped grammar + chunking only). Produces the four channels the resolver
 * chain reads: `imports`, per-chunk `calls`, per-chunk `localBindings`, and the
 * file-level `classFieldTypes`.
 *
 * Shaped after the Java walker (`java/walker/walker.ts`): innermost-chunk
 * attribution for BOTH calls (via the kernel's `assignCallsToInnermostChunks`)
 * and bindings, a flat `{ name, type, startLine }` collection pass, and a
 * file-level type→field→type map for the `self.field.method()` path.
 *
 * ## What tree-sitter-swift makes non-obvious
 *
 * - **Imports name a MODULE, never a symbol.** `import Foundation` and
 *   `import struct Foundation.Data` both yield a module path, so `importText`
 *   is that path and nothing downstream can map it to a declaration. The
 *   resolver has no import-receiver pass for exactly this reason — see
 *   `../resolver/swift-resolver.ts`.
 * - **A subscript read parses as a `call_expression`.** `items[i]` is a
 *   `call_expression` whose `call_suffix` is bracketed. Recording it emits a
 *   bare call named after a PROPERTY, which the terminal short-name pass then
 *   pins to an unrelated function, so the bracketed suffix is skipped.
 * - **Optional chaining and force unwrap live INSIDE the receiver text.**
 *   `obj!.forced()` gives a `postfix_expression` target whose text is `obj!`,
 *   and `a?.b!.c()` gives `a?.b!`. `normalizeSwiftReceiver` strips `?` and `!`
 *   so the text matches the name a binding or a stored property is keyed by;
 *   without it every unwrapped receiver in the corpus misses.
 * - **`try` / `await` wrap the call, not the other way round.** The walk visits
 *   every node, so `try await session.data(for:)` is reached as the ordinary
 *   `call_expression` nested inside them — no unwrapping needed.
 *
 * ## What is deliberately NOT bound
 *
 * - `[Thing]` and `[String: Foo]` annotations bind NOTHING. `LocalBinding.type`
 *   is a bare string with no container slot, so binding the element type would
 *   type the ARRAY as a `Thing` and pin `xs.append(_:)` to `Thing#append` — the
 *   Python lesson (`domains/language/CLAUDE.md`, "Python publishes type facts
 *   on THREE channels"), reached here through a different grammar.
 * - `guard let x = …` / `if let x = …` / `for x in …` bind nothing: the type is
 *   not written and inferring it needs the unwrapped expression's type, which
 *   no static pass here has.
 * - A non-CapWords initializer (`let t = makeThing()`) binds nothing — its
 *   return type is unknowable here and recording the FUNCTION name as a type
 *   fabricates a `makeThing#member` target (Rust `isCapWordsType`, Python
 *   `isCapWordsConstructor`).
 *
 * `fileScope` stays empty, as it is for java / rust / go / python / bash: the
 * Swift resolver has no reverse "which file declares X" channel, and the
 * resolution runner uses `fileScope` as the caller scope for file-level calls,
 * where a populated list would silently retarget them.
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

export interface SwiftExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromSwiftFile(input: SwiftExtractInput): FileExtraction {
  const imports = collectSwiftImports(input.tree.rootNode);
  const calls = collectSwiftCalls(input.tree.rootNode);
  const bindingOwnership = assignBindingsToInnermostChunks(
    collectSwiftTypedBindings(input.tree.rootNode),
    input.chunks,
  );
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
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
  };
  const classFieldTypes = collectSwiftStoredPropertyTypes(input.tree.rootNode);
  if (Object.keys(classFieldTypes).length > 0) out.classFieldTypes = classFieldTypes;
  return out;
}

/**
 * One `ImportRef` per `import_declaration`, carrying the MODULE path.
 *
 * The path lives in the declaration's `identifier` child (`Foundation`,
 * `Foundation.Data`), which is what separates it from the optional kind
 * keyword a declaration import carries (`import struct Foundation.Data`). A
 * grammar that stops emitting that child falls back to stripping the leading
 * `import` plus kind keyword from the node text.
 */
function collectSwiftImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_declaration") return;
    const path = node.children.find((c) => c.type === "identifier");
    const text = (path?.text ?? stripImportKeywords(node.text)).trim();
    if (text.length === 0) return;
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

/** `import struct Foundation.Data` → `Foundation.Data`. Fallback only — see `collectSwiftImports`. */
function stripImportKeywords(text: string): string {
  return text.replace(/^import\s+(?:typealias|struct|class|enum|protocol|let|var|func)?\s*/, "");
}

/**
 * One `CallRef` per invoking `call_expression`. Two callee shapes carry a call:
 * a bare `simple_identifier` (receiverless) and a `navigation_expression`
 * (`target` = receiver, `suffix.suffix` = member). Every other shape — an
 * immediately-invoked closure, a call on a parenthesised expression — names no
 * receiver this resolver could use and is skipped rather than guessed.
 *
 * `Foo()` is recorded as a BARE call whose member is `Foo`, not as
 * `Foo#init`. Swift's `Foo()` is sugar for `Foo.init(…)`, but a type relying on
 * the memberwise or default initializer declares no `init_declaration` and so
 * has no `Foo#init` symbol to land on; the bare form still resolves to the TYPE
 * through the terminal short-name pass, which is the edge that exists.
 */
function collectSwiftCalls(root: AstNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call_expression") return;
    const suffix = node.children.find((c) => c.type === "call_suffix");
    // Bracketed suffix = subscript read (`items[i]`, `dict["k"]`), not a call.
    if (!suffix || suffix.text.startsWith("[")) return;
    const callee = node.namedChildren.find((c) => c !== suffix);
    if (!callee) return;
    const startLine = node.startPosition.row + 1;
    if (callee.type === "simple_identifier") {
      out.push({ callText: node.text, receiver: null, member: callee.text, startLine });
      return;
    }
    if (callee.type !== "navigation_expression") return;
    const target = callee.childForFieldName("target");
    const member = callee.childForFieldName("suffix")?.childForFieldName("suffix");
    if (!target || !member) return;
    out.push({
      callText: node.text,
      receiver: normalizeSwiftReceiver(target.text),
      member: member.text,
      startLine,
    });
  });
  return out;
}

/**
 * Strip optional-chaining `?` and force-unwrap `!` out of a receiver's source
 * text: `obj!` → `obj`, `a?.b!` → `a.b`, `self.db` unchanged. The resolver
 * matches a receiver against `localBindings` keys and `classFieldTypes` field
 * names, neither of which carries the sugar, so an un-normalized receiver never
 * matches.
 */
export function normalizeSwiftReceiver(text: string): string {
  return text.replace(/[?!]/g, "");
}

interface SwiftTypedBinding {
  name: string;
  type: string;
  /** 1-based declaration line — used for innermost-chunk attribution and position-aware reads. */
  startLine: number;
}

/**
 * Collect `{ name, type, startLine }` for every statically typed binding in the
 * file. Three shapes, all determinable without inference:
 *
 *   1. `parameter` / `lambda_parameter` — the `name` field is the INTERNAL
 *      name (`_ invoice: Invoice` → `invoice`), which is the only one the body
 *      can reference; the `type` field carries the annotation.
 *   2. `property_declaration` carrying a `type_annotation` — the annotated
 *      `let` / `var`, at type level or inside a body.
 *   3. `property_declaration` with no annotation whose `value` is a CapWords
 *      initializer call (`var tmp = Helper()`).
 *
 * Both property shapes are collected here and in
 * `collectSwiftStoredPropertyTypes`; the two channels answer different
 * questions (a chunk-local receiver vs. a type's field) and the innermost-chunk
 * attribution below keeps a type-level property off the method chunks.
 */
function collectSwiftTypedBindings(root: AstNode): SwiftTypedBinding[] {
  const out: SwiftTypedBinding[] = [];
  walk(root, (node) => {
    if (node.type === "parameter" || node.type === "lambda_parameter") {
      const name = node.childForFieldName("name");
      const type = swiftBareTypeName(node.childForFieldName("type"));
      if (name && type) out.push({ name: name.text, type, startLine: node.startPosition.row + 1 });
      return;
    }
    if (node.type !== "property_declaration") return;
    const name = singleIdentifierPatternName(node.childForFieldName("name"));
    if (!name) return;
    const declared = swiftDeclaredPropertyType(node);
    if (declared) out.push({ name, type: declared, startLine: node.startPosition.row + 1 });
  });
  return out;
}

/**
 * The type a `property_declaration` declares, or null. Annotation first; on its
 * absence, a CapWords initializer call. A destructuring or tuple pattern is
 * rejected upstream by `singleIdentifierPatternName` — it names no single
 * receiver, and binding one of its members would invent a name.
 */
function swiftDeclaredPropertyType(node: AstNode): string | null {
  const annotation = node.children.find((c) => c.type === "type_annotation");
  if (annotation) return swiftBareTypeName(annotation.childForFieldName("type"));
  return constructedTypeName(node.childForFieldName("value"));
}

/**
 * `Helper()` → `Helper`. Null for anything else, including a lowercase callee.
 *
 * Swift types are UpperCamelCase and functions lowerCamelCase by universal
 * convention, and a lowercase callee's return type is not knowable here:
 * recording `makeThing` as a type would make the next call on the variable
 * resolve against a phantom `makeThing#member`. Same gate as Rust's
 * `isCapWordsType` and Python's `isCapWordsConstructor`.
 */
function constructedTypeName(value: AstNode | null): string | null {
  if (value?.type !== "call_expression") return null;
  const callee = value.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type !== "simple_identifier") return null;
  return /^[A-Z]/.test(callee.text) ? callee.text : null;
}

/** A `pattern` node's identifier when it binds exactly one name; null for tuple / destructuring patterns. */
function singleIdentifierPatternName(pattern: AstNode | null): string | null {
  if (pattern?.type !== "pattern" || pattern.namedChildCount !== 1) return null;
  const id = pattern.namedChildren[0];
  return id.type === "simple_identifier" ? id.text : null;
}

/**
 * Reduce a Swift type node to the bare name the symbol table is keyed by.
 *
 *   - `user_type` — `Foo` → `Foo`, `Set<Foo>` → `Set` (generics stripped by
 *     text, which also keeps a qualified `Outer.Inner` intact as the nested
 *     type's own composed id spells it).
 *   - `optional_type` — `Foo?` → `Foo`. The receiver of `x?.m()` is the wrapped
 *     value, so the Optional is transparent here.
 *   - anything else, notably `array_type` / `dictionary_type` / `tuple_type` /
 *     `function_type` / `opaque_type` — null. A container is not its element,
 *     and `LocalBinding.type` has nowhere to say so.
 */
function swiftBareTypeName(typeNode: AstNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === "optional_type") {
    const inner = typeNode.namedChildren[0];
    return inner ? swiftBareTypeName(inner) : null;
  }
  if (typeNode.type !== "user_type") return null;
  const raw = typeNode.text;
  const generics = raw.indexOf("<");
  const bare = (generics === -1 ? raw : raw.slice(0, generics)).trim();
  return bare.length > 0 ? bare : null;
}

/**
 * Attribute each binding to the INNERMOST chunk whose line range contains the
 * declaration, tie-broken by deeper scope — the same discipline
 * `assignCallsToInnermostChunks` applies to call sites, so a method's parameter
 * lands on the method chunk rather than the type chunk that also spans its
 * line. Bindings outside every chunk are dropped silently.
 *
 * Returns chunk index → `Record<name, LocalBinding[]>`: the position-aware
 * contract shape, so a re-bound name accumulates one `{ line, type }` per
 * declaration and `resolveLocalBindingType` picks the most recent one at or
 * before a call's line.
 */
function assignBindingsToInnermostChunks(
  bindings: SwiftTypedBinding[],
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
 * `typeName → propertyName → typeName` for every property declared DIRECTLY in
 * a nominal type's body — the channel the resolver's stored-property pass reads
 * for `self.db.write()` and for Swift's implicit-self `db.write()`.
 *
 * Keyed by the `class_declaration` / `protocol_declaration` name field, which
 * is what `swiftNameOf` composes the scope from, so the resolver's
 * `classFieldTypes[callerScope.at(-1)][field]` lookup lines up. One node type
 * covers class / struct / enum / actor; `enum_class_body` is the enum's body
 * node and carries properties just as `class_body` does.
 *
 * Computed properties are kept: `var total: Money { … }` still HAS type
 * `Money`, and a call on it dispatches on `Money` exactly as a stored one does.
 * An extension body declares no stored properties (Swift forbids them), so an
 * extension contributes nothing here and cannot collide with the type's own
 * entry.
 */
function collectSwiftStoredPropertyTypes(root: AstNode): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  walk(root, (node) => {
    if (node.type !== "class_declaration" && node.type !== "protocol_declaration") return;
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!name || !body) return;
    const fields: Record<string, string> = {};
    for (const member of body.children) {
      if (member.type !== "property_declaration") continue;
      const fieldName = singleIdentifierPatternName(member.childForFieldName("name"));
      const fieldType = swiftDeclaredPropertyType(member);
      if (fieldName && fieldType) fields[fieldName] = fieldType;
    }
    if (Object.keys(fields).length > 0) out[name.text] = { ...(out[name.text] ?? {}), ...fields };
  });
  return out;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
