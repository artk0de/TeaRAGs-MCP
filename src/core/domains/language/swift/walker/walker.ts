/**
 * Swift extraction walker — tier 2 of the Swift vertical (the tier-1 vertical
 * shipped grammar + chunking only). Produces the four channels the resolver
 * chain reads: `imports`, per-chunk `calls`, per-chunk `localBindings`, and the
 * field types published under BOTH addresses — the per-file `classFieldTypes`
 * and the run-global `classFieldTypesByClassKey` a chained receiver folds
 * across files (`../type-field-address.ts`).
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
 *   `call_expression` nested inside them — no unwrapping needed. An
 *   INITIALIZER is the other way round: `let x = try load()` hands the binding
 *   collector a `try_expression`, so the type walk unwraps them there.
 * - **A `guard` / `if` / `while` condition list is FLAT.** The grammar emits
 *   `value_binding_pattern`, the bound `simple_identifier`, `=` and the
 *   right-hand side as sibling children under a REPEATED `condition` field, so
 *   the clauses are read by scanning `children` in order — `childForFieldName`
 *   answers with the first writer only and cannot see clause two. It is also
 *   what separates `if let x = y` from `if case let .some(v) = y`: the
 *   pattern-matching form puts a `.` where the plain form puts the bound name.
 * - **A TYPE position carries TWO field names, and materialization keeps one.**
 *   `parameter.type`, `type_annotation.type` and a `func`'s `return_type` are
 *   each ALSO registered under `name`, which is the one `fieldNameForChild`
 *   reports and therefore the only one `materializeTree` records — so those
 *   three fields exist on a native node and are gone on the node the pipeline
 *   actually walks. Every type here is read positionally instead; see
 *   {@link swiftTypeNodeAfter}, which is the single place that reasoning lives.
 *
 * ## What the walker can prove about a receiver's type
 *
 * Every type below is READ, never guessed: an annotation, a CapWords
 * initializer, a declared `-> T`, or a stored property's declared type. The
 * evidence is FILE-LOCAL — {@link SwiftFileTypeEvidence} is built from this
 * file's own declarations — because a walker resolves nothing, and a
 * same-file answer is the only one it can be sure names the right declaration.
 *
 *   1. `parameter` / `lambda_parameter` annotations, and annotated `let` / `var`.
 *   2. A CapWords initializer call (`var tmp = Helper()`).
 *   3. `guard let x = …` / `if let x = …` / `if let x` / `while let x = …`,
 *      typed from the unwrapped expression — a stored property, an
 *      already-typed local, an initializer, a declared return, or the binding's
 *      own `: T` annotation.
 *   4. A local assigned from a call whose callee this FILE declares with a
 *      return type (`let x = make()` against `func make() -> Invoice`).
 *   5. `for x in xs`, typed from the ELEMENT of an `[T]`-typed collection.
 *
 * ## Scope extent is the interesting half of 3 and 5
 *
 * `LocalBinding.scopeEndLine` is what keeps a block-scoped unwrap from typing a
 * call below its block, and Swift's two forms differ:
 *
 * - a `guard let` binding is visible for the REST OF ITS ENCLOSING BLOCK (the
 *   `else` branch must leave the scope), so its `scopeEndLine` is that block's
 *   last line — the enclosing block, not the function, so a guard inside an
 *   `if` body stops at the `if`'s closing brace;
 * - an `if let` / `while let` / `for in` binding dies with its OWN block, so
 *   its `scopeEndLine` is the closing brace of the then-body. Taking the
 *   statement's end instead would carry the binding into the `else` branch,
 *   where Swift does not bind it at all.
 *
 * The lookups have no column, so a one-line `if let a = b { a.x() } else { a.y() }`
 * types the else arm too. That is the same limitation Go's declaration rule
 * documents (`domains/language/CLAUDE.md`), not a Swift-specific one.
 *
 * ## What is deliberately NOT bound
 *
 * - A `[Thing]` annotation never binds the annotated NAME as a `Thing`.
 *   `LocalBinding.type` is a bare string with no container slot, so binding
 *   the element type would type the ARRAY as a `Thing` and pin
 *   `xs.append(_:)` to `Thing#append` — the Python lesson
 *   (`domains/language/CLAUDE.md`, "Python publishes type facts on THREE
 *   channels"), reached here through a different grammar. It binds `Array`
 *   (and `[String: Foo]` binds `Dictionary`), the standard-library types those
 *   spellings ARE, so a call reaches the project's `extension Array where
 *   Element == Header` (bd tea-rags-mcp-y99pg.14; until then they bound
 *   nothing). The element type is held in {@link SwiftTypeFact}'s own slot,
 *   which only `for x in xs` and the element accessors read and which
 *   nothing emits, so the invariant is structural rather than a rule someone
 *   has to remember. A `Set<Foo>` / `Array<Foo>` spelling fills the same slot
 *   (bd tea-rags-mcp-y99pg.32) — its one generic argument IS its element — and
 *   a `[String: Foo]` element is NOT read: a dictionary iterates as a tuple the
 *   single-name pattern rejects anyway.
 * - A non-CapWords initializer whose callee this file does NOT declare
 *   (`let t = makeThing()`) binds nothing — its return type is unknowable here
 *   and recording the FUNCTION name as a type fabricates a `makeThing#member`
 *   target (Rust `isCapWordsType`, Python `isCapWordsConstructor`).
 * - A declared return of `Self` / `Any` / `AnyObject` / `Never` / `Void`, or of
 *   the function's own generic parameter, binds nothing: each names a type the
 *   symbol table cannot hold, and `T` would fabricate a `T#member` target.
 * - Two same-file overloads declaring DIFFERENT return types drop the name
 *   rather than let declaration order pick. A member declaration DOES beat a
 *   top-level namesake, which is Swift's own lookup order, not a tie-break.
 * - `if case let .some(v) = opt` binds nothing: it destructures a pattern, and
 *   the payload type is not written at the binding site.
 * - A binding named `self` / `Self` / `super` is never emitted. The idiomatic
 *   `guard let self = self else { return }` would otherwise put a local under a
 *   pseudo receiver, where the FIRST chain pass answers and DROPS what
 *   `selfMember` resolves.
 * - `classFieldTypes` keeps the NARROW rule — annotation or CapWords
 *   initializer — while a local reads the full expression walk. The map is the
 *   INPUT to that walk, so widening it would make a property's type depend on
 *   another property's.
 *
 * `fileScope` stays empty, as it is for java / rust / go / python / bash: the
 * Swift resolver has no reverse "which file declares X" channel, and the
 * resolution runner uses `fileScope` as the caller scope for file-level calls,
 * where a populated list would silently retarget them.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type {
  AritySignature,
  CallRef,
  CallResultBinding,
  ChunkExtraction,
  FileExtraction,
  GenericInitializerFact,
  ImportRef,
  KwargSignature,
  LocalBinding,
  SelfConstraintFact,
  SwiftFieldConstruction,
  SwiftWhereClauseFact,
  TypeDeclarationFact,
  TypeDeclarationKind,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { assignCallsToInnermostChunks } from "../../kernel/index.js";
import { swiftTypeFieldKey } from "../type-field-address.js";

export interface SwiftExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[]; bodyScope?: string[] }[];
}

export function extractFromSwiftFile(input: SwiftExtractInput): FileExtraction {
  const root = input.tree.rootNode;
  const imports = collectSwiftImports(root);
  const calls = collectSwiftCalls(root);
  const evidence = collectSwiftFileTypeEvidence(root);
  const bindingOwnership = assignBindingsToInnermostChunks(collectSwiftTypedBindings(root, evidence), input.chunks);
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const signatures = collectSwiftCallableSignatures(root, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const chunk: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    // A type chunk's own calls run inside the type (`swiftNameOf` opts in).
    if (c.bodyScope !== undefined) chunk.bodyScope = c.bodyScope;
    const signature = signatures.get(chunkIndex);
    if (signature) {
      chunk.arity = signature.arity;
      chunk.kwargs = signature.kwargs;
      chunk.acceptsBlock = signature.acceptsBlock;
    }
    const bindings = bindingOwnership.get(chunkIndex);
    if (bindings && Object.keys(bindings.localBindings).length > 0) chunk.localBindings = bindings.localBindings;
    if (bindings && Object.keys(bindings.callResultBindings).length > 0) {
      chunk.callResultBindings = bindings.callResultBindings;
    }
    return chunk;
  });
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
  const classFieldTypes = swiftClassFieldTypes(evidence);
  if (Object.keys(classFieldTypes).length > 0) {
    out.classFieldTypes = classFieldTypes;
    // The SAME facts under the run-global address. `classFieldTypes` reaches a
    // resolver per-FILE, so it can only ever answer about the caller's own
    // file; this key is the one that survives the pass-1 barrier and lets a
    // chained receiver read a field of a type declared somewhere else.
    out.classFieldTypesByClassKey = swiftClassFieldTypesByClassKey(classFieldTypes, input.relPath);
  }
  const classExtends = collectSwiftClassExtends(root);
  if (Object.keys(classExtends).length > 0) out.classExtends = classExtends;
  const structuredReturnTypes = collectSwiftStructuredReturnTypes(root, input.chunks);
  if (Object.keys(structuredReturnTypes).length > 0) out.structuredReturnTypes = structuredReturnTypes;
  const typeDeclarations = collectSwiftTypeDeclarations(root);
  if (typeDeclarations.length > 0) out.typeDeclarations = typeDeclarations;
  return out;
}

/**
 * Every type declaration of the file, in source order — the
 * `typeDeclarations` channel (bd tea-rags-mcp-y99pg.1).
 *
 * tree-sitter-swift parses `extension T` as the same `class_declaration` node a
 * `class T` is, and the symbol id both compose is `T`, so the keyword is the
 * only evidence of which one a node is. A declaration's id is its own name
 * under every enclosing declaration — an extension's included, since a type
 * nested in `extension Encoder` composes as `Encoder.Container` — and an
 * extension's own id is its name AS WRITTEN: Swift only lets an extension sit
 * at file scope, so that path is already qualified from the module.
 *
 * `conforms` lists every inheritance specifier, superclass and protocols
 * alike, because the clause marks neither; {@link collectSwiftClassExtends}
 * is where the superclass is told apart for `super`.
 */
function collectSwiftTypeDeclarations(root: AstNode): TypeDeclarationFact[] {
  const out: TypeDeclarationFact[] = [];
  walk(root, (node) => {
    const kind = swiftTypeDeclarationKind(node);
    if (kind === null) return;
    const name = swiftTypeNameText(node.childForFieldName("name")?.text);
    if (name === undefined) return;
    const enclosing: string[] = [];
    for (let current = node.parent; current; current = current.parent) {
      if (swiftTypeDeclarationKind(current) === null) continue;
      const outer = swiftTypeNameText(current.childForFieldName("name")?.text);
      if (outer !== undefined) enclosing.unshift(outer);
    }
    const conforms = swiftInheritedTypeNames(node);
    const genericParameters = kind === "extension" ? [] : swiftTypeParameterNames(node);
    const {
      fieldTypeArguments,
      fieldConstructions,
      memberClosureParameters,
      genericInitializers,
      genericFieldParameters,
      closureResultMembers,
    } = swiftGenericMemberFacts(node, genericParameters);
    const whereClause = kind === "extension" ? swiftWhereClauseFact(node) : undefined;
    const enumCasePayloads = kind === "enum" ? swiftEnumCasePayloads(node) : undefined;
    const functionAliasReturns = swiftFunctionAliasReturns(node);
    const selfConstraints = kind === "extension" ? swiftSelfConstraints(node) : undefined;
    const propertyAttributeTypes = swiftPropertyAttributeTypes(node);
    const optionalProperties = swiftOptionalPropertyNames(node);
    const memberTypeAliases = swiftMemberTypeAliases(node);
    // `extension Collection<String>` composes its members under the name as
    // WRITTEN (bd tea-rags-mcp-y99pg.19); an extension sits at file scope.
    const written = node.childForFieldName("name")?.text.trim();
    const spelledAs = kind === "extension" && written !== undefined && written !== name ? written : undefined;
    out.push({
      typeId: [...enclosing, name].join("."),
      reopens: kind === "extension",
      ...(kind === "extension" ? {} : { declarationKind: kind }),
      ...(conforms.length > 0 ? { conforms } : {}),
      ...(genericParameters.length > 0 ? { genericParameters } : {}),
      ...(fieldTypeArguments ? { fieldTypeArguments } : {}),
      ...(fieldConstructions ? { fieldConstructions } : {}),
      ...(memberClosureParameters ? { memberClosureParameters } : {}),
      ...(closureResultMembers ? { closureResultMembers } : {}),
      ...(genericInitializers ? { genericInitializers } : {}),
      ...(enumCasePayloads ? { enumCasePayloads } : {}),
      ...(spelledAs === undefined ? {} : { spelledAs }),
      ...(functionAliasReturns ? { functionAliasReturns } : {}),
      ...(selfConstraints ? { selfConstraints } : {}),
      ...(propertyAttributeTypes ? { propertyAttributeTypes } : {}),
      ...(optionalProperties.length > 0 ? { optionalProperties } : {}),
      ...(memberTypeAliases ? { memberTypeAliases } : {}),
      ...(genericFieldParameters ? { genericFieldParameters } : {}),
      ...(whereClause ? { whereClause } : {}),
    });
  });
  return out;
}

/**
 * The nominal member typealiases of a type body (bd tea-rags-mcp-y99pg.33):
 * `typealias Output = DataStreamRequest.Stream<Value, AFError>` →
 * `{ Output: "DataStreamRequest.Stream" }`. Only a plain nominal alias is
 * kept — an optional, a metatype or a function type is not the nominal a
 * `Self.Output` member dispatches on. The aliased type is read positionally
 * for the materialization hazard {@link swiftTypeNodeAfter} documents.
 */
function swiftMemberTypeAliases(node: AstNode): Record<string, string> | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;
  const out = createIdentifierRecord<string>();
  let any = false;
  for (const member of body.namedChildren) {
    if (member.type !== "typealias_declaration") continue;
    const alias = member.namedChildren.find((c) => c.type === "type_identifier")?.text;
    const aliased = swiftTypeNodeAfter(member, "=");
    if (alias === undefined || aliased?.type !== "user_type") continue;
    const { nominal } = swiftTypeFactOf(aliased);
    if (nominal === null) continue;
    out[alias] = nominal;
    any = true;
  }
  return any ? out : undefined;
}

