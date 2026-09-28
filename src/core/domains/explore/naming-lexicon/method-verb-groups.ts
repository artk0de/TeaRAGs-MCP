/**
 * The project's method verb vocabulary, per noun tail (spec 2026-09-28 naming
 * coverage, §D5 / §D4a) — the `verbs` section of the ontology report. Pure: the
 * rows are `readMethodHeadWords` grouped by file language, turned into one verb
 * lexicon per language namespace ({@link methodVerbLexicons}), then
 * `readMethodTailVerbs` over those lexicons' heads — contested tails only. This
 * module groups the pairs per language namespace, then per tail
 * ({@link groupMethodsByTail}).
 *
 * Descriptive only (revised after live validation): the verbs one tail carries
 * are mostly distinct operations (`find_user` / `build_user`), not synonyms, so
 * no name is marked a deviant of the tail's dominant verb.
 */
import type {
  MethodHeadWordRow,
  MethodNameRow,
  MethodTailVerbRow,
} from "../../../contracts/types/codegraph-storage.js";
import { joinIdentifierWords } from "./casing.js";
import { deriveMethodVerbLexicon, groupMethodsByTail, methodNounTail, methodVerbOf } from "./method-vocabulary.js";

/** One noun tail and the verbs a language namespace reads it with (`load_user` ×7, `fetch_user` ×1). */
export interface MethodVerbGroup {
  /** The noun tail, snake-joined (`user`, `user_name`). */
  tail: string;
  /** The namespace's languages present in the group, sorted, comma-joined (`ruby`, `javascript,typescript`). */
  language: string;
  holders: number;
  verbs: { verb: string; holders: number }[];
}

/** Where a file language's rows group. */
export interface MethodVerbNamespace {
  key: string;
}

export interface MethodVerbGroupOptions {
  /** The namespace of a row's file language; a row whose language has none is dropped. */
  namespaceOf: (language: string) => MethodVerbNamespace | undefined;
  /** The verb lexicon per namespace key ({@link methodVerbLexicons}); a row whose head is outside it is dropped. */
  lexicons: ReadonlyMap<string, ReadonlySet<string>>;
  /** Groups returned. */
  limit: number;
  /** Verbs kept per group. */
  namesPerGroup: number;
}

interface TailBucket {
  lexicon: ReadonlySet<string>;
  tail: string;
  languages: Set<string>;
  rows: MethodNameRow[];
}

/**
 * One verb lexicon per language namespace ({@link deriveMethodVerbLexicon}) from
 * head-word rows grouped by file language: a namespace's languages are summed.
 * Rows with no language, or a language no namespace profiles, are dropped.
 */
export function methodVerbLexicons(
  rows: readonly MethodHeadWordRow[],
  namespaceOf: (language: string) => MethodVerbNamespace | undefined,
): Map<string, ReadonlySet<string>> {
  const byNamespace = new Map<string, MethodHeadWordRow[]>();
  for (const row of rows) {
    const namespace = row.language ? namespaceOf(row.language) : undefined;
    if (!namespace) continue;
    const bucket = byNamespace.get(namespace.key) ?? [];
    bucket.push(row);
    byNamespace.set(namespace.key, bucket);
  }
  return new Map([...byNamespace].map(([key, bucket]) => [key, deriveMethodVerbLexicon(bucket)]));
}

/** Every head of `lexicons`, once and sorted — the heads `readMethodTailVerbs` is asked for. */
export function methodVerbLexiconHeads(lexicons: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  return [...new Set([...lexicons.values()].flatMap((lexicon) => [...lexicon]))].sort();
}

/**
 * `rows` (`readMethodTailVerbs`, grouped by file language) as verb groups, the
 * most contested first — by distinct verbs, then by holders, then tail and
 * language; at most `limit`, each with at most `namesPerGroup` verbs. Each pair
 * is read as its most-held spelling (`name`) under its namespace's lexicon. The
 * store reads contested tails across all languages, so a namespace may still
 * hold one verb of a tail — such a group stays and ranks low.
 */
export function buildMethodVerbGroups(
  rows: readonly MethodTailVerbRow[],
  options: MethodVerbGroupOptions,
): MethodVerbGroup[] {
  const buckets = new Map<string, TailBucket>();
  for (const row of rows) {
    if (!row.language) continue;
    const namespace = options.namespaceOf(row.language);
    const lexicon = namespace ? options.lexicons.get(namespace.key) : undefined;
    if (!namespace || !lexicon || methodVerbOf(row.name, lexicon) === undefined) continue;
    const tail = joinIdentifierWords(methodNounTail(row.name, lexicon), "snake");
    const key = `${namespace.key}\u0000${tail}`;
    const bucket = buckets.get(key) ?? { lexicon, tail, languages: new Set<string>(), rows: [] };
    bucket.languages.add(row.language);
    bucket.rows.push({ shortName: row.name, holders: row.holders });
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(verbGroup)
    .sort(
      (a, b) =>
        b.verbs.length - a.verbs.length ||
        b.holders - a.holders ||
        a.tail.localeCompare(b.tail) ||
        a.language.localeCompare(b.language),
    )
    .slice(0, options.limit)
    .map((group) => ({ ...group, verbs: group.verbs.slice(0, options.namesPerGroup) }));
}

/** One bucket's group with every verb (the caller caps them after ranking); one name across languages is one name. */
function verbGroup(bucket: TailBucket): MethodVerbGroup {
  const names = new Map<string, number>();
  for (const row of bucket.rows) names.set(row.shortName, (names.get(row.shortName) ?? 0) + row.holders);
  const tailNames: MethodNameRow[] = [...names].map(([shortName, holders]) => ({ shortName, holders }));
  const verbs = groupMethodsByTail(tailNames, bucket.lexicon).get(bucket.tail) ?? [];
  return {
    tail: bucket.tail,
    language: [...bucket.languages].sort().join(","),
    holders: verbs.reduce((s, v) => s + v.holders, 0),
    verbs: verbs.map(({ verb, holders }) => ({ verb, holders })),
  };
}
