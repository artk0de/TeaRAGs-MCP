/**
 * Naming shapes: how an identifier's name relates to its type or to the call it
 * is bound to. Pure lexical classification — the co-occurrence check that turns
 * a QUALIFIED name into a confirmed qualifier (a second binding of the same type
 * in the same owner) needs the table and is the ops layer's job.
 */
import type {
  IdentifierBoundCallee,
  IdentifierDeclarationKind,
} from "../../../contracts/types/codegraph-extraction.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import {
  joinIdentifierWords,
  pluralizeIdentifierWord,
  renderIdentifier,
  renderIdentifierPlural,
  splitIdentifierWords,
  stripIdentifierDecorations,
  typeNameWords,
} from "./casing.js";

/**
 * - `EXACT` — the type rendered in the casing, singular or plural
 *   (`tax_automation_document`, `tax_automation_documents`).
 * - `QUALIFIED` — the type's words plus a qualifier before or after them
 *   (`tax_automation_document_ignored`, `source_tax_automation_document`).
 * - `TAIL` — a proper suffix of the type's words (`document`).
 * - `VERB_TYPE` — on a `return`: one verb word plus the type's words
 *   (`find_tax_automation_document!`).
 * - `CALLEE_DERIVED` — a `local` / `field` named after the member it is bound
 *   to, minus a verb prefix and `!` / `?` (`x = find_x!(id)`); needs no type.
 * - `FREE` — none of the above: a role name (`row`).
 *
 * Word comparisons accept the plural of the type's last word throughout, since
 * collection annotations are unwrapped to the element type upstream.
 */
export type NamingShape = "EXACT" | "QUALIFIED" | "TAIL" | "VERB_TYPE" | "CALLEE_DERIVED" | "FREE";

/** Verb words that prefix a finder / factory name: `find_x`, `getX`, `build_x`. */
export const NAMING_VERB_PREFIXES: readonly string[] = [
  "find",
  "get",
  "fetch",
  "load",
  "build",
  "create",
  "new",
  "make",
];

/** Everything {@link classifyNamingShape} reads about one identifier. */
export interface NamingShapeInput {
  name: string;
  kind: IdentifierDeclarationKind;
  /** The canonical casing of the identifier's role (from the language descriptor). */
  casing: IdentifierCasing;
  typeName?: string;
  callee?: IdentifierBoundCallee;
}

/**
 * True for a type name that names no concept. `nonConceptTypes` is the
 * language's list (`LanguageCapability.naming.nonConceptTypes`, passed in by the
 * ops layer) and is matched EXACTLY — no case folding, the language's own
 * spelling decides. Single-letter generics (`T`, `K`) and the empty name are a
 * universal rule owned here. Such types are recorded but excluded from
 * `byType`, and a draft typed with one is judged as untyped.
 */
