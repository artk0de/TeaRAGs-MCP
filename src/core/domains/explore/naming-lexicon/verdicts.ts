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
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import { joinIdentifierWords, singularizeIdentifierWord, splitIdentifierWords, typeNameWords } from "./casing.js";
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
import type { ConceptTerm } from "./terms.js";

export type NamingVerdict =
  | { verdict: "CONFORMS" }
  | { verdict: "MISFIT"; suggestion: string; holder?: string }
  | { verdict: "NEW_TERM"; topTerms: string[] };

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
   * The rows are the draft TYPE's own and the draft is a value: a FREE draft
   * conforms only with a name the rows already hold — a role-naming history
   * licenses its own roles, not any word (see {@link judgeFreeValueName}).
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
 * A FREE value draft whose shape the type's rows accept: CONFORMS when one of
 * those rows already carries the name (compared by words, so a snake row names
 * a camel draft), else NEW_TERM — the project names the type by role, and this
 * role is one it has never used. `topTerms` carries the type's own top names
 * (heaviest first, merged per name): for a type with history the concept terms
 * are never consulted, so the slot holds the vocabulary the draft departs from.
 */
function judgeFreeValueName(name: string, rows: readonly NamingShapeRow[]): NamingVerdict {
  const draftKey = splitIdentifierWords(name).join("_");
  const perName = new Map<string, number>();
  for (const row of rows) perName.set(row.name, (perName.get(row.name) ?? 0) + row.n);
  if ([...perName.keys()].some((known) => splitIdentifierWords(known).join("_") === draftKey)) {
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
 *    judged the same way (rows carry their own recovered type); with no rows, a
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
