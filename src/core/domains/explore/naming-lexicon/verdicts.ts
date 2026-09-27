/**
 * Verdict on one draft name against the project's observed naming: the rows
 * bound to the draft's type, the rows bound to the draft's callee, and the
 * concept vocabulary. The convention is induced from the rows, never assumed —
 * a history that names by role accepts a role name, and a fallback convention
 * (callee-derived locals, a return verb) applies only when the project-wide
 * prior shows it.
 */
import type {
  IdentifierBoundCallee,
  IdentifierDeclarationKind,
  IdentifierTypeMultiplicity,
} from "../../../contracts/types/codegraph-extraction.js";
import type { SymbolDefinitionKind } from "../../../contracts/types/codegraph-symbols.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import {
  detectIdentifierCasing,
  joinIdentifierWords,
  singularizeIdentifierWord,
  splitIdentifierWords,
  typeNameLastSegment,
  typeNameWords,
} from "./casing.js";
import { splitNameSlots, type NameSlots } from "./name-slots.js";
import {
  calleeDerivedName,
  classifyNamingShape,
  isNonConceptType,
  matchesTypeWords,
  mergedSameTypeSiblingN,
  shapeDistribution,
  spellsTypeName,
  typeTailWords,
  type NamingShape,
  type NamingShapeDistribution,
  type NamingShapeRow,
} from "./shapes.js";
import {
  alignHead,
  alignQualifiers,
  anchoredHeadCandidates,
  correctedSimilarityFloor,
  establishedModifiers,
  isVocabularyWord,
  modifierLift,
  pathTerms,
  sharesWordStem,
  type ModifierUse,
  type TermAlternative,
} from "./term-alignment.js";
import type { ConceptTerm } from "./terms.js";
import {
  deriveTypeRoles,
  expectedRoleFor,
  isNamespaceDeclaration,
  isRoleFamilyMember,
  meetsProjectConventionSpread,
  projectSuffixRole,
  projectSupertypes,
  type ExpectedTypeRole,
  type TypeNameRow,
  type TypeRoleAssignment,
  type TypeRoleEvidence,
} from "./type-roles.js";

/** The role a type draft was expected to carry: its word, the evidence behind it, example type names. */
export interface NamingExpectedTypeRole {
  word: string;
  evidence: TypeRoleEvidence;
  examples: string[];
}

export type NamingVerdict =
  | {
      verdict: "CONFORMS";
      /**
       * A type draft conforming by project suffix or lexical alignment alone,
       * one of whose words the project spells with another, similar word
       * (bd tea-rags-mcp-433d2) — `EmbeddingBackend` → `provider`. Never on a
       * name carrying its expected (family / directory) role. CONFORMS judges
       * vocabulary only, never whether the name fits the behaviour.
       */
      alternatives?: TermAlternative[];
    }
  | { verdict: "MISFIT"; suggestion: string; holder?: string; role?: NamingExpectedTypeRole }
  | { verdict: "NEW_TERM"; topTerms: string[]; alternatives?: TermAlternative[] }
  | { verdict: "COLLISION"; existing: { symbolId: string; relPath: string } };

/** One `byType` aggregate row: a name bound to the draft's type `n` times. */
export interface NamingByTypeRow {
  kind: IdentifierDeclarationKind;
  name: string;
  n: number;
  exampleOwner: string;
  /** The casing of the row's own file language, when it differs from the draft's. */
  casing?: IdentifierCasing;
  /** Of `n`, the rows whose owner binds the type under another name ({@link NamingShapeRow}); absent = unknown. */
  sameTypeSiblingN?: number;
}

/** One `byCallee` aggregate row: a name bound to a call of `receiver.member` `n` times. */
export interface NamingByCalleeRow {
  member: string;
  receiver?: string;
  kind: IdentifierDeclarationKind;
  name: string;
  n: number;
  exampleOwner: string;
  /** The row's recovered type (e.g. `finder`), when it has one. */
  typeName?: string;
  /** The casing of the row's own file language, when it differs from the draft's. */
  casing?: IdentifierCasing;
}

/** A verb's share of the project's `VERB_TYPE` returns (`find` in `find_x`). */
export interface NamingReturnVerbShare {
  verb: string;
  share: number;
}

export interface DraftNameJudgementInput {
  name: string;
  /** Defaults to `local`. */
  kind?: IdentifierDeclarationKind;
  typeName?: string;
  /**
   * `many` for a collection of `typeName` (`Item[]`). The caller passes only the
   * rows of the same multiplicity; a `many` draft that spells the type must also
   * agree in number with them. Absent = one.
   */
  typeMultiplicity?: IdentifierTypeMultiplicity;
  /** The canonical casing of the draft's role (from the language descriptor). */
  casing: IdentifierCasing;
  /** The language's non-concept types (`naming.nonConceptTypes`); absent → only the universal rule applies. */
  nonConceptTypes?: readonly string[];
  /** The call the draft is bound to — drives `byCallee` when the type is unknown. */
  callee?: IdentifierBoundCallee;
  byTypeRows?: readonly NamingByTypeRow[];
  byCalleeRows?: readonly NamingByCalleeRow[];
  conceptTerms?: readonly ConceptTerm[];
  /**
   * The project / scope-wide shape distribution per kind, over all rows (not
   * one type's or one callee's). The only licence for a fallback suggestion
   * when the draft's own type / callee has no rows.
   */
  projectShapePrior?: Partial<Record<IdentifierDeclarationKind, NamingShapeDistribution>>;
  /** The project's `VERB_TYPE` return verbs with their shares — licenses the return fallback. */
  projectReturnVerbs?: readonly NamingReturnVerbShare[];
}

/** A draft's shape conforms when it holds at least this share of the observed rows. */
const CONFORMING_SHARE = 0.2;
/** A fallback convention needs this share of the project prior … */
const PRIOR_SUPPORT_SHARE = 0.5;
/** … at this prior confidence. */
const PRIOR_SUPPORT_CONFIDENCE = 0.5;
const TOP_CONCEPT_TERMS = 5;
/** Names a NEW_TERM on a novel FREE value name carries from the type's rows. */
const TOP_TYPE_NAMES = 5;

/** A stage with no evidence of its own; `unsupported` = a fallback applied but the project prior did not license it. */
type NamingStageOutcome = NamingVerdict | "unsupported" | undefined;

