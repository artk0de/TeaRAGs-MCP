/**
 * The untyped-method judgement (spec 2026-09-28 naming coverage, §D4): a
 * `return` draft with no known type is judged by the project's METHOD
 * vocabulary instead of a type. A noun tail (`…_user`, `…User`) with a dominant
 * verb makes a different verb a MISFIT; a verb the project uses conforms; a
 * verbless name (`total`) is judged by its declaration and its last word.
 *
 * The verbs are the language namespace's own ({@link deriveMethodVerbLexicon},
 * §D4a): a head word opening names with several noun tails more often than it
 * ends names — `update`, `send`, `can` — not a closed list.
 *
 * Pure: the evidence is read by the ops layer through `readMethodHeadWords` /
 * `readMethodNamesMatching`, whose `regexp_matches` patterns
 * {@link methodTailPattern} and {@link methodLastWordPattern} build — so they
 * stay inside RE2 (no lookaround, no backreferences).
 */
import type { MethodHeadWordRow, MethodNameRow } from "../../../contracts/types/codegraph-storage.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import { joinIdentifierWords, splitIdentifierWords } from "./casing.js";
import { MIN_ROLE_MEMBERS } from "./type-roles.js";

/**
 * The share of a tail's holders one verb needs to be its convention — the
 * majority bar `supportedReturnVerb` applies (`PRIOR_SUPPORT_SHARE` in
 * `verdicts.ts`, not exported), not a tuned value.
 */
const DOMINANT_VERB_SHARE = 0.5;
/** Terms a NEW_TERM carries, and analogues a NO_CONVENTION carries. */
const TOP_METHOD_TERMS = 5;
/** Trailing predicate / bang markers, kept on a suggestion: `valid?`, `save!`. */
const TRAILING_MARKER = /[!?]+$/;

/** Everything {@link judgeUntypedMethodName} reads about the project's methods. */
export interface UntypedMethodEvidence {
  /** The namespace's verb lexicon ({@link deriveMethodVerbLexicon}): a draft opening with none of it is verbless. */
  lexicon: ReadonlySet<string>;
  /** The head-word rows the lexicon was derived from (readMethodHeadWords) — a verb's holders rank NEW_TERM terms. */
  headWords: readonly MethodHeadWordRow[];
  /** Names sharing the draft's noun tail under any lexicon verb (readMethodNamesMatching). */
  tailNames: readonly MethodNameRow[];
  /** Verbless-branch analogues: names ending in the draft's last word. */
  lastWordNames: readonly MethodNameRow[];
  /**
   * Names ending in the draft's HEAD word, read for a multi-word draft whose head
   * is outside the lexicon — the head's position evidence ({@link isProjectNoun}).
   * Absent → the head ends no name.
   */
  headLastNames?: readonly MethodNameRow[];
  /** True when a method of this exact name is declared elsewhere in scope. */
  declared: boolean;
}

/** The verdict on one untyped method name; `holder` is the project name the suggestion follows. */
export type UntypedMethodVerdict =
  | { verdict: "CONFORMS" }
  | { verdict: "MISFIT"; suggestion: string; holder: string }
  | { verdict: "NEW_TERM"; topTerms: string[] }
  | { verdict: "NO_CONVENTION"; prefer: { analogous: string[] } };

/**
 * The verb lexicon of one language namespace from its head-word rows (spec
 * §D4a), rows of the namespace's languages summed per head: a head is a verb
 * when it opens at least {@link MIN_ROLE_MEMBERS} distinct noun tails AND opens
 * names more often than it ends them (`update` heads many tails; `user` ends
 * more names than it opens).
 */
export function deriveMethodVerbLexicon(rows: readonly MethodHeadWordRow[]): ReadonlySet<string> {
  const sums = new Map<string, { headHolders: number; headTails: number; lastHolders: number }>();
  for (const row of rows) {
    const sum = sums.get(row.head) ?? { headHolders: 0, headTails: 0, lastHolders: 0 };
    sum.headHolders += row.headHolders;
    sum.headTails += row.headTails;
    sum.lastHolders += row.lastHolders;
    sums.set(row.head, sum);
  }
  const lexicon = new Set<string>();
  for (const [head, sum] of sums) {
    if (sum.headTails >= MIN_ROLE_MEMBERS && sum.headHolders > sum.lastHolders) lexicon.add(head);
  }
  return lexicon;
}

