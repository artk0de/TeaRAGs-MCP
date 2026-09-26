/**
 * Which files DECLARE a Swift type and which only re-open it — the resolver's
 * read of the run-global `typeDeclarations` channel (bd tea-rags-mcp-y99pg.1).
 *
 * `extension World` composes exactly the symbol id `class World` does, so the
 * symbol table alone cannot tell the two apart. That costs twice:
 *
 *   - a type re-opened ACROSS files (`World.swift` + `World+DSL.swift`) answers
 *     its name with two definitions, and the strict gate drops every
 *     construction edge into it as ambiguous;
 *   - a type the project only EXTENDS (`extension JSONDecoder: DataDecoder {}`)
 *     answers its name with the extension alone, so `JSONDecoder()` lands on a
 *     file that declares no initializer of it.
 *
 * The channel is absent on an index built before the walker published it, and
 * every question here then answers `undefined` — the caller keeps the answer it
 * gave before the channel existed.
 */

import type {
  CallContext,
  GenericInitializerFact,
  SwiftFieldConstruction,
  SwiftWhereClauseFact,
  TypeDeclarationFact,
  TypeDeclarationKind,
} from "../../../../contracts/types/codegraph.js";
import { RunScopedMemo, splitAtBracketDepthZero } from "../../kernel/index.js";

interface SwiftTypeDeclarationSets {
  /** typeId → the files holding its own declaration. */
  readonly declaring: ReadonlyMap<string, ReadonlySet<string>>;
  /** typeId → the files re-opening it. */
  readonly reopening: ReadonlyMap<string, ReadonlySet<string>>;
  /** typeId → the keyword of each own declaration; `null` for one whose fact recorded none (bd tea-rags-mcp-y99pg.35). */
  readonly kinds: ReadonlyMap<string, ReadonlySet<TypeDeclarationKind | null>>;
  /** typeId → every supertype any declaration of it names, in first-seen order. */
  readonly conforms: ReadonlyMap<string, readonly string[]>;
  /** typeId → its own generic parameter names (bd tea-rags-mcp-y99pg.13). */
  readonly generics: ReadonlyMap<string, readonly string[]>;
  /** typeId → property → the generic arguments its declared type carries. */
  readonly fieldArguments: ReadonlyMap<string, ReadonlyMap<string, readonly (string | null)[]>>;
  /** typeId → method → its closure's parameter types; `null` where declarations disagree. */
  readonly closureParameters: ReadonlyMap<string, ReadonlyMap<string, readonly (string | null)[] | null>>;
  /** typeId → the methods returning their closure's result (bd tea-rags-mcp-y99pg.37). */
  readonly closureResults: ReadonlyMap<string, ReadonlySet<string>>;
  /** typeId → the ids its generic-argument extensions compose members under (bd tea-rags-mcp-y99pg.19). */
  readonly spellings: ReadonlyMap<string, readonly string[]>;
  /** typeId → function-typed alias → what calling it returns (bd tea-rags-mcp-y99pg.22). */
  readonly functionAliases: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** enum typeId → case → its payload slot types (bd tea-rags-mcp-y99pg.16). */
  readonly enumCases: ReadonlyMap<string, ReadonlyMap<string, Readonly<Record<string, readonly (string | null)[]>>>>;
  /** typeId → property → its attribute types, the wrapper candidates (bd tea-rags-mcp-y99pg.33). */
  readonly propertyAttributes: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** typeId → the properties any declaration of it annotates `T?` (bd tea-rags-mcp-y99pg.33). */
  readonly optionalProperties: ReadonlyMap<string, ReadonlySet<string>>;
  /** typeId → member typealias → the nominal it aliases, first declaration wins (bd tea-rags-mcp-y99pg.33). */
  readonly memberTypeAliases: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** typeId → stored property → the generic parameter it is typed as (bd tea-rags-mcp-y99pg.34). */
  readonly genericFields: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** relPath → the constrained re-openings it holds, each with its `where` clause (bd tea-rags-mcp-y99pg.34). */
  readonly whereClauses: ReadonlyMap<string, readonly { typeId: string; clause: SwiftWhereClauseFact }[]>;
}

