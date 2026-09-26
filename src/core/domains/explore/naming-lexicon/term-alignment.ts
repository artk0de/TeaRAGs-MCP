/**
 * Term alignment (bd tea-rags-mcp-vi0wx): reuse the project's words for a
 * draft name. The HEAD slot is aligned to the project's dominant spelling of
 * the same word (`doc` over `document`); the QUALIFIER slot to an ESTABLISHED
 * modifier — a word standing before several distinct heads in several
 * directories (`Predefined` in `PredefinedTemplate`, `PredefinedField`) — that
 * is over-represented in the code nearest the draft's concept. The judgement is
 * soft: callers attach the result to NEW_TERM, never to MISFIT. Pure.
 */
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
  heads: string[];
  domains: string[];
  lift: number;
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
