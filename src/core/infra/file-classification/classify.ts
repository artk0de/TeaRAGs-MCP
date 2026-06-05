import ignore, { type Ignore } from "ignore";

import { GENERATED_CONTENT_MARKERS, GENERATED_PATTERNS, TEST_PATTERNS, USER_GENERATED_PATTERNS } from "./patterns.js";

/**
 * Structurally identical to FileClassification in
 * core/contracts/types/file-classification.ts. Declared locally because
 * core/infra/ may not import core/contracts/ (foundation imports nothing).
 * Keep the two in sync — see the note in the contracts file.
 */
export interface FileClassification {
  isSource: boolean;
  isGenerated: boolean;
  isDocumentation: boolean;
  isTest: boolean;
}

export interface ClassifyOptions {
  /** First ~5 lines of the file, for content-marker generated detection. */
  contentHead?: string;
  /** Documentation flag, derived by the caller from the file's language. */
  isDocumentation?: boolean;
}

// Built once — immutable after construction (the `ignore` package is stateless
// once loaded). Lazily initialised so module import stays side-effect-light.
let generatedFilter: Ignore | undefined;
let testFilter: Ignore | undefined;

function getGeneratedFilter(): Ignore {
  if (!generatedFilter) {
    generatedFilter = ignore()
      .add(GENERATED_PATTERNS as string[])
      .add(USER_GENERATED_PATTERNS as string[]);
  }
  return generatedFilter;
}

function getTestFilter(): Ignore {
  if (!testFilter) testFilter = ignore().add(TEST_PATTERNS as string[]);
  return testFilter;
}

function hasGeneratedMarker(head: string): boolean {
  return GENERATED_CONTENT_MARKERS.some((re) => re.test(head));
}

/**
 * Classify a repo-relative path. Pattern-based generated/test detection plus
 * optional content-marker scan. `isDocumentation` is passed through (its
 * source of truth is the language layer in ingest/chunker/config.ts).
 */
export function classify(relPath: string, opts?: ClassifyOptions): FileClassification {
  const isGenerated =
    getGeneratedFilter().ignores(relPath) || (opts?.contentHead ? hasGeneratedMarker(opts.contentHead) : false);
  const isTest = getTestFilter().ignores(relPath);
  const isDocumentation = opts?.isDocumentation === true;
  // A generated or documentation file is not "source". A test IS source.
  const isSource = !isGenerated && !isDocumentation;
  return { isSource, isGenerated, isDocumentation, isTest };
}
