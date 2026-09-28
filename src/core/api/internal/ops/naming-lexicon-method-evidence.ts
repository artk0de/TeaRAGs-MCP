/**
 * The method-vocabulary evidence `get_naming_lexicon` judges untyped `return`
 * drafts by (spec 2026-09-28 naming coverage, §D4 / §D4a): at most two
 * bounded store reads per answer, whatever the number of drafts — the head
 * words the namespace's verb lexicon is derived from (memoized per request),
 * then the names ending in any verbless draft's last word. Which draft is
 * verbless depends on the lexicon, so the head-word read comes first. Each
 * draft's {@link UntypedMethodEvidence} is then filtered from those rows with
 * its own pattern. The reader is the answer's scoped reader: its excluded
 * files and language namespace are already bound.
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

/** The RE2 pattern of a verbless draft's last-word slice (its analogues); none for a draft with no word. */
function lastWordPattern(name: string): string | undefined {
  const lastWord = splitIdentifierWords(name).at(-1);
  return lastWord === undefined ? undefined : methodLastWordPattern(lastWord);
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

  const isVerbless = (name: string) => methodVerbOf(name, lexicon) === undefined;
  const lastWordPatterns = [...new Set(names.filter(isVerbless).flatMap((name) => lastWordPattern(name) ?? []))];
  const lastWordRows =
    lastWordPatterns.length > 0 ? await reader.readMethodNamesMatching({ ...base, patterns: lastWordPatterns }) : [];

  return (name) => ({
    lexicon,
    headWords,
    lastWordNames: isVerbless(name) ? rowsMatching(lastWordRows, lastWordPattern(name)) : [],
    declared: declared.has(name),
  });
}
