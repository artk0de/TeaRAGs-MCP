/**
 * Vocabulary of a SCOPED `--force` (bd tea-rags-mcp-j4oww): re-chunk and
 * re-embed a filtered file set in place on the live collection, leaving every
 * other point untouched.
 *
 * Three domains speak it and none may import another: ingest compiles a
 * selector into the run's forced work set, the language domain declares which
 * files a chunk-set bump touched, and maintenance/drift turns pending bumps into
 * the minimal scoped command and decides which stamps a finished run covered.
 * Hence contracts.
 *
 * Every field is a RESTRICTION and an absent field restricts nothing; a file is
 * selected when it passes all of them (conjunction). The filters reuse the
 * search vocabulary where it maps onto the filesystem, and answer by the same
 * predicates — `pathPattern` by `compilePathPatternMatcher`, `testFile` by the
 * path classifier that writes `payload.isTest` — so a scoped run re-chunks
 * exactly the files a search with the same filter would return.
 */

/** `testFile` on a rechunk: the inclusion tri-state minus `include`, which restricts nothing. */
export type RechunkTestFileScope = "only" | "exclude";

/**
 * Which files ONE chunk-set bump changed the chunks of — declared on the bump,
 * never measured. Languages are implied by whoever declares it (a language's
 * capability, or `*` for every language).
 */
export interface ChunkSetBumpScope {
  testFile?: RechunkTestFileScope;
  /** picomatch, negation by a leading `!`, relative to the project root. */
  pathPattern?: string;
  /** Leading-dot extensions, e.g. `[".rb"]`. */
  fileExtensions?: readonly string[];
}

/**
 * The scope declarations of one language's chunk-set axes (`chunking`,
 * `grammar`). A revision / grammar version with no entry is UNSCOPED: it may
 * have moved the chunks of every file of the language.
 */
export interface ChunkSetBumpScopes {
  /** Keyed by the `chunking` revision the bump moved TO. */
  chunking?: Readonly<Record<number, ChunkSetBumpScope>>;
  /** Keyed by the grammar package version the upgrade moved TO. */
  grammar?: Readonly<Record<string, ChunkSetBumpScope>>;
}

/** The file selection of a scoped `--force` run. */
export interface RechunkFileSelector extends ChunkSetBumpScope {
  /** Languages by name (`LANGUAGE_MAP` vocabulary). */
  languages?: readonly string[];
  /** Explicit project-relative paths. */
  files?: readonly string[];
}

/** True when the selector restricts anything at all. */
export function isRestrictingRechunkSelector(selector: RechunkFileSelector): boolean {
  return (
    (selector.languages?.length ?? 0) > 0 ||
    selector.testFile !== undefined ||
    (selector.pathPattern ?? "").length > 0 ||
    (selector.fileExtensions?.length ?? 0) > 0 ||
    (selector.files?.length ?? 0) > 0
  );
}
