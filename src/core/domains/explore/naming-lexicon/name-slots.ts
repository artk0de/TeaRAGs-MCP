/**
 * Slot split of a name for term alignment (bd tea-rags-mcp-vi0wx): the HEAD
 * names the entity (`Doc` in `CalculatedDoc`), the QUALIFIERS are the words
 * before it (`Calculated`). Pure: the project's known heads come in as an
 * argument.
 */
import { typeNameWords } from "./casing.js";

/** A name's words, lower-cased, split into its head and the qualifiers before it. */
export interface NameSlots {
  head: string[];
  qualifiers: string[];
}

/**
 * Splits `name` (type or value name, any casing, optionally namespaced) into
 * slots. The head is the LONGEST trailing phrase found in `knownHeads` — each
 * entry a lower-cased word or space-joined phrase (`"file signals"`); with no
 * known trailing phrase the head is the last word.
 */
export function splitNameSlots(name: string, knownHeads: ReadonlySet<string>): NameSlots {
  const words = typeNameWords(name);
  if (words.length === 0) return { head: [], qualifiers: [] };
  // Index where the longest known trailing phrase starts; -1 when none is known.
  const knownStart = words.findIndex((_, start) => knownHeads.has(words.slice(start).join(" ")));
  const headLength = knownStart < 0 ? 1 : words.length - knownStart;
  return { head: words.slice(-headLength), qualifiers: words.slice(0, -headLength) };
}
