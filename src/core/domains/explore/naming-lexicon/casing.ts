/**
 * Identifier casing, word splitting and English number for the naming lexicon.
 *
 * Pure and language-agnostic: the canonical casing of a role is a fact of the
 * language descriptor (`LanguageCapability.naming`), read by the ops layer and
 * passed in here as an argument. This module never looks a language up.
 */
import type { IdentifierCasing } from "../../../contracts/types/language.js";

/** Leading sigils that mark an identifier's storage, not its name: `@@`, `@`, `$`, `self.`. */
const LEADING_SIGIL = /^(?:@@|@|\$|self\.)/;
/** Trailing predicate / bang markers: `valid?`, `save!`. */
const TRAILING_MARKER = /[!?]+$/;
/** One word: an acronym run, a (capitalised) lowercase run, or digits; trailing digits stay on the word. */
const WORD = /[A-Z]+(?![a-z])[0-9]*|[A-Z]?[a-z]+[0-9]*|[0-9]+/g;

/** Strips leading sigils and trailing `!` / `?` — they are not part of the name's words or casing. */
export function stripIdentifierDecorations(name: string): string {
  return name.replace(LEADING_SIGIL, "").replace(TRAILING_MARKER, "");
}

/**
 * Splits an identifier into lowercased words across snake, camel, Pascal and
 * SCREAMING styles and the `::` / `#` / `.` separators, after
 * {@link stripIdentifierDecorations}.
 */
export function splitIdentifierWords(identifier: string): string[] {
  const words: string[] = [];
  for (const piece of stripIdentifierDecorations(identifier).split(/[^A-Za-z0-9]+/)) {
    for (const match of piece.matchAll(WORD)) words.push(match[0].toLowerCase());
  }
  return words;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Joins lowercased words in the given casing. */
export function joinIdentifierWords(words: readonly string[], casing: IdentifierCasing): string {
  switch (casing) {
    case "snake":
      return words.join("_");
    case "screamingSnake":
      return words.join("_").toUpperCase();
    case "pascal":
      return words.map(capitalize).join("");
    case "camel":
      return words.map((word, i) => (i === 0 ? word : capitalize(word))).join("");
  }
}

/**
 * The words of a type name's LAST namespace segment (`Foo::Bar`, `pkg.Bar`),
 * with a leading `::` and any generic arguments (`<…>`, `[…]`) dropped.
 */
export function typeNameWords(typeName: string): string[] {
  const bare = typeName.replace(/^::/, "").replace(/[<[].*$/, "");
  const segments = bare.split(/::|\./);
  return splitIdentifierWords(segments[segments.length - 1] ?? "");
}

/** Renders a type name as an identifier: `Foo::TaxAutomationDocument` → `tax_automation_document` (snake). */
export function renderIdentifier(typeName: string, casing: IdentifierCasing): string {
  return joinIdentifierWords(typeNameWords(typeName), casing);
}

/** Like {@link renderIdentifier}, with the last word pluralized: `tax_automation_documents`. */
export function renderIdentifierPlural(typeName: string, casing: IdentifierCasing): string {
  return joinIdentifierWords(pluralizeIdentifierWords(typeNameWords(typeName)), casing);
}

/** The same words with the last one pluralized. */
export function pluralizeIdentifierWords(words: readonly string[]): string[] {
  if (words.length === 0) return [];
  return [...words.slice(0, -1), pluralizeIdentifierWord(words[words.length - 1])];
}

/**
 * Regular English plural of a lowercase word: `-ies` after a consonant `y`,
 * `-es` after `s x z ch sh`, else `-s`. Irregular plurals are not modelled.
 */
export function pluralizeIdentifierWord(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/**
 * Inverse of {@link pluralizeIdentifierWord} for regular plurals. Words ending in
 * `ss`, `us`, `is`, and words of ≤ 3 letters, are left alone (`status`,
 * `process`, `analysis`).
 */
export function singularizeIdentifierWord(word: string): string {
  if (word.length <= 3) return word;
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * The casing a name is written in, after {@link stripIdentifierDecorations}.
 * `undefined` when indeterminate: a single lowercase word (`row` fits snake and
 * camel alike), a mixed style, or an empty name. A single-letter capital is
 * `pascal`; an all-caps word of two or more letters is `screamingSnake`.
 */
export function detectIdentifierCasing(name: string): IdentifierCasing | undefined {
  const bare = stripIdentifierDecorations(name);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(bare)) return undefined;
  const hasUpper = /[A-Z]/.test(bare);
  const hasLower = /[a-z]/.test(bare);
  const hasUnderscore = bare.includes("_");
  if (hasUpper && !hasLower) return bare.length === 1 ? "pascal" : "screamingSnake";
  if (!hasUpper) return hasUnderscore ? "snake" : undefined;
  if (hasUnderscore) return undefined;
  return /^[A-Z]/.test(bare) ? "pascal" : "camel";
}