const memo = new RunScopedMemo<Readonly<Record<string, readonly TypeDeclarationFact[]>>, SwiftTypeDeclarationSets>();

/**
 * The facts of `facts` the resolver reads — every one but a `type_alias`. The
 * walker publishes each non-local `typealias` for the naming lexicon (bd
 * tea-rags-mcp-vi0wx, spec §1b), and an alias declares no type: counted here, a
 * project `typealias JSONDecoder = …` would make the project DECLARE the SDK
 * type, and every declared-vs-re-opened answer below would move. Every read of
 * the channel in this resolver goes through this one filter.
 */
function swiftResolverTypeFacts(facts: readonly TypeDeclarationFact[] | undefined): readonly TypeDeclarationFact[] {
  if (facts === undefined) return [];
  return facts.some((fact) => fact.symbolKind === "type_alias")
    ? facts.filter((fact) => fact.symbolKind !== "type_alias")
    : facts;
}

function add(into: Map<string, Set<string>>, typeId: string, relPath: string): void {
  const files = into.get(typeId);
  if (files) files.add(relPath);
  else into.set(typeId, new Set([relPath]));
}

function mergeFieldArguments(
  into: Map<string, Map<string, readonly (string | null)[]>>,
  fact: TypeDeclarationFact,
): void {
  if (fact.fieldTypeArguments === undefined) return;
  const fields = into.get(fact.typeId) ?? new Map<string, readonly (string | null)[]>();
  for (const [field, args] of Object.entries(fact.fieldTypeArguments)) if (!fields.has(field)) fields.set(field, args);
  into.set(fact.typeId, fields);
}

/** Two declarations of one method that disagree on its closure's parameter types poison the entry to `null`. */
function mergeClosureParameters(
  into: Map<string, Map<string, readonly (string | null)[] | null>>,
  fact: TypeDeclarationFact,
): void {
  if (fact.memberClosureParameters === undefined) return;
  const members = into.get(fact.typeId) ?? new Map<string, readonly (string | null)[] | null>();
  for (const [member, types] of Object.entries(fact.memberClosureParameters)) {
    if (!members.has(member)) members.set(member, types);
    else if (!sameClosureTypes(members.get(member) ?? null, types)) members.set(member, null);
  }
  into.set(fact.typeId, members);
}

function sameClosureTypes(a: readonly (string | null)[] | null, b: readonly (string | null)[] | null): boolean {
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((type, i) => type === b[i]);
}

/**
 * The generic arguments an unspecialised construction binds (bd
 * tea-rags-mcp-y99pg.26): `Protected(State())` runs the initializer whose labels
 * are the call's, and each parameter that initializer types as a generic
 * parameter binds it to that argument's constructed type. The constructed type
 * is read lexically from the owner outward, as Swift names a nested type.
 * Undefined when no initializer takes the labels, when two that do bind
 * differently, or when nothing is bound.
 */
function constructionTypeArguments(
  owner: string,
  construction: SwiftFieldConstruction,
  generics: ReadonlyMap<string, readonly string[]>,
  initializers: ReadonlyMap<string, readonly GenericInitializerFact[]>,
): readonly (string | null)[] | undefined {
  const scopes = owner.split(".");
  let typeId: string | undefined;
  for (let depth = scopes.length; depth >= 0 && typeId === undefined; depth--) {
    const candidate = [...scopes.slice(0, depth), construction.type].join(".");
    if (generics.has(candidate)) typeId = candidate;
  }
  if (typeId === undefined) return undefined;
  const parameters = generics.get(typeId) ?? [];
  const labels = construction.arguments.map((arg) => arg.label);
  let bound: (string | null)[] | undefined;
  for (const init of initializers.get(typeId) ?? []) {
    if (init.labels.length !== labels.length || !init.labels.every((label, i) => label === labels[i])) continue;
    const next = parameters.map((parameter) => {
      const at = init.binds.indexOf(parameter);
      return at === -1 ? null : (construction.arguments[at]?.type ?? null);
    });
    if (bound !== undefined && !sameClosureTypes(bound, next)) return undefined;
    bound = next;
  }
  return bound?.some((type) => type !== null) ? bound : undefined;
}