/** The properties a type body annotates `T?` (bd tea-rags-mcp-y99pg.33), in source order. */
function swiftOptionalPropertyNames(node: AstNode): string[] {
  const body = node.childForFieldName("body");
  const out: string[] = [];
  for (const member of body?.children ?? []) {
    if (member.type !== "property_declaration" || !swiftDeclaresOptional(member)) continue;
    const name = singleIdentifierPatternName(member.childForFieldName("name"));
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The UpperCamelCase attribute types each property of a type body carries, in
 * source order (bd tea-rags-mcp-y99pg.33): `@Published var result` →
 * `{ result: ["Published"] }`. Which of them is the property's wrapper — the
 * type `$result` projects through — is the resolver's question: `@MainActor`
 * is spelled the same way and wraps nothing. A lowercase attribute
 * (`@objc`, `@available`) is a compiler attribute, never a type.
 */
function swiftPropertyAttributeTypes(node: AstNode): Record<string, string[]> | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;
  const out = createIdentifierRecord<string[]>();
  let any = false;
  for (const member of body.children) {
    if (member.type !== "property_declaration") continue;
    const name = singleIdentifierPatternName(member.childForFieldName("name"));
    const modifiers = member.children.find((c) => c.type === "modifiers");
    if (!name || !modifiers) continue;
    const types: string[] = [];
    for (const attribute of modifiers.namedChildren) {
      if (attribute.type !== "attribute") continue;
      const { nominal } = swiftTypeFactOf(attribute.namedChildren.find((c) => c.type === "user_type") ?? null);
      if (nominal !== null && /^_*[A-Z]/.test(nominal)) types.push(nominal);
    }
    if (types.length === 0) continue;
    out[name] = types;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * What an extension's `where` clause says `Self` is (bd tea-rags-mcp-y99pg.33):
 * `extension Download where Self: DataSerializer` — inside that body `Self`
 * conforms to `DataSerializer` too, so an implicit-self call reaches its
 * requirements. `Self == X` names `X` the same way. A constraint on any other
 * name (`where Value: Equatable`) says nothing about `Self`. Each constraint
 * is read positionally — subject first, constraining type last — for the
 * materialization hazard {@link swiftTypeNodeAfter} documents.
 */
function swiftSelfConstraints(node: AstNode): SelfConstraintFact | undefined {
  const types: string[] = [];
  for (const clause of node.children) {
    if (clause.type !== "type_constraints") continue;
    for (const constraint of clause.namedChildren) {
      const relation = constraint.namedChildren.find(
        (c) => c.type === "inheritance_constraint" || c.type === "equality_constraint",
      );
      if (relation?.namedChildren[0]?.text !== "Self") continue;
      const { nominal } = swiftTypeFactOf(relation.namedChildren[relation.namedChildCount - 1]);
      if (nominal !== null && !types.includes(nominal)) types.push(nominal);
    }
  }
  if (types.length === 0) return undefined;
  return { types, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

/**
 * A re-opening's `where` clause with the lines it scopes (bd
 * tea-rags-mcp-y99pg.34): each same-type requirement's type as written, each
 * conformance or superclass requirement's nominal. Read positionally — the
 * constrained name first, the type last — for the materialization hazard
 * {@link swiftTypeNodeAfter} documents. Undefined when the clause states
 * neither.
 */
function swiftWhereClauseFact(node: AstNode): SwiftWhereClauseFact | undefined {
  const sameType = createIdentifierRecord<string>();
  const bounds = createIdentifierRecord<string>();
  let anySameType = false;
  let anyBound = false;
  for (const clause of node.children) {
    if (clause.type !== "type_constraints") continue;
    for (const constraint of clause.namedChildren) {
      for (const requirement of constraint.namedChildren) {
        const name = requirement.namedChildren[0]?.text.trim();
        const type = requirement.namedChildren[requirement.namedChildCount - 1];
        if (!name || !type || requirement.namedChildCount < 2 || Object.hasOwn(sameType, name)) continue;
        if (requirement.type === "equality_constraint") {
          sameType[name] = type.text.trim();
          anySameType = true;
        } else if (requirement.type === "inheritance_constraint" && !Object.hasOwn(bounds, name)) {
          const { nominal } = swiftTypeFactOf(type);
          if (nominal === null) continue;
          bounds[name] = nominal;
          anyBound = true;
        }
      }
    }
  }
  if (!anySameType && !anyBound) return undefined;
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    ...(anySameType ? { sameType } : {}),
    ...(anyBound ? { bounds } : {}),
  };
}

/**
 * What each function-typed `typealias` a type body declares returns (bd
 * tea-rags-mcp-y99pg.22): `typealias Handler = (Callback) -> DataRequest` →
 * `Handler: "DataRequest"`. Read positionally, past `=` and then `->`.
 */
function swiftFunctionAliasReturns(node: AstNode): Record<string, string> | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;
  const out = createIdentifierRecord<string>();
  let any = false;
  for (const member of body.namedChildren) {
    if (member.type !== "typealias_declaration") continue;
    const alias = member.namedChildren.find((c) => c.type === "type_identifier")?.text;
    const aliased = swiftTypeNodeAfter(member, "=");
    if (alias === undefined || aliased?.type !== "function_type") continue;
    const returned = swiftTypeFactOf(swiftTypeNodeAfter(aliased, "->")).nominal;
    if (returned === null || SWIFT_UNUSABLE_RETURN_TYPES.has(returned)) continue;
    out[alias] = returned;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * An enum's payload-carrying cases, each slot's nominal type in position
 * order (bd tea-rags-mcp-y99pg.16). One `case a(X), b(Y)` entry declares
 * several cases, each name followed by its own parameter list. Slots are read
 * positionally — a slot's label is the `simple_identifier` beside it, never a
 * type — for the materialization hazard {@link swiftTypeNodeAfter} documents.
 */
function swiftEnumCasePayloads(node: AstNode): Record<string, (string | null)[]> | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;
  const cases = createIdentifierRecord<(string | null)[]>();
  let any = false;
  for (const entry of body.namedChildren) {
    if (entry.type !== "enum_entry") continue;
    let caseName: string | null = null;
    for (const child of entry.namedChildren) {
      if (child.type === "simple_identifier") caseName = child.text;
      else if (child.type === "enum_type_parameters" && caseName !== null) {
        cases[caseName] = child.namedChildren
          .filter((slot) => slot.type !== "simple_identifier" && slot.type !== "comment")
          .map((slot) => swiftTypeFactOf(slot).nominal);
        any = true;
      }
    }
  }
  return any ? cases : undefined;
}

/** A declaration's own generic parameter names: `class Protected<Value>` → `["Value"]`. */
function swiftTypeParameterNames(node: AstNode): string[] {
  const list = node.children.find((c) => c.type === "type_parameters");
  if (!list) return [];
  const names: string[] = [];
  for (const parameter of list.namedChildren) {
    if (parameter.type !== "type_parameter") continue;
    const identifier = parameter.namedChildren.find((c) => c.type === "type_identifier");
    if (identifier) names.push(identifier.text);
  }
  return names;
}

/**
 * What a type body says that a USE of the type in another file needs in
 * order to type a closure parameter (bd tea-rags-mcp-y99pg.13): the generic
 * arguments its stored properties are declared with, and the parameter types
 * of the one closure each of its methods takes. Both are read positionally —
 * `type_arguments` and `tuple_type_item` children, never fields — for the
 * materialization hazard {@link swiftTypeNodeAfter} documents.
 */
function swiftGenericMemberFacts(
  node: AstNode,
  genericParameters: readonly string[],
): {
  fieldTypeArguments?: Record<string, (string | null)[]>;
  fieldConstructions?: Record<string, SwiftFieldConstruction>;
  memberClosureParameters?: Record<string, (string | null)[] | null>;
  genericInitializers?: GenericInitializerFact[];
  genericFieldParameters?: Record<string, string>;
  closureResultMembers?: string[];
} {
  const body = node.childForFieldName("body");
  if (!body) return {};
  const fields = createIdentifierRecord<(string | null)[]>();
  const genericFields = createIdentifierRecord<string>();
  let anyGenericField = false;
  const constructions = createIdentifierRecord<SwiftFieldConstruction>();
  const closures = createIdentifierRecord<(string | null)[] | null>();
  const initializers: GenericInitializerFact[] = [];
  const closureResults = new Map<string, boolean>();
  let anyField = false;
  let anyConstruction = false;
  let anyClosure = false;
  for (const member of body.children) {
    if (member.type === "property_declaration") {
      const name = singleIdentifierPatternName(member.childForFieldName("name"));
      if (!name) continue;
      const annotation = member.children.find((c) => c.type === "type_annotation");
      const value = annotation ? null : member.childForFieldName("value");
      // `Protected<[T]>(…)` spells its arguments on the construction (bd tea-rags-mcp-y99pg.26).
      const typeNode = annotation
        ? swiftTypeNodeAfter(annotation, ":")
        : value?.type === "constructor_expression"
          ? (value.namedChildren.find((c) => c.type === "user_type") ?? null)
          : null;
      // `var value: Value` / `Value?` — typed by whatever a receiver binds the parameter to (bd tea-rags-mcp-y99pg.34).
      const unwrapped = typeNode?.type === "optional_type" ? (typeNode.namedChildren[0] ?? null) : typeNode;
      if (unwrapped?.type === "user_type" && genericParameters.includes(unwrapped.text.trim())) {
        genericFields[name] = unwrapped.text.trim();
        anyGenericField = true;
        continue;
      }
      const args = typeNode?.type === "user_type" ? typeNode.children.find((c) => c.type === "type_arguments") : null;
      if (args) {
        fields[name] = args.namedChildren.map((arg) => swiftTypeFactOf(arg).nominal);
        anyField = true;
        continue;
      }
      const construction = value ? swiftFieldConstruction(value) : null;
      if (construction) {
        constructions[name] = construction;
        anyConstruction = true;
      }
      continue;
    }
    if (member.type === "init_declaration") {
      const initializer = swiftGenericInitializer(member, genericParameters);
      if (initializer) initializers.push(initializer);
    } else if (member.type !== "function_declaration" && member.type !== "protocol_function_declaration") continue;
    // An initializer publishes under `init`, the member a construction's
    // closure is read off (bd tea-rags-mcp-y99pg.29).
    const name = member.type === "init_declaration" ? "init" : member.childForFieldName("name")?.text;
    if (name && member.type !== "init_declaration") {
      const returnsClosureResult = swiftReturnsClosureResult(member);
      closureResults.set(name, (closureResults.get(name) ?? true) && returnsClosureResult);
    }
    const types = name ? swiftClosureParameterTypeNames(member, genericParameters) : undefined;
    if (!name || types === undefined) continue;
    anyClosure = true;
    if (!Object.hasOwn(closures, name)) closures[name] = types;
    else if (!sameSwiftTypeNames(closures[name], types)) closures[name] = null;
  }
  const closureResultMembers = [...closureResults].filter(([, every]) => every).map(([name]) => name);
  return {
    ...(closureResultMembers.length > 0 ? { closureResultMembers } : {}),
    ...(anyField ? { fieldTypeArguments: fields } : {}),
    ...(anyConstruction ? { fieldConstructions: constructions } : {}),
    ...(anyClosure ? { memberClosureParameters: closures } : {}),
    ...(initializers.length > 0 ? { genericInitializers: initializers } : {}),
    ...(anyGenericField ? { genericFieldParameters: genericFields } : {}),
  };
}

/**
 * `Protected(State())` → the constructed type and each argument's label and
 * constructed nominal — null for anything but a CapWords construction with at
 * least one argument of known type (bd tea-rags-mcp-y99pg.26).
 */
function swiftFieldConstruction(value: AstNode): SwiftFieldConstruction | null {
  if (value.type !== "call_expression") return null;
  const callee = value.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type !== "simple_identifier" || !SWIFT_TYPE_NAME_TEXT.test(callee.text)) return null;
  const suffix = value.namedChildren.find((c) => c.type === "call_suffix");
  const list = suffix?.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
  const args: { label: string | null; type: string | null }[] = [];
  for (const arg of list) {
    if (arg.type !== "value_argument") continue;
    const label = arg.children.find((c) => c.type === "value_argument_label")?.text ?? null;
    const expression = arg.namedChildren.filter((c) => c.type !== "value_argument_label").at(-1) ?? null;
    args.push({ label, type: constructedTypeFact(expression).nominal });
  }
  return args.some((arg) => arg.type !== null) ? { type: callee.text, arguments: args } : null;
}

/**
 * An `init` whose parameters include one typed exactly as a generic parameter
 * of the enclosing type: its labels and what each position binds. Read
 * positionally, as every Swift parameter here.
 */
function swiftGenericInitializer(init: AstNode, genericParameters: readonly string[]): GenericInitializerFact | null {
  if (genericParameters.length === 0) return null;
  const labels: (string | null)[] = [];
  const binds: (string | null)[] = [];
  for (const parameter of init.children) {
    if (parameter.type !== "parameter") continue;
    const colon = parameter.children.findIndex((c) => c.type === ":");
    const names = parameter.children
      .slice(0, colon === -1 ? undefined : colon)
      .filter((c) => c.type === "simple_identifier")
      .map((c) => c.text);
    labels.push(names[0] === "_" ? null : (names[0] ?? null));
    const typeNode = swiftParameterTypeNode(parameter);
    const written = typeNode?.type === "user_type" ? typeNode.text.trim() : undefined;
    binds.push(written !== undefined && genericParameters.includes(written) ? written : null);
  }
  return binds.some((bound) => bound !== null) ? { labels, binds } : null;
}

/** Whether two overloads state the same closure parameter types; `null` (poisoned) equals nothing. */
function sameSwiftTypeNames(a: readonly (string | null)[] | null, b: readonly (string | null)[] | null): boolean {
  if (a === null) return false;
  if (b === null) return false;
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * The declared parameter types of the ONE function-typed parameter `fn`
 * takes that itself takes a parameter — `undefined` when it takes none,
 * `null` when it takes two or more.
 * A name the enclosing type declares as a generic parameter is kept as that
 * name, to be bound by a receiver's type arguments; a method's own generic
 * parameter reads as its constraint, or nothing.
 */
function swiftClosureParameterTypeNames(
  fn: AstNode,
  genericParameters: readonly string[],
): (string | null)[] | null | undefined {
  let found: (string | null)[] | null | undefined;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    const functionType = swiftFunctionTypeNode(swiftParameterTypeNode(parameter));
    if (!functionType) continue;
    const params = functionType.children.find((c) => c.type === "tuple_type");
    // A slot whose function takes nothing (`onTermination: (() -> Void)?`)
    // can never receive a closure that names a parameter, so it does not
    // compete for one (bd tea-rags-mcp-y99pg.29).
    if (!(params?.namedChildren ?? []).some((item) => item.type === "tuple_type_item")) continue;
    if (found !== undefined) return null;
    const types: (string | null)[] = [];
    for (const item of params?.namedChildren ?? []) {
      if (item.type !== "tuple_type_item") continue;
      const typeNode = item.namedChildren[item.namedChildCount - 1] ?? null;
      const written = typeNode?.type === "user_type" ? typeNode.text : undefined;
      if (written !== undefined && genericParameters.includes(written)) types.push(written);
      else {
        types.push(
          swiftSpelledWithArguments(
            swiftGenericResolvedFact(swiftTypeFactOf(typeNode), fn).nominal,
            typeNode,
            fn,
            genericParameters,
          ),
        );
      }
    }
    found = types;
  }
  return found;
}

/**
 * Whether `fn` returns exactly what its one value-taking closure returns: a
 * method generic `U` spelled as the declared return AND as that closure's
 * return — `func read<U>(_ closure: (Value) throws -> U) rethrows -> U` (bd
 * tea-rags-mcp-y99pg.37). Read positionally past `->`, for the materialization
 * hazard {@link swiftTypeNodeAfter} documents. A second function-typed
 * parameter, a wrapped `[U]` / `U?` return, or a closure taking nothing
 * disqualifies it.
 */
function swiftReturnsClosureResult(fn: AstNode): boolean {
  const generics = swiftTypeParameterNames(fn);
  if (generics.length === 0) return false;
  const returned = swiftTypeNodeAfter(fn, "->");
  if (returned?.type !== "user_type" || !generics.includes(returned.text.trim())) return false;
  let closure: AstNode | null = null;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    const functionType = swiftFunctionTypeNode(swiftParameterTypeNode(parameter));
    if (!functionType) continue;
    if (closure !== null) return false;
    closure = functionType;
  }
  if (closure === null) return false;
  const params = closure.children.find((c) => c.type === "tuple_type");
  if (!(params?.namedChildren ?? []).some((item) => item.type === "tuple_type_item")) return false;
  return swiftTypeNodeAfter(closure, "->")?.text.trim() === returned.text.trim();
}

/**
 * `nominal` spelled with the generic arguments `typeNode` states —
 * `Result<URLRequest, Error>` for `Result<URLRequest, any Error>` (bd
 * tea-rags-mcp-y99pg.32) — so a reader in another file can bind the
 * declaring SDK type's parameters (`Result.get()` returns `Success`). Each
 * argument is reduced to its nominal. The bare nominal when there are no
 * arguments, when one names nothing, or when one is a generic parameter in
 * scope: that is bound per use, not declared. Read positionally off
 * `type_arguments`, past an optional's `?`.
 */
function swiftSpelledWithArguments(
  nominal: string | null,
  typeNode: AstNode | null,
  at: AstNode,
  genericParameters: readonly string[],
): string | null {
  if (nominal === null) return null;
  let bare = typeNode;
  while (bare?.type === "optional_type") bare = bare.namedChildren[0] ?? null;
  if (bare?.type !== "user_type") return nominal;
  const args = bare.children.find((c) => c.type === "type_arguments")?.namedChildren ?? [];
  if (args.length === 0) return nominal;
  const names: string[] = [];
  for (const arg of args) {
    const name = swiftTypeFactOf(arg).nominal;
    if (name === null || genericParameters.includes(name) || swiftGenericConstraint(name, at) !== undefined) {
      return nominal;
    }
    names.push(name);
  }
  return `${nominal}<${names.join(", ")}>`;
}

/** `class` / `struct` / `enum` / `actor` / `extension` / `protocol`, or null for any other node. */
function swiftTypeDeclarationKind(node: AstNode): TypeDeclarationKind | "extension" | null {
  if (node.type === "protocol_declaration") return "protocol";
  if (node.type !== "class_declaration") return null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null || child.isNamed) continue;
    if (child.type === "extension") return "extension";
    const keyword = SWIFT_TYPE_DECLARATION_KEYWORDS.get(child.type);
    if (keyword !== undefined) return keyword;
  }
  return null;
}

