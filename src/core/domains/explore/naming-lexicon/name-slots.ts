/**
 * The parts of a type name (bd tea-rags-mcp-vi0wx): the HEAD names the entity
 * (`Doc` in `CalculatedDoc`), the QUALIFIERS are the words before it
 * (`Calculated`), and a trailing prepositional COMPLEMENT (`ForFirm` in
 * `ObjectsForFirm`) names what the entity is related to — never the head, never
 * a qualifier. The one place that reads a head off a type name: role
 * derivation, draft judgement and term alignment all go through
 * {@link typeNameParts}. Pure: the project's known heads and role words come in
 * as arguments.
 */
import { typeNameWords } from "./casing.js";

/**
 * The words that open a prepositional complement: English prepositions, a
 * CLOSED grammatical class — a fact of the language, not a vocabulary read off a
 * project. The positional distribution of type, method and identifier names
 * separates them from compound interiors nowhere: `uploaded`, `resolution`,
 * `db` are as interior-only as `for` (spec 2026-09-26 §2). Left out, by what
 * they do inside a name:
 *   - `of` is the partitive of a classifier (`KindOfService`, `OutOfScope…`),
 *     whose semantic head FOLLOWS it — `KindOfService` commands are services;
 *   - `and` / `or` coordinate two modifiers or verbs of one compound
 *     (`CardAndBankPaymentMethodType`, `FindOrCreate`), whose head stays last.
 */
export const CONNECTOR_WORDS: ReadonlySet<string> = new Set([
  "for",
  "by",
  "to",
  "from",
  "with",
  "in",
  "on",
  "at",
  "as",
  "via",
  "per",
  "into",
  "over",
  "under",
  "without",
]);

/** A type name's words, lower-cased, split into qualifiers, head and trailing complement. */
export interface TypeNameParts {
  /** Every word of the name's last namespace segment. */
  words: string[];
  /** The words before the head. */
  qualifiers: string[];
  /** `undefined` for a name with no words. */
  head: string | undefined;
  /** The connector opening the complement; absent when the name has none. */
  connector?: string;
  /** The words after {@link connector}; empty when the name has no complement. */
  complement: string[];
}

/** Whether `words[i]` is a connector: a {@link CONNECTOR_WORDS} word, neither first nor last. */
export function isInteriorConnector(words: readonly string[], i: number): boolean {
  return i > 0 && i < words.length - 1 && CONNECTOR_WORDS.has(words[i]);
}

/** Reads a type name's parts with one population's role words ({@link typeNameParts}). */
export type TypeNameParser = (name: string) => TypeNameParts;

/**
 * The parts of `name` (type name, any casing, optionally namespaced). A word of
 * {@link CONNECTOR_WORDS} is a connector only in an INTERIOR position — never
 * the first word nor the last (`SignIn`, `GroupBy`, `WithRouter` are plain
 * compounds). A name with a connector is read two ways, and `roleWords` decides:
 * when its last word is one of them — a role word the project's names carry
 * with no connector (`BatchMarkAsReadWorker` is a worker) — the head is the last
 * word and every word before it a qualifier, as in a name without connector;
 * otherwise the head is the word before the FIRST connector, the words before
 * it its qualifiers, and the rest the complement (`ObjectsForFirm` → `objects`).
 */
export function typeNameParts(name: string, roleWords: ReadonlySet<string> = new Set()): TypeNameParts {
  const words = typeNameWords(name);
  const last = words.at(-1);
  const at = words.findIndex((_, i) => isInteriorConnector(words, i));
  if (at < 0 || (last !== undefined && roleWords.has(last))) {
    return { words, qualifiers: words.slice(0, -1), head: last, complement: [] };
  }
  return {
    words,
    qualifiers: words.slice(0, at - 1),
    head: words[at - 1],
    connector: words[at],
    complement: words.slice(at + 1),
  };
}

/** A name's words split into its head and the qualifiers before it, and its complement when it has one. */
export interface NameSlots {
  head: string[];
  qualifiers: string[];
  /** The words after a connector ({@link TypeNameParts.complement}); absent when the name has none. */
  complement?: string[];
}

/**
 * Splits `name` (type or value name, any casing, optionally namespaced) into
 * slots. The head is the LONGEST trailing phrase of the words up to the head of
 * `parse` found in `knownHeads` — each entry a lower-cased word or space-joined
 * phrase (`"file signals"`); with no known trailing phrase the head is the
 * parsed head word. A complement is never part of the head.
 */
export function splitNameSlots(
  name: string,
  knownHeads: ReadonlySet<string>,
  parse: TypeNameParser = (value) => typeNameParts(value),
): NameSlots {
  const parts = parse(name);
  const words = parts.head === undefined ? [] : [...parts.qualifiers, parts.head];
  const complement = parts.complement.length > 0 ? { complement: parts.complement } : {};
  if (words.length === 0) return { head: [], qualifiers: [], ...complement };
  // Index where the longest known trailing phrase starts; -1 when none is known.
  const knownStart = words.findIndex((_, start) => knownHeads.has(words.slice(start).join(" ")));
  const headLength = knownStart < 0 ? 1 : words.length - knownStart;
  return { head: words.slice(-headLength), qualifiers: words.slice(0, -headLength), ...complement };
}
