/**
 * Term alignment (bd tea-rags-mcp-vi0wx): reuse the project's words for a
 * draft name. The HEAD slot is aligned to the project's dominant spelling of
 * the same word (`doc` over `document`); the QUALIFIER slot to an ESTABLISHED
 * modifier — a word standing before several distinct heads in several
 * directories (`Predefined` in `PredefinedTemplate`, `PredefinedField`) — that
 * is over-represented in the code nearest the draft's concept. The judgement is
 * soft: callers attach the result to NEW_TERM, never to MISFIT. Pure.
 */
import { createHash } from "node:crypto";

import { typeNameWords } from "./casing.js";
import { isWordAbbreviation } from "./homonyms.js";
import type { NameSlots } from "./name-slots.js";

/** One word the project uses as a qualifier before a head in type names. */
export interface ModifierUse {
  word: string;
  /** Distinct heads the word qualifies. */
  heads: ReadonlySet<string>;
  /** Distinct directories of the types it qualifies. */
  dirs: ReadonlySet<string>;
  /** Type names carrying the word as a qualifier, project-wide. */
  count: number;
}

/** An established modifier offered in place of the draft's own qualifier. */
export interface TermAlternative {
  word: string;
  /**
   * `head`: the project's dominant spelling of the draft's head word
   * (`doc` for `…Document`) — `heads` is then empty, `domains` the directories
   * of the types ending in it, `lift` its count over the draft spelling's.
   * Absent: a qualifier alternative.
   */
  slot?: "head";
  heads: string[];
  domains: string[];
  lift: number;
  /**
   * A head alternative found by meaning (bd tea-rags-mcp-433d2): the embedding
   * similarity of this word to the draft's head (`numbers` → `metrics`), above
   * the draft's corrected null floor ({@link correctedSimilarityFloor}). Absent on a
   * qualifier alternative and on a spelling variant judged without embeddings.
   */
  similarity?: number;
  /** A head alternative found by meaning: project types carrying the word that anchored it (`IndexMetrics`). */
  examples?: string[];
  /**
   * A path-term alternative (bd tea-rags-mcp-433d2): the draft word it would
   * replace (`staleness` → `freshness`). `domains` is then the directory the
   * term names, `heads` empty and `lift` 0 — no frequency is judged.
   */
  replaces?: string;
}

/** A modifier is established when it qualifies ≥ `minHeads` distinct heads in ≥ `minDirs` directories. */
export function establishedModifiers(uses: readonly ModifierUse[], minHeads = 2, minDirs = 2): ModifierUse[] {
  return uses.filter((use) => use.heads.size >= minHeads && use.dirs.size >= minDirs);
}

/**
 * Lift of each established modifier in the code nearest a concept:
 * (names in `conceptNames` carrying the word as a qualifier ÷
 * `conceptNames.length`) ÷ (`count` ÷ `projectTotal`). A modifier absent from
 * the concept names lifts 0; so does every modifier when either side has no
 * population to measure.
 */
export function modifierLift(
  established: readonly ModifierUse[],
  conceptNames: readonly string[],
  projectTotal: number,
): Map<string, number> {
  const qualifierSets = conceptNames.map((name) => new Set(typeNameWords(name).slice(0, -1)));
  const lift = new Map<string, number>();
  for (const use of established) {
    const occurrences = qualifierSets.filter((qualifiers) => qualifiers.has(use.word)).length;
    const measurable = conceptNames.length > 0 && use.count > 0 && projectTotal > 0;
    lift.set(use.word, measurable ? occurrences / conceptNames.length / (use.count / projectTotal) : 0);
  }
  return lift;
}

/**
 * Established modifiers with lift above `floor`, offered when the draft has a
 * qualifier and none of its qualifiers is established already. Highest lift
 * first; heads and domains sorted for a deterministic answer. Empty = a new
 * concept, a legitimate outcome.
 */
export function alignQualifiers(
  slots: NameSlots,
  established: readonly ModifierUse[],
  lift: ReadonlyMap<string, number>,
  floor: number,
): TermAlternative[] {
  if (slots.qualifiers.length === 0) return [];
  const establishedWords = new Set(established.map((use) => use.word));
  if (slots.qualifiers.some((word) => establishedWords.has(word))) return [];
  return established
    .map((use) => ({ use, lift: lift.get(use.word) ?? 0 }))
    .filter((candidate) => candidate.lift > floor)
    .sort((a, b) => b.lift - a.lift || a.use.word.localeCompare(b.use.word))
    .map(({ use, lift: value }) => ({
      word: use.word,
      heads: [...use.heads].sort(),
      domains: [...use.dirs].sort(),
      lift: value,
    }));
}

