/**
 * The per-language test-file conventions, as `infra` receives them (bd
 * tea-rags-mcp-vjz6s).
 *
 * `domains/language` owns them — each vertical declares its own
 * `testFiles` on its capability, and `languageTestFileConventions()` aggregates
 * them — while the classifier that matches them is foundation, which imports
 * nothing above itself. So ownership moves by inversion: a composition root
 * hands the aggregate down.
 *
 * Two ways in, one source:
 *   - explicit: `buildTestPathFilter(conventions)`,
 *     `buildNonProductionPathFilter(conventions)`, `nonProductionPathPatterns`
 *     and {@link testPathPatterns} take the conventions as an argument;
 *   - installed: the module-level readers with no construction seam —
 *     `classify()` and scope detection, called from stateless helpers across
 *     ingest, trajectory and explore — answer from the conventions a
 *     composition root installed once per isolate: `createComposition()` on the
 *     main thread, and the codegraph provider factory in each enrichment worker,
 *     right after it imports the language module by path (the worker DI of
 *     `.claude/rules/domains-language.md`). The explicit builders default to it.
 *
 * Nothing installed is a wiring bug, not "no language masks": a read throws
 * rather than silently calling every `*_test.go` production code.
 */
import type { CaseSplitPathPatterns, TestFileConventions } from "../../contracts/types/file-classification.js";
import { COMMON_TEST_DIRECTORY_PATTERNS } from "./patterns.js";

let installed: TestFileConventions | undefined;

/**
 * Install the conventions every module-level reader of this isolate answers
 * from. Idempotent for the same value; a later install replaces the earlier one
 * (the readers key their caches on the installed object).
 */
export function installTestFileConventions(conventions: TestFileConventions): void {
  installed = conventions;
}

/** The installed conventions. Throws when no composition root installed any. */
export function installedTestFileConventions(): TestFileConventions {
  if (!installed) {
    throw new Error(
      "test-file conventions are not installed in this isolate: a composition root must call " +
        "installTestFileConventions(languageTestFileConventions()) before any file is classified",
    );
  }
  return installed;
}

/** Every test pattern of `conventions`, the language-agnostic directories first, split by case matching. */
export interface TestPathPatternSets extends CaseSplitPathPatterns {
  /** The deduped union — `caseSensitive` and `caseInsensitive` partition it. */
  readonly all: readonly string[];
}

function hasCapitalisedFilename(pattern: string): boolean {
  return /[A-Z]/.test(pattern.slice(pattern.lastIndexOf("/") + 1));
}

/**
 * The flat test-pattern sets of `conventions`: {@link COMMON_TEST_DIRECTORY_PATTERNS}
 * plus every language's patterns, deduped.
 *
 * Case-sensitive: a capitalised filename suffix (`*Test.java`, `*IT.java`,
 * `*Spec.scala`) names a PascalCase convention, and matching it
 * case-insensitively turns `Latest.java`, `Contest.kt` and `Audit.java` into
 * tests (bd tea-rags-mcp-ezm9o) — unless its language declares
 * `mixedCaseSuffixes` (googletest's `parser_test.cc` beside `ParserTest.cc`).
 * Derived here, so a new PascalCase language lands in the case-sensitive set
 * with no second edit. Everything else — directories, lowercase suffixes — is
 * case-insensitive.
 */
export function testPathPatterns(conventions: TestFileConventions): TestPathPatternSets {
  const conventionList = Object.values(conventions);
  const all = [...new Set([...COMMON_TEST_DIRECTORY_PATTERNS, ...conventionList.flatMap((c) => c.patterns)])];
  const caseSensitive = [
    ...new Set(
      conventionList.filter((c) => !c.mixedCaseSuffixes).flatMap((c) => c.patterns.filter(hasCapitalisedFilename)),
    ),
  ];
  const sensitive = new Set(caseSensitive);
  return { all, caseSensitive, caseInsensitive: all.filter((pattern) => !sensitive.has(pattern)) };
}
