/**
 * Per-language test-file masks live in `domains/language` (bd tea-rags-mcp-vjz6s):
 * each vertical declares its own on its capability, the language domain
 * aggregates them, and `infra/file-classification` only matches what it is
 * given. Assertions carried over from the retired
 * `tests/core/infra/file-classification/test-patterns.test.ts`, which pinned the
 * same table while it lived in infra.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  languageTestFileConventions,
  nativeLanguageCapabilities,
} from "../../../../../src/core/domains/language/capability/native.js";
import {
  aggregateTestFileConventions,
  TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL,
} from "../../../../../src/core/domains/language/capability/test-files.js";
import {
  COMMON_TEST_DIRECTORY_PATTERNS,
  testPathPatterns,
} from "../../../../../src/core/infra/file-classification/index.js";

const LANGUAGE_DIR = join(process.cwd(), "src/core/domains/language");
const INFRA_DIR = join(process.cwd(), "src/core/infra");

// The canonical pre-relocation flat TEST_PATTERNS set. The per-language
// reorganization MUST stay lossless against this — no test-file shape dropped,
// none added (substrate spec backward-compat invariant). One deliberate
// addition since: TypeScript's ESM / CJS module formats (`.mts` / `.cts`),
// which ingest and the codegraph index as TypeScript (bd tea-rags-mcp-1y13c),
// carry TypeScript's own test suffixes. A second: the languages only the
// retired static-trajectory basename regex knew (php … clojure), folded in when
// `payload.isTest` moved onto this classifier (bd tea-rags-mcp-9ty5z).
const CANONICAL_TEST_PATTERNS = [
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/spec/**",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mts",
  "**/*.test.cts",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.mts",
  "**/*.spec.cts",
  "**/*.spec.mjs",
  "**/*.spec.cjs",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
  "**/*_test.rb",
  "**/*_spec.rb",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*IT.java",
  "**/*_test.go",
  "**/*_test.rs",
  "**/*Test.php",
  "**/*Test.cs",
  "**/*Tests.cs",
  "**/*Test.cpp",
  "**/*Tests.cpp",
  "**/*Test.cc",
  "**/*Tests.cc",
  "**/*Test.cxx",
  "**/*Tests.cxx",
  "**/*Test.c",
  "**/*Tests.c",
  "**/*Test.swift",
  "**/*Tests.swift",
  "**/*Test.kt",
  "**/*_test.dart",
  "**/*Spec.scala",
  "**/*Test.scala",
  "**/*_test.clj",
  "**/*_test.cljs",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("languageTestFileConventions — per-language test path patterns (in domains/language)", () => {
  const conventions = languageTestFileConventions();

  it("groups patterns by code language; directory conventions stay language-agnostic in infra", () => {
    // Code-language buckets the byLanguage codegraph metric will key off.
    for (const lang of ["typescript", "javascript", "python", "ruby", "java", "go", "rust"]) {
      expect(conventions[lang], `${lang} bucket`).toBeDefined();
      expect(conventions[lang].patterns.length).toBeGreaterThan(0);
    }
    // Directory conventions are language-agnostic.
    expect(COMMON_TEST_DIRECTORY_PATTERNS).toContain("**/spec/**");
    expect(conventions.common).toBeUndefined();
  });

  it("assigns each language its own suffix conventions", () => {
    expect(conventions.ruby.patterns).toEqual(["**/*_test.rb", "**/*_spec.rb"]);
    expect(conventions.go.patterns).toEqual(["**/*_test.go"]);
    expect(conventions.python.patterns).toContain("**/conftest.py");
    expect(conventions.typescript.patterns).toContain("**/*.test.ts");
    expect(conventions.java.patterns).toContain("**/*IT.java");
  });

  it("derives the flat pattern list as the deduped union of all buckets — lossless vs canonical", () => {
    const { all } = testPathPatterns(conventions);
    const union = new Set([
      ...COMMON_TEST_DIRECTORY_PATTERNS,
      ...Object.values(conventions).flatMap((c) => c.patterns),
    ]);
    expect(new Set(all)).toEqual(union);
    // Provably lossless: the flat set equals the pre-change canonical set.
    expect(new Set(all)).toEqual(new Set(CANONICAL_TEST_PATTERNS));
  });

  it("contains no duplicate patterns in the flat list", () => {
    const { all } = testPathPatterns(conventions);
    expect(all.length).toBe(new Set(all).size);
  });

  it("partitions the flat list by case sensitivity — PascalCase suffixes only (bd tea-rags-mcp-ezm9o)", () => {
    const { all, caseSensitive, caseInsensitive } = testPathPatterns(conventions);
    const sensitive = new Set(caseSensitive);
    expect(new Set([...caseSensitive, ...caseInsensitive])).toEqual(new Set(all));
    expect(caseInsensitive.filter((p) => sensitive.has(p))).toEqual([]);
    for (const p of ["**/*Test.java", "**/*IT.java", "**/*Test.kt", "**/*Tests.swift", "**/*Tests.cs"]) {
      expect(sensitive.has(p), p).toBe(true);
    }
    for (const p of ["**/*Spec.scala", "**/*Test.php"]) expect(sensitive.has(p), p).toBe(true);
    // Directories, lowercase conventions and the mixed-case C / C++ suffixes stay case-insensitive.
    for (const p of [...COMMON_TEST_DIRECTORY_PATTERNS, "**/*_test.go", "**/*.spec.ts", "**/*Test.cc", "**/*Tests.c"]) {
      expect(sensitive.has(p), p).toBe(false);
    }
  });
});

