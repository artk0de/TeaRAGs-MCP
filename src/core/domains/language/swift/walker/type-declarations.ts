/**
 * The `typeDeclarations` channel (`collectSwiftTypeDeclarations`) with the
 * naming facts a type body carries — aliases, member typealiases, attribute
 * types, `where` clauses, enum payloads — and the run-global
 * `structuredReturnTypes` channel (`collectSwiftStructuredReturnTypes`),
 * keyed by the callee's own composed symbolId.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type {
  SelfConstraintFact,
  SwiftWhereClauseFact,
  TypeDeclarationFact,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { swiftGenericMemberFacts } from "./generics.js";
import {
  composedIdNames,
  singleIdentifierPatternName,
  swiftTypeDeclarationKind,
  swiftTypeNameText,
  swiftTypeNodeAfter,
  swiftTypeParameterNames,
  walk,
} from "./shared.js";
import { symbolKindOf } from "./symbol-kind.js";
import {
  SWIFT_UNUSABLE_RETURN_TYPES,
  swiftDeclaredReturnFact,
  swiftDeclaresOptional,
  swiftSelfReturnMarker,
  swiftTypeFactOf,
} from "./type-evidence.js";

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
 *
 * `symbolKind` (bd tea-rags-mcp-vi0wx) is the chunk's kind ({@link symbolKindOf}):
 * class / struct / actor → `class`, enum → `enum`, protocol → `interface`.
 * An extension declares no kind of its own, so a re-opening borrows the kind
 * of the same file's own declaration of the type and falls back to the
 * nominal `class` for a type declared elsewhere (an SDK type, another file) —
 * which the naming lexicon never reads, because it reads own declarations only.
 *
 * A `typealias` at file scope or directly in a type body (an extension's
 * included) publishes a `type_alias` fact for the naming lexicon (spec §1b),
 * composed like a type: `extension Request { typealias Validation = … }` →
 * `Request.Validation`. One declared inside a function, accessor or closure is
 * a local and publishes nothing. An alias declares no type, so the resolver's
 * read of the channel skips it (`swiftResolverTypeFacts` in
 * `resolver/swift-type-declarations.ts`).
 */
export function collectSwiftTypeDeclarations(root: AstNode): TypeDeclarationFact[] {
  const out: TypeDeclarationFact[] = [];
  const ownKinds = new Map<string, SymbolDefinitionKind>();
  walk(root, (node) => {
    if (node.type === "typealias_declaration") {
      const alias = swiftTypeAliasFact(node);
      if (alias !== undefined) out.push(alias);
      return;
    }
    const kind = swiftTypeDeclarationKind(node);
    if (kind === null) return;
    const name = swiftTypeNameText(node.childForFieldName("name")?.text);
    if (name === undefined) return;
    const enclosing = swiftEnclosingTypeNames(node);
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
    const typeId = [...enclosing, name].join(".");
    const ownKind =
      kind === "extension" ? undefined : symbolKindOf(node.type, { atTopLevel: false, typeKeyword: kind });
    if (ownKind !== undefined && !ownKinds.has(typeId)) ownKinds.set(typeId, ownKind);
    out.push({
      typeId,
      symbolKind: ownKind ?? SWIFT_REOPENED_NOMINAL_KIND,
      line: node.startPosition.row + 1,
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
  // A re-opening may precede the declaration it re-opens, so its kind is
  // settled once every own declaration of the file is known.
  return out.map((fact) =>
    fact.reopens ? { ...fact, symbolKind: ownKinds.get(fact.typeId) ?? fact.symbolKind } : fact,
  );
}

/**
 * The names of every type declaration enclosing `node`, outermost first — an
 * extension's included, by its written name with generic arguments dropped.
 */
function swiftEnclosingTypeNames(node: AstNode): string[] {
  const enclosing: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (swiftTypeDeclarationKind(current) === null) continue;
    const outer = swiftTypeNameText(current.childForFieldName("name")?.text);
    if (outer !== undefined) enclosing.unshift(outer);
  }
  return enclosing;
}

/** The body nodes a type, extension or protocol declares its members in. */
const SWIFT_TYPE_BODY_NODE_TYPES: ReadonlySet<string> = new Set(["class_body", "enum_class_body", "protocol_body"]);

/**
 * The naming fact of a `typealias` declared at file scope or directly in a
 * type body, or undefined for a local one — an alias inside a function,
 * accessor or closure sits under that body's `statements`, never directly
 * under the file or a type body.
 */
function swiftTypeAliasFact(node: AstNode): TypeDeclarationFact | undefined {
  const { parent } = node;
  if (parent === null) return undefined;
  const atFileScope = parent.type === "source_file";
  const inTypeBody =
    SWIFT_TYPE_BODY_NODE_TYPES.has(parent.type) &&
    parent.parent !== null &&
    swiftTypeDeclarationKind(parent.parent) !== null;
  if (!atFileScope && !inTypeBody) return undefined;
  const name = node.childForFieldName("name")?.text.trim();
  const symbolKind = symbolKindOf(node.type, { atTopLevel: atFileScope });
  if (!name || symbolKind === undefined) return undefined;
  return {
    typeId: [...swiftEnclosingTypeNames(node), name].join("."),
    symbolKind,
    line: node.startPosition.row + 1,
    reopens: false,
  };
}

/** The kind a re-opening of a type the file does not declare carries: Swift extends nominal types. */
const SWIFT_REOPENED_NOMINAL_KIND: SymbolDefinitionKind = "class";

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
export function collectSwiftStructuredReturnTypes(
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
