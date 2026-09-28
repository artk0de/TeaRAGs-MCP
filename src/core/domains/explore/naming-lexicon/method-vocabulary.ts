/**
 * The untyped-method judgement (spec 2026-09-28 naming coverage, §D4): a
 * `return` draft with no known type is judged by the project's METHOD
 * vocabulary instead of a type. A noun tail (`…_user`, `…User`) with a dominant
 * verb makes a different verb a MISFIT; a verb the project uses conforms; a
 * verbless name (`total`) is judged by its declaration and its last word.
 *
 * Pure: the evidence is read by the ops layer through `readMethodVerbs` /
 * `readMethodNamesMatching`, whose `regexp_matches` patterns
 * {@link methodTailPattern} and {@link methodLastWordPattern} build — so they
 * stay inside RE2 (no lookaround, no backreferences).
 */
import type { MethodNameRow, MethodVerbRow } from "../../../contracts/types/codegraph-storage.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import { joinIdentifierWords, splitIdentifierWords } from "./casing.js";
import { NAMING_VERB_PREFIXES } from "./shapes.js";
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
  /** Project verbs of NAMING_VERB_PREFIXES with holders (readMethodVerbs). */
  verbs: readonly MethodVerbRow[];
  /** Names sharing the draft's noun tail under any lexicon verb (readMethodNamesMatching). */
  tailNames: readonly MethodNameRow[];
  /** Verbless-branch analogues: names ending in the draft's last word. */
  lastWordNames: readonly MethodNameRow[];
  /** True when a method of this exact name is declared elsewhere in scope. */
  declared: boolean;
}

/** The verdict on one untyped method name; `holder` is the project name the suggestion follows. */
export type UntypedMethodVerdict =
  | { verdict: "CONFORMS" }
  | { verdict: "MISFIT"; suggestion: string; holder: string }
  | { verdict: "NEW_TERM"; topTerms: string[] }
  | { verdict: "NO_CONVENTION"; prefer: { analogous: string[] } };

/** The lexicon verb a method name opens with (`load_user`, `loadUser` → `load`); none for one word or a verbless name. */
export function methodVerbOf(name: string): string | undefined {
  const words = splitIdentifierWords(name);
  return words.length > 1 && NAMING_VERB_PREFIXES.includes(words[0]) ? words[0] : undefined;
}

/** The words after {@link methodVerbOf}'s verb, markers dropped (`load_user!` → `["user"]`); empty without a verb. */
export function methodNounTail(name: string): string[] {
  return methodVerbOf(name) === undefined ? [] : splitIdentifierWords(name).slice(1);
}

/** Escapes RE2 metacharacters; identifier words carry none, but a pattern must not trust its input. */
function escapePatternWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * An RE2 pattern for a lexicon verb followed by exactly `tail`, in snake
 * (`load_user?`) or camel (`loadUser`) casing: `^(?:find|…)(?:_user|User)[!?]?$`.
 */
export function methodTailPattern(tail: readonly string[]): string {
  const escaped = tail.map(escapePatternWord);
  const verbs = NAMING_VERB_PREFIXES.map(escapePatternWord).join("|");
  const snake = escaped.map((word) => `_${word}`).join("");
  const camel = escaped.map(capitalize).join("");
  return `^(?:${verbs})(?:${snake}|${camel})[!?]?$`;
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
): Map<string, { verb: string; holders: number; name: string }[]> {
  const byTail = new Map<string, Map<string, { verb: string; holders: number; name: string; top: number }>>();
  for (const row of rows) {
    const verb = methodVerbOf(row.shortName);
    if (verb === undefined) continue;
    const tailKey = joinIdentifierWords(methodNounTail(row.shortName), "snake");
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
 * Judges an untyped method name, in order:
 * 1. no lexicon verb → {@link judgeVerblessMethodName};
 * 2. the dominant verb among the `tailNames` spelling exactly the draft's noun
 *    tail (≥ {@link MIN_ROLE_MEMBERS} holders and ≥ {@link DOMINANT_VERB_SHARE}
 *    of the tail's) differs from the draft's →
 *    MISFIT, suggested in the draft's casing with its trailing `!` / `?` kept;
 * 3. the draft's verb holds ≥ {@link MIN_ROLE_MEMBERS} in the project → CONFORMS;
 * 4. otherwise NEW_TERM with the project's verbs that clear that bar.
 */
export function judgeUntypedMethodName(input: {
  name: string;
  casing: IdentifierCasing;
  evidence: UntypedMethodEvidence;
}): UntypedMethodVerdict {
  const { name, casing, evidence } = input;
  const verb = methodVerbOf(name);
  if (verb === undefined) return judgeVerblessMethodName(name, evidence);

  const tail = methodNounTail(name);
  const tailVerbs = groupMethodsByTail(evidence.tailNames).get(joinIdentifierWords(tail, "snake")) ?? [];
  const tailHolders = tailVerbs.reduce((sum, entry) => sum + entry.holders, 0);
  const top = tailVerbs[0];
  if (top && top.verb !== verb && top.holders >= MIN_ROLE_MEMBERS && top.holders / tailHolders >= DOMINANT_VERB_SHARE) {
    const marker = TRAILING_MARKER.exec(name)?.[0] ?? "";
    const suggestion = joinIdentifierWords([top.verb, ...tail], casing) + marker;
    return { verdict: "MISFIT", suggestion, holder: top.name };
  }

  const verbHolders = sumHolders(
    evidence.verbs,
    (row) => row.verb,
    (row) => row.holders,
  );
  if ((verbHolders.get(verb) ?? 0) >= MIN_ROLE_MEMBERS) return { verdict: "CONFORMS" };
  const supported = new Map([...verbHolders].filter(([, holders]) => holders >= MIN_ROLE_MEMBERS));
  return { verdict: "NEW_TERM", topTerms: topKeys(supported, TOP_METHOD_TERMS, verb) };
}
