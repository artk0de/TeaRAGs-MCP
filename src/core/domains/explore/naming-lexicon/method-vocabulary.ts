/**
 * The untyped-method judgement (spec 2026-09-28 naming coverage, §D4): a
 * `return` draft with no known type is judged by the project's METHOD
 * vocabulary instead of a type: a verb the project uses conforms, a rare one is
 * a NEW_TERM; a verbless name (`total`) is judged by its declaration and its
 * last word.
 *
 * No verb is a MISFIT for another verb of its noun tail (revised after live
 * validation): the verbs one tail carries are mostly distinct operations
 * (`find_user` / `build_user`), not synonyms, so a tail's dominant verb says
 * nothing about a draft's.
 *
 * The verbs are the language namespace's own ({@link deriveMethodVerbLexicon},
 * §D4a): a head word opening names with several noun tails more often than it
 * ends names, whose compounds are not themselves names of values — `update`,
 * `send`, `can` — not a closed list.
 *
 * Pure: the evidence is read by the ops layer through `readMethodHeadWords` /
 * `readMethodNamesMatching`, whose `regexp_matches` pattern
 * {@link methodLastWordPattern} builds — so it stays inside RE2 (no lookaround,
 * no backreferences).
 */
import type { MethodHeadWordRow, MethodNameRow } from "../../../contracts/types/codegraph-storage.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import { joinIdentifierWords, splitIdentifierWords } from "./casing.js";
import { MIN_ROLE_MEMBERS } from "./type-roles.js";

/** Terms a NEW_TERM carries, and analogues a NO_CONVENTION carries. */
const TOP_METHOD_TERMS = 5;

/** Everything {@link judgeUntypedMethodName} reads about the project's methods. */
export interface UntypedMethodEvidence {
  /** The namespace's verb lexicon ({@link deriveMethodVerbLexicon}): a draft opening with none of it is verbless. */
  lexicon: ReadonlySet<string>;
  /** The head-word rows the lexicon was derived from (readMethodHeadWords) — a verb's holders rank NEW_TERM terms. */
  headWords: readonly MethodHeadWordRow[];
  /** Verbless-branch analogues: names ending in the draft's last word. */
  lastWordNames: readonly MethodNameRow[];
  /** True when a method of this exact name is declared elsewhere in scope. */
  declared: boolean;
}

/** The verdict on one untyped method name. */
export type UntypedMethodVerdict =
  | { verdict: "CONFORMS" }
  | { verdict: "NEW_TERM"; topTerms: string[] }
  | { verdict: "NO_CONVENTION"; prefer: { analogous: string[] } };

/**
 * True when `valueCompounds` (summed per head) marks a noun modifier: at least
 * {@link MIN_ROLE_MEMBERS} of the head's compound names also name a value — a
 * name that names a value is a noun phrase (`pagination_collection`,
 * `media_attachment`), so two of them make the head a noun convention.
 */
function namesValues(valueCompounds: number): boolean {
  return valueCompounds >= MIN_ROLE_MEMBERS;
}

/**
 * The verb lexicon of one language namespace from its head-word rows (spec
 * §D4a), rows of the namespace's languages summed per head: a head is a verb
 * when it opens at least {@link MIN_ROLE_MEMBERS} distinct noun tails, opens
 * names more often than it ends them (`update` heads many tails; `user` ends
 * more names than it opens), AND fewer than {@link MIN_ROLE_MEMBERS} of its
 * compounds also name a value (`pagination_collection` is a variable too, so
 * `pagination` modifies nouns rather than acting on them).
 */
export function deriveMethodVerbLexicon(rows: readonly MethodHeadWordRow[]): ReadonlySet<string> {
  const sums = new Map<
    string,
    { headHolders: number; headTails: number; lastHolders: number; valueCompounds: number }
  >();
  for (const row of rows) {
    const sum = sums.get(row.head) ?? { headHolders: 0, headTails: 0, lastHolders: 0, valueCompounds: 0 };
    sum.headHolders += row.headHolders;
    sum.headTails += row.headTails;
    sum.lastHolders += row.lastHolders;
    sum.valueCompounds += row.valueCompounds;
    sums.set(row.head, sum);
  }
  const lexicon = new Set<string>();
  for (const [head, sum] of sums) {
    if (sum.headTails >= MIN_ROLE_MEMBERS && sum.headHolders > sum.lastHolders && !namesValues(sum.valueCompounds)) {
      lexicon.add(head);
    }
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
 * 1. no lexicon verb → {@link judgeVerblessMethodName};
 * 2. the draft's verb holds ≥ {@link MIN_ROLE_MEMBERS} in the project → CONFORMS,
 *    whatever verbs the other names of its noun tail use;
 * 3. otherwise NEW_TERM with the lexicon verbs that clear that bar, heaviest first.
 *
 * `casing` is part of the judgement's input contract (every draft verdict
 * receives it); no verdict here renders a name, so it is not read.
 */
export function judgeUntypedMethodName(input: {
  name: string;
  casing: IdentifierCasing;
  evidence: UntypedMethodEvidence;
}): UntypedMethodVerdict {
  const { name, evidence } = input;
  const { lexicon } = evidence;
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