/** A declared or extended type's name with any generic argument list dropped (`Box<T>` → `Box`). */
function swiftTypeNameText(text: string | undefined): string | undefined {
  const name = text?.split("<")[0]?.trim();
  return name !== undefined && name.length > 0 ? name : undefined;
}

/** Every inheritance specifier's type name, generic arguments dropped, in clause order. */
function swiftInheritedTypeNames(node: AstNode): string[] {
  const out: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "inheritance_specifier") continue;
    const name = swiftTypeNameText(child.text);
    if (name !== undefined) out.push(name);
  }
  return out;
}

/**
 * Every `func` this file declares with a usable return type, keyed by the
 * callee's OWN composed symbolId (`Store#load`, `Store.make`,
 * `Store.Inner#child`, `load~2` for a second overload) — the run-global
 * `structuredReturnTypes` channel (bd tea-rags-mcp-kkwg3).
 *
 * The resolver reads it one way only: it first resolves a call hop to the
 * declaration the call lands on — own type, then superclass — and then asks
 * what THAT symbol returns. So the key must be the symbolId the chunk carries,
 * overload suffix included, and it is taken from the chunk collected at the
 * declaration's own start line rather than recomposed here: two spellings of
 * one id are exactly the drift `symbolid-convention.md` exists to prevent.
 *
 * The value is read by the same {@link swiftDeclaredReturnFact} the file-local
 * call-result typing reads, so the two can never disagree about what a
 * signature says — including what it declines (`Void`, `Self`, a generic
 * parameter, an `[T]` return, which types no member).
 */
function collectSwiftStructuredReturnTypes(
  root: AstNode,
  chunks: readonly { symbolId: string; startLine: number }[],
): Record<string, TypeRef> {
  const idsByLine = new Map<number, string[]>();
  for (const chunk of chunks) {
    const ids = idsByLine.get(chunk.startLine);
    if (ids) ids.push(chunk.symbolId);
    else idsByLine.set(chunk.startLine, [chunk.symbolId]);
  }
  const out: Record<string, TypeRef> = createIdentifierRecord();
  walk(root, (node) => {
    if (node.type !== "function_declaration" && node.type !== "protocol_function_declaration") return;
    const name = node.childForFieldName("name")?.text;
    const nominal = name === undefined ? null : (swiftDeclaredReturnFact(node)?.nominal ?? swiftSelfReturnMarker(node));
    if (name === undefined || nominal === null) return;
    const symbolId = idsByLine.get(node.startPosition.row + 1)?.find((id) => composedIdNames(id, name));
    if (symbolId !== undefined) out[symbolId] = { form: "instance", name: nominal };
  });
  return out;
}

/**
 * chunk index → the argument-label signature of the `func` / `init` that chunk
 * IS, matched the way {@link collectSwiftStructuredReturnTypes} matches a
 * declaration to its chunk: same start line, final id segment naming it.
 */
function collectSwiftCallableSignatures(
  root: AstNode,
  chunks: readonly { symbolId: string; startLine: number }[],
): Map<number, SwiftCallableSignature> {
  const indicesByLine = new Map<number, number[]>();
  chunks.forEach((chunk, index) => {
    const at = indicesByLine.get(chunk.startLine);
    if (at) at.push(index);
    else indicesByLine.set(chunk.startLine, [index]);
  });
  const out = new Map<number, SwiftCallableSignature>();
  walk(root, (node) => {
    if (
      node.type !== "function_declaration" &&
      node.type !== "protocol_function_declaration" &&
      node.type !== "init_declaration"
    ) {
      return;
    }
    const name = node.type === "init_declaration" ? "init" : node.childForFieldName("name")?.text;
    if (name === undefined) return;
    const index = indicesByLine.get(node.startPosition.row + 1)?.find((i) => composedIdNames(chunks[i].symbolId, name));
    if (index !== undefined && !out.has(index)) out.set(index, swiftCallableSignature(node));
  });
  return out;
}

/** Whether a composed id's final segment is `name`, an overload suffix aside. */
function composedIdNames(symbolId: string, name: string): boolean {
  const base = symbolId.replace(OVERLOAD_SUFFIX, "");
  return base === name || base.endsWith(`#${name}`) || base.endsWith(`.${name}`);
}

/** The suffix `collectSymbols` appends to the 2nd and later declaration of one composed id. */
const OVERLOAD_SUFFIX = /~\d+$/;

/**
 * The declaration keywords `class_declaration` covers. tree-sitter-swift gives
 * all four the same node type, so the keyword token is the only evidence of
 * which one a node is — and only `class` can have a superclass: a `struct` and
 * an `enum` conform to protocols, and Swift forbids an `actor` from inheriting
 * at all.
 */
const SWIFT_TYPE_DECLARATION_KEYWORDS: ReadonlyMap<string, TypeDeclarationKind> = new Map(
  (["class", "struct", "enum", "actor"] as const).map((keyword) => [keyword, keyword]),
);

/**
 * `className → superclass`, for the `super` pass alone.
 *
 * Two narrowings make this sound, and dropping either one fabricates a
 * hierarchy. Only a `class` is recorded, because the other three keywords share
 * its node type while having no superclass — `enum Status: Int` names a RAW
 * VALUE type, and reading it as a base would send `super` into `Int`. And only
 * the FIRST `inheritance_specifier` is taken: the clause lists a superclass and
 * protocols identically, marking neither, and Swift's requirement that the
 * superclass come first is the whole of what distinguishes them.
 *
 * The known limit is a class that conforms to protocols WITHOUT subclassing
 * (`class Handler: Codable`): its first specifier is a protocol and is recorded
 * as if it were a base. That costs nothing today, because `super` is not
 * expressible in such a class — there is no superclass to call — so the entry
 * is unreachable rather than wrong-in-use. A future consumer that reads this
 * channel for anything but `super` must revisit it.
 */
function collectSwiftClassExtends(root: AstNode): Record<string, string> {
  const out: Record<string, string> = createIdentifierRecord();
  walk(root, (node) => {
    if (node.type !== "class_declaration") return;
    if (swiftDeclarationKeyword(node) !== "class") return;
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const base = swiftFirstInheritedTypeName(node);
    if (base !== null && base !== name) out[name] = base;
  });
  return out;
}

/**
 * Which keyword a `class_declaration` was spelled with, read off the ANONYMOUS
 * children — modifiers (`public final`) arrive as a named node, so the keyword
 * is not at a fixed index and is matched by value rather than by position.
 */
function swiftDeclarationKeyword(node: AstNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && !child.isNamed && SWIFT_TYPE_DECLARATION_KEYWORDS.has(child.type)) return child.type;
  }
  return null;
}

/** The first inherited type's NAME, with any generic argument list dropped (`Base<T>` → `Base`). */
function swiftFirstInheritedTypeName(node: AstNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type !== "inheritance_specifier") continue;
    const text = child.text.trim();
    const name = (text.split("<")[0] ?? text).trim();
    return name.length > 0 ? name : null;
  }
  return null;
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
    // `Protected<[T]>(…)`: a construction the grammar does not call a call.
    if (node.type === "constructor_expression") {
      const name = swiftConstructedGenericFact(node).nominal;
      const constructorSuffix = node.children.find((c) => c.type === "constructor_suffix");
      if (name && !name.includes(".")) {
        out.push({
          callText: node.text,
          receiver: null,
          member: name,
          startLine: node.startPosition.row + 1,
          ...(constructorSuffix ? swiftCallArguments(constructorSuffix) : {}),
        });
      }
      return;
    }
    if (node.type !== "call_expression") return;
    const suffix = node.children.find((c) => c.type === "call_suffix");
    // Bracketed suffix = subscript read (`items[i]`, `dict["k"]`), not a call.
    if (!suffix || suffix.text.startsWith("[")) return;
    const callee = node.namedChildren.find((c) => c !== suffix);
    if (!callee) return;
    const startLine = node.startPosition.row + 1;
    const signature = swiftCallArguments(suffix);
    if (callee.type === "simple_identifier") {
      // Invoking a closure VALUE calls no declared symbol (bd tea-rags-mcp-y99pg.8).
      if (node.children.some((c) => c.type === "?") || isSwiftLocalValueName(callee.text, node)) return;
      out.push({ callText: node.text, receiver: null, member: callee.text, startLine, ...signature });
      return;
    }
    if (callee.type !== "navigation_expression") return;
    const target = callee.childForFieldName("target");
    const member = callee.childForFieldName("suffix")?.childForFieldName("suffix");
    if (!target || !member) return;
    const targetText = swiftReceiverTargetText(target);
    const receiver = normalizeSwiftReceiver(targetText);
    // `a?.c()` puts its `?` beside the target, not inside it (bd tea-rags-mcp-y99pg.33).
    const written = callee.children.some((c) => c.type === "?") ? `${targetText}?` : targetText;
    out.push({
      callText: node.text,
      receiver,
      ...(written === receiver ? {} : { writtenReceiver: written }),
      member: member.text,
      startLine,
      ...signature,
    });
  });
  return out;
}

/**
 * Whether `name`, at `at`, names a VALUE the enclosing code declares — a
 * parameter of an enclosing function or closure, or a `let` / `var` an
 * enclosing block declares ABOVE `at` — rather than a function. Swift resolves
 * a bare name to the innermost declaration, so such a `name(...)` invokes the
 * value and calls no declared symbol. The walk stops at the enclosing type: a
 * stored property of closure type is indistinguishable from a method by name
 * here, and only the optional-call form (`name?(…)`) says which it is.
 */