/** The lexicon verb a method name opens with (`load_user`, `loadUser` → `load`); none for one word or a verbless name. */
export function methodVerbOf(name: string, lexicon: ReadonlySet<string>): string | undefined {
  const words = splitIdentifierWords(name);
  return words.length > 1 && lexicon.has(words[0]) ? words[0] : undefined;
}

/** The words after {@link methodVerbOf}'s verb, markers dropped (`load_user!` → `["user"]`); empty without a verb. */
export function methodNounTail(name: string, lexicon: ReadonlySet<string>): string[] {
  return methodVerbOf(name, lexicon) === undefined ? [] : splitIdentifierWords(name).slice(1);
}

/** Escapes RE2 metacharacters; identifier words carry none, but a pattern must not trust its input. */
function escapePatternWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * An RE2 pattern for any head word followed by exactly `tail`, in snake
 * (`load_user?`) or camel (`loadUser`) casing: `^[a-z][a-z0-9]*(?:_user|User)[!?]?$`.
 * It enumerates no verbs — the heads are filtered by the lexicon in TS.
 */
export function methodTailPattern(tail: readonly string[]): string {
  const escaped = tail.map(escapePatternWord);
  const snake = escaped.map((word) => `_${word}`).join("");
  const camel = escaped.map(capitalize).join("");
  return `^[a-z][a-z0-9]*(?:${snake}|${camel})[!?]?$`;
}

/** An RE2 pattern for a name whose last word is `word`, in snake or camel casing, or the bare word itself. */
export function methodLastWordPattern(word: string): string {
  const escaped = escapePatternWord(word);
  return `(?:^|_)${escaped}[!?]?$|^${escaped}$|[a-z0-9]${capitalize(escaped)}$`;
}

/** Holders summed per key — a row set grouped by language carries one row per (key, language). */
function sumHolders<T>(rows: readonly T[], keyOf: (row: T) => string | undefined, holdersOf: (row: T) => number) {
  const sums = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key !== undefined) sums.set(key, (sums.get(key) ?? 0) + holdersOf(row));
  }
  return sums;
}