/**
 * Two words spell one concept when the shorter abbreviates the longer
 * ({@link isWordAbbreviation}: same first letter, letters in order — `doc` /
 * `document`, `ctx` / `context`) AND is at most 60% of its length. The length
 * cap keeps near-equal words apart: `preset` does not spell `presenter`.
 */
const MAX_VARIANT_LENGTH_RATIO = 0.6;

/**
 * Two words share a stem when one begins with the other or one spells the
 * other (`chunk` / `chunker`, `doc` / `document`): the draft already carries
 * that term, so offering it would restate the draft.
 */
export function sharesWordStem(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a) || isSpellingVariant(a, b);
}

function isSpellingVariant(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length <= long.length * MAX_VARIANT_LENGTH_RATIO && isWordAbbreviation(short, long);
}

/**
 * The project's dominant spelling of the draft's head word (its last head
 * word), or `undefined` when the head already is the most-used spelling or
 * has no variant in `headCounts`. A variant must be strictly more frequent.
 */
export function alignHead(slots: NameSlots, headCounts: ReadonlyMap<string, number>): string | undefined {
  const head = slots.head[slots.head.length - 1];
  if (head === undefined) return undefined;
  let best: string | undefined;
  let bestCount = headCounts.get(head) ?? 0;
  for (const [word, count] of headCounts) {
    if (word === head || !isSpellingVariant(word, head)) continue;
    if (count > bestCount || (count === bestCount && best !== undefined && word < best)) {
      best = word;
      bestCount = count;
    }
  }
  return best;
}

/** A head the project uses near the draft — a type sharing a qualifier with it, or living in its directory. */
export interface HeadCandidate {
  word: string;
  /** The anchoring types carrying the word as their head, sorted. */
  examples: string[];
  /** Their directories, sorted. */
  domains: string[];
}

/**
 * A candidate head is the project's term only when at least this many types
 * (project-wide) end in it: a word one type uses is that type's choice, not a
 * vocabulary to align to.
 */
const MIN_HEAD_CANDIDATE_TYPES = 2;

/**
 * Candidate replacements for the draft's head (bd tea-rags-mcp-433d2): the
 * heads of the population's types that share a qualifier word with the draft
 * (`IndexNumbers` → `IndexMetrics`, `IndexStatus`) or live in the draft's
 * directory. A word the draft already carries is never a candidate, nor a head
 * fewer than {@link MIN_HEAD_CANDIDATE_TYPES} types end in (`headCounts`) —
 * unless `admitted` names it: a head ONE central type carries, established by
 * usage rather than by count (`Reranker`). Which candidate spells the draft's
 * concept is a question of meaning, left to the caller. Sorted by word.
 */
export function anchoredHeadCandidates(
  slots: NameSlots,
  draftDir: string,
  rows: readonly { shortName: string; relPath: string }[],
  headCounts: ReadonlyMap<string, number>,
  admitted: ReadonlySet<string> = new Set(),
): HeadCandidate[] {
  const draftWords = new Set([...slots.qualifiers, ...slots.head]);
  const qualifiers = new Set(slots.qualifiers);
  const anchored = new Map<string, { examples: Set<string>; domains: Set<string> }>();
  for (const row of rows) {
    const words = typeNameWords(row.shortName);
    const head = words.at(-1);
    if (head === undefined || draftWords.has(head)) continue;
    if ((headCounts.get(head) ?? 0) < MIN_HEAD_CANDIDATE_TYPES && !admitted.has(head)) continue;
    const slash = row.relPath.lastIndexOf("/");
    const dir = slash < 0 ? "" : row.relPath.slice(0, slash);
    const sharesQualifier = words.slice(0, -1).some((word) => qualifiers.has(word));
    if (!sharesQualifier && dir !== draftDir) continue;
    const entry = anchored.get(head) ?? { examples: new Set<string>(), domains: new Set<string>() };
    entry.examples.add(row.shortName);
    entry.domains.add(dir);
    anchored.set(head, entry);
  }
  return [...anchored]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([word, entry]) => ({ word, examples: [...entry.examples].sort(), domains: [...entry.domains].sort() }));
}

/**
 * The family-wise level of alignment by meaning (bd tea-rags-mcp-433d2): the
 * chance that ANY of the pairs a draft is compared on clears its floor by
 * chance stays at 1 − 0.9, however many pairs that is
 * ({@link perComparisonQuantile}). With one pair, a candidate must be closer
 * to the draft's word than 9 in 10 random pairs of the project's own head
 * words are to each other. A definition of "unusually close", not a tuned
 * value — the floor it yields moves with the embedding model and the
 * project's vocabulary.
 */
export const NULL_SIMILARITY_QUANTILE = 0.9;
/** Heads in the null sample: 64 heads → 2,016 pairs, one embedding batch per request. */
export const NULL_SAMPLE_HEADS = 64;
/**
 * Below this many heads (45 pairs) the null distribution is too thin to place
 * a 0.9 quantile on — no alignment by meaning.
 */
