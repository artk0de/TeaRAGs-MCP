/**
 * Verdict on one draft name against the project's observed naming: the rows
 * bound to the draft's type, the rows bound to the draft's callee, and the
 * concept vocabulary. The convention is induced from the rows, never assumed —
 * a history that names by role accepts a role name.
 */
import type {
  IdentifierBoundCallee,
  IdentifierDeclarationKind,
} from "../../../contracts/types/codegraph-extraction.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import { joinIdentifierWords, singularizeIdentifierWord, splitIdentifierWords, typeNameWords } from "./casing.js";
import {
  calleeDerivedName,
  classifyNamingShape,
  isNonConceptType,
  shapeDistribution,
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
}

export interface DraftNameJudgementInput {
  name: string;
  /** Defaults to `local`. */
  kind?: IdentifierDeclarationKind;
  typeName?: string;
  /** The canonical casing of the draft's role (from the language descriptor). */
  casing: IdentifierCasing;
  /** The call the draft is bound to — drives `byCallee` when the type is unknown. */
  callee?: IdentifierBoundCallee;
  byTypeRows?: readonly NamingByTypeRow[];
  byCalleeRows?: readonly NamingByCalleeRow[];
  conceptTerms?: readonly ConceptTerm[];
}

/** A draft's shape conforms when it holds at least this share of the observed rows. */
const CONFORMING_SHARE = 0.2;
const TOP_CONCEPT_TERMS = 5;
const DEFAULT_RETURN_VERB = "find";

interface JudgedRows {
  rows: readonly (NamingShapeRow & { exampleOwner: string })[];
  typeName?: string;
  callee?: IdentifierBoundCallee;
}

/** CONFORMS when the draft's shape holds ≥ 20% of the rows, else MISFIT naming the most frequent row. */
function judgeAgainstRows(
  input: DraftNameJudgementInput,
  kind: IdentifierDeclarationKind,
  judged: JudgedRows,
): NamingVerdict {
  const context = { kind, casing: input.casing, typeName: judged.typeName, callee: judged.callee };
  const distribution = shapeDistribution(judged.rows, context);
  const draftShape = classifyNamingShape({ ...context, name: input.name });
  const share = distribution.shares.find((s) => s.shape === draftShape)?.share ?? 0;
  if (share >= CONFORMING_SHARE) return { verdict: "CONFORMS" };
  const top = judged.rows.reduce((best, row) => (row.n > best.n ? row : best));
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

function judgeByType(
  input: DraftNameJudgementInput,
  kind: IdentifierDeclarationKind,
  typeName: string,
): NamingVerdict | undefined {
  const typeRows = input.byTypeRows ?? [];
  const kindRows = typeRows.filter((row) => row.kind === kind);
  if (kindRows.length > 0) return judgeAgainstRows(input, kind, { rows: kindRows, typeName });
  if (kind !== "return" || typeRows.length === 0) return undefined;
  // A known type with no return history: the verb form is the default convention.
  const shape = classifyNamingShape({ name: input.name, kind, casing: input.casing, typeName });
  if (shape === "VERB_TYPE" || shape === "EXACT") return { verdict: "CONFORMS" };
  return {
    verdict: "MISFIT",
    suggestion: joinIdentifierWords([DEFAULT_RETURN_VERB, ...typeNameWords(typeName)], input.casing),
  };
}

function judgeByCallee(
  input: DraftNameJudgementInput,
  kind: IdentifierDeclarationKind,
  callee: IdentifierBoundCallee,
  typeName: string | undefined,
): NamingVerdict | undefined {
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
  const shape = classifyNamingShape({ name: input.name, kind, casing: input.casing, callee });
  return shape === "CALLEE_DERIVED" ? { verdict: "CONFORMS" } : { verdict: "MISFIT", suggestion: derived };
}

function judgeByConcept(name: string, terms: readonly ConceptTerm[]): NamingVerdict {
  const topTerms = terms.slice(0, TOP_CONCEPT_TERMS).map((t) => t.term);
  const termWords = new Set(topTerms.flatMap((term) => term.split("_")));
  const draftWords = splitIdentifierWords(name).map(singularizeIdentifierWord);
  return draftWords.some((word) => termWords.has(word)) ? { verdict: "CONFORMS" } : { verdict: "NEW_TERM", topTerms };
}

/**
 * Judges a draft name, strongest evidence first:
 *
 * 1. typed (a concept type, see `isNonConceptType`) with rows of the draft's
 *    kind → shape share ≥ 0.2 CONFORMS, else MISFIT naming the most frequent
 *    row; a `return` with no return rows for a known type → the verb form
 *    (`find_` + type) is the default;
 * 2. bound to a callee → the `byCallee` rows of that member / receiver and kind,
 *    judged the same way (rows carry their own recovered type); with no rows, a
 *    `local` / `field` whose callee derives a name (`find_x!` → `x`) must be
 *    `CALLEE_DERIVED`;
 * 3. concept terms → NEW_TERM when no draft word appears in the top 5 terms;
 * 4. a concept type with no history at all → NEW_TERM with no terms;
 * 5. otherwise CONFORMS — nothing to judge against.
 */
export function judgeDraftName(input: DraftNameJudgementInput): NamingVerdict {
  const kind = input.kind ?? "local";
  const typeName = input.typeName !== undefined && !isNonConceptType(input.typeName) ? input.typeName : undefined;

  const byType = typeName !== undefined ? judgeByType(input, kind, typeName) : undefined;
  if (byType) return byType;

  const byCallee = input.callee ? judgeByCallee(input, kind, input.callee, typeName) : undefined;
  if (byCallee) return byCallee;

  if (input.conceptTerms && input.conceptTerms.length > 0) return judgeByConcept(input.name, input.conceptTerms);

  if (typeName !== undefined && input.byTypeRows?.length === 0) return { verdict: "NEW_TERM", topTerms: [] };
  return { verdict: "CONFORMS" };
}
