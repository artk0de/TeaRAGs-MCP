import type { TestFileConvention, TestFileConventions } from "../../../contracts/types/file-classification.js";
import type { LanguageCapability } from "../../../contracts/types/language.js";

/**
 * Test-file masks of the languages tea-rags indexes WITHOUT a
 * `domains/language` vertical — no chunking hooks, no walker, no capability
 * descriptor to declare them on. Carried over from the retired static-trajectory
 * basename regex (bd tea-rags-mcp-9ty5z) so `payload.isTest` loses no language.
 *
 * Why here and not in `infra`: which file names a language's tests is language
 * knowledge, and the language domain is its owner whether or not the language
 * has a vertical yet; `infra` keeps only the language-agnostic test directories.
 * Why not in a per-language directory: a directory under `domains/language/`
 * means a vertical, and these languages have none. When one gets a vertical its
 * entry moves into `<lang>/test-files.ts` and out of this bucket — the capability
 * test fails while both declare it.
 *
 * C and C++ test naming is mixed-case — googletest's `parser_test.cc` beside
 * `ParserTest.cc`, `unittest.c` — so their capitalised suffixes match
 * case-insensitively; every other capitalised suffix here is PascalCase-only.
 */
export const TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL: Readonly<Record<string, TestFileConvention>> = {
  php: { patterns: ["**/*Test.php"] },
  c_sharp: { patterns: ["**/*Test.cs", "**/*Tests.cs"] },
  cpp: {
    patterns: ["**/*Test.cpp", "**/*Tests.cpp", "**/*Test.cc", "**/*Tests.cc", "**/*Test.cxx", "**/*Tests.cxx"],
    mixedCaseSuffixes: true,
  },
  c: { patterns: ["**/*Test.c", "**/*Tests.c"], mixedCaseSuffixes: true },
  kotlin: { patterns: ["**/*Test.kt"] },
  dart: { patterns: ["**/*_test.dart"] },
  scala: { patterns: ["**/*Spec.scala", "**/*Test.scala"] },
  clojure: { patterns: ["**/*_test.clj", "**/*_test.cljs"] },
};

/**
 * Every language's test-file masks (bd tea-rags-mcp-vjz6s): each vertical's own
 * `LanguageCapability.testFiles` (declared in `<lang>/test-files.ts`), plus
 * {@link TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL}. A new vertical contributes by
 * declaring `testFiles` on its capability; nothing here changes. The memoized
 * aggregate a process installs is `languageTestFileConventions` in `native.ts`,
 * which owns the capability map this reads.
 *
 * Throws when a language sits both in the bucket and on a capability: two
 * declarations of one fact.
 */
export function aggregateTestFileConventions(
  capabilities: ReadonlyMap<string, LanguageCapability>,
): TestFileConventions {
  const conventions: Record<string, TestFileConvention> = {};
  for (const [language, capability] of capabilities) {
    if (capability.testFiles) conventions[language] = capability.testFiles;
  }
  for (const [language, convention] of Object.entries(TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL)) {
    if (conventions[language]) {
      throw new Error(`test-file masks of "${language}" are declared by its vertical AND the fallback bucket`);
    }
    conventions[language] = convention;
  }
  return conventions;
}
