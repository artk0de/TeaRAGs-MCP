/**
 * Concept terms: the vocabulary a set of semantic-search holders shares. Their
 * symbol ids and paths are split into singular words and folded into n-grams,
 * each scored by the holders that carry it.
 */
import { singularizeIdentifierWord, splitIdentifierWords } from "./casing.js";

/** One concept term: a snake n-gram, its summed holder score, and up to three holders (best first). */
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

/** Path segments that carry no concept. */
const NOISE_PATH_SEGMENTS: ReadonlySet<string> = new Set(["src", "lib", "app"]);
const MAX_NGRAM = 3;
const MAX_TERM_HOLDERS = 3;
const DEFAULT_TERM_LIMIT = 10;

function pathWords(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0 && !NOISE_PATH_SEGMENTS.has(segment));
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last].replace(/\.[^.]*$/, "");
  return segments.flatMap((segment) => splitIdentifierWords(segment));
}

function ngrams(words: readonly string[]): string[] {
  const grams: string[] = [];
  for (let size = 1; size <= MAX_NGRAM; size++) {
    for (let start = 0; start + size <= words.length; start++) grams.push(words.slice(start, start + size).join("_"));
  }
  return grams;
}

/** The distinct terms one holder carries: n-grams of its symbol id and, separately, of its path. */
function holderTerms(holder: ConceptTermHolder): Set<string> {
  const singular = (words: string[]) => words.map(singularizeIdentifierWord);
  return new Set([
    ...ngrams(singular(splitIdentifierWords(holder.symbolId))),
    ...ngrams(singular(pathWords(holder.relativePath))),
  ]);
}

function wordCount(term: string): number {
  return term.split("_").length;
}

/**
 * Terms shared by semantic-search holders. A term is a 1–3 word snake n-gram of
 * consecutive singularized words, taken from the symbol id and the path (minus
 * `src` / `lib` / `app` and the file extension) separately. Score = Σ score of
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
      holders: [...entry.holders]
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_TERM_HOLDERS)
        .map((holder) => holder.symbolId),
    }))
    .sort((a, b) => b.score - a.score || wordCount(b.term) - wordCount(a.term) || a.term.localeCompare(b.term))
    .slice(0, limit);
}