function setsFor(ctx: CallContext): SwiftTypeDeclarationSets | undefined {
  const channel = ctx.typeDeclarations;
  if (channel === undefined) return undefined;
  const hit = memo.get(ctx.runScope, channel);
  if (hit !== undefined) return hit;
  const declaring = new Map<string, Set<string>>();
  const reopening = new Map<string, Set<string>>();
  const kinds = new Map<string, Set<TypeDeclarationKind | null>>();
  const conforms = new Map<string, string[]>();
  const generics = new Map<string, readonly string[]>();
  const fieldArguments = new Map<string, Map<string, readonly (string | null)[]>>();
  const closureParameters = new Map<string, Map<string, readonly (string | null)[] | null>>();
  const closureResults = new Map<string, Set<string>>();
  const spellings = new Map<string, string[]>();
  const functionAliases = new Map<string, Readonly<Record<string, string>>>();
  const enumCases = new Map<string, Map<string, Readonly<Record<string, readonly (string | null)[]>>>>();
  const propertyAttributes = new Map<string, Map<string, readonly string[]>>();
  const optionalProperties = new Map<string, Set<string>>();
  const memberTypeAliases = new Map<string, Map<string, string>>();
  const initializers = new Map<string, GenericInitializerFact[]>();
  const constructions: { owner: string; field: string; construction: SwiftFieldConstruction }[] = [];
  const genericFields = new Map<string, Readonly<Record<string, string>>>();
  const whereClauses = new Map<string, { typeId: string; clause: SwiftWhereClauseFact }[]>();
  // Sorted, so which file's clause comes first is a property of the project
  // rather than of the order this run walked it in.
  for (const relPath of Object.keys(channel).sort()) {
    // Swift declarations only, as every lookup here (`swift-symbol-lookup.ts`).
    if (!relPath.endsWith(".swift")) continue;
    for (const fact of swiftResolverTypeFacts(channel[relPath])) {
      add(fact.reopens ? reopening : declaring, fact.typeId, relPath);
      if (!fact.reopens) {
        const own = kinds.get(fact.typeId) ?? new Set<TypeDeclarationKind | null>();
        own.add(fact.declarationKind ?? null);
        kinds.set(fact.typeId, own);
      }
      if (fact.genericParameters !== undefined && !generics.has(fact.typeId)) {
        generics.set(fact.typeId, fact.genericParameters);
      }
      mergeFieldArguments(fieldArguments, fact);
      // A stored property lives in the type's own declaration; Swift lets no extension add one.
      if (fact.genericFieldParameters !== undefined && !fact.reopens && !genericFields.has(fact.typeId)) {
        genericFields.set(fact.typeId, fact.genericFieldParameters);
      }
      if (fact.whereClause !== undefined) {
        const list = whereClauses.get(relPath) ?? [];
        list.push({ typeId: fact.typeId, clause: fact.whereClause });
        whereClauses.set(relPath, list);
      }
      if (fact.genericInitializers !== undefined) {
        initializers.set(fact.typeId, [...(initializers.get(fact.typeId) ?? []), ...fact.genericInitializers]);
      }
      for (const [field, construction] of Object.entries(fact.fieldConstructions ?? {})) {
        constructions.push({ owner: fact.typeId, field, construction });
      }
      mergeClosureParameters(closureParameters, fact);
      for (const member of fact.closureResultMembers ?? []) add(closureResults, fact.typeId, member);
      for (const field of fact.optionalProperties ?? []) add(optionalProperties, fact.typeId, field);
      for (const [field, types] of Object.entries(fact.propertyAttributeTypes ?? {})) {
        const fields = propertyAttributes.get(fact.typeId) ?? new Map<string, readonly string[]>();
        if (!fields.has(field)) fields.set(field, types);
        propertyAttributes.set(fact.typeId, fields);
      }
      for (const [alias, aliased] of Object.entries(fact.memberTypeAliases ?? {})) {
        const aliases = memberTypeAliases.get(fact.typeId) ?? new Map<string, string>();
        if (!aliases.has(alias)) aliases.set(alias, aliased);
        memberTypeAliases.set(fact.typeId, aliases);
      }
      if (fact.functionAliasReturns !== undefined && !functionAliases.has(fact.typeId)) {
        functionAliases.set(fact.typeId, fact.functionAliasReturns);
      }
      if (fact.spelledAs !== undefined) {
        const list = spellings.get(fact.typeId) ?? [];
        if (!list.includes(fact.spelledAs)) list.push(fact.spelledAs);
        spellings.set(fact.typeId, list);
      }
      // An enum's cases live in its own declaration; Swift lets no extension add one.
      if (fact.enumCasePayloads !== undefined && !fact.reopens) {
        const byFile =
          enumCases.get(fact.typeId) ?? new Map<string, Readonly<Record<string, readonly (string | null)[]>>>();
        byFile.set(relPath, fact.enumCasePayloads);
        enumCases.set(fact.typeId, byFile);
      }
      if (fact.conforms === undefined) continue;
      const list = conforms.get(fact.typeId) ?? [];
      for (const name of fact.conforms) if (!list.includes(name)) list.push(name);
      conforms.set(fact.typeId, list);
    }
  }
  for (const { owner, field, construction } of constructions) {
    const fields = fieldArguments.get(owner) ?? new Map<string, readonly (string | null)[]>();
    if (fields.has(field)) continue;
    const bound = constructionTypeArguments(owner, construction, generics, initializers);
    if (bound === undefined) continue;
    fields.set(field, bound);
    fieldArguments.set(owner, fields);
  }
  const fresh = {
    declaring,
    reopening,
    kinds,
    conforms,
    generics,
    fieldArguments,
    closureParameters,
    closureResults,
    spellings,
    functionAliases,
    enumCases,
    propertyAttributes,
    optionalProperties,
    memberTypeAliases,
    genericFields,
    whereClauses,
  };
  memo.set(ctx.runScope, channel, fresh);
  return fresh;
}

