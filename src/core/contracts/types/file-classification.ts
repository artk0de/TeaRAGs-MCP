/**
 * What kind of file this is — the single FACT consumed by per-provider
 * enrichment policy (EnrichmentProvider.shouldEnrich). Canonical home.
 *
 * Sole declaration: `infra/file-classification/classify()` imports this type
 * and re-exports it. The foundation order (contracts < infra < adapters) makes
 * that type-only edge legal — before it was legalized, infra kept a
 * structurally-identical copy that had to be hand-synced.
 */
export interface FileClassification {
  /** Ordinary, human-edited source code. */
  isSource: boolean;
  /** Machine-generated (db/schema.rb, *.pb.go, @generated marker, vendored). */
  isGenerated: boolean;
  /** Documentation (markdown etc.) — derived from the file's language. */
  isDocumentation: boolean;
  /** Test file (*_spec.rb, *.test.ts, test dirs). */
  isTest: boolean;
}

/**
 * How one language names a test file by its path (bd tea-rags-mcp-vjz6s). The
 * language owns it — each vertical declares its own on its capability
 * (`LanguageCapability.testFiles`) — and the file classifier in `infra` only
 * matches it. Directory conventions shared by every language (`tests/`,
 * `spec/`) are not repeated here: the classifier holds them.
 */
export interface TestFileConvention {
  /** `.gitignore`-syntax globs, one path segment each (`**` + `/*_test.go`). */
  readonly patterns: readonly string[];
  /**
   * The language's test naming is mixed-case, so a capitalised suffix in
   * `patterns` is only the PascalCase spelling of a convention just as often
   * written in lowercase (googletest's `parser_test.cc`): such suffixes match
   * case-insensitively. Absent: a capitalised suffix (`*Test.java`) names a
   * PascalCase convention and matches case-sensitively, so `Latest.java` is no
   * test (bd tea-rags-mcp-ezm9o).
   */
  readonly mixedCaseSuffixes?: true;
}

/** Every language's {@link TestFileConvention}, keyed by language id. */
export type TestFileConventions = Readonly<Record<string, TestFileConvention>>;

/**
 * Path globs split by how case is matched — the one shape the JS path filter
 * and the DuckDB predicate both compile, so neither re-derives the split.
 */
export interface CaseSplitPathPatterns {
  readonly caseInsensitive: readonly string[];
  readonly caseSensitive: readonly string[];
}