interface JudgedRows {
  rows: readonly (NamingShapeRow & { exampleOwner: string })[];
  typeName?: string;
  callee?: IdentifierBoundCallee;
  /**
   * The rows are the draft type's or bound callee's own and the draft is a
   * value: a FREE draft conforms only with a name the rows already hold — a
   * role-naming history licenses its own roles, not any word (see
   * {@link judgeFreeValueName}).
   */
  freeNameMustBeKnown?: boolean;
}

/** CONFORMS when the draft's shape holds ≥ 20% of the rows, else MISFIT naming the most frequent row. */
function judgeAgainstRows(
  input: DraftNameJudgementInput,
  kind: IdentifierDeclarationKind,
  judged: JudgedRows,
): NamingVerdict {
  const context = { kind, casing: input.casing, typeName: judged.typeName, callee: judged.callee };
  const distribution = shapeDistribution(judged.rows, context);
  const shareOf = (shape: NamingShape) => distribution.shares.find((s) => s.shape === shape)?.share ?? 0;
  let draftShape = classifyNamingShape({ ...context, name: input.name });
  // Rows counted by co-occurrence split QUALIFIED from lone-prefix FREE; the
  // draft's owner is unknown, so a QUALIFIED draft is judged as whichever
  // reading the rows accept, QUALIFIED first.
  if (
    draftShape === "QUALIFIED" &&
    shareOf("QUALIFIED") < CONFORMING_SHARE &&
    judged.rows.some((row) => row.sameTypeSiblingN !== undefined)
  ) {
    draftShape = "FREE";
  }
  const share = shareOf(draftShape);
  if (share < CONFORMING_SHARE) {
    const top = judged.rows.reduce((best, row) => (row.n > best.n ? row : best));
    return { verdict: "MISFIT", suggestion: top.name, holder: top.exampleOwner };
  }
  if (draftShape === "FREE" && judged.freeNameMustBeKnown === true) {
    return judgeFreeValueName(input.name, judged.rows);
  }
  if (input.typeMultiplicity === "many" && spellsTypeName(draftShape)) {
    return judgeCollectionNumber(input.name, judged.rows, (row) =>
      spellsTypeName(
        classifyNamingShape({
          ...context,
          name: row.name,
          typeName: row.typeName ?? context.typeName,
          casing: row.casing ?? context.casing,
        }),
      ),
    );
  }
  return { verdict: "CONFORMS" };
}

/**
 * A FREE value draft whose shape the type's or callee's rows accept: CONFORMS
 * when one of those rows already carries the name (compared by words in either
 * number, so a snake row names a camel draft and `rows` names `row`), else
 * NEW_TERM — the project names the value by role, and this role is one it has
 * never used. `topTerms` carries the rows' own top names (heaviest first,
 * merged per name): for a type or callee with history the concept terms are
 * never consulted, so the slot holds the vocabulary the draft departs from.
 */
function judgeFreeValueName(name: string, rows: readonly NamingShapeRow[]): NamingVerdict {
  const wordKey = (identifier: string) => splitIdentifierWords(identifier).map(singularizeIdentifierWord).join("_");
  const draftKey = wordKey(name);
  const perName = new Map<string, number>();
  for (const row of rows) perName.set(row.name, (perName.get(row.name) ?? 0) + row.n);
  if ([...perName.keys()].some((known) => wordKey(known) === draftKey)) {
    return { verdict: "CONFORMS" };
  }
  const topTerms = [...perName]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TYPE_NAMES)
    .map(([known]) => known);
  return { verdict: "NEW_TERM", topTerms };
}

/** True when the last word of `name` is a plural (`items`, `documentRows`). */
function endsInPlural(name: string): boolean {
  const words = splitIdentifierWords(name);
  const last = words[words.length - 1];
  return last !== undefined && singularizeIdentifierWord(last) !== last;
}

/**
 * A collection draft that spells its type must agree in number with the rows
 * that spell it: `item` for an `Item[]` where the project writes `items` is a
 * MISFIT naming `items`. Induced, not assumed — rows that spell collections in
 * the singular make the singular conform. No spelling rows → nothing to agree with.
 */
function judgeCollectionNumber(
  name: string,
  rows: readonly (NamingShapeRow & { exampleOwner: string })[],
  spells: (row: NamingShapeRow) => boolean,
): NamingVerdict {
  const spelling = rows.filter(spells);
  const total = spelling.reduce((s, row) => s + row.n, 0);
  const plural = endsInPlural(name);
  const agreeing = spelling.filter((row) => endsInPlural(row.name) === plural).reduce((s, row) => s + row.n, 0);
  if (total === 0 || agreeing >= CONFORMING_SHARE * total) return { verdict: "CONFORMS" };
  const top = spelling.reduce((best, row) => (row.n > best.n ? row : best));
  return { verdict: "MISFIT", suggestion: top.name, holder: top.exampleOwner };
}

function sameReceiver(a: string | undefined, b: string | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** The type most rows carry, weighted by `n`. */
function dominantRowType(rows: readonly NamingByCalleeRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.typeName) counts.set(row.typeName, (counts.get(row.typeName) ?? 0) + row.n);
  let best: string | undefined;
  for (const [typeName, n] of counts) if (best === undefined || n > (counts.get(best) ?? 0)) best = typeName;
  return best;
}

function priorIsConfident(prior: NamingShapeDistribution | undefined): prior is NamingShapeDistribution {
  return prior !== undefined && prior.confidence >= PRIOR_SUPPORT_CONFIDENCE;
}

/** The project's dominant return verb, when a confident `return` prior and a ≥ 50% verb license it. */
function supportedReturnVerb(input: DraftNameJudgementInput): string | undefined {
  if (!priorIsConfident(input.projectShapePrior?.return)) return undefined;
  const top = [...(input.projectReturnVerbs ?? [])].sort((a, b) => b.share - a.share)[0];
  return top && top.share >= PRIOR_SUPPORT_SHARE ? top.verb : undefined;
}

/** True when a confident prior for `kind` holds ≥ 50% `CALLEE_DERIVED`. */
function calleeDerivedIsSupported(input: DraftNameJudgementInput, kind: IdentifierDeclarationKind): boolean {
  const prior = input.projectShapePrior?.[kind];
  if (!priorIsConfident(prior)) return false;
  return (prior.shares.find((s) => s.shape === "CALLEE_DERIVED")?.share ?? 0) >= PRIOR_SUPPORT_SHARE;
}

/**
 * Rows of several kinds folded into one per (name, casing), `n` summed — a name
 * held by 4 params and 4 fields outweighs one held by 6 params. The example
 * owner is the heaviest contributing row's (the first on a tie).
 */