function isSwiftLocalValueName(name: string, at: AstNode): boolean {
  const line = at.startPosition.row;
  for (let current = at.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") return false;
    if (SWIFT_FUNCTION_LIKE_NODES.has(current.type) && declaresSwiftParameter(current, name)) return true;
    if (current.type === "lambda_literal") {
      const params = swiftLambdaParameters(current) ?? [];
      if (params.some((p) => p.childForFieldName("name")?.text === name)) return true;
    }
    if (current.type === "statements") {
      for (const statement of current.children) {
        if (statement.startPosition.row >= line) break;
        if (
          statement.type === "property_declaration" &&
          singleIdentifierPatternName(statement.childForFieldName("name")) === name
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Whether a function-like declaration takes a parameter whose INTERNAL name is `name`. */
function declaresSwiftParameter(fn: AstNode, name: string): boolean {
  return fn.children.some((parameter) => {
    if (parameter.type !== "parameter") return false;
    const colon = parameter.children.findIndex((c) => c.type === ":");
    const names = parameter.children.slice(0, colon === -1 ? undefined : colon);
    const internal = names.filter((c) => c.type === "simple_identifier").pop();
    return internal?.text === name;
  });
}

/**
 * Strip optional-chaining `?` and force-unwrap `!` out of a receiver's source
 * text: `obj!` → `obj`, `a?.b!` → `a.b`, `self.db` unchanged. The resolver
 * matches a receiver against `localBindings` keys and `classFieldTypes` field
 * names, neither of which carries the sugar, so an un-normalized receiver never
 * matches.
 */
/**
 * A call target's text without the prefix operator the grammar hangs on it
 * (bd tea-rags-mcp-y99pg.39). tree-sitter-swift parses `!kept.contains(id)`
 * with `!kept` as the navigation target, but Swift binds a prefix operator
 * looser than member access and call: the expression is `!(kept.contains(id))`
 * and the receiver is `kept`. The operator sits on the leftmost spine of the
 * target, however deep (`!a!.b.c()`). An implicit member expression's leading
 * `.` (`.quaternary.opacity(1)`) is part of the receiver and stays.
 */
function swiftReceiverTargetText(target: AstNode): string {
  let node: AstNode | null = target;
  while (node !== null && node.startIndex === target.startIndex) {
    if (node.type === "prefix_expression") {
      const operation = node.childForFieldName("operation");
      const operand = node.childForFieldName("target");
      if (operation !== null && operand !== null && operation.text !== ".") {
        return target.text.slice(operand.startIndex - target.startIndex);
      }
    }
    node = node.child(0);
  }
  return target.text;
}

export function normalizeSwiftReceiver(text: string): string {
  return text.replace(/[?!]/g, "");
}

/**
 * What a Swift type node PROVES about a value, in two separate slots.
 *
 * `nominal` is the type the value itself has and is the only slot anything
 * emits. `element` is the type of what the value CONTAINS — set for `[T]` and
 * nothing else — and exists so `for x in xs` can type `x` without ever letting
 * `xs` be typed as a `T`. Keeping them apart is what makes the container rule
 * structural: a caller that wants a receiver type reads `nominal` and gets
 * `Array` for an array, whatever the element is.
 */
interface SwiftTypeFact {
  readonly nominal: string | null;
  readonly element: string | null;
  /**
   * A `Dictionary`'s key and value nominals, for a `for (key, value) in`
   * over it (bd tea-rags-mcp-y99pg.17). Absent on every other fact.
   */
  readonly entry?: readonly [string | null, string | null];
}

const NO_TYPE: SwiftTypeFact = { nominal: null, element: null };

/** Names a binding must never be recorded under — each is claimed by a chain pass of its own. */
const SWIFT_PSEUDO_BINDING_NAMES: ReadonlySet<string> = new Set(["self", "Self", "super"]);

/** The `structuredReturnTypes` marker a `-> Self` return publishes (bd tea-rags-mcp-y99pg.18). */
const SWIFT_SELF_RETURN = "Self";

/**
 * Return types that name nothing the symbol table can hold. `Self` is the
 * conforming type, unknowable at the declaration (the run-global channel
 * publishes it as {@link SWIFT_SELF_RETURN} for the resolver to substitute);
 * the other four are universal or empty and carry no member a call could land
 * on.
 */
const SWIFT_UNUSABLE_RETURN_TYPES: ReadonlySet<string> = new Set(["Self", "Any", "AnyObject", "Never", "Void"]);

/** Nodes that open a value scope — the ancestor a `guard let` binding stays alive to the end of. */
const SWIFT_BLOCK_NODES: ReadonlySet<string> = new Set([
  "statements",
  "function_body",
  "class_body",
  "enum_class_body",
  "protocol_body",
  "source_file",
]);

/**
 * Declarations that own their own local names. Two bindings of one name in two
 * methods of the same type are different variables, so an identifier lookup is
 * confined to the bindings whose nearest such ancestor is the SAME node.
 *
 * `lambda_literal` is deliberately absent: a closure CAPTURES its enclosing
 * function's locals, so a `guard let` inside one must still see them.
 */
const SWIFT_FUNCTION_LIKE_NODES: ReadonlySet<string> = new Set([
  "function_declaration",
  "protocol_function_declaration",
  "init_declaration",
  "deinit_declaration",
  "subscript_declaration",
  "computed_property",
]);

/**
 * Everything this file declares about types, gathered in ONE walk before any
 * binding is typed.
 *
 * File-local by construction. A walker resolves nothing, so the only callee
 * whose return type it may read is one this file declares, and the only
 * property whose type it may read is one this file's type body declares — which
 * is also exactly what `classFieldTypes` publishes.
 */
interface SwiftFileTypeEvidence {
  /**
   * `typeName → propertyName → fact`, the fact-valued source of
   * `classFieldTypes`, keyed by nesting path AND by short name
   * ({@link swiftPropertyTypeViews}).
   */
  readonly propertyTypes: Map<string, Map<string, SwiftTypeFact>>;
  /**
   * `returnKey(owner, funcName) → fact`, or `null` where two declarations of
   * that coordinate disagree and the name is therefore unusable.
   */
  readonly returnTypes: Map<string, SwiftTypeFact | null>;
  /**
   * `returnKey(owner, funcName) → positional parameter facts` of the ONE
   * function-typed parameter that declaration takes — what a closure passed to
   * it binds `$0`, `$1`, … or its named parameters to (bd
   * tea-rags-mcp-y99pg.3). `null` where two declarations of the coordinate
   * disagree, or where one declaration takes two function-typed parameters and
   * which one a closure lands on is a label question.
   */
  readonly closureParameters: Map<string, readonly SwiftTypeFact[] | null>;
  /**
   * `returnKey(owner, funcName) → the argument` whose `Type.self` value names
   * what a generic return is (`as type: R.Type` → `-> R`), `null` where two
   * declarations disagree. Read before `returnTypes`, which holds only the
   * return's constraint.
   */
  readonly metatypeReturns: Map<string, SwiftMetatypeSlot | null>;
}

/** Which argument of a call binds a generic return: by label, or by position when unlabelled. */
interface SwiftMetatypeSlot {
  readonly label: string | null;
  readonly index: number;
}

/**
 * Sequence methods whose closure receives the ELEMENT — one parameter, or two
 * for the comparators. Read only off an `element` fact, which only an `[T]`
 * type produces, so a project type's own namesake method is never re-read as a
 * collection's.
 */
const SWIFT_ELEMENT_CLOSURE_ARITY: ReadonlyMap<string, number> = new Map([
  ["forEach", 1],
  ["map", 1],
  ["compactMap", 1],
  ["flatMap", 1],
  ["filter", 1],
  ["first", 1],
  ["last", 1],
  ["contains", 1],
  ["allSatisfy", 1],
  ["firstIndex", 1],
  ["lastIndex", 1],
  ["drop", 1],
  ["prefix", 1],
  ["removeAll", 1],
  ["sorted", 2],
  ["sort", 2],
  ["min", 2],
  ["max", 2],
]);

/** Key a declared return under its owning type (`null` = top level) plus its name. */
function returnKey(owner: string | null, name: string): string {
  return `${owner ?? ""}\u0000${name}`;
}

/**
 * Collect the file's property types and declared return types.
 *
 * Properties are gathered per nominal type body exactly as the published
 * `classFieldTypes` needs them — `class_declaration` covers class / struct /
 * enum / extension / actor, `protocol_declaration` its requirements — and
 * computed properties count: `var total: Money { … }` still HAS type `Money`,
 * and a call on it dispatches on `Money` as a stored one does. An extension
 * body declares no stored properties (Swift forbids them), so it contributes
 * only computed ones and cannot collide with the type's own entry.
 *
 * Return types are gathered per `func`, keyed by the enclosing type so a
 * member beats a top-level namesake at lookup time without either erasing the
 * other. A coordinate two declarations disagree on is poisoned to `null`.
 */
function collectSwiftFileTypeEvidence(root: AstNode): SwiftFileTypeEvidence {
  const propertyTypesByPath = new Map<string, SwiftTypePropertyFacts>();
  const returnTypes = new Map<string, SwiftTypeFact | null>();
  const closureParameters = new Map<string, readonly SwiftTypeFact[] | null>();
  const metatypeReturns = new Map<string, SwiftMetatypeSlot | null>();
  walk(root, (node) => {
    if (node.type === "class_declaration" || node.type === "protocol_declaration") {
      collectSwiftPropertyTypes(node, propertyTypesByPath);
      return;
    }
    if (node.type !== "function_declaration" && node.type !== "protocol_function_declaration") return;
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const key = returnKey(enclosingSwiftTypeName(node), name);
    const closure = swiftClosureParameterFacts(node);
    if (closure !== undefined) {
      const seen = closureParameters.get(key);
      if (seen === undefined) closureParameters.set(key, closure);
      else if (!sameSwiftFacts(seen, closure)) closureParameters.set(key, null);
    }
    const slot = swiftMetatypeReturnSlot(node);
    if (slot !== undefined) {
      const seen = metatypeReturns.get(key);
      if (seen === undefined) metatypeReturns.set(key, slot);
      else if (seen?.label !== slot.label || seen.index !== slot.index) metatypeReturns.set(key, null);
    }
    const fact = swiftDeclaredReturnFact(node);
    if (!fact) return;
    const previous = returnTypes.get(key);
    if (previous === undefined) returnTypes.set(key, fact);
    // `previous === null` is the poisoned marker, and optional access keeps it poisoned.
    else if (previous?.nominal !== fact.nominal || previous?.element !== fact.element) returnTypes.set(key, null);
  });
  return {
    propertyTypes: swiftPropertyTypeViews(propertyTypesByPath),
    returnTypes,
    closureParameters,
    metatypeReturns,
  };
}

/** Whether two positional fact lists state the same types; `null` (poisoned) equals nothing. */
function sameSwiftFacts(a: readonly SwiftTypeFact[] | null, b: readonly SwiftTypeFact[] | null): boolean {
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((fact, i) => fact.nominal === b[i].nominal && fact.element === b[i].element);
}

/**
 * The positional parameter facts of the ONE function-typed parameter a
 * declaration takes: `undefined` when it takes none, `null` when it takes two
 * or more. A name that is a generic parameter of the declaration or of its
 * enclosing type (`(inout Value) -> U` on `Protected<Value>`) proves nothing —
 * it is bound per use, not declared.
 */
function swiftClosureParameterFacts(fn: AstNode): readonly SwiftTypeFact[] | null | undefined {
  let found: readonly SwiftTypeFact[] | null | undefined;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    const functionType = swiftFunctionTypeNode(swiftParameterTypeNode(parameter));
    if (!functionType) continue;
    if (found !== undefined) return null;
    const params = functionType.children.find((c) => c.type === "tuple_type");
    const facts: SwiftTypeFact[] = [];
    for (const item of params?.namedChildren ?? []) {
      if (item.type !== "tuple_type_item") continue;
      facts.push(swiftGenericResolvedFact(swiftTypeFactOf(item.namedChildren[item.namedChildCount - 1] ?? null), fn));
    }
    found = facts;
  }
  return found;
}

/**
 * Where a generic return is bound by a METATYPE argument —
 * `func request<R: Request>(for: …, as type: R.Type) -> R?` returns whatever
 * type the `as:` argument names. The slot is the argument's label, or its
 * position when the parameter has none; `undefined` when the return is not
 * the declaration's own generic parameter or no parameter carries `R.Type`.
 */
function swiftMetatypeReturnSlot(fn: AstNode): SwiftMetatypeSlot | undefined {
  const returned = swiftTypeFactOf(swiftTypeNodeAfter(fn, "->")).nominal;
  if (!returned || !declaresSwiftTypeParameter(fn, returned)) return undefined;
  let index = 0;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    if (swiftParameterTypeNode(parameter)?.text === `${returned}.Type`) {
      const names = parameter.children.filter((c) => c.type === "simple_identifier").map((c) => c.text);
      const label = names.length > 1 ? names[0] : (names[0] ?? "_");
      return { label: label === "_" ? null : label, index };
    }
    index += 1;
  }
  return undefined;
}

/**
 * The type a call's metatype argument names — `DataRequest` for
 * `request(for: task, as: DataRequest.self)` — or null when the argument is
 * not a `Type.self` literal.
 */
function swiftMetatypeArgumentType(suffix: AstNode, slot: SwiftMetatypeSlot): string | null {
  const args = suffix.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
  const values = args.filter((a) => a.type === "value_argument");
  const labelOf = (arg: AstNode): string | null =>
    arg.children.find((c) => c.type === "value_argument_label")?.text ?? null;
  const arg = slot.label === null ? values[slot.index] : values.find((a) => labelOf(a) === slot.label);
  const value = arg?.namedChildren[arg.namedChildCount - 1];
  if (value?.type !== "navigation_expression") return null;
  if (value.childForFieldName("suffix")?.childForFieldName("suffix")?.text !== "self") return null;
  const typeText = value.childForFieldName("target")?.text;
  return typeText !== undefined && /^_*[A-Z][\w.]*$/.test(typeText) ? typeText : null;
}

/** Declarations whose `type_parameters` and `where` clause scope a generic name over their subtree. */
const SWIFT_GENERIC_SCOPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "protocol_function_declaration",
  "init_declaration",
  "subscript_declaration",
  "class_declaration",
]);

/**
 * What a generic parameter NAME stands for at `at`: `undefined` when no
 * enclosing declaration declares it (so it is a real type name), else the
 * nominal of its conformance constraint — inline (`<R: Request>`) or in a
 * `where` clause (`where T: Authenticator`) — or null when unconstrained.
 *
 * A call on a value of a constrained generic type dispatches on the
 * constraint's requirement, which is the declaration the typechecker binds, so
 * the constraint IS the receiver type for member lookup. The nearest declaring
 * scope wins, which is Swift's own shadowing.
 */
function swiftGenericConstraint(name: string, at: AstNode): string | null | undefined {
  for (let current: AstNode | null = at; current; current = current.parent) {
    if (!SWIFT_GENERIC_SCOPES.has(current.type)) continue;
    const declared = current.children
      .find((c) => c.type === "type_parameters")
      ?.namedChildren.find((p) => p.type === "type_parameter" && p.namedChildren[0]?.text === name);
    if (!declared) continue;
    if (declared.namedChildCount > 1) return swiftTypeFactOf(declared.namedChildren[1]).nominal;
    for (const clause of current.children) {
      if (clause.type !== "type_constraints") continue;
      for (const constraint of clause.namedChildren) {
        const inheritance = constraint.namedChildren.find((c) => c.type === "inheritance_constraint");
        if (inheritance?.namedChildren[0]?.text !== name) continue;
        return swiftTypeFactOf(inheritance.namedChildren[inheritance.namedChildCount - 1]).nominal;
      }
    }
    return null;
  }
  return undefined;
}

/**
 * A fact with every generic parameter name replaced by its constraint
 * ({@link swiftGenericConstraint}). A member of a generic parameter
 * (`Serializer.SerializedObject`, an associated type) proves nothing.
 */
function swiftGenericResolvedFact(fact: SwiftTypeFact, at: AstNode): SwiftTypeFact {
  const resolve = (name: string | null): string | null => {
    if (name === null) return null;
    const head = name.split(".")[0];
    const constraint = swiftGenericConstraint(head, at);
    if (constraint === undefined) return name;
    return head === name ? constraint : null;
  };
  const nominal = resolve(fact.nominal);
  const element = resolve(fact.element);
  return nominal === fact.nominal && element === fact.element ? fact : { nominal, element };
}

/**
 * The evidence a CALL reads from a table keyed by {@link returnKey}, in
 * Swift's lookup order: a bare callee on the enclosing type, then at the top
 * level; a qualified one on whatever its receiver types to.
 */
function swiftCalleeEvidence<T>(
  callee: AstNode,
  table: ReadonlyMap<string, T>,
  scope: SwiftTypeScope,
  depth: number,
): T | undefined {
  if (callee.type === "simple_identifier") {
    const own = table.get(returnKey(scope.site.enclosingType, callee.text));
    return own !== undefined ? own : table.get(returnKey(null, callee.text));
  }
  if (callee.type !== "navigation_expression") return undefined;
  const member = callee.childForFieldName("suffix")?.childForFieldName("suffix");
  const owner = swiftReceiverTypeName(callee.childForFieldName("target"), scope, depth);
  return member && owner ? table.get(returnKey(owner, member.text)) : undefined;
}

/**
 * The type node of a `parameter`, past any `type_modifiers` (`@escaping`,
 * `@Sendable`) — which tree-sitter-swift places between the `:` and the type.
 */
function swiftParameterTypeNode(parameter: AstNode): AstNode | null {
  const at = parameter.children.findIndex((c) => c.type === ":");
  if (at === -1) return null;
  for (let i = at + 1; i < parameter.children.length; i++) {
    const child = parameter.children[i];
    // `@escaping` alone parses as `parameter_modifiers`, with `@Sendable` as `type_modifiers`.
    if (child.type !== "type_modifiers" && child.type !== "parameter_modifiers") return child;
  }
  return null;
}

/** A callable's argument-label signature, in the shape `SymbolDefinition` persists. */
interface SwiftCallableSignature {
  readonly arity: AritySignature;
  readonly kwargs: KwargSignature;
  readonly acceptsBlock: boolean;
}

/**
 * The argument-label signature of a `func` / `init` (bd tea-rags-mcp-y99pg.7),
 * mapped onto the kernel's call-compatibility axes: a LABELLED parameter is a
 * keyword (`kwargs`), an unlabelled (`_`) one a positional slot (`arity`), and
 * whether a trailing closure can land on it (`acceptsBlock`).
 *
 * Whether a parameter can take a closure is three-valued
 * ({@link swiftClosureCapability}), because a closure type is very often
 * spelled through a typealias (`closure: @escaping ProgressHandler`,
 * `_ closure: QuickConfigurer`) that no file-local read can expand. A PROVEN
 * closure parameter is never required on either axis — a trailing closure may
 * satisfy it without its label or its position — and neither is a defaulted
 * or variadic one. A POSSIBLE one stays required, and the resolver lets a
 * trailing closure stand in for one missing requirement. `acceptsBlock` is
 * false only when no parameter can take a closure. A single parameter name is
 * both label and local name, which is Swift's rule for every declaration here.
 */
function swiftCallableSignature(fn: AstNode): SwiftCallableSignature {
  const required: string[] = [];
  const optional: string[] = [];
  let minRequired = 0;
  let maxPositional = 0;
  let hasSplat = false;
  let acceptsBlock = false;
  fn.children.forEach((parameter, i) => {
    if (parameter.type !== "parameter") return;
    const colon = parameter.children.findIndex((c) => c.type === ":");
    const names = parameter.children
      .slice(0, colon === -1 ? undefined : colon)
      .filter((c) => c.type === "simple_identifier")
      .map((c) => c.text);
    const label = names[0] === "_" ? null : (names[0] ?? null);
    const capability = swiftClosureCapability(parameter, fn);
    const variadic = parameter.children.some((c) => c.type === "...");
    const defaulted = fn.children[i + 1]?.type === "=";
    const mandatory = capability !== "yes" && !variadic && !defaulted;
    if (capability !== "no") acceptsBlock = true;
    if (label !== null) {
      (mandatory ? required : optional).push(label);
      return;
    }
    maxPositional += 1;
    if (variadic) hasSplat = true;
    if (mandatory) minRequired += 1;
  });
  return {
    arity: { minRequired, maxPositional, hasSplat },
    kwargs: { required, optional, hasSplat: false },
    acceptsBlock,
  };
}

/** Value types a closure is never spelled as — the common non-closure parameter types. */
const SWIFT_NON_CLOSURE_TYPES: ReadonlySet<string> = new Set([
  "String",
  "Substring",
  "Character",
  "Int",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "UInt",
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "Double",
  "Float",
  "CGFloat",
  "Bool",
  "Data",
  "Date",
  "URL",
  "UUID",
  "TimeInterval",
  "DispatchQueue",
  "OperationQueue",
]);

/**
 * Whether a parameter can take a closure: `yes` for a function type or an
 * `@escaping` / `@Sendable` one (only a closure carries those), `no` for an
 * `@autoclosure` one and for a type that is provably not a function — an array,
 * dictionary, real tuple or metatype, a protocol-constrained generic
 * parameter (a function type conforms to no protocol), or a common value
 * type — and `maybe` for any other name, which may be a closure typealias.
 */
function swiftClosureCapability(parameter: AstNode, fn: AstNode): "yes" | "no" | "maybe" {
  const modifiers = parameter.children.filter((c) => c.type === "type_modifiers" || c.type === "parameter_modifiers");
  // `@autoclosure` wraps the argument EXPRESSION; a closure literal written
  // there is the value itself, so no trailing closure lands on it — checked
  // first, since its spelled type IS a function type (bd tea-rags-mcp-y99pg.36).
  if (modifiers.some((c) => /@autoclosure\b/.test(c.text))) return "no";
  const typeNode = swiftParameterTypeNode(parameter);
  if (swiftFunctionTypeNode(typeNode) !== null) return "yes";
  const attributed = modifiers.some((c) => /@(escaping|Sendable)\b/.test(c.text));
  if (attributed) return "yes";
  let bare = typeNode;
  while (bare?.type === "optional_type") bare = bare.namedChildren[0] ?? null;
  if (!bare) return "maybe";
  if (bare.type === "array_type" || bare.type === "dictionary_type" || bare.type === "metatype") return "no";
  if (bare.type === "tuple_type" && parenthesizedSwiftTypeNode(bare) === null) return "no";
  if (bare.type !== "user_type") return "maybe";
  const name = bare.text.replace(/<[\s\S]*$/, "");
  if (name.endsWith(".Type") || SWIFT_NON_CLOSURE_TYPES.has(name)) return "no";
  const constraint = swiftGenericConstraint(name, fn);
  return constraint !== undefined && constraint !== null ? "no" : "maybe";
}

/**
 * What a call writes, on the same axes: its labels, its unlabelled argument
 * count and whether a trailing closure follows the parentheses.
 */
function swiftCallArguments(suffix: AstNode): Pick<CallRef, "argCount" | "kwargKeys" | "passesBlock"> {
  const args = suffix.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
  const kwargKeys: string[] = [];
  let argCount = 0;
  for (const arg of args) {
    if (arg.type !== "value_argument") continue;
    const label = arg.children.find((c) => c.type === "value_argument_label")?.text;
    if (label === undefined) argCount += 1;
    else kwargKeys.push(label);
  }
  return { argCount, kwargKeys, passesBlock: suffix.children.some((c) => c.type === "lambda_literal") };
}

/** A `function_type` node, looking through `?` and parentheses: `((T) -> Void)?`. */
function swiftFunctionTypeNode(typeNode: AstNode | null): AstNode | null {
  if (!typeNode) return null;
  if (typeNode.type === "function_type") return typeNode;
  if (typeNode.type === "optional_type") return swiftFunctionTypeNode(typeNode.namedChildren[0] ?? null);
  if (typeNode.type === "tuple_type") return swiftFunctionTypeNode(parenthesizedSwiftTypeNode(typeNode));
  return null;
}

/**
 * The positional facts a closure literal's parameters take from the call it
 * is an argument of — trailing or parenthesized — or null when nothing proves
 * them.
 *
 * Two sources, both declarations: the callee's ONE function-typed parameter
 * when this file declares the callee (same lookup order as
 * {@link swiftCallResultFact}), and the ELEMENT of an `[T]` receiver for a
 * sequence method (`xs.forEach { $0… }`).
 */
function swiftClosureArgumentFacts(lambda: AstNode, scope: SwiftTypeScope): readonly SwiftTypeFact[] | null {
  let suffix = lambda.parent;
  if (suffix?.type === "value_argument") suffix = suffix.parent?.parent ?? null;
  if (suffix?.type !== "call_suffix") return null;
  const call = suffix.parent;
  if (call?.type !== "call_expression") return null;
  const callee = call.namedChildren.find((c) => c.type !== "call_suffix");
  if (!callee) return null;
  if (callee.type === "navigation_expression") {
    const member = callee.childForFieldName("suffix")?.childForFieldName("suffix")?.text;
    const target = callee.childForFieldName("target");
    const element = target ? swiftExpressionFact(target, scope, 0).element : null;
    const arity = member === undefined ? undefined : SWIFT_ELEMENT_CLOSURE_ARITY.get(member);
    if (element && arity !== undefined) {
      return Array.from({ length: arity }, () => ({ nominal: element, element: null }));
    }
  }
  return swiftCalleeEvidence(callee, scope.evidence.closureParameters, scope, 0) ?? null;
}

/**
 * The SPELLING of the callee a closure literal is passed to — `mutableState.write`
 * for `mutableState.write { … }`, `withCheckedContinuation` for a BARE callee
 * (bd tea-rags-mcp-y99pg.29) — or undefined when the callee is neither a member
 * access on a value chain the resolver can fold nor a bare name.
 *
 * Only the call's LAST closure is spelled: the resolver reads the callee's
 * last function-typed parameter, the one a trailing closure fills, so an
 * earlier closure of `handle { … } onCancel: { … }` would be typed by the
 * wrong parameter.
 */
function swiftClosureCalleeSpelling(lambda: AstNode): string | undefined {
  let suffix = lambda.parent;
  if (suffix?.type === "value_argument") suffix = suffix.parent?.parent ?? null;
  if (suffix?.type !== "call_suffix" && suffix?.type !== "constructor_suffix") return undefined;
  const call = suffix.parent;
  if (call?.type !== "call_expression" && call?.type !== "constructor_expression") return undefined;
  if (lastClosureArgument(suffix)?.startIndex !== lambda.startIndex) return undefined;
  // `StreamOf<T>(…) { … }` — an explicitly specialised construction — is spelled
  // by its type, generic arguments dropped: the resolver reads the type's `init`.
  if (call.type === "constructor_expression") {
    // Positional, not `constructed_type`: see the materialization hazard {@link swiftTypeNodeAfter} documents.
    const typeNode = call.namedChildren.find((c) => c.type === "user_type");
    const constructed = typeNode?.text.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, "");
    return constructed !== undefined && SWIFT_TYPE_NAME_TEXT.test(constructed) && /^[\w.]+$/.test(constructed)
      ? constructed
      : undefined;
  }
  const callee = call.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type === "simple_identifier") return callee.text;
  if (callee?.type !== "navigation_expression") return undefined;
  const member = callee.childForFieldName("suffix")?.childForFieldName("suffix")?.text;
  const targetNode = callee.childForFieldName("target");
  const target = swiftValueChainSpelling(targetNode) ?? swiftConstructionSpelling(targetNode);
  return member && target ? `${target}.${member}` : undefined;
}