/**
 * The files holding `typeId`'s own declaration, or `undefined` when the run
 * says nothing about the type — no channel, or no file declaring or re-opening
 * it. An EMPTY set means the project only re-opens the type.
 */
export function swiftDeclaringFiles(typeId: string, ctx: CallContext): ReadonlySet<string> | undefined {
  const sets = setsFor(ctx);
  if (sets === undefined) return undefined;
  const declaring = sets.declaring.get(typeId);
  if (declaring !== undefined) return declaring;
  return sets.reopening.has(typeId) ? new Set<string>() : undefined;
}

/**
 * The keyword of every declaration of `typeId` the project holds — `null` for
 * one an older index recorded without it — or `undefined` when the project
 * declares no type of that id, or the run publishes no channel (bd
 * tea-rags-mcp-y99pg.35). More than one member means namesake types in several
 * targets, each a declaration of its own.
 */
export function swiftDeclarationKinds(
  typeId: string,
  ctx: CallContext,
): ReadonlySet<TypeDeclarationKind | null> | undefined {
  return setsFor(ctx)?.kinds.get(typeId);
}

/** Whether the run PROVES `typeId` is a type the project re-opens but never declares. */
export function isSwiftReopenedOnlyType(typeId: string, ctx: CallContext): boolean {
  return swiftDeclaringFiles(typeId, ctx)?.size === 0;
}

/**
 * Whether a project extension declares an initializer of `typeId` — the one
 * way a construction of a type the project only re-opens can land in the
 * project. Which initializer a call runs is an argument-label question, so this
 * says only that one CAN.
 */