function mergeRowsByName(rows: readonly NamingByTypeRow[]): NamingByTypeRow[] {
  const merged = new Map<string, { row: NamingByTypeRow; topN: number }>();
  for (const row of rows) {
    const key = `${row.name}\u0000${row.casing ?? ""}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { row: { ...row }, topN: row.n });
      continue;
    }
    const siblings = mergedSameTypeSiblingN(prev.row, row);
    if (siblings !== undefined) prev.row.sameTypeSiblingN = siblings;
    prev.row.n += row.n;
    if (row.n > prev.topN) [prev.row.exampleOwner, prev.topN] = [row.exampleOwner, row.n];
  }
  return [...merged.values()].map(({ row }) => row);
}

/**
 * A value draft whose type is held only by `return` rows: the project's noun
 * for the type is the type tail those return names end in, weighted by `n` —
 * `computeFileSignals` / `assembleFileSignals` → `fileSignals` for
 * `GitFileSignals`, in the row's own casing. A draft that spells the type
 * conforms; any other name is a MISFIT naming the noun, held by the heaviest
 * return row carrying it. No return name ends in a type tail → `undefined`.
 */
function judgeByReturnNoun(
  input: DraftNameJudgementInput,
  kind: IdentifierDeclarationKind,
  typeName: string,
  returnRows: readonly NamingByTypeRow[],
): NamingStageOutcome {
  const nouns = new Map<string, { noun: string; n: number; holder: NamingByTypeRow }>();
  for (const row of returnRows) {
    const tail = typeTailWords(row.name, typeName);
    if (tail === undefined) continue;
    const key = tail.join("_");
    const entry = nouns.get(key) ?? { noun: joinIdentifierWords(tail, row.casing ?? input.casing), n: 0, holder: row };
    entry.n += row.n;
    if (row.n > entry.holder.n) entry.holder = row;
    nouns.set(key, entry);
  }
  let best: { noun: string; n: number; holder: NamingByTypeRow } | undefined;
  for (const entry of nouns.values()) if (!best || entry.n > best.n) best = entry;
  if (!best) return undefined;
  const shape = classifyNamingShape({ name: input.name, kind, casing: input.casing, typeName });
  if (spellsTypeName(shape)) return { verdict: "CONFORMS" };
  return { verdict: "MISFIT", suggestion: best.noun, holder: best.holder.exampleOwner };
}

function judgeByType(
  input: DraftNameJudgementInput,
  kind: IdentifierDeclarationKind,
  typeName: string,
): NamingStageOutcome {
  const typeRows = input.byTypeRows ?? [];
  const kindRows = typeRows.filter((row) => row.kind === kind);
  const freeNameMustBeKnown = kind !== "return";
  if (kindRows.length > 0) return judgeAgainstRows(input, kind, { rows: kindRows, typeName, freeNameMustBeKnown });
  if (kind !== "return") {
    // No rows of the draft's kind: the type's value rows of the other kinds, one row per name.
    const otherKindRows = mergeRowsByName(typeRows.filter((row) => row.kind !== "return"));
    if (otherKindRows.length > 0) {
      return judgeAgainstRows(input, kind, { rows: otherKindRows, typeName, freeNameMustBeKnown });
    }
    return judgeByReturnNoun(input, kind, typeName, typeRows);
  }
  if (typeRows.length === 0) return undefined;
  // A known type with no return history: the project's own dominant verb, if it has one.
  const verb = supportedReturnVerb(input);
  if (verb === undefined) return "unsupported";
  const words = splitIdentifierWords(input.name);
  const typeWords = typeNameWords(typeName);
  if (words[0] === verb && matchesTypeWords(words.slice(1), typeWords)) return { verdict: "CONFORMS" };
  return { verdict: "MISFIT", suggestion: joinIdentifierWords([verb, ...typeWords], input.casing) };
}

function judgeByCallee(
  input: DraftNameJudgementInput,
  kind: IdentifierDeclarationKind,
  callee: IdentifierBoundCallee,
  typeName: string | undefined,
): NamingStageOutcome {
  const calleeRows = (input.byCalleeRows ?? []).filter(
    (row) => row.kind === kind && row.member === callee.member && sameReceiver(row.receiver, callee.receiver),
  );
  if (calleeRows.length > 0) {
    return judgeAgainstRows(input, kind, {
      rows: calleeRows,
      callee,
      typeName: typeName ?? dominantRowType(calleeRows),
      freeNameMustBeKnown: kind !== "return",
    });
  }
  if (kind !== "local" && kind !== "field") return undefined;
  const derived = calleeDerivedName(callee.member, input.casing);
  if (derived === undefined) return undefined;
  // No rows for this callee: the callee-derived name only where the project names that way.
  if (!calleeDerivedIsSupported(input, kind)) return "unsupported";
  const shape = classifyNamingShape({ name: input.name, kind, casing: input.casing, callee });
  return shape === "CALLEE_DERIVED" ? { verdict: "CONFORMS" } : { verdict: "MISFIT", suggestion: derived };
}

function topConceptTerms(terms: readonly ConceptTerm[] | undefined): string[] {
  return (terms ?? []).slice(0, TOP_CONCEPT_TERMS).map((t) => t.term);
}

function judgeByConcept(name: string, terms: readonly ConceptTerm[]): NamingVerdict {
  const topTerms = topConceptTerms(terms);
  const termWords = new Set(topTerms.flatMap((term) => term.split("_")));
  const draftWords = splitIdentifierWords(name).map(singularizeIdentifierWord);
  return draftWords.some((word) => termWords.has(word)) ? { verdict: "CONFORMS" } : { verdict: "NEW_TERM", topTerms };
}

/**
 * Judges a draft name, strongest evidence first:
 *
 * 1. typed (a concept type, see `isNonConceptType`) with rows of the draft's
 *    kind → shape share ≥ 0.2 CONFORMS, else MISFIT naming the most frequent
 *    row — except a FREE value draft (`param`, `local`, `field`), which
 *    conforms only with a name the type's rows already carry (compared by
 *    words) and is otherwise a NEW_TERM whose `topTerms` are the type's top 5
 *    names (`x: SymbolDefinition` against `defs` / `candidates` / `fallback`);
 *    rows carrying `sameTypeSiblingN` count a qualified name as QUALIFIED only
 *    beside a second binding of the type, FREE otherwise, so a QUALIFIED draft
 *    (its owner unknown) that the QUALIFIED share rejects is judged as FREE;
 *    a `return` with no return rows for a known type → the project's
 *    dominant return verb + type, when licensed; a value draft (`param`,
 *    `local`, `field`) with no rows of its kind → the type's value rows of the
 *    OTHER kinds, one row per name with `n` summed across kinds, judged the
 *    same way (a local `meta: GitFileSignals` against params and fields named
 *    `fileSignals` is a MISFIT); a value draft whose type has ONLY `return`
 *    rows → the project's noun for the type, the type tail those return names
 *    end in weighted by `n` (`computeFileSignals` → `fileSignals`): a draft
 *    spelling the type CONFORMS, any other a MISFIT naming the noun; a `many`
 *    draft that spells its type must also agree in number with the spelling
 *    rows (`item: Item[]` against `items` is a MISFIT) — the caller passes rows
 *    of the draft's multiplicity only;
 * 2. bound to a callee → the `byCallee` rows of that member / receiver and kind,
 *    judged the same way (rows carry their own recovered type) — a FREE value
 *    draft, too, conforms only with a name those rows carry, else NEW_TERM
 *    with their top names (`thing = registry.findByName(…)` against `entry`);
 *    with no rows, a
 *    `local` / `field` whose callee derives a name (`find_x!` → `x`) must be
 *    `CALLEE_DERIVED`, when licensed;
 * 3. a fallback the project prior does not license (licence: ≥ 50% share at
 *    prior confidence ≥ 0.5 — `CALLEE_DERIVED` for the kind, or the top return
 *    verb) → NEW_TERM with the concept's top terms, no suggestion;
 * 4. concept terms → NEW_TERM when no draft word appears in the top 5 terms;
 * 5. a concept type none of the above could compare with — no history at all,
 *    or history with no comparable row (return names carrying no type tail)
 *    → NEW_TERM with no terms, never a false CONFORMS;
 * 6. otherwise (untyped, or a non-concept type) CONFORMS — nothing to judge against.
 *
 * Concept terms (3, 4) speak only for an untyped draft or a typed one whose
 * type has no history at all: a type the project already holds is judged by
 * its own rows, and a concept query's vocabulary says nothing about them.
 */
export function judgeDraftName(input: DraftNameJudgementInput): NamingVerdict {
  const kind = input.kind ?? "local";
  const typeName =
    input.typeName !== undefined && !isNonConceptType(input.typeName, input.nonConceptTypes ?? [])
      ? input.typeName
      : undefined;
  const typeHasHistory = typeName !== undefined && (input.byTypeRows?.length ?? 0) > 0;
  const conceptTerms = typeHasHistory ? undefined : input.conceptTerms;

  const byType = typeName !== undefined ? judgeByType(input, kind, typeName) : undefined;
  if (byType !== undefined && byType !== "unsupported") return byType;

  const byCallee = input.callee ? judgeByCallee(input, kind, input.callee, typeName) : undefined;
  if (byCallee !== undefined && byCallee !== "unsupported") return byCallee;

  if (byType === "unsupported" || byCallee === "unsupported") {
    return { verdict: "NEW_TERM", topTerms: topConceptTerms(conceptTerms) };
  }

  if (conceptTerms && conceptTerms.length > 0) return judgeByConcept(input.name, conceptTerms);

  // A concept type nothing above could compare with — no history, or history
  // with no comparable row — is no evidence of conformance.
  if (typeName !== undefined) return { verdict: "NEW_TERM", topTerms: [] };
  return { verdict: "CONFORMS" };
}

// ── type and constant drafts (bd tea-rags-mcp-vi0wx) ─────────────────────────

/** The declaration kinds a TYPE draft is judged against; a constant draft is judged against `constant`. */
export const TYPE_DRAFT_KINDS: readonly SymbolDefinitionKind[] = ["class", "module", "interface", "enum", "type_alias"];

/** Which population a `kind: "type"` draft belongs to: the project's types, or its constants. */
export type TypeDraftPopulation = "type" | "constant";

/** Term alignment's default lift floor: a modifier must be over-represented 2× in the concept code. */
const DEFAULT_LIFT_FLOOR = 2;
/** Directories listed on a head alternative. */
const MAX_HEAD_DOMAINS = 5;
/** Example types listed on a head alternative found by meaning. */
const MAX_HEAD_EXAMPLES = 3;
/**
 * Qualifier alternatives offered, most lifted first. Live on the self-index
 * (3,600 declarations) an unbounded list ran to 17 for `CalculatedDoc`; an agent
 * reads the top few.
 */
const MAX_QUALIFIER_ALTERNATIVES = 3;
/**
 * Head alternatives found by meaning. One: on the measurement set the runner-up
 * was never the draft's concept (`EmbeddingBackend`: `provider` 0.66, then
 * `factory` 0.54).
 */
const MAX_MEANING_HEAD_ALTERNATIVES = 1;
/** An ambient declaration file (`declare global`, `declare module "x"`) augments; it declares nothing new. */
const AMBIENT_DECLARATION_FILE = /\.d\.[cm]?ts$/;

/**
 * A draft is a constant when the caller says so (`symbolKind`), else when it
 * is written in SCREAMING_SNAKE — the one casing no language gives a type.
 */
export function typeDraftPopulation(draft: { name: string; symbolKind?: SymbolDefinitionKind }): TypeDraftPopulation {
  if (draft.symbolKind !== undefined) return draft.symbolKind === "constant" ? "constant" : "type";
  return detectIdentifierCasing(draft.name) === "screamingSnake" ? "constant" : "type";
}

/** Everything a type draft is judged against, derived once per population from the store's rows. */
export interface TypeNameEvidence {
  population: TypeDraftPopulation;
  /** The population's rows, one per (relPath, symbolId). */
  rows: readonly TypeNameRow[];
  roles: readonly TypeRoleAssignment[];
  /** Modifiers standing before ≥ 2 heads in ≥ 2 directories. */
  established: readonly ModifierUse[];
  /** Names per head word (a name's last word). */
  headCounts: ReadonlyMap<string, number>;
  /** Directories of the names per head word. */
  headDirs: ReadonlyMap<string, ReadonlySet<string>>;
}

function directoryOfPath(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash < 0 ? "" : relPath.slice(0, slash);
}

/**
 * The evidence of one population. A (relPath, symbolId) read twice — a Rust
 * associated const declared in two trait impls of one file — is one
 * declaration. Constants carry no ancestors: their roles come from directory
 * and project-suffix evidence only.
 */
export function typeNameEvidence(rows: readonly TypeNameRow[], population: TypeDraftPopulation): TypeNameEvidence {
  const seen = new Set<string>();
  const members: TypeNameRow[] = [];
  for (const row of rows) {
    if ((row.symbolKind === "constant") !== (population === "constant")) continue;
    const key = `${row.relPath}\u0000${row.symbolId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(population === "constant" ? { ...row, ancestors: [] } : row);
  }

  const modifiers = new Map<string, { heads: Set<string>; dirs: Set<string>; count: number }>();
  const headCounts = new Map<string, number>();
  const headDirs = new Map<string, Set<string>>();
  for (const row of members) {
    const words = typeNameWords(row.shortName);
    const head = words.at(-1);
    if (head === undefined) continue;
    const dir = directoryOfPath(row.relPath);
    headCounts.set(head, (headCounts.get(head) ?? 0) + 1);
    headDirs.set(head, (headDirs.get(head) ?? new Set<string>()).add(dir));
    for (const word of new Set(words.slice(0, -1))) {
      const use = modifiers.get(word) ?? { heads: new Set<string>(), dirs: new Set<string>(), count: 0 };
      use.heads.add(head);
      use.dirs.add(dir);
      use.count += 1;
      modifiers.set(word, use);
    }
  }

  return {
    population,
    rows: members,
    roles: deriveTypeRoles(members),
    established: establishedModifiers([...modifiers].map(([word, use]) => ({ word, ...use }))),
    headCounts,
    headDirs,
  };
}

export interface TypeDraftJudgementInput {
  name: string;
  /** The file the declaration will live in. */
  path: string;
  /** The planned ancestor — a type draft's family; ignored for a constant. */
  extends?: string;
  /**
   * The declaration kind, when known. A namespace ({@link isNamespaceDeclaration})
   * carries no role: neither demanded nor confirmed (bd tea-rags-mcp-59q9c).
   */
  symbolKind?: SymbolDefinitionKind;
  /** The casing a suggestion is rendered in when the draft's own is indeterminate (the language's role casing). */
  casing: IdentifierCasing;
  /** Built by {@link typeNameEvidence} for the draft's {@link typeDraftPopulation}. */
  evidence: TypeNameEvidence;
  /** Type names in the code nearest the draft's concept — the term-alignment lift sample. */
  conceptNames: readonly string[];
  liftFloor?: number;
  /**
   * Embedding similarity of two of the words {@link typeDraftAlignmentWords}
   * names (bd tea-rags-mcp-433d2), on the caller's scale.
   */
  wordSimilarity?: (a: string, b: string) => number;
  /**
   * The project's null distribution of head-pair similarity on the same scale
   * (`nullSimilarityDistribution`). A word must EXCEED its quantile corrected
   * for the pairs the draft is compared on ({@link correctedSimilarityFloor}
   * over {@link typeDraftMeaningPairs}). Without both a similarity and a
   * distribution — no embedding, or a population too small to measure — the
   * draft is judged without alignment by meaning, and neither the spelling
   * variant nor the lifted qualifier alternatives are gated.
   */
  nullSimilarities?: readonly number[];
  /**
   * Heads ONE type carries that usage establishes as the project's term — the
   * type's file is imported at least as much as the project's `popular` files
   * (bd tea-rags-mcp-433d2). Candidates like the heads ≥ 2 types carry.
   */
  usageEstablishedHeads?: ReadonlySet<string>;
}

/** The first existing TYPE with the draft's short name in another, non-ambient file. */
function collidingType(input: TypeDraftJudgementInput): { symbolId: string; relPath: string } | undefined {
  if (input.evidence.population !== "type") return undefined;
  const shortName = typeNameLastSegment(input.name);
  const hits = input.evidence.rows
    .filter(
      (row) => row.shortName === shortName && row.relPath !== input.path && !AMBIENT_DECLARATION_FILE.test(row.relPath),
    )
    .sort((a, b) => a.relPath.localeCompare(b.relPath) || a.symbolId.localeCompare(b.symbolId));
  // A short name the project declares across modules is its convention (one `Result` per
  // namespace, qualified at use), not a homonym to warn about (bd tea-rags-mcp-icuxg).
  const files = new Set(hits.map((row) => row.relPath));
  const dirs = new Set(hits.map((row) => directoryOfPath(row.relPath)));
  if (meetsProjectConventionSpread(files.size, dirs.size)) return undefined;
  const hit = hits.at(0);
  return hit ? { symbolId: hit.symbolId, relPath: hit.relPath } : undefined;
}

/**
 * The lexical qualifier candidates: established modifiers lifted in the concept
 * code, never a word the draft already carries, the three most lifted. Chosen
 * by lift alone, so the pairs they form with the draft's qualifiers can be
 * counted before any is judged by meaning.
 */
function liftedQualifierCandidates(
  slots: NameSlots,
  words: readonly string[],
  evidence: TypeNameEvidence,
  conceptNames: readonly string[],
  liftFloor: number,
): TermAlternative[] {
  const lift = modifierLift(evidence.established, conceptNames, evidence.rows.length);
  return alignQualifiers(slots, evidence.established, lift, liftFloor)
    .filter((alternative) => !words.includes(alternative.word))
    .slice(0, MAX_QUALIFIER_ALTERNATIVES);
}

/**
 * A lifted qualifier candidate judged by meaning (bd tea-rags-mcp-433d2): lift
 * says the modifier is frequent in the concept code, not that it spells the
 * draft's qualifier — for a new concept the concept search returns unrelated
 * code and lift picks its noise (`HeadCandidate` drew `markdown`, `git`,
 * `commit`). A candidate stands in for the draft's qualifiers as a whole, so it
 * is compared with each of them; it is offered when the most similar exceeds
 * the draft's floor, and names that qualifier as the word it `replaces`.
 */
function gateQualifierCandidate(
  candidate: TermAlternative,
  qualifiers: readonly string[],
  gate: MeaningGate,
): TermAlternative | undefined {
  let best: { word: string; similarity: number } | undefined;
  for (const word of qualifiers) {
    const similarity = gate.similarity(word, candidate.word);
    if (best === undefined || similarity > best.similarity) best = { word, similarity };
  }
  if (best === undefined || !(best.similarity > gate.floor)) return undefined;
  return { ...candidate, similarity: roundSimilarity(best.similarity), replaces: best.word };
}

/**
 * Qualifier alternatives ({@link liftedQualifierCandidates}; with embeddings,
 * only those passing {@link gateQualifierCandidate}), then the head's dominant
 * spelling. Without embeddings — no port, a failed request, a population too
 * small for a floor — lift alone decides, as before alignment by meaning.
 */
function termAlternatives(
  input: TypeDraftJudgementInput,
  words: readonly string[],
  gate: MeaningGate | undefined,
): TermAlternative[] {
  const { evidence } = input;
  const slots = draftSlots(words, evidence);
  const lifted = liftedQualifierCandidates(
    slots,
    words,
    evidence,
    input.conceptNames,
    input.liftFloor ?? DEFAULT_LIFT_FLOOR,
  );
  const alternatives =
    gate === undefined
      ? lifted
      : lifted.flatMap(
          (candidate) => gateQualifierCandidate(candidate, slots.qualifiers.filter(isVocabularyWord), gate) ?? [],
        );
  const head = alignHead(slots, evidence.headCounts);
  const draftHead = slots.head.at(-1);
  const similarity = head === undefined || draftHead === undefined ? undefined : gate?.similarity(draftHead, head);
  // With embeddings, a spelling variant must also MEAN the head: `site` abbreviates `splitter` letter by letter.
  if (head !== undefined && (gate === undefined || (similarity ?? 0) > gate.floor)) {
    const draftHeadCount = evidence.headCounts.get(slots.head.at(-1) ?? "") ?? 0;
    alternatives.push({
      word: head,
      slot: "head",
      heads: [],
      domains: [...(evidence.headDirs.get(head) ?? [])].sort().slice(0, MAX_HEAD_DOMAINS),
      lift: (evidence.headCounts.get(head) ?? 0) / Math.max(1, draftHeadCount),
      ...(similarity !== undefined ? { similarity: roundSimilarity(similarity) } : {}),
    });
  }
  return alternatives;
}

/** The head words of the type names in the code nearest a concept. */
function conceptHeadWords(conceptNames: readonly string[]): Set<string | undefined> {
  return new Set(conceptNames.map((name) => typeNameWords(name).at(-1)));
}

function draftSlots(words: readonly string[], evidence: TypeNameEvidence): NameSlots {
  return splitNameSlots(words.join("_"), new Set(evidence.headCounts.keys()));
}

/** The similarity and the floor it is judged against. */
interface MeaningGate {
  similarity: (a: string, b: string) => number;
  floor: number;
}

/**
 * The similarity and the draft's floor — both, or no judgement by meaning. The
 * floor is the null distribution's quantile corrected for every pair the draft
 * is compared on ({@link typeDraftMeaningPairs}), counted before any is judged
 * so the floor never depends on its own outcome.
 */
function meaningGate(input: TypeDraftJudgementInput): MeaningGate | undefined {
  const { wordSimilarity, nullSimilarities } = input;
  if (wordSimilarity === undefined || nullSimilarities === undefined) return undefined;
  const admitted = input.usageEstablishedHeads ?? new Set<string>();
  const comparisons = typeDraftMeaningPairs(
    input,
    input.evidence,
    input.conceptNames,
    admitted,
    input.liftFloor ?? DEFAULT_LIFT_FLOOR,
  ).length;
  return { similarity: wordSimilarity, floor: correctedSimilarityFloor(nullSimilarities, comparisons) };
}

function roundSimilarity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** A type draft as role evidence reads it: its name, the file it lives in, its planned ancestor, its kind. */
export interface TypeDraftPlacement {
  name: string;
  path: string;
  extends?: string;
  symbolKind?: SymbolDefinitionKind;
}

/** The draft's expected role ({@link expectedRoleFor}); a constant has no family, so its `extends` is ignored. */
function draftRole(draft: TypeDraftPlacement, evidence: TypeNameEvidence): ExpectedTypeRole | undefined {
  return expectedRoleFor(evidence.roles, {
    path: draft.path,
    ...(evidence.population === "type" && draft.extends !== undefined ? { extends: draft.extends } : {}),
  });
}

/**
 * The supertypes a type draft is KNOWN to declare, by last namespace segment:
 * its `extends`, plus — when the draft names a declaration already at its
 * `path` — that declaration's own supertypes. `undefined` when they declare
 * none: a new draft that states no `extends` has not said it declares none,
 * and a declaration with no supertypes may still match a family structurally
 * (TS) or by duck typing (Ruby).
 */
function knownDraftSupertypes(draft: TypeDraftPlacement, evidence: TypeNameEvidence): Set<string> | undefined {
  if (evidence.population !== "type") return undefined;
  const own = ownDeclarations(draft, evidence);
  const declared = [...(draft.extends !== undefined ? [draft.extends] : []), ...own.flatMap((row) => row.ancestors)];
  // Declaring nothing is no evidence of non-membership: only a declared supertype can miss.
  if (declared.length === 0) return undefined;
  return projectSupertypes(evidence.rows)(draft.name, declared);
}

/** The existing declarations the draft names: its short name, at its `path`. */
function ownDeclarations(draft: TypeDraftPlacement, evidence: TypeNameEvidence): TypeNameRow[] {
  const shortName = typeNameLastSegment(draft.name);
  return evidence.rows.filter((row) => row.relPath === draft.path && row.shortName === shortName);
}

/** The draft's declaration kind: the caller's, else the existing declaration's; `undefined` when unknown. */
function knownDraftKind(draft: TypeDraftPlacement, evidence: TypeNameEvidence): SymbolDefinitionKind | undefined {
  if (draft.symbolKind !== undefined) return draft.symbolKind;
  return ownDeclarations(draft, evidence).find((row) => row.symbolKind !== null)?.symbolKind ?? undefined;
}

/**
 * The role word of the draft's directory or project-suffix family when the
 * draft is KNOWN not to belong to it ({@link isRoleFamilyMember}, bd
 * tea-rags-mcp-tun7x / 49fsr) — the test the derivation applies to an existing
 * type. A cohesive family asks for its supertype (`RubyConeDispatchResolver`
 * `implements DispatchResolverComponent` among `*SymbolResolutionStrategy`); a
 * project suffix also asks for its form (`module ClientPushBaseData` among
 * `*Data` type aliases). A non-member's role neither demands nor confirms, and
 * its word is no head for the draft either. `undefined` for an inheritance role
 * and for a draft whose kind and supertypes are unknown.
 */
function familyNonMemberRole(
  draft: TypeDraftPlacement,
  evidence: TypeNameEvidence,
  role: ExpectedTypeRole | undefined = draftRole(draft, evidence),
): string | undefined {
  if (role === undefined || role.evidence === "inheritance") return undefined;
  const supertypes = knownDraftSupertypes(draft, evidence);
  const symbolKind = knownDraftKind(draft, evidence);
  const member = isRoleFamilyMember(role, {
    ...(supertypes !== undefined ? { supertypes } : {}),
    ...(symbolKind !== undefined ? { symbolKind } : {}),
  });
  return member ? undefined : role.role;
}

/**
 * The anchored head candidates grounded in the concept code: heads of type
 * names `conceptNames` holds — never the role word of a family the draft is
 * known not to belong to ({@link familyNonMemberRole}).
 */
function groundedHeadCandidates(
  slots: NameSlots,
  draft: TypeDraftPlacement,
  evidence: TypeNameEvidence,
  conceptNames: readonly string[],
  admitted: ReadonlySet<string>,
): ReturnType<typeof anchoredHeadCandidates> {
  const conceptHeads = conceptHeadWords(conceptNames);
  const withheld = familyNonMemberRole(draft, evidence);
  return anchoredHeadCandidates(
    slots,
    directoryOfPath(draft.path),
    evidence.rows,
    evidence.headCounts,
    admitted,
  ).filter((candidate) => conceptHeads.has(candidate.word) && candidate.word !== withheld);
}

/**
 * The (draft word, candidate word) pairs alignment by meaning scores for a
 * draft (bd tea-rags-mcp-433d2) — its m comparisons: the draft's head with the
 * spelling variant {@link alignHead} offers (gated by similarity) and with each
 * grounded {@link anchoredHeadCandidates} head (≥ 2 carriers, or `admitted` by
 * usage); each draft qualifier with each lifted qualifier candidate
 * ({@link liftedQualifierCandidates}, at `liftFloor`); every draft word with
 * each of its {@link pathTerms}, a pair sharing a stem excepted. Each distinct
 * pair counts once, even one an earlier alternative would pre-empt: the count
 * is fixed before any pair is judged.
 */
export function typeDraftMeaningPairs(
  draft: TypeDraftPlacement,
  evidence: TypeNameEvidence,
  conceptNames: readonly string[],
  admitted: ReadonlySet<string> = new Set(),
  liftFloor: number = DEFAULT_LIFT_FLOOR,
): [string, string][] {
  const words = typeNameWords(draft.name);
  const slots = draftSlots(words, evidence);
  const draftHead = slots.head.at(-1);
  if (draftHead === undefined) return [];
  const lifted = liftedQualifierCandidates(slots, words, evidence, conceptNames, liftFloor);
  const variant = alignHead(slots, evidence.headCounts);
  const heads = new Set([
    ...(variant ? [variant] : []),
    ...groundedHeadCandidates(slots, draft, evidence, conceptNames, admitted).map((candidate) => candidate.word),
  ]);
  const pairs = new Map<string, [string, string]>();
  const compare = (word: string, candidate: string): void => {
    pairs.set([word, candidate].sort().join("\u0000"), [word, candidate]);
  };
  for (const head of heads) compare(draftHead, head);
  // A version token (`v11`) is no word a modifier could replace: it is never compared.
  const qualifiers = slots.qualifiers.filter(isVocabularyWord);
  for (const candidate of lifted) for (const qualifier of qualifiers) compare(qualifier, candidate.word);
  for (const term of pathTerms(draft.path, words, conceptNames)) {
    for (const word of words) if (!sharesWordStem(word, term.word)) compare(word, term.word);
  }
  // One comparison per pair: `chunker` may be both the directory's head and its directory word.
  return [...pairs.values()];
}

/**
 * The words whose embeddings alignment by meaning compares: every word of
 * {@link typeDraftMeaningPairs}. Empty when there is nothing to compare the
 * draft with.
 */
export function typeDraftAlignmentWords(
  draft: TypeDraftPlacement,
  evidence: TypeNameEvidence,
  conceptNames: readonly string[],
  admitted: ReadonlySet<string> = new Set(),
): string[] {
  return [...new Set(typeDraftMeaningPairs(draft, evidence, conceptNames, admitted).flat())];
}

/**
 * The heads exactly ONE type carries among the draft's grounded anchored
 * candidates, with that type's file — the heads usage may establish
 * (`usageEstablishedHeads`). The caller reads the files' fan-in.
 */
export function singleCarrierHeadFiles(
  draft: TypeDraftPlacement,
  evidence: TypeNameEvidence,
  conceptNames: readonly string[],
): Map<string, string> {
  const slots = draftSlots(typeNameWords(draft.name), evidence);
  const single = new Set([...evidence.headCounts].filter(([, count]) => count === 1).map(([head]) => head));
  const files = new Map<string, string>();
  for (const candidate of groundedHeadCandidates(slots, draft, evidence, conceptNames, single)) {
    if (!single.has(candidate.word)) continue;
    const carrier = evidence.rows.find((row) => row.shortName === candidate.examples[0]);
    if (carrier) files.set(candidate.word, carrier.relPath);
  }
  return files;
}

/**
 * The anchored head most similar to the draft's head, when its similarity
 * exceeds the draft's corrected floor AND it heads a type name in the code
 * nearest the draft's concept (`conceptNames`) — the word alone is too weak a
 * signal: without that grounding `SymbolLookupTable` drew `row` (0.72) and
 * `IndexStalenessChecker` drew `guard` (0.71). None when `taken` already
 * aligns the head (a spelling variant: `SignalStatistics` → `stats`).
 */
function meaningHeadAlternatives(
  input: TypeDraftJudgementInput,
  words: readonly string[],
  taken: readonly TermAlternative[],
  gate: MeaningGate | undefined,
): TermAlternative[] {
  const { evidence } = input;
  if (gate === undefined || taken.some((alternative) => alternative.slot === "head")) return [];
  const slots = draftSlots(words, evidence);
  const draftHead = slots.head.at(-1) ?? "";
  const offered = new Set(taken.map((alternative) => alternative.word));
  const draftHeadCount = evidence.headCounts.get(draftHead) ?? 0;
  const admitted = input.usageEstablishedHeads ?? new Set<string>();
  return groundedHeadCandidates(slots, input, evidence, input.conceptNames, admitted)
    .filter((candidate) => !offered.has(candidate.word))
    .map((candidate) => ({ candidate, similarity: gate.similarity(draftHead, candidate.word) }))
    .filter(({ similarity }) => similarity > gate.floor)
    .sort((a, b) => b.similarity - a.similarity || a.candidate.word.localeCompare(b.candidate.word))
    .slice(0, MAX_MEANING_HEAD_ALTERNATIVES)
    .map(({ candidate, similarity }) => ({
      word: candidate.word,
      slot: "head" as const,
      heads: [],
      domains: candidate.domains.slice(0, MAX_HEAD_DOMAINS),
      lift: (evidence.headCounts.get(candidate.word) ?? 0) / Math.max(1, draftHeadCount),
      similarity: roundSimilarity(similarity),
      examples: candidate.examples.slice(0, MAX_HEAD_EXAMPLES),
    }));
}

/**
 * The draft's directory words ({@link pathTerms}) nearest one of its words
 * (bd tea-rags-mcp-433d2) — `IndexStalenessChecker` in `maintenance/freshness/`
 * → `freshness` for `staleness`. Every draft word is compared, head and
 * qualifiers; a pair sharing a stem (`chunk` / `chunker`) is not. The one most
 * similar pair above the floor is offered at its draft word's slot — never a
 * word `taken` offers, nor a second head.
 */
function pathTermAlternatives(
  input: TypeDraftJudgementInput,
  words: readonly string[],
  taken: readonly TermAlternative[],
  gate: MeaningGate | undefined,
): TermAlternative[] {
  if (gate === undefined) return [];
  const head = draftSlots(words, input.evidence).head.at(-1);
  const offered = new Set(taken.map((alternative) => alternative.word));
  const headTaken = taken.some((alternative) => alternative.slot === "head");
  let best: { term: { word: string; dir: string }; replaces: string; similarity: number } | undefined;
  for (const term of pathTerms(input.path, words, input.conceptNames)) {
    if (offered.has(term.word)) continue;
    for (const word of words) {
      if (sharesWordStem(word, term.word) || (word === head && headTaken)) continue;
      const similarity = gate.similarity(word, term.word);
      if (similarity > gate.floor && (best === undefined || similarity > best.similarity)) {
        best = { term, replaces: word, similarity };
      }
    }
  }
  if (best === undefined) return [];
  return [
    {
      word: best.term.word,
      ...(best.replaces === head ? { slot: "head" as const } : {}),
      heads: [],
      domains: [best.term.dir],
      lift: 0,
      similarity: roundSimilarity(best.similarity),
      replaces: best.replaces,
    },
  ];
}

/**
 * Judges a type or constant draft (spec §3–4), strongest evidence first:
 *
 * 1. MISFIT — the family role (via `extends`, types only), else the
 *    directory's, and the name's last word is not that role; suggestion = the
 *    name + the role, in the draft's own casing. A project suffix never sets
 *    an expected role: popular elsewhere, unanchored here, it is a guess;
 * 2. COLLISION — a TYPE draft whose short name another module already declares
 *    as a type (the draft's own file and ambient `*.d.ts` files excluded);
 *    constants never collide — `VERSION` in two modules is routine;
 * 3. NEW_TERM with `alternatives` — term alignment found an established
 *    modifier over-represented in the concept code, or the project's dominant
 *    spelling of the head — with embeddings, each only when it is also similar
 *    to the draft word it replaces, above the draft's corrected floor; soft,
 *    never MISFIT;
 * 4. CONFORMS — the name carries its expected role, or its head is a project
 *    suffix (the suffix confirms, never demands), or its head is a known head
 *    and every qualifier an established modifier;
 * 5. otherwise NEW_TERM with no alternatives — a new concept, a legitimate outcome.
 */
export function judgeTypeDraft(input: TypeDraftJudgementInput): NamingVerdict {
  const words = typeNameWords(input.name);
  const draftCasing = detectIdentifierCasing(input.name) ?? input.casing;
  // A namespace wraps its file's subject: no member of any role family (bd tea-rags-mcp-59q9c).
  const namespace = isNamespaceDeclaration({
    shortName: typeNameLastSegment(input.name),
    relPath: input.path,
    symbolKind: input.symbolKind,
  });
  const role = namespace ? undefined : draftRole(input, input.evidence);
  // Only inheritance and directory evidence set an EXPECTED role; a project suffix only confirms,
  // and a cohesive directory family only speaks for its members.
  const nonMember = familyNonMemberRole(input, input.evidence, role) !== undefined;
  const expected = role?.evidence === "projectSuffix" || nonMember ? undefined : role;
  if (expected && words.at(-1) !== expected.role) {
    return {
      verdict: "MISFIT",
      suggestion: joinIdentifierWords([...words, expected.role], draftCasing),
      role: { word: expected.role, evidence: expected.evidence, examples: expected.examples },
    };
  }

  const existing = collidingType(input);
  if (existing) return { verdict: "COLLISION", existing };

  const gate = meaningGate(input);
  const lexical = termAlternatives(input, words, gate);
  // The name carries its expected role: its head is right by construction.
  if (lexical.length === 0 && expected) return { verdict: "CONFORMS" };
  const byMeaning = [...lexical, ...meaningHeadAlternatives(input, words, lexical, gate)];
  const alternatives = [...byMeaning, ...pathTermAlternatives(input, words, byMeaning, gate)];
  if (lexical.length > 0) return { verdict: "NEW_TERM", topTerms: [], alternatives };
  const withAlternatives = alternatives.length > 0 ? { alternatives } : {};

  // A project suffix or a known head only CONFIRMS the words: a synonym head passes both,
  // so the verdict stays and the head alternatives ride along (bd tea-rags-mcp-433d2).
  // The suffix confirms only a member of its family — the test its carriers passed (bd tea-rags-mcp-49fsr).
  const suffix = namespace
    ? undefined
    : projectSuffixRole(input.evidence.roles, input.evidence.rows, words.at(-1) ?? "");
  if (suffix !== undefined && familyNonMemberRole(input, input.evidence, suffix) === undefined) {
    return { verdict: "CONFORMS", ...withAlternatives };
  }
  const establishedWords = new Set(input.evidence.established.map((use) => use.word));
  const headKnown = (input.evidence.headCounts.get(words.at(-1) ?? "") ?? 0) > 0;
  const aligned = headKnown && words.slice(0, -1).every((word) => establishedWords.has(word));
  return aligned
    ? { verdict: "CONFORMS", ...withAlternatives }
    : { verdict: "NEW_TERM", topTerms: [], ...withAlternatives };
}
