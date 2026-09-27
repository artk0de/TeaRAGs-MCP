/**
 * Concept terms: the vocabulary a set of semantic-search holders shares. Their
 * symbol ids and file-name stems are split into singular words and folded into
 * n-grams, each scored by the holders that carry it. Directory segments never
 * contribute: they name the project's layout (`core`, `domains`, `infra`), not
 * the concept, and every holder under one tree would share them. Neither does a
 * holder's NAMESPACE (bd tea-rags-mcp-i569j): the `::` segments before its own
 * name locate it the way its directories do — every `TaxPreparation::*` hit
 * repeats `tax_preparation`, which ranked above the words the hits are named
 * with. Which words are namespace words is read off each hit's own symbol id,
 * never a word list: an n-gram lying wholly in the namespace is dropped, one
 * reaching into the name (`tax_automation_document` off
 * `TaxAutomations::Document`) is kept.
 */
import { singularizeIdentifierWord, splitIdentifierWords } from "./casing.js";

/** One concept term: a snake n-gram, its summed holder score, and up to three distinct holder symbols (best first, no `#partN`). */
export interface ConceptTerm {
  term: string;
  score: number;
  holders: string[];
}

/** A semantic-search hit a term is read from. */
export interface ConceptTermHolder {
  symbolId: string;
  relativePath: string;
  score: number;
}

/** The chunker's split suffix: an oversized symbol becomes `Foo#bar#part1`, `#part2`, … */
const CHUNK_PART_SUFFIX = /#part\d+$/;
const MAX_NGRAM = 3;
const MAX_TERM_HOLDERS = 3;
const DEFAULT_TERM_LIMIT = 10;

/** Words of the file name without its extension; directory segments are dropped. */
function fileStemWords(relativePath: string): string[] {
  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return splitIdentifierWords(fileName.replace(/\.[^.]*$/, ""));
}

/** The symbol a chunk id windows: the id without the chunker's `#partN` split suffix. */
function symbolOfChunkId(symbolId: string): string {
  return symbolId.replace(CHUNK_PART_SUFFIX, "");
}

/** The namespace separator: the segments before the last one locate the symbol, the last names it. */
const NAMESPACE_SEPARATOR = "::";

/**
 * Words of the symbol id without the chunker's `#partN` split suffix, and how
 * many of them lead it as its NAMESPACE — the words of every `::` segment
 * before the last.
 */
function symbolWords(symbolId: string): { words: string[]; namespaceWords: number } {
  const symbol = symbolOfChunkId(symbolId);
  const cut = symbol.lastIndexOf(NAMESPACE_SEPARATOR);
  const namespaceWords = cut < 0 ? 0 : splitIdentifierWords(symbol.slice(0, cut)).length;
  return { words: splitIdentifierWords(symbol), namespaceWords };
}

/** The 1..3-word n-grams of `words`, skipping those lying wholly within its first `locating` words. */
function ngrams(words: readonly string[], locating = 0): string[] {
  const grams: string[] = [];
  for (let size = 1; size <= MAX_NGRAM; size++) {
    for (let start = 0; start + size <= words.length; start++) {
      if (start + size <= locating) continue;
      grams.push(words.slice(start, start + size).join("_"));
    }
  }
  return grams;
}

/** The distinct terms one holder carries: n-grams of its symbol id (namespace-only ones dropped) and, separately, of its file-name stem. */
function holderTerms(holder: ConceptTermHolder): Set<string> {
  const singular = (words: string[]) => words.map(singularizeIdentifierWord);
  const symbol = symbolWords(holder.symbolId);
  return new Set([
    ...ngrams(singular(symbol.words), symbol.namespaceWords),
    ...ngrams(singular(fileStemWords(holder.relativePath))),
  ]);
}

function wordCount(term: string): number {
  return term.split("_").length;
}

/**
 * Terms shared by semantic-search holders. A term is a 1–3 word snake n-gram of
 * consecutive singularized words, taken separately from the symbol id (minus a
 * `#partN` split suffix, an n-gram wholly inside its namespace dropped) and the
 * file-name stem (no directories, no extension). Score = Σ score of
 * the holders carrying it, each holder counted once. Ties rank the longer, more
 * specific n-gram first, then alphabetically.
 */
export function extractConceptTerms(holders: readonly ConceptTermHolder[], limit = DEFAULT_TERM_LIMIT): ConceptTerm[] {
  const byTerm = new Map<string, { score: number; holders: ConceptTermHolder[] }>();
  for (const holder of holders) {
    for (const term of holderTerms(holder)) {
      const entry = byTerm.get(term) ?? { score: 0, holders: [] };
      entry.score += holder.score;
      entry.holders.push(holder);
      byTerm.set(term, entry);
    }
  }
  return [...byTerm]
    .map(([term, entry]) => ({
      term,
      score: entry.score,
      holders: [
        ...new Set(
          [...entry.holders].sort((a, b) => b.score - a.score).map((holder) => symbolOfChunkId(holder.symbolId)),
        ),
      ].slice(0, MAX_TERM_HOLDERS),
    }))
    .sort((a, b) => b.score - a.score || wordCount(b.term) - wordCount(a.term) || a.term.localeCompare(b.term))
    .slice(0, limit);
}