export function swiftExtensionDeclaresInit(typeId: string, lookup: (symbolId: string) => readonly unknown[]): boolean {
  return lookup(`${typeId}#init`).length > 0 || lookup(`${typeId}.init`).length > 0;
}

/**
 * Every supertype any declaration of `typeId` names — its own clause and each
 * re-opening's — or none when the run publishes no channel.
 */
export function swiftConformances(typeId: string, ctx: CallContext): readonly string[] {
  return setsFor(ctx)?.conforms.get(typeId) ?? [];
}

/** `typeId`'s own generic parameter names, or none (bd tea-rags-mcp-y99pg.13). */
export function swiftGenericParameters(typeId: string, ctx: CallContext): readonly string[] {
  return setsFor(ctx)?.generics.get(typeId) ?? [];
}

/** The generic parameter of `typeId` its stored property `field` is typed as, or undefined (bd tea-rags-mcp-y99pg.34). */
export function swiftGenericFieldParameter(typeId: string, field: string, ctx: CallContext): string | undefined {
  const fields = setsFor(ctx)?.genericFields.get(typeId);
  return fields !== undefined && Object.hasOwn(fields, field) ? fields[field] : undefined;
}

/**
 * The `where` clause of the re-opening of `typeId` in `relPath` whose lines
 * hold `line`, or undefined (bd tea-rags-mcp-y99pg.34). Extensions sit at file
 * scope and never nest, so at most one holds a line.
 */
export function swiftWhereClauseAt(
  typeId: string,
  relPath: string,
  line: number,
  ctx: CallContext,
): SwiftWhereClauseFact | undefined {
  for (const { typeId: id, clause } of setsFor(ctx)?.whereClauses.get(relPath) ?? []) {
    if (id === typeId && clause.startLine <= line && line <= clause.endLine) return clause;
  }
  return undefined;
}

/** The generic arguments `typeId` declares its property `field` with, or undefined. */
export function swiftFieldTypeArguments(
  typeId: string,
  field: string,
  ctx: CallContext,
): readonly (string | null)[] | undefined {
  return setsFor(ctx)?.fieldArguments.get(typeId)?.get(field);
}

/**
 * The parameter types of the closure `typeId`'s method `member` takes —
 * `undefined` when no declaration of it takes one, `null` when declarations
 * disagree.
 */
export function swiftMemberClosureParameters(
  typeId: string,
  member: string,
  ctx: CallContext,
): readonly (string | null)[] | null | undefined {
  return setsFor(ctx)?.closureParameters.get(typeId)?.get(member);
}

/** Whether a declaration of `typeId` says its method `member` returns its closure's result (bd tea-rags-mcp-y99pg.37). */
export function swiftMemberReturnsClosureResult(typeId: string, member: string, ctx: CallContext): boolean {
  return setsFor(ctx)?.closureResults.get(typeId)?.has(member) === true;
}

/**
 * The sugar spellings under which the project re-opens `Array` or
 * `Dictionary` — `extension [HTTPHeader]` composes its members as
 * `[HTTPHeader]#index` (bd tea-rags-mcp-y99pg.14). Element-blind: a receiver
 * typed `Array` reaches every `[T]` extension, and two of them declaring one
 * member leave the lookup ambiguous rather than pick one. Any type also
 * answers the ids its generic-argument extensions are spelled as
 * (`Collection<String>`, bd tea-rags-mcp-y99pg.19), argument-blind for the
 * same reason.
 */
export function swiftSugarAliases(typeId: string, ctx: CallContext): readonly string[] {
  const sets = setsFor(ctx);
  if (sets === undefined) return [];
  // `extension Collection<String>` composes under its spelled id (bd tea-rags-mcp-y99pg.19).
  const aliases: string[] = [...(sets.spellings.get(typeId) ?? [])];
  if (typeId !== "Array" && typeId !== "Dictionary") return aliases;
  for (const id of [...sets.declaring.keys(), ...sets.reopening.keys()]) {
    if (!id.startsWith("[") || !id.endsWith("]") || aliases.includes(id)) continue;
    const isDictionary = splitAtBracketDepthZero(id.slice(1, -1), ":").length > 1;
    if (isDictionary === (typeId === "Dictionary")) aliases.push(id);
  }
  return aliases;
}

