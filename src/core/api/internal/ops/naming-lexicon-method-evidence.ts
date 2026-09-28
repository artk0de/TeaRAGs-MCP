/**
 * The method-vocabulary evidence `get_naming_lexicon` judges untyped `return`
 * drafts by (spec 2026-09-28 naming coverage, §D4): at most three bounded
 * store reads per answer, whatever the number of drafts — the project's verb
 * vocabulary (memoized per request), the names carrying any verbed draft's noun
 * tail, and the names ending in any verbless draft's last word. Each draft's
 * {@link UntypedMethodEvidence} is then filtered from those rows with its own
 * patterns. The reader is the answer's scoped reader: its excluded files and
 * language namespace are already bound.
 */
import type { GraphDbClient, MethodNameRow, MethodVerbRow, TypeNameQuery } from "../../../contracts/types/codegraph.js";
import {
  methodLastWordPattern,
  methodNounTail,
  methodTailPattern,
  methodVerbOf,
  NAMING_VERB_PREFIXES,
  splitIdentifierWords,
  type UntypedMethodEvidence,
} from "../../../domains/explore/naming-lexicon/index.js";

type MethodVocabularyReader = Pick<GraphDbClient, "readMethodVerbs" | "readMethodNamesMatching">;

/** Where the method reads look: the answer's path prefixes and the non-production paths they skip. */
export interface MethodEvidenceScope {
  pathPrefixes: string[] | undefined;
  nonProductionPaths: TypeNameQuery["nonProductionPaths"];
}

/**
 * The request's verb-vocabulary reads, keyed by the reader's scope (its
 * language namespace, excluded files and prefixes): diff mode answers once per
 * language, and names mode once per owned file, so one request reads each
 * scope's vocabulary once.
 */
export interface MethodVerbMemo {
  reads: Map<string, Promise<MethodVerbRow[]>>;
  key: string;
}

/** The RE2 pattern a draft's name slice is read and filtered by; none for a verbed draft's empty tail. */
function draftPattern(name: string): string | undefined {
  if (methodVerbOf(name) !== undefined) return methodTailPattern(methodNounTail(name));
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
  memo?: MethodVerbMemo,
): Promise<(name: string) => UntypedMethodEvidence> {
  const names = [...new Set(drafts.map((d) => d.name))];
  const verbed = names.filter((name) => methodVerbOf(name) !== undefined);
  const verbless = names.filter((name) => methodVerbOf(name) === undefined);
  const base = {
    ...(scope.pathPrefixes ? { pathPrefixes: scope.pathPrefixes } : {}),
    nonProductionPaths: scope.nonProductionPaths,
  };
  const patternsOf = (group: readonly string[]) => [...new Set(group.flatMap((name) => draftPattern(name) ?? []))];
  const tailPatterns = patternsOf(verbed);
  const lastWordPatterns = patternsOf(verbless);

  const readVerbs = async (): Promise<MethodVerbRow[]> =>
    reader.readMethodVerbs({ ...base, verbs: NAMING_VERB_PREFIXES });
  const verbsRead = async (): Promise<MethodVerbRow[]> => {
    if (!memo) return readVerbs();
    let read = memo.reads.get(memo.key);
    if (read === undefined) {
      read = readVerbs();
      memo.reads.set(memo.key, read);
    }
    return read;
  };
  const [verbs, tailRows, lastWordRows] = await Promise.all([
    verbed.length > 0 ? verbsRead() : Promise.resolve<MethodVerbRow[]>([]),
    tailPatterns.length > 0
      ? reader.readMethodNamesMatching({ ...base, patterns: tailPatterns })
      : Promise.resolve<MethodNameRow[]>([]),
    lastWordPatterns.length > 0
      ? reader.readMethodNamesMatching({ ...base, patterns: lastWordPatterns })
      : Promise.resolve<MethodNameRow[]>([]),
  ]);

  return (name) => {
    const pattern = draftPattern(name);
    const isVerbed = methodVerbOf(name) !== undefined;
    return {
      verbs,
      tailNames: isVerbed ? rowsMatching(tailRows, pattern) : [],
      lastWordNames: isVerbed ? [] : rowsMatching(lastWordRows, pattern),
      declared: declared.has(name),
    };
  };
}
