import ignore, { type Ignore } from "ignore";

import type { FileClassification, TestFileConventions } from "../../contracts/types/file-classification.js";
import { GENERATED_CONTENT_MARKERS, GENERATED_PATTERNS, USER_GENERATED_PATTERNS } from "./patterns.js";
import { installedTestFileConventions } from "./test-file-conventions.js";
import { buildTestPathFilter, type PathFilter } from "./test-path-filter.js";

export type { FileClassification };

export interface ClassifyOptions {
  /** First ~5 lines of the file, for content-marker generated detection. */
  contentHead?: string;
  /** Documentation flag, derived by the caller from the file's language. */
  isDocumentation?: boolean;
}

// Built once — immutable after construction (the `ignore` package is stateless
// once loaded). Lazily initialised so module import stays side-effect-light.
let generatedFilter: Ignore | undefined;
/** The test filter, built for the conventions installed when it was built — rebuilt on a re-install. */
let testFilter: { conventions: TestFileConventions; filter: PathFilter } | undefined;

function getGeneratedFilter(): Ignore {
  if (!generatedFilter) {
    generatedFilter = ignore().add(GENERATED_PATTERNS).add(USER_GENERATED_PATTERNS);
  }
  return generatedFilter;
}

function getTestFilter(): PathFilter {
  const conventions = installedTestFileConventions();
  if (testFilter?.conventions !== conventions) {
    testFilter = { conventions, filter: buildTestPathFilter(conventions) };
  }
  return testFilter.filter;
}

function hasGeneratedMarker(head: string): boolean {
  return GENERATED_CONTENT_MARKERS.some((re) => re.test(head));
}

/**
 * Classify a repo-relative path. Pattern-based generated/test detection plus
 * optional content-marker scan. `isDocumentation` is passed through (its
 * source of truth is the language layer in ingest/chunker/config.ts). The
 * test shapes are the INSTALLED test-file conventions
 * (`./test-file-conventions.ts`); classifying before a composition root
 * installed them throws.
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