/**
 * The nominal type enum `typeId` declares for payload slot `index` of its
 * case `caseName`, or undefined (bd tea-rags-mcp-y99pg.16, .17).
 */
export function swiftEnumCasePayloadType(
  typeId: string,
  caseName: string,
  index: number,
  ctx: CallContext,
): string | undefined {
  // A `private enum` is file-scoped, so two files may each declare one of a
  // name: the caller's own file wins, and otherwise only a lone declaration
  // answers.
  const byFile = setsFor(ctx)?.enumCases.get(typeId);
  const cases = byFile?.get(ctx.callerFile) ?? (byFile?.size === 1 ? [...byFile.values()][0] : undefined);
  if (cases === undefined || !Object.hasOwn(cases, caseName)) return undefined;
  return cases[caseName][index] ?? undefined;
}

/**
 * What calling a value of the function-typed alias `alias` returns, the alias
 * read lexically from `scopes` (innermost first), or undefined (bd
 * tea-rags-mcp-y99pg.22).
 */
export function swiftFunctionAliasReturn(
  alias: string,
  scopes: readonly string[],
  ctx: CallContext,
): { returned: string; declaredIn: string } | undefined {
  const aliases = setsFor(ctx)?.functionAliases;
  if (aliases === undefined) return undefined;
  for (const scope of scopes) {
    const table = aliases.get(scope);
    if (table !== undefined && Object.hasOwn(table, alias)) return { returned: table[alias], declaredIn: scope };
  }
  return undefined;
}

/**
 * The attribute types the property `field` of `typeId` is declared with, in
 * source order — its wrapper candidates (bd tea-rags-mcp-y99pg.33). Empty
 * when it carries none or the channel is absent.
 */
export function swiftPropertyAttributeTypes(typeId: string, field: string, ctx: CallContext): readonly string[] {
  return setsFor(ctx)?.propertyAttributes.get(typeId)?.get(field) ?? [];
}

/**
 * The member typealiases the declarations of `typeId` declare, each to the
 * nominal it names as spelled (bd tea-rags-mcp-y99pg.33): `typealias Output =
 * DataStreamRequest.Stream<…>` → `Output` → `DataStreamRequest.Stream`.
 * Undefined when none does or the channel is absent.
 */
export function swiftMemberTypeAliases(typeId: string, ctx: CallContext): ReadonlyMap<string, string> | undefined {
  return setsFor(ctx)?.memberTypeAliases.get(typeId);
}

/** Whether a declaration of `typeId` annotates its property `field` as `T?` (bd tea-rags-mcp-y99pg.33). */
export function swiftIsOptionalProperty(typeId: string, field: string, ctx: CallContext): boolean {
  return setsFor(ctx)?.optionalProperties.get(typeId)?.has(field) ?? false;
}

/**
 * The types `Self` is constrained to at `line` of the caller's file, inside a
 * re-opening of `typeId` whose `where` clause names them (bd
 * tea-rags-mcp-y99pg.33): `extension Download where Self: DataSerializer`. Read
 * from the caller's own file only — the constraint holds inside that body and
 * nowhere else. Empty when no such re-opening spans the line.
 */
export function swiftSelfConstraintsAt(typeId: string, line: number, ctx: CallContext): readonly string[] {
  for (const fact of swiftResolverTypeFacts(ctx.typeDeclarations?.[ctx.callerFile])) {
    const constraint = fact.selfConstraints;
    if (fact.typeId !== typeId || constraint === undefined) continue;
    if (line >= constraint.startLine && line <= constraint.endLine) return constraint.types;
  }
  return [];
}