/** The last closure literal a call passes — parenthesized or trailing — or undefined. */
function lastClosureArgument(suffix: AstNode): AstNode | undefined {
  let last: AstNode | undefined;
  for (const child of suffix.children) {
    if (child.type === "lambda_literal") last = child;
    else if (child.type === "value_arguments") {
      for (const argument of child.namedChildren) {
        const value = argument.type === "value_argument" ? argument.namedChildren.at(-1) : undefined;
        if (value?.type === "lambda_literal") last = value;
      }
    }
  }
  return last;
}

/**
 * A construction written as a closure's receiver — `Result { try … }` in
 * `Result { try … }.mapError { $0 … }` — spelled WHOLE, arguments and all,
 * since the resolver types a construction head by the type it names and the
 * generic arguments it spells (bd tea-rags-mcp-y99pg.31). Only an
 * UpperCamelCase callee is a construction; `make(1).then { … }` is a call
 * whose value no spelling here can carry.
 */
function swiftConstructionSpelling(node: AstNode | null): string | undefined {
  if (node?.type !== "call_expression") return undefined;
  const callee = node.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type !== "simple_identifier" || !/^_*[A-Z]/.test(callee.text)) return undefined;
  return node.text;
}

/** How many `$n` parameters a closure's own body reads: one past the highest `n`. */
function swiftImplicitParameterCount(lambda: AstNode): number {
  let count = 0;
  for (const match of lambda.text.matchAll(/\$(\d+)/g)) count = Math.max(count, Number(match[1]) + 1);
  return count;
}

/** The `lambda_parameter` nodes a closure literal names, or null when it uses `$0`-style ones. */
function swiftLambdaParameters(lambda: AstNode): AstNode[] | null {
  const signature = lambda.children.find((c) => c.type === "lambda_function_type");
  if (!signature) return null;
  const list = signature.children.find((c) => c.type === "lambda_function_type_parameters");
  return list ? list.children.filter((c) => c.type === "lambda_parameter") : [];
}

/**
 * Whether a closure body nests an implicit-parameter closure. Such a closure
 * re-binds `$0` for its own body, and one this walker cannot type would
 * otherwise see the OUTER `$0`'s type, since a binding here is scoped by line.
 */
function nestsImplicitParameterClosure(lambda: AstNode): boolean {
  let nested = false;
  const visit = (node: AstNode): void => {
    for (const child of node.children) {
      if (nested) return;
      if (child.type === "lambda_literal" && swiftLambdaParameters(child) === null) nested = true;
      else visit(child);
    }
  };
  visit(lambda);
  return nested;
}

/** One type declaration's property facts, under the path it is nested at. */
interface SwiftTypePropertyFacts {
  /** The declaration's own name text — what the short-name view keys it by. */
  readonly name: string;
  readonly fields: Map<string, SwiftTypeFact>;
}

/**
 * One nominal type body's `propertyName → fact` entries, merged into the file
 * map under its NESTING PATH (`DownloadResponsePublisher.Inner`) — the
 * enclosing types' names outward-in, then its own. A same-path re-opening (a
 * same-file extension) merges into the same entry, first writer kept.
 */
function collectSwiftPropertyTypes(node: AstNode, into: Map<string, SwiftTypePropertyFacts>): void {
  const name = node.childForFieldName("name");
  const body = node.childForFieldName("body");
  if (!name || !body) return;
  const path = swiftNestingPath(node);
  for (const member of body.children) {
    if (member.type !== "property_declaration" && member.type !== "protocol_property_declaration") continue;
    const fieldName =
      member.type === "property_declaration"
        ? singleIdentifierPatternName(member.childForFieldName("name"))
        : protocolRequirementName(member);
    const fact = swiftDeclaredPropertyFact(member);
    if (!fieldName || (!fact.nominal && !fact.element)) continue;
    let entry = into.get(path);
    if (!entry) {
      entry = { name: name.text, fields: new Map<string, SwiftTypeFact>() };
      into.set(path, entry);
    }
    if (!entry.fields.has(fieldName)) entry.fields.set(fieldName, fact);
  }
}

/**
 * The file's property facts keyed BOTH ways a reader asks (bd
 * tea-rags-mcp-y99pg.36): by nesting path, and by the short name text every
 * pre-path reader — and every type-name spelling a receiver fold produces —
 * keys a type by.
 *
 * A short name several nested types share (Alamofire's Combine.swift nests an
 * `Inner` in each of three publishers) used to take the first body's fields,
 * so `request` typed `DataRequest` inside `DownloadResponsePublisher.Inner`.
 * The short entry is now:
 *
 *   - a declaration whose path IS its name (top-level, or an extension
 *     spelled `extension A.B`) speaks for it alone — nothing nested under a
 *     namesake reaches it;
 *   - otherwise the nested namesakes' union, keeping only the fields every
 *     namesake declaring them agrees on. A disagreement names no type, and a
 *     reader that can tell the namesakes apart reads the path key instead.
 */
function swiftPropertyTypeViews(
  byPath: ReadonlyMap<string, SwiftTypePropertyFacts>,
): Map<string, Map<string, SwiftTypeFact>> {
  const out = new Map<string, Map<string, SwiftTypeFact>>();
  const pathsByName = new Map<string, string[]>();
  for (const [path, entry] of byPath) {
    out.set(path, entry.fields);
    const paths = pathsByName.get(entry.name) ?? [];
    paths.push(path);
    pathsByName.set(entry.name, paths);
  }
  for (const [name, paths] of pathsByName) {
    if (out.has(name)) continue;
    const merged = new Map<string, SwiftTypeFact>();
    const poisoned = new Set<string>();
    for (const path of paths) {
      for (const [field, fact] of byPath.get(path)?.fields ?? []) {
        const seen = merged.get(field);
        if (seen === undefined) merged.set(field, fact);
        else if (seen.nominal !== fact.nominal || seen.element !== fact.element) poisoned.add(field);
      }
    }
    for (const field of poisoned) merged.delete(field);
    if (merged.size > 0) out.set(name, merged);
  }
  return out;
}

/** A type declaration's nesting path: the enclosing types' names outward-in, then its own. */
function swiftNestingPath(declaration: AstNode): string {
  const own = declaration.childForFieldName("name")?.text ?? "";
  const outer = enclosingSwiftTypePath(declaration);
  return outer === null ? own : `${outer}.${own}`;
}

/** The nesting path of the type declaration enclosing `node`, or null at file scope. */
function enclosingSwiftTypePath(node: AstNode): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") {
      return current.childForFieldName("name") ? swiftNestingPath(current) : null;
    }
  }
  return null;
}

/**
 * The name a protocol property requirement (`var manager: Manager { get }`)
 * declares. Its `pattern` carries the `var` keyword's binding pattern BESIDE
 * the name, so the one-identifier read a stored property uses finds nothing.
 */
function protocolRequirementName(requirement: AstNode): string | null {
  const pattern = requirement.children.find((c) => c.type === "pattern");
  const names = pattern?.namedChildren.filter((c) => c.type === "simple_identifier") ?? [];
  return names.length === 1 ? names[0].text : null;
}

/**
 * The published `typeName → fieldName → typeName` view of the property
 * evidence — the channel the resolver's stored-property pass reads for
 * `self.db.write()` and for Swift's implicit-self `db.write()`.
 *
 * Only `nominal` survives the projection, so an `[Thing]` property contributes
 * nothing here while still typing `for item in items` inside the walker.
 */
function swiftClassFieldTypes(evidence: SwiftFileTypeEvidence): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = createIdentifierRecord();
  for (const [typeName, fields] of evidence.propertyTypes) {
    const published: Record<string, string> = createIdentifierRecord();
    for (const [fieldName, fact] of fields) if (fact.nominal) published[fieldName] = fact.nominal;
    if (Object.keys(published).length > 0) out[typeName] = published;
  }
  return out;
}

/**
 * The same published view, re-keyed to the run-global address
 * (`../type-field-address.ts`).
 *
 * A projection and not a second collection pass: both addresses state exactly
 * the facts `swiftClassFieldTypes` already published, so the two can never
 * disagree about a type's fields. The file-qualified key is what
 * `CodegraphRunState` merges per-key across the run, which is what keeps a type
 * re-opened by an `extension` in another file from overwriting the entry
 * carrying its own body.
 */
function swiftClassFieldTypesByClassKey(
  published: Record<string, Record<string, string>>,
  relPath: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = createIdentifierRecord();
  for (const [typeName, fields] of Object.entries(published)) out[swiftTypeFieldKey(relPath, typeName)] = fields;
  return out;
}

/**
 * A `func`'s DECLARED return type, or null when it names nothing usable.
 *
 * Swift writes its return types, so this is a read rather than the terminal-
 * expression fold `kernel/return-inference.ts` performs for Ruby and Python.
 * The two gates are what keep the read honest: a universal / empty type
 * (`Any`, `Void`, `Self`) has no member to land on, and a generic parameter
 * is a name that exists only inside the signature — recording `T` would
 * fabricate a `T#member` target at every call site, so it reads as its
 * constraint, or as nothing when it has none (bd tea-rags-mcp-y99pg.6).
 */
function swiftDeclaredReturnFact(node: AstNode): SwiftTypeFact | null {
  const fact = swiftGenericResolvedFact(swiftTypeFactOf(swiftTypeNodeAfter(node, "->")), node);
  const named = fact.nominal ?? fact.element;
  if (!named) return null;
  return SWIFT_UNUSABLE_RETURN_TYPES.has(named) ? null : fact;
}

/**
 * `SWIFT_SELF_RETURN` for a `func` declared `-> Self`, else null (bd
 * tea-rags-mcp-y99pg.18). Published as a MARKER, never as the declaring type:
 * `Self` is the RECEIVER's type, which only the resolver's fold knows —
 * `dataRequest.configured()` on a method `Request` declares returns a
 * `DataRequest`.
 */
function swiftSelfReturnMarker(node: AstNode): string | null {
  const declared = swiftTypeFactOf(swiftTypeNodeAfter(node, "->")).nominal;
  return declared === SWIFT_SELF_RETURN ? SWIFT_SELF_RETURN : null;
}

/** Whether `name` is one of the declaration's own generic parameters (`func decode<T>() -> T`). */
function declaresSwiftTypeParameter(node: AstNode, name: string): boolean {
  const parameters = node.children.find((c) => c.type === "type_parameters");
  if (!parameters) return false;
  return parameters.children.some(
    (p) => p.type === "type_parameter" && p.children.find((c) => c.type === "type_identifier")?.text === name,
  );
}