describe("test-file masks are owned by the language that declares them (bd tea-rags-mcp-vjz6s)", () => {
  const conventions = languageTestFileConventions();
  const native = nativeLanguageCapabilities();

  it("every vertical's masks come from its own capability, declared in its own directory", () => {
    for (const [language, capability] of native) {
      if (!capability.testFiles) continue;
      expect(conventions[language], language).toBe(capability.testFiles);
      expect(existsSync(join(LANGUAGE_DIR, language, "test-files.ts")), `${language}/test-files.ts`).toBe(true);
    }
  });

  it("a vertical declares test-file masks unless its tests tier says it has no test convention to match", () => {
    const withoutMasks = [...native.values()].filter((c) => !c.testFiles).map((c) => c.language);
    // bash: bats / shunit are not recognized; markdown is a documentation language.
    expect(withoutMasks.sort()).toEqual(["bash", "markdown"]);
  });

  it("the fallback bucket holds only languages with no vertical, and never shadows one", () => {
    for (const language of Object.keys(TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL)) {
      expect(native.has(language), language).toBe(false);
      expect(existsSync(join(LANGUAGE_DIR, language)), `domains/language/${language}`).toBe(false);
      expect(conventions[language]).toBe(TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL[language]);
    }
    expect(Object.keys(TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL).sort()).toEqual(
      ["c", "c_sharp", "clojure", "cpp", "dart", "kotlin", "php", "scala"].sort(),
    );
  });

  it("only C and C++ declare mixed-case suffixes", () => {
    const mixed = Object.entries(conventions)
      .filter(([, c]) => c.mixedCaseSuffixes)
      .map(([language]) => language)
      .sort();
    expect(mixed).toEqual(["c", "cpp"]);
  });

  it("infra holds no pattern literal of a language that has a vertical", () => {
    const infraText = sourceFiles(INFRA_DIR).map((path) => [path, readFileSync(path, "utf8")] as const);
    for (const [language, capability] of native) {
      for (const pattern of capability.testFiles?.patterns ?? []) {
        for (const [path, text] of infraText) {
          expect(text.includes(`"${pattern}"`), `${language} ${pattern} in ${path}`).toBe(false);
        }
      }
    }
  });
});

describe("how the conventions reach the file classifier (bd tea-rags-mcp-vjz6s)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("loading the language capability map installs them, so no entry point has to remember to", async () => {
    vi.resetModules();
    const infra = await import("../../../../../src/core/infra/file-classification/test-file-conventions.js");
    expect(() => infra.installedTestFileConventions()).toThrow(/installTestFileConventions/);
    const language = await import("../../../../../src/core/domains/language/capability/native.js");
    expect(infra.installedTestFileConventions()).toBe(language.languageTestFileConventions());
  });

  it("refuses a language declared both by its vertical and by the fallback bucket", () => {
    const [[language, capability]] = [...nativeLanguageCapabilities()].filter(([, c]) => c.testFiles);
    const bucketLanguage = Object.keys(TEST_FILES_OF_LANGUAGES_WITHOUT_VERTICAL)[0];
    expect(() => aggregateTestFileConventions(new Map([[bucketLanguage, capability]]))).toThrow(/fallback bucket/);
    expect(aggregateTestFileConventions(new Map([[language, capability]]))[language]).toBe(capability.testFiles);
  });
});
