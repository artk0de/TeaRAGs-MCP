/**
 * The project's method verb vocabulary, per noun tail (spec 2026-09-28 naming
 * coverage, §D5) — the `verbs` section of the ontology report. Pure: the rows
 * are one `readMethodNamesMatching` over {@link methodVerbHeadPattern} grouped
 * by file language; this module groups them per language namespace, then per
 * tail ({@link groupMethodsByTail}), and names the deviants exactly as the
 * untyped-method judgement would: a name {@link judgeUntypedMethodName} calls
 * MISFIT against its own group. No second implementation of the judgement.
 */
import type { MethodNameRow } from "../../../contracts/types/codegraph-storage.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import { joinIdentifierWords } from "./casing.js";
import { groupMethodsByTail, judgeUntypedMethodName, methodNounTail, methodVerbOf } from "./method-vocabulary.js";

/** One noun tail and the verbs a language namespace reads it with (`load_user` ×7, `fetch_user` ×1). */
export interface MethodVerbGroup {
  /** The noun tail, snake-joined (`user`, `user_name`). */
  tail: string;
  /** The namespace's languages present in the group, sorted, comma-joined (`ruby`, `javascript,typescript`). */
  language: string;
  holders: number;
  verbs: { verb: string; holders: number }[];
  /** Names off the tail's dominant verb, each with the name the lexicon would suggest. */
  deviants: { name: string; holders: number; suggestion: string }[];
}

/** Where a file language's rows group, and the method casing a suggestion there is rendered in. */
export interface MethodVerbNamespace {
  key: string;
  casing: IdentifierCasing;
}

export interface MethodVerbGroupOptions {
  /** The namespace of a row's file language; a row whose language has none is dropped. */
  namespaceOf: (language: string) => MethodVerbNamespace | undefined;
  /** Groups returned. */
  limit: number;
  /** Verbs and deviants kept per group. */
  namesPerGroup: number;
}

interface TailBucket {
  namespace: MethodVerbNamespace;
  tail: string;
  languages: Set<string>;
  rows: MethodNameRow[];
}

/**
 * `rows` (grouped by file language) as verb groups, ranked by the holders of
 * their deviants, then by holders, then tail and language; at most `limit`.
 * A group with one verb and no deviant stays — it ranks low.
 */
export function buildMethodVerbGroups(
  rows: readonly MethodNameRow[],
  options: MethodVerbGroupOptions,
): MethodVerbGroup[] {
  const buckets = new Map<string, TailBucket>();
  for (const row of rows) {
    if (!row.language || methodVerbOf(row.shortName) === undefined) continue;
    const namespace = options.namespaceOf(row.language);
    if (!namespace) continue;
    const tail = joinIdentifierWords(methodNounTail(row.shortName), "snake");
    const key = `${namespace.key}\u0000${tail}`;
    const bucket = buckets.get(key) ?? { namespace, tail, languages: new Set<string>(), rows: [] };
    bucket.languages.add(row.language);
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  const groups = [...buckets.values()].map((bucket) => verbGroup(bucket, options.namesPerGroup));
  return groups
    .map((group) => ({ group, deviantHolders: group.deviants.reduce((s, d) => s + d.holders, 0) }))
    .sort(
      (a, b) =>
        b.deviantHolders - a.deviantHolders ||
        b.group.holders - a.group.holders ||
        a.group.tail.localeCompare(b.group.tail) ||
        a.group.language.localeCompare(b.group.language),
    )
    .slice(0, options.limit)
    .map(({ group }) => group);
}

/** One bucket's group: the same name across languages of the namespace is one name. */
function verbGroup(bucket: TailBucket, namesPerGroup: number): MethodVerbGroup {
  const names = new Map<string, number>();
  for (const row of bucket.rows) names.set(row.shortName, (names.get(row.shortName) ?? 0) + row.holders);
  const tailNames: MethodNameRow[] = [...names].map(([shortName, holders]) => ({ shortName, holders }));
  const verbs = groupMethodsByTail(tailNames).get(bucket.tail) ?? [];
  const evidence = { verbs: [], tailNames, lastWordNames: [], declared: true };
  const deviants: MethodVerbGroup["deviants"] = [];
  for (const { shortName, holders } of tailNames) {
    const verdict = judgeUntypedMethodName({ name: shortName, casing: bucket.namespace.casing, evidence });
    if (verdict.verdict === "MISFIT") deviants.push({ name: shortName, holders, suggestion: verdict.suggestion });
  }
  return {
    tail: bucket.tail,
    language: [...bucket.languages].sort().join(","),
    holders: verbs.reduce((s, v) => s + v.holders, 0),
    verbs: verbs.slice(0, namesPerGroup).map(({ verb, holders }) => ({ verb, holders })),
    deviants: deviants.sort((a, b) => b.holders - a.holders || a.name.localeCompare(b.name)).slice(0, namesPerGroup),
  };
}
