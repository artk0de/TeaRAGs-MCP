/**
 * Sink-time row builder for `cg_identifiers` (bd tea-rags-mcp-4p3sb.9): joins a
 * file's `identifierDeclarations` with the type channels its language already
 * publishes, so each declared identifier is persisted with its best-known type.
 *
 * Pure — one `FileExtraction` in, rows out. The kernel pass that publishes the
 * declarations sees no native extraction, so the join happens here, where the
 * merged extraction is whole. Stages, strongest first; the first that answers
 * wins and names itself in `typeSource`:
 *
 *   1. syntactic   — the declaration's own `annotation` / `constructor` type;
 *   2. `binding` / `field-type` — the owner chunk's `localBindings` (param,
 *      local) or the enclosing class's `ivarTypes` / `classFieldTypes` (field);
 *   3. `finder`    — bound to a finder of the language's vocabulary on a
 *      constant receiver → that constant.
 *
 * `call-return` is NOT a stage here: the reads join the bound call to its edge
 * at query time. `return` rows come from `structuredReturnTypes`, one per chunk.
 *
 * Invariant: every row is a declaration or a declared return type. A name a
 * naming convention could type but nothing declares yields no row, and no stage
 * reads a convention-derived type — a lexicon fed by its own convention would
 * confirm itself.
 */

import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  IdentifierDeclaration,
  IdentifierRow,
  LocalBinding,
  PersistedIdentifierTypeSource,
} from "../../../../contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor, TypeRef } from "../../../../contracts/types/language.js";

/** Finder members per language, from `LanguageProvider.identifierFinderMethods`. */
export type IdentifierFinderVocabulary = ReadonlyMap<string, ReadonlySet<string>>;

const NO_FINDERS: IdentifierFinderVocabulary = new Map();

/**
 * Every registered language's finder vocabulary, collected ONCE — the factory's
 * `create` is expensive, so the provider builds this at construction the way it
 * collects the schema-column and dependency-manifest sources.
 */
export function collectIdentifierFinderVocabulary(
  languageFactory: LanguageFactoryDescriptor | undefined,
): IdentifierFinderVocabulary {
  const vocabulary = new Map<string, ReadonlySet<string>>();
  if (!languageFactory) return vocabulary;
  for (const lang of languageFactory.supported()) {
    const methods = languageFactory.create(lang).identifierFinderMethods;
    if (methods !== undefined && methods.length > 0) vocabulary.set(lang, new Set(methods));
  }
  return vocabulary;
}

/** A constant path as written: `Doc`, `Tax::Doc`, `::Tax::Doc`. A call chain is not one. */
const CONSTANT_RECEIVER = /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/;

/** Drop the root-namespace marker: `::System` and `System` name one type. */
function normalizeTypeName(typeName: string): string {
  return typeName.startsWith("::") ? typeName.slice(2) : typeName;
}

/**
 * The single nominal name of a return ref: a class / instance names itself, a
 * container its element. A union — nilable ones included — and `nil` have no
 * single name and yield nothing (same rule as the language kernel's flat
 * return channels).
 */
function singleNominalName(ref: TypeRef): string | undefined {
  if (ref.form === "class" || ref.form === "instance") return ref.name;
  if (ref.form === "container") return singleNominalName(ref.element);
  return undefined;
}

/** The member part of a symbolId: after the last `#` or `.`. */
function memberNameOf(symbolId: string): string {
  const cut = Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf("."));
  return cut < 0 ? symbolId : symbolId.slice(cut + 1);
}

function lastScopeSegment(symbolId: string): string {
  const parts = symbolId.split(/::|\./);
  return parts[parts.length - 1] ?? symbolId;
}

/** The chunk owning `line` among those carrying `symbolId`, else the first of them. */
function ownerChunkOf(chunks: readonly ChunkExtraction[] | undefined, line: number): ChunkExtraction | undefined {
  if (!chunks || chunks.length === 0) return undefined;
  return (
    chunks.find(
      (c) => c.startLine !== undefined && c.endLine !== undefined && c.startLine <= line && line <= c.endLine,
    ) ?? chunks[0]
  );
}

/** The binding on the declaration's line, else the nearest preceding one; an empty type is no binding. */
function bindingTypeAt(bindings: readonly LocalBinding[] | undefined, line: number): string | undefined {
  let best: LocalBinding | undefined;
  for (const binding of bindings ?? []) {
    if (binding.type === "" || binding.line > line) continue;
    if (best === undefined || binding.line > best.line) best = binding;
  }
  return best?.type;
}

/** Class keys a field's owner may be recorded under: short name, `::`-qualified, dotted. */
function enclosingClassKeys(chunk: ChunkExtraction): string[] {
  const keys =
    chunk.scope.length > 0
      ? [chunk.scope[chunk.scope.length - 1], chunk.scope.join("::"), chunk.scope.join(".")]
      : [lastScopeSegment(chunk.symbolId), chunk.symbolId];
  return [...new Set(keys.filter((k): k is string => k !== undefined && k.length > 0))];
}

/** A field as it may be spelled in a class field map: as declared, bare, and with the ivar sigil. */
function fieldNameVariants(name: string): string[] {
  const bare = name.replace(/^(?:@|self\.|this\.)/, "");
  return [...new Set([name, bare, `@${bare}`])];
}

