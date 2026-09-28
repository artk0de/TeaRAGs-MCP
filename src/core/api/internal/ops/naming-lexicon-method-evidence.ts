/**
 * The method-vocabulary evidence `get_naming_lexicon` judges untyped `return`
 * drafts by (spec 2026-09-28 naming coverage, §D4 / §D4a): at most three
 * bounded store reads per answer, whatever the number of drafts — the head
 * words the namespace's verb lexicon is derived from (memoized per request),
 * then the names carrying any verbed draft's noun tail and the names ending in
 * any verbless draft's last word. Which draft is verbed depends on the lexicon,
 * so the head-word read comes first. Each draft's {@link UntypedMethodEvidence}
 * is then filtered from those rows with its own patterns. The reader is the
 * answer's scoped reader: its excluded files and language namespace are
 * already bound.
 */
import type {
  GraphDbClient,
  MethodHeadWordRow,
  MethodNameRow,
  TypeNameQuery,
} from "../../../contracts/types/codegraph.js";
import {
  deriveMethodVerbLexicon,
  methodLastWordPattern,
  methodTailPattern,
  methodVerbOf,
  MIN_ROLE_MEMBERS,
  splitIdentifierWords,
  type UntypedMethodEvidence,
} from "../../../domains/explore/naming-lexicon/index.js";

type MethodVocabularyReader = Pick<GraphDbClient, "readMethodHeadWords" | "readMethodNamesMatching">;

/** Where the method reads look: the answer's path prefixes and the non-production paths they skip. */
export interface MethodEvidenceScope {
  pathPrefixes: string[] | undefined;
  nonProductionPaths: TypeNameQuery["nonProductionPaths"];
}

/**
 * The request's head-word reads, keyed by the reader's scope (its language
 * namespace, excluded files and prefixes): diff mode answers once per
 * language, and names mode once per owned file, so one request reads each
 * scope's head words — and so derives its verb lexicon — once.
 */
export interface MethodHeadWordMemo {
  reads: Map<string, Promise<MethodHeadWordRow[]>>;
  key: string;
}

/**
 * The RE2 pattern of a multi-word draft's tail slice: the names spelling its
 * words after the head under any head (`modify_user` → `…_user`). The judge
 * compares a dominant lexicon verb there whether or not the draft's own head
 * is one. None for a one-word draft.
 */
function tailPattern(name: string): string | undefined {
  const words = splitIdentifierWords(name);
  return words.length > 1 ? methodTailPattern(words.slice(1)) : undefined;
}

/** The RE2 pattern of a verbless draft's last-word slice (its analogues); none for a draft with no word. */
function lastWordPattern(name: string): string | undefined {
  const lastWord = splitIdentifierWords(name).at(-1);
  return lastWord === undefined ? undefined : methodLastWordPattern(lastWord);
}

/**
 * The RE2 pattern of the names ending in a multi-word draft's head when the head
 * is outside the lexicon — the positional evidence that tells a project noun
 * (`user_name`) from a new synonym verb (`modify_user`). None otherwise.
 */
function headLastWordPattern(name: string, lexicon: ReadonlySet<string>): string | undefined {
  const [head, ...tail] = splitIdentifierWords(name);
  return tail.length > 0 && !lexicon.has(head) ? methodLastWordPattern(head) : undefined;
}

/** Rows whose name matches `pattern` — the store matched the batch, this splits it per draft. */
function rowsMatching(rows: readonly MethodNameRow[], pattern: string | undefined): MethodNameRow[] {
  if (pattern === undefined) return [];
  const regex = new RegExp(pattern);
  return rows.filter((row) => regex.test(row.shortName));
}

/**
 * Reads the evidence for `drafts` (untyped `return` drafts) and returns the
 * per-name lookup. `declared` = the draft names a method of the same name is
 * declared under elsewhere in scope (the judge's `existingSymbolShortNames`).
 */
export async function readUntypedMethodEvidence(
  reader: MethodVocabularyReader,
  drafts: readonly { name: string }[],
  scope: MethodEvidenceScope,
  declared: ReadonlySet<string>,
  memo?: MethodHeadWordMemo,
): Promise<(name: string) => UntypedMethodEvidence> {
  const names = [...new Set(drafts.map((d) => d.name))];
  const base = {
    ...(scope.pathPrefixes ? { pathPrefixes: scope.pathPrefixes } : {}),
    nonProductionPaths: scope.nonProductionPaths,
  };

  const readHeadWords = async (): Promise<MethodHeadWordRow[]> =>
    reader.readMethodHeadWords({ ...base, minTails: MIN_ROLE_MEMBERS });
  const headWordsRead = async (): Promise<MethodHeadWordRow[]> => {
    if (!memo) return readHeadWords();
    let read = memo.reads.get(memo.key);
    if (read === undefined) {
      read = readHeadWords();
      memo.reads.set(memo.key, read);
    }
    return read;
  };
  const headWords = names.length > 0 ? await headWordsRead() : [];
  const lexicon = deriveMethodVerbLexicon(headWords);

  const verbless = names.filter((name) => methodVerbOf(name, lexicon) === undefined);
  const patternsOf = (group: readonly string[], patternOf: (name: string) => string | undefined) => [
    ...new Set(group.flatMap((name) => patternOf(name) ?? [])),
  ];
  const tailPatterns = patternsOf(names, tailPattern);
  const lastWordPatterns = [
    ...new Set([
      ...patternsOf(verbless, lastWordPattern),
      ...patternsOf(verbless, (name) => headLastWordPattern(name, lexicon)),
    ]),
  ];
  const [tailRows, lastWordRows] = await Promise.all([
    tailPatterns.length > 0
      ? reader.readMethodNamesMatching({ ...base, patterns: tailPatterns })
      : Promise.resolve<MethodNameRow[]>([]),
    lastWordPatterns.length > 0
      ? reader.readMethodNamesMatching({ ...base, patterns: lastWordPatterns })
      : Promise.resolve<MethodNameRow[]>([]),
  ]);

  return (name) => {
    const isVerbed = methodVerbOf(name, lexicon) !== undefined;
    return {
      lexicon,
      headWords,
      tailNames: rowsMatching(tailRows, tailPattern(name)),
      lastWordNames: isVerbed ? [] : rowsMatching(lastWordRows, lastWordPattern(name)),
      headLastNames: rowsMatching(lastWordRows, headLastWordPattern(name, lexicon)),
      declared: declared.has(name),
    };
  };
}