/**
 * A binding as the walker holds it: the full {@link SwiftTypeFact} plus the
 * scope coordinates the emitted `LocalBinding` cannot carry.
 *
 * `functionKey` never leaves the walker — it exists so an identifier on one
 * method's right-hand side cannot be typed by a same-named local of another
 * method. A binding with no `nominal` is kept in the list and never emitted:
 * that is how an `[T]` annotation feeds `for x in xs` without typing the array.
 */
interface SwiftScopedBinding {
  readonly name: string;
  readonly fact: SwiftTypeFact;
  /** 1-based declaration line — used for innermost-chunk attribution and position-aware reads. */
  readonly line: number;
  /** `startIndex` of the nearest enclosing function-like declaration; `-1` at type / file level. */
  readonly functionKey: number;
  /** 1-based last line the binding is visible on; absent ⇒ visible to the end of its chunk. */
  readonly scopeEndLine?: number;
  /**
   * The right-hand side's SPELLING when this file cannot type it — a value
   * chain whose links live in other files (bd tea-rags-mcp-y99pg.6). Emitted as
   * a `callResultBindings` entry for the resolver to fold; inside the walker the
   * binding types nothing but still SHADOWS a same-named property.
   */
  readonly valueChain?: string;
  /**
   * Set when `valueChain` is the CALLEE a closure is passed to and this
   * binding is that closure's N-th parameter (bd tea-rags-mcp-y99pg.13).
   */
  readonly closureParameter?: number;
  /**
   * Set when `valueChain` is a switch SUBJECT and this binding is payload
   * slot `index` of its case `caseName` (bd tea-rags-mcp-y99pg.16).
   */
  readonly enumPayload?: { readonly caseName: string; readonly index: number };
  /**
   * Set when the binding's own declaration spells its type `T?` — a
   * parameter or an annotated `let` / `var` — so its value is an `Optional`
   * of `fact.nominal` (bd tea-rags-mcp-y99pg.33). Never inferred: an
   * `if let` re-binding is the unwrapped value.
   */
  readonly optional?: true;
  /** Set when `valueChain` spells a `for` loop's SEQUENCE and this binding is its item (bd tea-rags-mcp-y99pg.37). */
  readonly sequenceElement?: true;
}

/** Where a right-hand side is being typed — the coordinates every lookup is relative to. */
interface SwiftBindingSite {
  readonly line: number;
  readonly functionKey: number;
  readonly enclosingType: string | null;
  /** The enclosing type's nesting path — what tells same-named nested types apart. */
  readonly enclosingTypePath: string | null;
}

/**
 * Everything {@link swiftExpressionFact} consults: the file's declarations plus
 * what is bound above.
 *
 * `bindingsByName` is an INDEX over the bindings collected so far, not a second
 * copy of them — the identifier lookup runs once per typed right-hand side and
 * a flat scan would make the pass quadratic in a file's binding count, which is
 * the shape a single generated source file turns into a measurable stall.
 */
interface SwiftTypeScope {
  readonly evidence: SwiftFileTypeEvidence;
  readonly bindingsByName: ReadonlyMap<string, SwiftScopedBinding[]>;
  readonly site: SwiftBindingSite;
}

/** Receiver chains longer than this are not walked — a cap, not a semantic boundary. */
const SWIFT_MAX_TYPE_HOPS = 4;

/**
 * Collect every binding in the file whose type this file can PROVE, in source
 * order, so a right-hand side may read what was bound above it.
 *
 * Pre-order is what makes the ordering work: a `function_declaration`'s
 * parameters are visited before its body, and a statement's bindings before
 * every statement below. The type-level `property_declaration`s a body
 * contains are visited too — they are the implicit-self receivers — and
 * innermost-chunk attribution keeps them off the method chunks.
 */
function collectSwiftTypedBindings(root: AstNode, evidence: SwiftFileTypeEvidence): SwiftScopedBinding[] {
  const collected: SwiftScopedBinding[] = [];
  const bindingsByName = new Map<string, SwiftScopedBinding[]>();
  const siteOf = (node: AstNode): SwiftBindingSite => ({
    line: node.startPosition.row + 1,
    functionKey: enclosingSwiftFunctionKey(node),
    enclosingType: enclosingSwiftTypeName(node),
    enclosingTypePath: enclosingSwiftTypePath(node),
  });
  const record = (
    name: string,
    fact: SwiftTypeFact,
    site: SwiftBindingSite,
    scopeEndLine?: number,
    valueChain?: string,
    closureParameter?: number,
    enumPayload?: { readonly caseName: string; readonly index: number },
    optional?: boolean,
    sequenceElement?: true,
  ): void => {
    if (SWIFT_PSEUDO_BINDING_NAMES.has(name)) return;
    if (!fact.nominal && !fact.element && valueChain === undefined) return;
    const binding: SwiftScopedBinding = {
      name,
      fact,
      line: site.line,
      functionKey: site.functionKey,
      scopeEndLine,
      valueChain,
      ...(closureParameter === undefined ? {} : { closureParameter }),
      ...(enumPayload === undefined ? {} : { enumPayload }),
      ...(optional === true ? { optional: true as const } : {}),
      ...(sequenceElement === undefined ? {} : { sequenceElement }),
    };
    collected.push(binding);
    const sameName = bindingsByName.get(name);
    if (sameName) sameName.push(binding);
    else bindingsByName.set(name, [binding]);
  };
  // A local only: a type-level property's initializer is not a scope a
  // receiver is read in.
  const deferredSpelling = (fact: SwiftTypeFact, value: AstNode | null, site: SwiftBindingSite): string | undefined =>
    fact.nominal || fact.element || site.functionKey === -1 ? undefined : (swiftValueChainSpelling(value) ?? undefined);
  walk(root, (node) => {
    switch (node.type) {
      case "parameter":
      case "lambda_parameter": {
        const name = node.childForFieldName("name");
        if (name) {
          // Past `inout` / `@escaping`, which sit between the colon and the type.
          const typeNode = swiftParameterTypeNode(node);
          const declared = swiftTypeFactOf(typeNode);
          const optional = typeNode?.type === "optional_type";
          record(
            name.text,
            swiftGenericResolvedFact(declared, node),
            siteOf(node),
            undefined,
            undefined,
            undefined,
            undefined,
            optional,
          );
        }
        return;
      }
      case "property_declaration": {
        const name = singleIdentifierPatternName(node.childForFieldName("name"));
        if (!name) return;
        const site = siteOf(node);
        const declared = swiftDeclaredPropertyFact(node);
        const value = node.childForFieldName("value");
        const fact = declared.nominal ? declared : swiftExpressionFact(value, { evidence, bindingsByName, site }, 0);
        record(
          name,
          fact,
          site,
          enclosingSwiftClosureEndLine(node),
          deferredSpelling(fact, value, site),
          undefined,
          undefined,
          declared.nominal !== null && swiftDeclaresOptional(node),
        );
        // `didSet { oldValue… }` / `willSet { newValue… }`: an observer's
        // parameter is a value of the property's DECLARED type, for the
        // clause's own body (bd tea-rags-mcp-y99pg.31).
        if (declared.nominal) {
          for (const clause of swiftPropertyObserverClauses(node)) {
            record(clause.name, declared, siteOf(clause.node), clause.node.endPosition.row + 1);
          }
        }
        return;
      }
      case "guard_statement":
      case "if_statement":
      case "while_statement": {
        const scopeEndLine =
          node.type === "guard_statement" ? enclosingSwiftBlockEndLine(node) : swiftThenBlockEndLine(node);
        for (const clause of swiftOptionalBindingClauses(node)) {
          // Each clause on its OWN line: a multi-line condition's later clause
          // folds the earlier ones, and a spelling is visible strictly below
          // its line (bd tea-rags-mcp-y99pg.32).
          const site = siteOf(clause.nameNode);
          const annotated = swiftGenericResolvedFact(swiftTypeFactOf(clause.annotation), node);
          const annotatedOrInferred =
            annotated.nominal || annotated.element
              ? annotated
              : swiftExpressionFact(clause.value, { evidence, bindingsByName, site }, 0);
          // Unwrapping `[T]?` yields `[T]`, so the element slot survives the
          // unwrap — the array still binds no receiver, and a `for` over the
          // unwrapped name still types its item.
          const spelling = deferredSpelling(annotatedOrInferred, clause.value, site);
          record(clause.name, annotatedOrInferred, site, scopeEndLine, spelling);
        }
        return;
      }
      case "for_statement": {
        const item = node.childForFieldName("item");
        const name = singleIdentifierPatternName(item);
        const pair = name ? null : swiftTuplePatternNames(item);
        if (!name && !pair) return;
        const site = siteOf(node);
        const collection = swiftExpressionFact(
          node.childForFieldName("collection"),
          { evidence, bindingsByName, site },
          0,
        );
        const scopeEnd = swiftThenBlockEndLine(node);
        if (name && collection.element) record(name, { nominal: collection.element, element: null }, site, scopeEnd);
        // A sequence only the resolver can type: the item is its element (bd tea-rags-mcp-y99pg.37).
        const sequence =
          name && !collection.element && site.functionKey !== -1
            ? swiftValueChainSpelling(node.childForFieldName("collection"))
            : null;
        if (name && sequence !== null) {
          record(name, NO_TYPE, site, scopeEnd, sequence, undefined, undefined, undefined, true);
        }
        // `for (key, value) in dictionary` (bd tea-rags-mcp-y99pg.17).
        if (pair && collection.entry) {
          pair.forEach((slotName, i) => {
            const nominal = collection.entry?.[i] ?? null;
            if (slotName !== null && nominal !== null) record(slotName, { nominal, element: null }, site, scopeEnd);
          });
        }
        break;
      }
      // `switch unit { case .group(let g): … }` — each payload name is bound
      // to its case's slot on the subject's enum, which another file
      // declares (bd tea-rags-mcp-y99pg.16).
      case "switch_statement": {
        const subject = swiftValueChainSpelling(
          node.childForFieldName("expr") ?? node.namedChildren.find((c) => c.type !== "switch_entry") ?? null,
        );
        if (subject === null) return;
        for (const entry of node.namedChildren) {
          if (entry.type !== "switch_entry") continue;
          const patterns = entry.namedChildren.filter((c) => c.type === "switch_pattern");
          if (patterns.length !== 1) continue;
          const site = siteOf(entry);
          // The entry and its `statements` run on to the next `case`; the last
          // statement is where the scope ends.
          let last = entry.namedChildren[entry.namedChildCount - 1];
          while (last.type === "statements" && last.namedChildCount > 0) {
            last = last.namedChildren[last.namedChildCount - 1];
          }
          const endLine = last.endPosition.row + 1;
          for (const payload of swiftEnumCasePayloadNames(patterns[0])) {
            record(payload.name, NO_TYPE, site, endLine, subject, undefined, payload.slot);
          }
        }
        return;
      }
      // `catch { error… }` — a clause with no pattern binds `error: any Error`
      // for its own block (bd tea-rags-mcp-y99pg.10).
      case "catch_block": {
        if (node.namedChildren.some((c) => c.type !== "catch_keyword" && c.type !== "statements")) return;
        const body = node.namedChildren.find((c) => c.type === "statements");
        if (!body) return;
        record("error", { nominal: "Error", element: null }, siteOf(body), node.endPosition.row + 1);
        return;
      }
      case "lambda_literal": {
        const site = siteOf(node);
        const facts = swiftClosureArgumentFacts(node, { evidence, bindingsByName, site });
        // No declaration in this file types the closure: hand its callee to
        // the resolver, which reads the callee's closure signature run-wide
        // (bd tea-rags-mcp-y99pg.13).
        const callee = facts ? undefined : swiftClosureCalleeSpelling(node);
        if (!facts && callee === undefined) return;
        const endLine = node.endPosition.row + 1;
        const bind = (name: string, i: number): void => {
          if (facts) {
            if (i < facts.length) record(name, facts[i], site, endLine);
          } else record(name, NO_TYPE, site, endLine, callee, i);
        };
        const named = swiftLambdaParameters(node);
        if (named === null) {
          if (nestsImplicitParameterClosure(node)) return;
          const count = facts ? facts.length : swiftImplicitParameterCount(node);
          for (let i = 0; i < count; i++) bind(`$${i}`, i);
          return;
        }
        named.forEach((parameter, i) => {
          const name = parameter.childForFieldName("name")?.text;
          // An annotated parameter is typed by its own `lambda_parameter` arm.
          if (!name || name === "_" || parameter.children.some((c) => c.type === ":")) return;
          bind(name, i);
        });
        break;
      }
      default:
        break;
    }
  });
  return collected;
}

/**
 * The names a `.caseName(let a, _)` / `let .caseName(a, _)` switch pattern
 * binds, each with its payload slot (bd tea-rags-mcp-y99pg.16). Any other
 * pattern shape — a qualified case, a nested pattern, a labelled slot — binds
 * nothing here.
 */
function swiftEnumCasePayloadNames(
  switchPattern: AstNode,
): { name: string; slot: { caseName: string; index: number } }[] {
  const pattern = switchPattern.namedChildren.find((c) => c.type === "pattern");
  if (!pattern) return [];
  const { children } = pattern;
  const outerLet = children[0]?.type === "value_binding_pattern" && children[0].namedChildCount <= 1;
  const dot = children.findIndex((c) => c.type === ".");
  const caseNode = dot === -1 ? undefined : children[dot + 1];
  if (dot !== (outerLet ? 1 : 0) || caseNode?.type !== "simple_identifier") return [];
  const out: { name: string; slot: { caseName: string; index: number } }[] = [];
  children
    .filter((c) => c.type === "pattern")
    .forEach((slot, index) => {
      const named = slot.namedChildren;
      let name: string | undefined;
      if (named.length === 2 && named[0].type === "value_binding_pattern" && named[1].type === "simple_identifier") {
        name = named[1].text;
      } else if (outerLet && named.length === 1 && named[0].type === "simple_identifier") {
        name = named[0].text;
      }
      if (name !== undefined && name !== "_") out.push({ name, slot: { caseName: caseNode.text, index } });
    });
  return out;
}

/** The parameter name each observer clause the language gives it when the clause names none. */
const SWIFT_OBSERVER_DEFAULT_PARAMETER: Readonly<Record<string, string>> = {
  didset_clause: "oldValue",
  willset_clause: "newValue",
};

/**
 * A property's `didSet` / `willSet` clauses, each with the name its parameter
 * goes by — the one the clause spells (`didSet(previous)`), else the
 * language's implicit `oldValue` / `newValue`.
 */
function swiftPropertyObserverClauses(property: AstNode): { name: string; node: AstNode }[] {
  const block = property.namedChildren.find((c) => c.type === "willset_didset_block");
  if (!block) return [];
  const out: { name: string; node: AstNode }[] = [];
  for (const clause of block.namedChildren) {
    const implicit = SWIFT_OBSERVER_DEFAULT_PARAMETER[clause.type];
    if (implicit === undefined) continue;
    const spelled = clause.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    out.push({ name: spelled ?? implicit, node: clause });
  }
  return out;
}

/**
 * The two names of a `(a, b)` for-in pattern, `null` for a `_` slot; null
 * for any other pattern shape.
 */
function swiftTuplePatternNames(item: AstNode | null): [string | null, string | null] | null {
  if (!item || item.children[0]?.type !== "(") return null;
  const slots = item.namedChildren.filter((c) => c.type === "pattern");
  if (slots.length !== 2 || slots.length !== item.namedChildCount) return null;
  const names = slots.map((slot) => {
    const only = slot.namedChildCount === 1 ? slot.namedChildren[0] : null;
    return only?.type === "simple_identifier" ? only.text : null;
  });
  return [names[0], names[1]];
}

/** One `let x` / `var x` clause of a `guard` / `if` / `while` condition list. */
interface SwiftOptionalBindingClause {
  readonly name: string;
  /** The bound identifier — where the clause's binding is positioned. */
  readonly nameNode: AstNode;
  /** The binding's own `: T` annotation, when written. */
  readonly annotation: AstNode | null;
  /**
   * The expression being unwrapped. For the Swift 5.7 shorthand (`if let x`)
   * this is the bound identifier itself — the form re-binds the name it
   * unwraps, so the outer value is exactly what to type it from.
   */
  readonly value: AstNode | null;
}