/** Keys heaviest first (the first seen on a tie), without `exclude`, at most `limit`. */
function topKeys(sums: ReadonlyMap<string, number>, limit: number, exclude?: string): string[] {
  return [...sums]
    .filter(([key]) => key !== exclude)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

/**
 * Verbed names grouped by noun tail (keyed by the snake-joined tail, `user_name`),
 * one entry per verb with its holders summed across casings and the heaviest
 * name it is spelled as; verbs heaviest first. Verbless names are dropped.
 */
export function groupMethodsByTail(
  rows: readonly MethodNameRow[],
  lexicon: ReadonlySet<string>,
): Map<string, { verb: string; holders: number; name: string }[]> {
  const byTail = new Map<string, Map<string, { verb: string; holders: number; name: string; top: number }>>();
  for (const row of rows) {
    const verb = methodVerbOf(row.shortName, lexicon);
    if (verb === undefined) continue;
    const tailKey = joinIdentifierWords(methodNounTail(row.shortName, lexicon), "snake");
    const verbs =
      byTail.get(tailKey) ?? new Map<string, { verb: string; holders: number; name: string; top: number }>();
    byTail.set(tailKey, verbs);
    const entry = verbs.get(verb);
    if (!entry) {
      verbs.set(verb, { verb, holders: row.holders, name: row.shortName, top: row.holders });
      continue;
    }
    entry.holders += row.holders;
    if (row.holders > entry.top) {
      entry.name = row.shortName;
      entry.top = row.holders;
    }
  }
  const groups = new Map<string, { verb: string; holders: number; name: string }[]>();
  for (const [tailKey, verbs] of byTail) {
    groups.set(
      tailKey,
      [...verbs.values()]
        .sort((a, b) => b.holders - a.holders)
        .map(({ verb, holders, name }) => ({ verb, holders, name })),
    );
  }
  return groups;
}

/**
 * True when `head` is a noun of the project by the lexicon's own positional
 * criterion ({@link deriveMethodVerbLexicon}): it ends more multi-word names
 * than it opens. Opening holders come from the head-word rows when the head has
 * one, else from the draft's tail slice (the names spelling its tail under
 * `head`) — 0 for a head the project never opens a name with.
 */
function isProjectNoun(head: string, evidence: UntypedMethodEvidence): boolean {
  const opens = (row: MethodNameRow) => splitIdentifierWords(row.shortName)[0] === head;
  const ends = (row: MethodNameRow) => {
    const words = splitIdentifierWords(row.shortName);
    return words.length > 1 && words.at(-1) === head;
  };
  const headRows = evidence.headWords.filter((row) => row.head === head);
  const headHolders =
    headRows.length > 0
      ? headRows.reduce((sum, row) => sum + row.headHolders, 0)
      : evidence.tailNames.filter(opens).reduce((sum, row) => sum + row.holders, 0);
  const lastHolders = (evidence.headLastNames ?? []).filter(ends).reduce((sum, row) => sum + row.holders, 0);
  return lastHolders > headHolders;
}

/** Verbless draft: declared elsewhere conforms, otherwise the heaviest names sharing its last word. */
function judgeVerblessMethodName(name: string, evidence: UntypedMethodEvidence): UntypedMethodVerdict {
  if (evidence.declared) return { verdict: "CONFORMS" };
  const sums = sumHolders(
    evidence.lastWordNames,
    (row) => row.shortName,
    (row) => row.holders,
  );
  return { verdict: "NO_CONVENTION", prefer: { analogous: topKeys(sums, TOP_METHOD_TERMS, name) } };
}

/**
 * Judges an untyped method name by `evidence.lexicon`, in order:
 * 1. a multi-word name's words after its head are its candidate noun tail,
 *    whether or not the head is a lexicon verb: when the dominant LEXICON verb
 *    among the `tailNames` spelling exactly that tail (≥ {@link MIN_ROLE_MEMBERS}
 *    holders and ≥ {@link DOMINANT_VERB_SHARE} of the tail's) differs from the
 *    head → MISFIT, suggested in the draft's casing with its trailing `!` / `?`
 *    kept. A new synonym verb (`modify_user` among `update_user`) lands here —
 *    unless a head outside the lexicon is a noun of the project
 *    ({@link isProjectNoun}: `user_name` is not `get_name` misspelt);
 * 2. no lexicon verb → {@link judgeVerblessMethodName};
 * 3. the draft's verb holds ≥ {@link MIN_ROLE_MEMBERS} in the project → CONFORMS;
 * 4. otherwise NEW_TERM with the lexicon verbs that clear that bar, heaviest first.
 */
export function judgeUntypedMethodName(input: {
  name: string;
  casing: IdentifierCasing;
  evidence: UntypedMethodEvidence;
}): UntypedMethodVerdict {
  const { name, casing, evidence } = input;
  const { lexicon } = evidence;
  const [head, ...tail] = splitIdentifierWords(name);
  if (tail.length > 0 && (lexicon.has(head) || !isProjectNoun(head, evidence))) {
    const tailVerbs = groupMethodsByTail(evidence.tailNames, lexicon).get(joinIdentifierWords(tail, "snake")) ?? [];
    const tailHolders = tailVerbs.reduce((sum, entry) => sum + entry.holders, 0);
    const top = tailVerbs[0];
    if (
      top &&
      top.verb !== head &&
      top.holders >= MIN_ROLE_MEMBERS &&
      top.holders / tailHolders >= DOMINANT_VERB_SHARE
    ) {
      const marker = TRAILING_MARKER.exec(name)?.[0] ?? "";
      const suggestion = joinIdentifierWords([top.verb, ...tail], casing) + marker;
      return { verdict: "MISFIT", suggestion, holder: top.name };
    }
  }

  const verb = methodVerbOf(name, lexicon);
  if (verb === undefined) return judgeVerblessMethodName(name, evidence);

  const verbHolders = sumHolders(
    evidence.headWords,
    (row) => (lexicon.has(row.head) ? row.head : undefined),
    (row) => row.headHolders,
  );
  if ((verbHolders.get(verb) ?? 0) >= MIN_ROLE_MEMBERS) return { verdict: "CONFORMS" };
  const supported = new Map([...verbHolders].filter(([, holders]) => holders >= MIN_ROLE_MEMBERS));
  return { verdict: "NEW_TERM", topTerms: topKeys(supported, TOP_METHOD_TERMS, verb) };
}