export function isNonConceptType(typeName: string, nonConceptTypes: readonly string[]): boolean {
  const bare = typeName.replace(/^::/, "");
  return bare.length === 0 || /^[A-Z]$/.test(bare) || nonConceptTypes.includes(bare);
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

/** `words` equals `typeWords`, with the last word singular or plural. */
export function matchesTypeWords(words: readonly string[], typeWords: readonly string[]): boolean {
  if (words.length !== typeWords.length || typeWords.length === 0) return false;
  const last = typeWords.length - 1;
  if (!sameWords(words.slice(0, last), typeWords.slice(0, last))) return false;
  return words[last] === typeWords[last] || words[last] === pluralizeIdentifierWord(typeWords[last]);
}

function typeShape(
  name: string,
  nameWords: string[],
  typeName: string,
  input: NamingShapeInput,
): NamingShape | undefined {
  const typeWords = typeNameWords(typeName);
  if (typeWords.length === 0) return undefined;
  const bare = stripIdentifierDecorations(name);
  if (bare === renderIdentifier(typeName, input.casing) || bare === renderIdentifierPlural(typeName, input.casing)) {
    return "EXACT";
  }
  const extra = nameWords.length - typeWords.length;
  if (
    input.kind === "return" &&
    extra === 1 &&
    NAMING_VERB_PREFIXES.includes(nameWords[0]) &&
    matchesTypeWords(nameWords.slice(1), typeWords)
  ) {
    return "VERB_TYPE";
  }
  if (
    extra > 0 &&
    (matchesTypeWords(nameWords.slice(0, typeWords.length), typeWords) ||
      matchesTypeWords(nameWords.slice(extra), typeWords))
  ) {
    return "QUALIFIED";
  }
  if (extra < 0 && nameWords.length > 0 && matchesTypeWords(nameWords, typeWords.slice(-nameWords.length))) {
    return "TAIL";
  }
  return undefined;
}

/**
 * The words of a callee member with a leading verb word and `!` / `?` dropped:
 * `find_tax_automation_document!` / `findTaxAutomationDocument` →
 * `[tax, automation, document]`; a bare verb (`find`) → `[]`.
 */
export function calleeDerivedWords(member: string): string[] {
  const words = splitIdentifierWords(member);
  return words.length > 0 && NAMING_VERB_PREFIXES.includes(words[0]) ? words.slice(1) : words;
}

/** The name {@link calleeDerivedWords} renders in the casing, or `undefined` when it derives none. */
export function calleeDerivedName(member: string, casing: IdentifierCasing): string | undefined {
  const words = calleeDerivedWords(member);
  return words.length > 0 ? joinIdentifierWords(words, casing) : undefined;
}

/** Classifies one identifier's name into a {@link NamingShape}; type-based shapes win over `CALLEE_DERIVED`. */
export function classifyNamingShape(input: NamingShapeInput): NamingShape {
  const nameWords = splitIdentifierWords(input.name);
  if (input.typeName !== undefined) {
    const shape = typeShape(input.name, nameWords, input.typeName, input);
    if (shape) return shape;
  }
  if (input.callee && (input.kind === "local" || input.kind === "field")) {
    const derived = calleeDerivedWords(input.callee.member);
    if (derived.length > 0 && sameWords(nameWords, derived)) return "CALLEE_DERIVED";
  }
  return "FREE";
}

/** One shape's share of a row set. */
export interface NamingShapeShare {
  shape: NamingShape;
  share: number;
}

/** Shape shares over a row set, with its total count and a `(n/20)^2` confidence. */
export interface NamingShapeDistribution {
  /** Non-zero shares, largest first; they sum to 1. */
  shares: NamingShapeShare[];
  n: number;
  /** `min(1, (n / 20) ** 2)`. */
  confidence: number;
}

/** One aggregated name with its occurrence count; its own type / callee override the context's. */
export interface NamingShapeRow {
  name: string;
  n: number;
  typeName?: string;
  callee?: IdentifierBoundCallee;
}

/** What a row set shares: its kind and casing, and optionally a type or callee. */
export type NamingShapeContext = Omit<NamingShapeInput, "name">;

const CONFIDENCE_SUPPORT = 20;

/** Distribution of {@link NamingShape}s over aggregated rows, weighted by `n`. */
export function shapeDistribution(
  rows: readonly NamingShapeRow[],
  context: NamingShapeContext,
): NamingShapeDistribution {
  const counts = new Map<NamingShape, number>();
  let n = 0;
  for (const row of rows) {
    const shape = classifyNamingShape({
      ...context,
      name: row.name,
      typeName: row.typeName ?? context.typeName,
      callee: row.callee ?? context.callee,
    });
    counts.set(shape, (counts.get(shape) ?? 0) + row.n);
    n += row.n;
  }
  if (n === 0) return { shares: [], n: 0, confidence: 0 };
  const shares = [...counts]
    .filter(([, count]) => count > 0)
    .map(([shape, count]) => ({ shape, share: count / n }))
    .sort((a, b) => b.share - a.share);
  return { shares, n, confidence: Math.min(1, (n / CONFIDENCE_SUPPORT) ** 2) };
}