/**
 * Read the `let` / `var` clauses out of a flat condition list.
 *
 * A clause is `value_binding_pattern`, then the bound `simple_identifier`,
 * then an optional `type_annotation`, then an optional `=` and its right-hand
 * side. Anything else after the binding pattern — the `.` of
 * `if case let .some(v)` — means the form destructures a pattern rather than
 * binding one name, and the clause is skipped.
 */
function swiftOptionalBindingClauses(node: AstNode): SwiftOptionalBindingClause[] {
  const out: SwiftOptionalBindingClause[] = [];
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type !== "value_binding_pattern") continue;
    const nameNode = kids[i + 1];
    if (nameNode?.type !== "simple_identifier") continue;
    let next = i + 2;
    let annotation: AstNode | null = null;
    if (kids[next]?.type === "type_annotation") {
      annotation = swiftTypeNodeAfter(kids[next], ":");
      next += 1;
    }
    const value = kids[next]?.type === "=" ? (kids[next + 1] ?? null) : nameNode;
    out.push({ name: nameNode.text, nameNode, annotation, value });
  }
  return out;
}

/** What a module-level value declaration states about the value (bd tea-rags-mcp-y99pg.30). */
export interface SwiftModuleValueFact {
  readonly name: string;
  /** The nominal the declaration spells — an annotation or a CapWords construction. */
  readonly type?: string;
  /** Else the right-hand side's value-chain spelling, for the resolver to fold. */
  readonly spelling?: string;
}

/**
 * What a FILE-SCOPE `property_declaration` publishes as a module value, or
 * null: a single bound name, typed by the same narrow rule a stored property
 * is ({@link swiftDeclaredPropertyFact}), else spelled by the rule a local's
 * cross-file right-hand side is ({@link swiftValueChainSpelling}). The caller
 * owns which nodes are file-scope and which access levels leave the file.
 */
export function swiftModuleValueOf(node: AstNode): SwiftModuleValueFact | null {
  if (node.type !== "property_declaration") return null;
  const name = singleIdentifierPatternName(node.childForFieldName("name"));
  if (name === null || SWIFT_PSEUDO_BINDING_NAMES.has(name)) return null;
  const declared = swiftDeclaredPropertyFact(node);
  if (declared.nominal) return { name, type: declared.nominal };
  const spelling = swiftValueChainSpelling(node.childForFieldName("value"));
  return spelling === null ? null : { name, spelling };
}

/**
 * The type a `property_declaration` DECLARES, or nothing. Annotation first; on
 * its absence, a CapWords initializer call.
 *
 * This is the narrow rule `classFieldTypes` publishes — evidence written at the
 * declaration and nothing inferred through it. A local falls back to
 * {@link swiftExpressionFact} when this is silent; a type-level property does
 * not, because the property map is that walk's input.
 */
/**
 * Whether a `property_declaration` ANNOTATES its type as `T?` (bd
 * tea-rags-mcp-y99pg.33). `T!` is not: an implicitly unwrapped value reads its
 * members off `T`. Read positionally, as every type position here is.
 */
function swiftDeclaresOptional(node: AstNode): boolean {
  const annotation = node.children.find((c) => c.type === "type_annotation");
  return annotation !== undefined && swiftTypeNodeAfter(annotation, ":")?.type === "optional_type";
}

function swiftDeclaredPropertyFact(node: AstNode): SwiftTypeFact {
  const annotation = node.children.find((c) => c.type === "type_annotation");
  if (annotation) return swiftGenericResolvedFact(swiftTypeFactOf(swiftTypeNodeAfter(annotation, ":")), node);
  return constructedTypeFact(node.childForFieldName("value"));
}

/**
 * `Helper()` → `Helper`. Nothing for anything else, including a lowercase callee.
 *
 * Swift types are UpperCamelCase and functions lowerCamelCase by universal
 * convention, so a CapWords callee is a construction. A lowercase one is a
 * function, and its return type is answered — where this file declares it — by
 * {@link swiftDeclaredReturnFact}, never by recording the function's own name
 * as a type. Same gate as Rust's `isCapWordsType` and Python's
 * `isCapWordsConstructor`.
 */
function constructedTypeFact(value: AstNode | null): SwiftTypeFact {
  if (value?.type === "constructor_expression") return swiftConstructedGenericFact(value);
  if (value?.type !== "call_expression") return NO_TYPE;
  const callee = value.namedChildren.find((c) => c.type !== "call_suffix");
  if (!callee) return NO_TYPE;
  if (callee.type !== "simple_identifier") return swiftCollectionConstructionFact(callee) ?? NO_TYPE;
  return /^_*[A-Z]/.test(callee.text) ? { nominal: callee.text, element: null } : NO_TYPE;
}

/**
 * `Protected<[T]>(…)` — tree-sitter-swift parses an explicitly specialised
 * construction as a `constructor_expression` over a `user_type`, not a call —
 * types as the generic's nominal (bd tea-rags-mcp-y99pg.10).
 */
function swiftConstructedGenericFact(node: AstNode): SwiftTypeFact {
  const constructed = node.namedChildren.find((c) => c.type === "user_type") ?? null;
  const fact = swiftTypeFactOf(constructed);
  return fact.nominal && /^_*[A-Z]/.test(fact.nominal) ? fact : NO_TYPE;
}

/** A `pattern` node's identifier when it binds exactly one name; null for tuple / destructuring patterns. */
function singleIdentifierPatternName(pattern: AstNode | null): string | null {
  if (pattern?.type !== "pattern" || pattern.namedChildCount !== 1) return null;
  const id = pattern.namedChildren[0];
  return id.type === "simple_identifier" ? id.text : null;
}

/**
 * The type node that follows `separator` among a node's children — how EVERY
 * Swift type position is read here, and never `childForFieldName`.
 *
 * `materializeTree` rebuilds the field map from `fieldNameForChild`, which
 * reports ONE field name per child, and tree-sitter-swift registers every type
 * position under `name` as WELL as under `type` / `return_type`. `name` is what
 * gets reported, so on a MATERIALIZED node — the only kind the pipeline ever
 * walks, `CodegraphFileExtractor` materializes before calling a walker — both
 * `type` and `return_type` are simply absent. A field read therefore works in
 * every unit test (which parse natively) and silently returns nothing in
 * production, leaving `localBindings` and `classFieldTypes` empty for the whole
 * language.
 *
 * The position is unambiguous in each case a caller uses: `:` in a `parameter`,
 * `lambda_parameter` or `type_annotation`, `->` in a `func` signature. A
 * default value, a variadic `...` or a `throws` clause all sit on the far side
 * of the separator or beyond the type, so none of them displaces it.
 * `tests/…/swift-walker.test.ts` pins native-vs-materialized parity.
 */
function swiftTypeNodeAfter(node: AstNode, separator: string): AstNode | null {
  const at = node.children.findIndex((c) => c.type === separator);
  return at === -1 ? null : (node.children[at + 1] ?? null);
}

/**
 * Reduce a Swift type node to what it proves.
 *
 *   - `user_type` — `Foo` → nominal `Foo`, `Set<Foo>` → nominal `Set` (generics
 *     stripped by text, which also keeps a qualified `Outer.Inner` intact as
 *     the nested type's own composed id spells it).
 *   - `optional_type` — `Foo?` → whatever `Foo` proves. The receiver of
 *     `x?.m()` is the wrapped value, so the Optional is transparent here.
 *   - `existential_type` — `any Proto` → whatever `Proto` proves. Swift 5.7
 *     made the keyword mandatory, so this is how protocol-typed storage is
 *     SPELLED in modern code rather than an exotic corner: a call on such a
 *     value dispatches on the protocol's own requirement, which is a project
 *     symbol whenever the protocol is.
 *   - `tuple_type` holding exactly one unlabelled item — `(any Proto)`, `(Foo)`
 *     → whatever the item proves. Swift has no one-element tuple; that shape is
 *     a PARENTHESIZED type, and the parentheses are required around an
 *     existential before `?`. A tuple with two or more items proves nothing,
 *     because no member dispatches on a tuple.
 *   - `array_type` — `[Foo]` → nominal `Array`, ELEMENT `Foo`. An Array is not
 *     a Foo; see the container note in the file docblock.
 *   - `dictionary_type` — `[K: V]` → nominal `Dictionary`, no element.
 *   - anything else, notably `function_type`, and a `tuple_type` that is a
 *     real tuple — nothing.
 */
const SWIFT_METATYPE_SUFFIX = /\.(?:Type|Protocol)$/;

/** Constraints that declare no member a call could dispatch on: marker protocols and `AnyObject`. */
const SWIFT_MARKER_PROTOCOLS: ReadonlySet<string> = new Set([
  "Sendable",
  "AnyObject",
  "Copyable",
  "Escapable",
  "BitwiseCopyable",
  "SendableMetatype",
]);

function swiftTypeFactOf(typeNode: AstNode | null): SwiftTypeFact {
  if (!typeNode) return NO_TYPE;
  if (typeNode.type === "optional_type") return swiftTypeFactOf(typeNode.namedChildren[0] ?? null);
  if (typeNode.type === "array_type") {
    return { nominal: "Array", element: swiftTypeFactOf(typeNode.namedChildren[0] ?? null).nominal };
  }
  if (typeNode.type === "dictionary_type") {
    // Positionally, for the materialization hazard `swiftTypeNodeAfter` documents.
    const [key, value] = typeNode.namedChildren;
    return {
      nominal: "Dictionary",
      element: null,
      entry: [swiftTypeFactOf(key ?? null).nominal, swiftTypeFactOf(value ?? null).nominal],
    };
  }
  // `any P` and `some P` both dispatch a member call on P's requirement.
  if (typeNode.type === "existential_type" || typeNode.type === "opaque_type") {
    return swiftTypeFactOf(typeNode.namedChildren[0] ?? null);
  }
  // `Subscriber & Sendable` dispatches on Subscriber: a marker protocol declares
  // no member. Two real protocols leave the lookup undecided (bd tea-rags-mcp-y99pg.28).
  if (typeNode.type === "protocol_composition_type") {
    const real = typeNode.namedChildren.filter((c) => !SWIFT_MARKER_PROTOCOLS.has(c.text.trim()));
    return real.length === 1 ? swiftTypeFactOf(real[0]) : NO_TYPE;
  }
  if (typeNode.type === "tuple_type") return swiftTypeFactOf(parenthesizedSwiftTypeNode(typeNode));
  if (typeNode.type === "metatype") return swiftTypeFactOf(typeNode.namedChildren[0] ?? null);
  if (typeNode.type !== "user_type") return NO_TYPE;
  const raw = typeNode.text;
  const generics = raw.indexOf("<");
  // `Foo.Type` / `Foo.Protocol` is Foo's metatype: a member read off it is one
  // of Foo's static members, which compose under Foo (bd tea-rags-mcp-y99pg.12).
  const bare = (generics === -1 ? raw : raw.slice(0, generics)).trim().replace(SWIFT_METATYPE_SUFFIX, "");
  if (bare.length === 0) return NO_TYPE;
  return { nominal: bare, element: swiftSpelledSequenceElement(typeNode, bare) };
}

/**
 * The standard library sequences whose ONE generic argument is their
 * `Element` — `Set<Request>` iterates `Request`s exactly as `[Request]` does
 * (bd tea-rags-mcp-y99pg.32). `Dictionary`, `Result` and every other generic
 * type are absent: an argument of theirs is not what a `for` or a `forEach`
 * hands its body.
 */
const SWIFT_SINGLE_ELEMENT_SEQUENCES: ReadonlySet<string> = new Set(["Array", "Set", "ArraySlice", "ContiguousArray"]);

/**
 * The element nominal a `user_type` spelling one of
 * {@link SWIFT_SINGLE_ELEMENT_SEQUENCES} with its argument states, or null.
 * Read positionally off `type_arguments`, for the materialization hazard
 * {@link swiftTypeNodeAfter} documents.
 */
function swiftSpelledSequenceElement(typeNode: AstNode, nominal: string): string | null {
  if (!SWIFT_SINGLE_ELEMENT_SEQUENCES.has(nominal)) return null;
  const args = typeNode.children.find((c) => c.type === "type_arguments")?.namedChildren ?? [];
  return args.length === 1 ? swiftTypeFactOf(args[0]).nominal : null;
}

/**
 * The type a `tuple_type` merely PARENTHESISES, or null when it is a real
 * tuple.
 *
 * `(any EventMonitor)` and `(Thing)` parse as one-element tuples, a shape
 * Swift's type system does not have — `(T)` IS `T` — and the parentheses are
 * not optional in the one place this matters most, since `any P?` is ambiguous
 * and must be written `(any P)?`. Anything with a second item, or with a label
 * on its only item, is left alone: a member call dispatches on no tuple.
 *
 * Read positionally. `tuple_type_item.type` is one of the fields
 * tree-sitter-swift registers twice and `materializeTree` therefore drops, so a
 * field read here would work in a native-parsing spec and return nothing in
 * production — the hazard {@link swiftTypeNodeAfter} exists for.
 */
function parenthesizedSwiftTypeNode(tupleType: AstNode): AstNode | null {
  if (tupleType.namedChildCount !== 1) return null;
  const item = tupleType.namedChildren[0];
  return item.type === "tuple_type_item" && item.namedChildCount === 1 ? item.namedChildren[0] : null;
}

/**
 * What an expression PROVES about its value, from this file's evidence alone.
 *
 * Every arm reads a declaration: a binding above, a declared property, a
 * declared return, or a CapWords construction. An expression no arm recognises
 * proves nothing — the walk STOPS rather than degrading to a guess, which is
 * the same discipline `kernel/receiver-type-propagation.ts` applies to a
 * multi-hop receiver.
 */
function swiftExpressionFact(node: AstNode | null, scope: SwiftTypeScope, depth: number): SwiftTypeFact {
  if (!node || depth > SWIFT_MAX_TYPE_HOPS) return NO_TYPE;
  switch (node.type) {
    // `try f()` / `await f()` wrap the value; the operand is the last named child.
    case "try_expression":
    case "await_expression":
      return swiftExpressionFact(node.namedChildren[node.namedChildCount - 1] ?? null, scope, depth + 1);
    // `obj!` — the operand is first, the `bang` second.
    case "postfix_expression":
      return swiftExpressionFact(node.namedChildren[0] ?? null, scope, depth + 1);
    case "self_expression":
      return { nominal: scope.site.enclosingType, element: enclosingSwiftSelfElement(node) };
    case "simple_identifier":
      return node.text === "Self"
        ? { nominal: scope.site.enclosingType, element: null }
        : swiftIdentifierFact(node.text, scope);
    case "navigation_expression": {
      const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
      if (!member) return NO_TYPE;
      const element = swiftElementAccess(
        node.childForFieldName("target"),
        member.text,
        SWIFT_ELEMENT_PROPERTIES,
        scope,
        depth,
      );
      if (element) return element;
      const owner = swiftReceiverTypeName(node.childForFieldName("target"), scope, depth);
      if (!owner) return NO_TYPE;
      return swiftPropertyFact(owner, member.text, scope);
    }
    case "call_expression":
      return swiftCallResultFact(node, scope, depth);
    case "constructor_expression":
      return swiftConstructedGenericFact(node);
    // A literal's default type (bd tea-rags-mcp-y99pg.27): `"…"` is String.
    case "line_string_literal":
    case "multi_line_string_literal":
    case "raw_string_literal":
      return { nominal: "String", element: null };
    case "array_literal":
      return swiftArrayLiteralFact(node, scope, depth);
    // `x as? Foo` / `x as! Foo` / `x as Foo` — the cast names its type.
    case "as_expression":
      return swiftTypeFactOf(node.namedChildren[node.namedChildCount - 1] ?? null);
    // `a ?? b` — the left operand, unwrapped; the right one where it proves nothing.
    case "nil_coalescing_expression": {
      const left = swiftExpressionFact(node.namedChildren[0] ?? null, scope, depth + 1);
      if (left.nominal || left.element) return left;
      return swiftExpressionFact(node.namedChildren[node.namedChildCount - 1] ?? null, scope, depth + 1);
    }
    default:
      return NO_TYPE;
  }
}