function fieldTypeOf(extraction: FileExtraction, chunk: ChunkExtraction | undefined, name: string): string | undefined {
  if (!chunk) return undefined;
  const classKeys = enclosingClassKeys(chunk);
  const names = fieldNameVariants(name);
  // `ivarTypes` carries declarations and outranks the inferred short-name map,
  // the same order every resolver reads them in.
  for (const map of [extraction.ivarTypes, extraction.classFieldTypes]) {
    if (!map) continue;
    for (const classKey of classKeys) {
      const fields = map[classKey];
      if (!fields) continue;
      for (const field of names) {
        const type = fields[field];
        if (type) return type;
      }
    }
  }
  return undefined;
}

/**
 * The `callText` of the call the declaration is bound to: the FIRST call of the
 * owner chunk at or after the declaration's line with the same member and
 * receiver. The value's call precedes any later namesake, and it may start a
 * line below the declared name (`x =\n  foo()`).
 */
function boundCallExpressionOf(chunk: ChunkExtraction | undefined, decl: IdentifierDeclaration): string | undefined {
  const callee = decl.boundCallee;
  if (!chunk || !callee) return undefined;
  const receiver = callee.receiver ?? null;
  let first: CallRef | undefined;
  for (const call of chunk.calls) {
    if (call.startLine < decl.line || call.member !== callee.member || call.receiver !== receiver) continue;
    if (first === undefined || call.startLine < first.startLine) first = call;
  }
  return first?.callText;
}

function recoveredType(
  extraction: FileExtraction,
  chunk: ChunkExtraction | undefined,
  decl: IdentifierDeclaration,
  finders: ReadonlySet<string> | undefined,
): { typeName: string; typeSource: PersistedIdentifierTypeSource } | undefined {
  if (decl.typeName) return { typeName: decl.typeName, typeSource: decl.typeSource ?? "annotation" };
  if (decl.kind === "field") {
    const fieldType = fieldTypeOf(extraction, chunk, decl.name);
    if (fieldType) return { typeName: fieldType, typeSource: "field-type" };
  } else {
    const bound = bindingTypeAt(chunk?.localBindings?.[decl.name], decl.line);
    if (bound) return { typeName: bound, typeSource: "binding" };
  }
  const callee = decl.boundCallee;
  if (callee?.receiver && finders?.has(callee.member) && CONSTANT_RECEIVER.test(callee.receiver)) {
    return { typeName: callee.receiver, typeSource: "finder" };
  }
  return undefined;
}

function declarationRow(
  extraction: FileExtraction,
  chunksBySymbol: ReadonlyMap<string, ChunkExtraction[]>,
  decl: IdentifierDeclaration,
  finders: ReadonlySet<string> | undefined,
): IdentifierRow {
  const chunk = ownerChunkOf(chunksBySymbol.get(decl.ownerSymbolId), decl.line);
  const row: IdentifierRow = { ownerSymbolId: decl.ownerSymbolId, kind: decl.kind, name: decl.name, line: decl.line };
  const type = recoveredType(extraction, chunk, decl, finders);
  if (type) {
    row.typeName = normalizeTypeName(type.typeName);
    row.typeSource = type.typeSource;
  }
  if (decl.boundCallee) {
    row.boundMember = decl.boundCallee.member;
    if (decl.boundCallee.receiver !== undefined) row.boundReceiver = decl.boundCallee.receiver;
    const callExpression = boundCallExpressionOf(chunk, decl);
    if (callExpression !== undefined) row.boundCallExpression = callExpression;
  }
  return row;
}

function returnRows(extraction: FileExtraction): IdentifierRow[] {
  const returnTypes = extraction.structuredReturnTypes;
  if (!returnTypes) return [];
  const rows: IdentifierRow[] = [];
  const seen = new Set<string>();
  for (const chunk of extraction.chunks) {
    if (seen.has(chunk.symbolId) || !Object.hasOwn(returnTypes, chunk.symbolId)) continue;
    seen.add(chunk.symbolId);
    const typeName = singleNominalName(returnTypes[chunk.symbolId]);
    if (!typeName) continue;
    rows.push({
      ownerSymbolId: chunk.symbolId,
      kind: "return",
      name: memberNameOf(chunk.symbolId),
      line: chunk.startLine ?? 0,
      typeName: normalizeTypeName(typeName),
      typeSource: "return-type",
    });
  }
  return rows;
}

/**
 * The `cg_identifiers` rows of one file: one per declaration, then one per
 * chunk with a single-name structured return type. `finderVocabulary` supplies
 * the finder stage for the extraction's language; absent, the stage is off.
 */
export function buildIdentifierRows(
  extraction: FileExtraction,
  finderVocabulary: IdentifierFinderVocabulary = NO_FINDERS,
): IdentifierRow[] {
  const chunksBySymbol = new Map<string, ChunkExtraction[]>();
  for (const chunk of extraction.chunks) {
    const list = chunksBySymbol.get(chunk.symbolId);
    if (list) list.push(chunk);
    else chunksBySymbol.set(chunk.symbolId, [chunk]);
  }
  const finders = finderVocabulary.get(extraction.language);
  const rows = (extraction.identifierDeclarations ?? []).map((decl) =>
    declarationRow(extraction, chunksBySymbol, decl, finders),
  );
  return [...rows, ...returnRows(extraction)];
}