export const MIN_NULL_SAMPLE_HEADS = 10;

/**
 * The heads the null distribution is measured on: at most `size` of the words
 * at least {@link MIN_HEAD_CANDIDATE_TYPES} types end in — the same population
 * a candidate head is drawn from — in the order of a hash of the word.
 * Deterministic (one project, one sample) and unbiased: the most-carried heads
 * are generic words (`result`, `options`, `config`) closer to each other than
 * the population is — on the self-index they put the 0.9 quantile at 0.593
 * against 0.562 over all 296 heads.
 */
export function nullHeadSample(headCounts: ReadonlyMap<string, number>, size = NULL_SAMPLE_HEADS): string[] {
  return [...headCounts]
    .filter(([, count]) => count >= MIN_HEAD_CANDIDATE_TYPES)
    .map(([word]) => ({ word, key: createHash("sha1").update(word).digest("hex") }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.word.localeCompare(b.word))
    .slice(0, size)
    .map(({ word }) => word);
}

/** The `q` quantile of `values`, linear between order statistics; `undefined` for an empty sample. */
export function similarityQuantile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * The project's null distribution of head similarity: the scores of every pair
 * of `sample` ({@link nullHeadSample}), ascending. `undefined` under
 * {@link MIN_NULL_SAMPLE_HEADS} heads.
 */
export function nullSimilarityDistribution(
  sample: readonly string[],
  score: (a: string, b: string) => number,
): number[] | undefined {
  if (sample.length < MIN_NULL_SAMPLE_HEADS) return undefined;
  const scores: number[] = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) scores.push(score(sample[i], sample[j]));
  }
  return scores.sort((a, b) => a - b);
}

/**
 * The per-comparison quantile for a draft compared on `comparisons` pairs —
 * the Šidák correction of {@link NULL_SIMILARITY_QUANTILE}: `0.9^(1/m)`, so the
 * chance that any of the m random pairs clears it is 10%, whatever m is. One
 * comparison (or none) is the family-wise level itself. Capped at what a null
 * distribution of `pairs` scores resolves, `1 − 1/pairs` (0.9995 for the 2,016
 * pairs of a full sample, m ≈ 210): beyond it the quantile would be the
 * sample's maximum, not a measured tail.
 */
export function perComparisonQuantile(comparisons: number, pairs: number): number {
  const corrected = NULL_SIMILARITY_QUANTILE ** (1 / Math.max(1, comparisons));
  return Math.min(corrected, 1 - 1 / Math.max(1, pairs));
}

/**
 * The similarity a draft's candidate must EXCEED when the draft is compared
 * on `comparisons` pairs: the {@link perComparisonQuantile} of the project's
 * `nullSimilarities` ({@link nullSimilarityDistribution}).
 */
export function correctedSimilarityFloor(nullSimilarities: readonly number[], comparisons: number): number {
  return similarityQuantile(nullSimilarities, perComparisonQuantile(comparisons, nullSimilarities.length)) ?? Infinity;
}

/** A word of the draft's own directory path the project uses as a term. */
export interface PathTerm {
  word: string;
  /** The directory the word names, up to and including its segment. */
  dir: string;
}

/**
 * The words of the directories `draftPath` lives under that name a concept
 * the code nearest the draft carries (bd tea-rags-mcp-433d2): a segment word
 * that is a word of a type name in `conceptNames` — `freshness` in
 * `maintenance/freshness/` beside `IndexFreshnessCheck`. Grounded like a head
 * candidate, because the project's own vocabulary is too loose a test: on the
 * self-index "a word of any type, or a directory of ≥ 2 files" let `core`,
 * `api`, `static`, `explore`, `ingest` and `maintenance` through, each
 * 0.57–0.62 similar to some draft word — above the null floor, and as close as
 * the one true pair (`staleness` / `freshness`, 0.617). A word the draft
 * carries is never a term. Outermost directory first.
 */
export function pathTerms(
  draftPath: string,
  draftWords: readonly string[],
  conceptNames: readonly string[],
): PathTerm[] {
  const conceptWords = new Set(conceptNames.flatMap((name) => typeNameWords(name)));
  const carried = new Set(draftWords);
  const segments = draftPath.split("/").slice(0, -1);
  const terms: PathTerm[] = [];
  const seen = new Set<string>();
  segments.forEach((segment, i) => {
    const dir = segments.slice(0, i + 1).join("/");
    for (const word of segment.split(/[^A-Za-z0-9]+/).flatMap((part) => typeNameWords(part))) {
      if (carried.has(word) || seen.has(word) || !conceptWords.has(word)) continue;
      seen.add(word);
      terms.push({ word, dir });
    }
  });
  return terms;
}
