/**
 * The forced work set of a scoped `--force` (bd tea-rags-mcp-j4oww).
 *
 * A scoped force is an incremental run whose work set is widened by every
 * indexed file a {@link RechunkFileSelector} picks. Those files are then
 * re-chunked exactly the way a MODIFIED file is — old points deleted by path,
 * new chunks embedded and upserted, the codegraph walker's DELETE+INSERT
 * replacing their rows, enrichment run for their chunks only — so nothing
 * outside the selection is touched and no new collection is built.
 *
 * Each filter answers by the predicate its search namesake uses, so a scoped
 * run re-chunks exactly the files a search with the same filter would return:
 * `testFile` by `classify(...).isTest` (the writer of `payload.isTest`),
 * `pathPattern` by `compilePathPatternMatcher`, `languages` by the extension map
 * the scanner already selects languages with.
 */

import { extname } from "node:path";

import type { RechunkFileSelector } from "../../../contracts/types/rechunk.js";
import { classify } from "../../../infra/file-classification/index.js";
import { compilePathPatternMatcher } from "../../../infra/path-pattern.js";
import { extensionsForLanguages } from "../pipeline/chunker/config.js";

/** True iff a project-relative path is selected. */
export type RechunkFileMatcher = (relativePath: string) => boolean;

export function compileRechunkFileSelector(selector: RechunkFileSelector): RechunkFileMatcher {
  const predicates: RechunkFileMatcher[] = [];

  if (selector.languages && selector.languages.length > 0) {
    const extensions = new Set(extensionsForLanguages(selector.languages));
    predicates.push((path) => extensions.has(extname(path)));
  }
  if (selector.fileExtensions && selector.fileExtensions.length > 0) {
    const extensions = new Set(selector.fileExtensions.map(normalizeExtension));
    predicates.push((path) => extensions.has(extname(path)));
  }
  if (selector.testFile !== undefined) {
    const wantTests = selector.testFile === "only";
    predicates.push((path) => isTestPath(path) === wantTests);
  }
  const pathMatcher = compilePathPatternMatcher(selector.pathPattern);
  if (pathMatcher) predicates.push(pathMatcher);
  if (selector.files && selector.files.length > 0) {
    const files = new Set(selector.files.map(normalizeRelativePath));
    predicates.push((path) => files.has(path));
  }

  return (path) => predicates.every((matches) => matches(path));
}

/**
 * The files a scoped force re-chunks: selected AND already indexed. A file the
 * index does not hold yet is an ADDED file the incremental leg ingests anyway;
 * forcing it would only double-count it.
 */
export function selectRechunkWorkSet(input: {
  selector: RechunkFileSelector;
  scannedFiles: readonly string[];
  indexedFiles: ReadonlySet<string>;
}): string[] {
  const matches = compileRechunkFileSelector(input.selector);
  return input.scannedFiles.filter((path) => input.indexedFiles.has(path) && matches(path));
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeRelativePath(path: string): string {
  return path.trim().replace(/^\.\/+/, "");
}

/** Same guard `detectTestFile` applies: the classifier throws on non-relative paths. */
function isTestPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("..")) return false;
  return classify(path).isTest;
}