/**
 * `[a, b]` is an Array whose element is the type every element proves, or no
 * element where they disagree or one proves nothing; `[]` proves nothing, since
 * only its context types it (bd tea-rags-mcp-y99pg.27).
 */
function swiftArrayLiteralFact(node: AstNode, scope: SwiftTypeScope, depth: number): SwiftTypeFact {
  const elements = node.namedChildren.filter((c) => c.type !== "comment");
  if (elements.length === 0) return NO_TYPE;
  const types = new Set(elements.map((element) => swiftExpressionFact(element, scope, depth + 1).nominal));
  const [only] = types;
  return { nominal: "Array", element: types.size === 1 && only !== undefined ? only : null };
}

/**
 * The SPELLING of a value chain the resolver can fold — `self`, a value or
 * type name, then `.member` and `.method(…)` links — with `try` / `await`,
 * optional chaining, force unwraps and call arguments stripped, and `a ?? b`
 * read as `a`. Null for anything else, a chain headed by a bare call included:
 * the fold types a head by name, and `make()` is no name.
 */
function swiftValueChainSpelling(node: AstNode | null, depth = 0): string | null {
  if (!node || depth > SWIFT_MAX_TYPE_HOPS + 2) return null;
  switch (node.type) {
    case "try_expression":
    case "await_expression":
      return swiftValueChainSpelling(node.namedChildren[node.namedChildCount - 1] ?? null, depth + 1);
    case "postfix_expression":
    case "nil_coalescing_expression":
      return swiftValueChainSpelling(node.namedChildren[0] ?? null, depth + 1);
    case "self_expression":
      return "self";
    case "simple_identifier":
      return node.text;
    case "navigation_expression": {
      const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
      const target = swiftValueChainSpelling(node.childForFieldName("target"), depth + 1);
      return member?.type === "simple_identifier" && target !== null ? `${target}.${member.text}` : null;
    }
    case "call_expression": {
      const suffix = node.children.find((c) => c.type === "call_suffix");
      if (!suffix || suffix.children.some((c) => c.type !== "value_arguments")) return null;
      const callee = node.namedChildren.find((c) => c.type !== "call_suffix");
      const spelled = callee?.type === "navigation_expression" ? swiftValueChainSpelling(callee, depth + 1) : null;
      // `read(\.activeRequests)`: the one argument a generic return can be
      // bound by, so the spelling keeps it (bd tea-rags-mcp-y99pg.37).
      const keyPath = swiftLoneKeyPathArgument(suffix);
      return spelled !== null && keyPath !== null ? `${spelled}(${keyPath})` : spelled;
    }
    default:
      return null;
  }
}

/** `\.p`, `\.p.q`, `\.self` — a root-inferred key path of plain property names. */
const SWIFT_PLAIN_KEY_PATH = /^\\\.(?:self|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/;

/** The text of a call's ONE unlabeled argument when it is a plain key path, else null. */
function swiftLoneKeyPathArgument(suffix: AstNode): string | null {
  const list = suffix.children.find((c) => c.type === "value_arguments");
  const args = (list?.namedChildren ?? []).filter((c) => c.type === "value_argument");
  if (args.length !== 1) return null;
  const [arg] = args;
  if (arg.children.some((c) => c.type === "value_argument_label")) return null;
  const text = arg.text.trim();
  return SWIFT_PLAIN_KEY_PATH.test(text) ? text : null;
}

/**
 * The type a bare identifier holds: the nearest binding ABOVE it in the same
 * function scope, else the enclosing type's property of that name — Swift's
 * implicit `self`.
 *
 * The scope filters are the precision story. `functionKey` keeps one method's
 * local out of another's right-hand side; `line` keeps a later binding from
 * typing an earlier use; `scopeEndLine` keeps a block-scoped unwrap out of the
 * lines below its block. Same rule as the kernel's
 * {@link resolveLocalBinding}, applied inside the walker where the bindings
 * are still being built.
 */
function swiftIdentifierFact(name: string, scope: SwiftTypeScope): SwiftTypeFact {
  let best: SwiftScopedBinding | undefined;
  for (const binding of scope.bindingsByName.get(name) ?? []) {
    if (binding.functionKey !== scope.site.functionKey) continue;
    if (binding.line > scope.site.line) continue;
    if (binding.scopeEndLine !== undefined && binding.scopeEndLine < scope.site.line) continue;
    if (!best || binding.line > best.line) best = binding;
  }
  if (best) return best.fact;
  const owner = scope.site.enclosingType;
  return owner ? swiftPropertyFact(owner, name, scope) : NO_TYPE;
}

/**
 * The fact of property `name` on the type `owner` names. The enclosing type's
 * own name reads its NESTING PATH first — Swift resolves that name lexically,
 * so inside `DownloadResponsePublisher.Inner` an `Inner` is that type and not
 * a namesake nested elsewhere (bd tea-rags-mcp-y99pg.36).
 */
function swiftPropertyFact(owner: string, name: string, scope: SwiftTypeScope): SwiftTypeFact {
  const path = owner === scope.site.enclosingType ? scope.site.enclosingTypePath : null;
  return (
    (path ? scope.evidence.propertyTypes.get(path)?.get(name) : undefined) ??
    scope.evidence.propertyTypes.get(owner)?.get(name) ??
    NO_TYPE
  );
}

/**
 * The type name a RECEIVER denotes — the owner a member lookup is keyed by.
 *
 * Differs from {@link swiftExpressionFact} in one arm: a CapWords identifier
 * that names no value is read as the TYPE itself, which is how `Foo.shared`
 * and `Foo.make()` find their member. The metatype never becomes a binding —
 * this function is reachable only from a navigation target or a call's callee,
 * so `let v = Foo` still binds nothing.
 */
function swiftReceiverTypeName(node: AstNode | null, scope: SwiftTypeScope, depth: number): string | null {
  if (!node) return null;
  if (node.type === "simple_identifier" && node.text !== "Self") {
    const fact = swiftIdentifierFact(node.text, scope);
    if (fact.nominal) return fact.nominal;
    return /^_*[A-Z]/.test(node.text) ? node.text : null;
  }
  return swiftExpressionFact(node, scope, depth + 1).nominal;
}

/**
 * What a call evaluates to: a CapWords construction, or the DECLARED return
 * type of a callee this file also declares.
 *
 * A bare callee is looked up on the enclosing type BEFORE the top level, which
 * is Swift's own lookup order — a method shadows a global of the same name. A
 * qualified one is looked up on whatever its receiver types to, so
 * `self.build()`, `Foo.make()` and `repo.load()` are one arm.
 *
 * A bracketed `call_suffix` is a subscript read, not a call: `items[i]` proves
 * only that `items` is a collection, which this type language cannot say.
 */
function swiftCallResultFact(node: AstNode, scope: SwiftTypeScope, depth: number): SwiftTypeFact {
  const suffix = node.children.find((c) => c.type === "call_suffix");
  if (!suffix || suffix.text.startsWith("[")) return NO_TYPE;
  const callee = node.namedChildren.find((c) => c.type !== "call_suffix");
  if (!callee) return NO_TYPE;
  if (callee.type === "simple_identifier" && /^_*[A-Z]/.test(callee.text)) {
    return { nominal: callee.text, element: null };
  }
  // `[T]()` / `[K: V]()` construct an empty collection of the named types
  // (bd tea-rags-mcp-y99pg.17); a literal holding values is no type name.
  const collection = swiftCollectionConstructionFact(callee);
  if (collection) return collection;
  if (callee.type === "navigation_expression") {
    const member = callee.childForFieldName("suffix")?.childForFieldName("suffix")?.text;
    const target = callee.childForFieldName("target");
    const element = member ? swiftElementAccess(target, member, SWIFT_ELEMENT_METHODS, scope, depth) : null;
    if (element) return element;
  }
  // A generic return bound by a `Type.self` argument names its type at the
  // call; the declared return holds only its constraint.
  const slot = swiftCalleeEvidence(callee, scope.evidence.metatypeReturns, scope, depth);
  const bound = slot ? swiftMetatypeArgumentType(suffix, slot) : null;
  if (bound !== null) return { nominal: bound, element: null };
  return swiftCalleeEvidence(callee, scope.evidence.returnTypes, scope, depth) ?? NO_TYPE;
}

/** `startIndex` of the nearest enclosing function-like declaration; `-1` at type / file level. */
function enclosingSwiftFunctionKey(node: AstNode): number {
  for (let current = node.parent; current; current = current.parent) {
    if (SWIFT_FUNCTION_LIKE_NODES.has(current.type)) return current.startIndex;
  }
  return -1;
}

/**
 * The collection an `[T]()` / `[K: V]()` callee constructs, or null when the
 * literal holds anything but type names. Read positionally: the literal's
 * `element` / `key` / `value` fields are not relied on.
 */
function swiftCollectionConstructionFact(callee: AstNode): SwiftTypeFact | null {
  const names = callee.namedChildren;
  if (!names.every((n) => n.type === "simple_identifier" && SWIFT_TYPE_NAME_TEXT.test(n.text))) return null;
  if (callee.type === "array_literal" && names.length === 1) {
    return { nominal: "Array", element: names[0].text };
  }
  if (callee.type === "dictionary_literal" && names.length === 2) {
    return { nominal: "Dictionary", element: null, entry: [names[0].text, names[1].text] };
  }
  return null;
}

/** A spelled type name: UpperCamelCase, leading underscores allowed. */
const SWIFT_TYPE_NAME_TEXT = /^_*[A-Z]/;

/** `[T]` properties that read one element. */
const SWIFT_ELEMENT_PROPERTIES: ReadonlySet<string> = new Set(["first", "last"]);

/** `[T]` methods that return one element (optional or not). */
const SWIFT_ELEMENT_METHODS: ReadonlySet<string> = new Set([
  "removeFirst",
  "removeLast",
  "popLast",
  "randomElement",
  "first",
  "last",
  "min",
  "max",
]);

/**
 * The element an accessor reads off an `[T]` value — `xs.first`,
 * `xs.removeFirst()` — or null. Keyed on the `element` slot, which only an
 * array type produces, so a project type's own `first` is never read this way.
 */
function swiftElementAccess(
  target: AstNode | null,
  member: string,
  accessors: ReadonlySet<string>,
  scope: SwiftTypeScope,
  depth: number,
): SwiftTypeFact | null {
  if (!target || !accessors.has(member)) return null;
  const { element } = swiftExpressionFact(target, scope, depth + 1);
  return element ? { nominal: element, element: null } : null;
}

/**
 * 1-based last line of the closure a declaration sits in, when its nearest
 * scope is a closure rather than a function: a `let` inside `{ … }` is gone at
 * the brace, and without the bound a sibling closure's same-named local would
 * type this one's reads. `undefined` outside any closure.
 */
function enclosingSwiftClosureEndLine(node: AstNode): number | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "lambda_literal") return current.endPosition.row + 1;
    if (SWIFT_FUNCTION_LIKE_NODES.has(current.type)) return undefined;
  }
  return undefined;
}

/**
 * The element `self` iterates as inside an extension of an ARRAY type:
 * `extension [ServerTrustEvaluating]` or `extension Array where Element ==
 * ServerTrustEvaluating` — so `for evaluator in self` types `evaluator` (bd
 * tea-rags-mcp-y99pg). Any other enclosing type answers null. The `where`
 * clause is read positionally: the constrained name first, the type last.
 */
function enclosingSwiftSelfElement(node: AstNode): string | null {
  let declaration: AstNode | null = node.parent;
  while (declaration && declaration.type !== "class_declaration" && declaration.type !== "protocol_declaration") {
    declaration = declaration.parent;
  }
  if (declaration?.type !== "class_declaration" || swiftTypeDeclarationKind(declaration) !== "extension") return null;
  const name = declaration.childForFieldName("name");
  if (name?.type === "array_type") return swiftTypeFactOf(name).element;
  if (name?.type !== "user_type" || name.text.trim() !== "Array") return null;
  for (const clause of declaration.children) {
    if (clause.type !== "type_constraints") continue;
    for (const constraint of clause.namedChildren) {
      const equality = constraint.namedChildren.find((c) => c.type === "equality_constraint");
      if (equality?.namedChildren[0]?.text !== "Element") continue;
      return swiftTypeFactOf(equality.namedChildren[equality.namedChildCount - 1]).nominal;
    }
  }
  return null;
}

/** Short name of the nearest enclosing nominal type, as `classFieldTypes` keys it. */
function enclosingSwiftTypeName(node: AstNode): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") {
      return current.childForFieldName("name")?.text ?? null;
    }
  }
  return null;
}

/**
 * 1-based last line of the block CONTAINING `node` — a `guard let` binding's
 * scope extent. The `else` branch must exit, so everything below the guard and
 * inside the same block sees the unwrapped value, and nothing outside it does.
 */
function enclosingSwiftBlockEndLine(node: AstNode): number | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (SWIFT_BLOCK_NODES.has(current.type)) return current.endPosition.row + 1;
  }
  return undefined;
}

/**
 * 1-based line of the brace closing a statement's OWN body — an `if let` /
 * `while let` / `for in` binding's scope extent.
 *
 * The first `}` among the direct children is that brace: a condition's own
 * braces are nested inside its subtree, and an `else` block's `}` comes after
 * the `else` keyword. Reading the statement's end line instead would carry an
 * `if let` binding into the `else` branch, which Swift does not bind.
 */
function swiftThenBlockEndLine(node: AstNode): number | undefined {
  const close = node.children.find((c) => c.type === "}");
  return close ? close.endPosition.row + 1 : undefined;
}

/**
 * Attribute each binding to the INNERMOST chunk whose line range contains the
 * declaration, tie-broken by deeper scope — the same discipline
 * `assignCallsToInnermostChunks` applies to call sites, so a method's parameter
 * lands on the method chunk rather than the type chunk that also spans its
 * line. Bindings outside every chunk are dropped silently, and so is every
 * binding with no nominal type: an `[T]`-typed name reached this far only to
 * type a `for` loop's item.
 *
 * Returns chunk index → `Record<name, LocalBinding[]>`: the position-aware
 * contract shape, so a re-bound name accumulates one `{ line, type }` per
 * declaration and `resolveLocalBindingType` picks the most recent one at or
 * before a call's line, skipping one whose `scopeEndLine` has passed.
 */
function assignBindingsToInnermostChunks(
  bindings: readonly SwiftScopedBinding[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, SwiftChunkBindings> {
  const out = new Map<number, SwiftChunkBindings>();
  for (const binding of bindings) {
    if (!binding.fact.nominal && binding.valueChain === undefined) continue;
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (binding.line < c.startLine || binding.line > c.endLine) continue;
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
      bucket = { localBindings: createIdentifierRecord(), callResultBindings: createIdentifierRecord() };
      out.set(bestIdx, bucket);
    }
    const scoped = binding.scopeEndLine === undefined ? {} : { scopeEndLine: binding.scopeEndLine };
    if (binding.fact.nominal) {
      const emitted: LocalBinding = {
        line: binding.line,
        type: binding.fact.nominal,
        ...scoped,
        // `T?` keeps `type: T` for every reader that wants the wrapped type,
        // and says what the value IS beside it (bd tea-rags-mcp-y99pg.33).
        ...(binding.optional === true
          ? {
              typeRef: {
                form: "instance" as const,
                name: "Optional",
                args: [{ form: "instance" as const, name: binding.fact.nominal }],
              },
            }
          : {}),
      };
      (bucket.localBindings[binding.name] ??= []).push(emitted);
    } else if (binding.valueChain !== undefined) {
      const emitted: CallResultBinding = {
        line: binding.line,
        callee: binding.valueChain,
        ...(binding.closureParameter === undefined ? {} : { closureParameter: binding.closureParameter }),
        ...(binding.enumPayload === undefined ? {} : { enumPayload: binding.enumPayload }),
        ...(binding.sequenceElement === undefined ? {} : { sequenceElement: binding.sequenceElement }),
        ...scoped,
      };
      (bucket.callResultBindings[binding.name] ??= []).push(emitted);
    }
  }
  return out;
}

/** One chunk's share of the file's bindings, in the two channels a chunk carries them in. */
interface SwiftChunkBindings {
  readonly localBindings: Record<string, LocalBinding[]>;
  readonly callResultBindings: Record<string, CallResultBinding[]>;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
