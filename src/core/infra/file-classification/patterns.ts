/**
 * Single source of truth for "what kind of file is this" path patterns.
 * Consolidates the previously codegraph-only generated/test pattern lists
 * (was trajectory/codegraph/exclusion.ts) so git enrichment, codegraph, and
 * any future consumer share one definition. `ignore` (gitignore) syntax.
 */

/** Machine-generated files — never meaningfully owned, often huge. */
export const GENERATED_PATTERNS: readonly string[] = [
  // Rails generated AR schema — re-authored by `rails db:migrate`.
  "**/db/schema.rb",
  // Vendored third-party code (bundled gems, asset libs).
  "**/vendor/**",
  // Protobuf / gRPC generated stubs.
  "*.pb.go",
  "*_pb2.py",
  // Common "generated" naming conventions.
  "*.generated.*",
  "*.g.dart",
];

/**
 * Conventional test-file shapes, grouped per code language (+ a language-agnostic
 * `common` directory bucket). Each language OWNS its suffix conventions so the
 * per-code-language codegraph `resolveSuccessRate` breakdown and the classifier
 * agree on "a test file in language X".
 *
 * Why this lives in `infra` (not `domains/language`): the classifier is
 * foundation and `core/infra` imports NOTHING — neither `contracts` nor
 * `domains` are reachable (see the duplicated `FileClassification` in
 * `classify.ts`). The classifier, the codegraph exclusion filter, and the
 * enrichment/chunker workers all reach these patterns via the infra import, so
 * infra is the only layer every consumer can read. Per-language grouping gives
 * the ownership; the flat `TEST_PATTERNS` union is derived for existing
 * consumers.
 *
 * `common` holds directory conventions not specific to one language (a `spec/`
 * dir is shared by ruby/js, a `test/` dir is universal). Code languages only —
 * `bash` (no test convention) and `markdown` (doc language) contribute nothing.
 */
export const TEST_PATTERNS_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  common: ["**/tests/**", "**/test/**", "**/__tests__/**", "**/spec/**"],
  // `.mts` / `.cts` are indexed as TypeScript (bd tea-rags-mcp-1y13c); without
  // them here `worker.test.mts` entered the codegraph as production code.
  typescript: [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.test.mts",
    "**/*.test.cts",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.spec.mts",
    "**/*.spec.cts",
  ],
  javascript: [
    "**/*.test.js",
    "**/*.test.jsx",
    "**/*.test.mjs",
    "**/*.test.cjs",
    "**/*.spec.js",
    "**/*.spec.jsx",
    "**/*.spec.mjs",
    "**/*.spec.cjs",
  ],
  python: ["**/test_*.py", "**/*_test.py", "**/conftest.py"],
  ruby: ["**/*_test.rb", "**/*_spec.rb"],
  java: ["**/*Test.java", "**/*Tests.java", "**/*IT.java"],
  go: ["**/*_test.go"],
  rust: ["**/*_test.rs"],
  // Carried over from the retired static-trajectory basename regex (bd
  // tea-rags-mcp-9ty5z) so `payload.isTest` loses no language when it moved
  // onto this classifier. A capitalised suffix matches case-sensitively — see
  // CASE_SENSITIVE_TEST_PATTERNS.
  php: ["**/*Test.php"],
  c_sharp: ["**/*Test.cs", "**/*Tests.cs"],
  cpp: ["**/*Test.cpp", "**/*Tests.cpp", "**/*Test.cc", "**/*Tests.cc", "**/*Test.cxx", "**/*Tests.cxx"],
  c: ["**/*Test.c", "**/*Tests.c"],
  swift: ["**/*Test.swift", "**/*Tests.swift"],
  kotlin: ["**/*Test.kt"],
  dart: ["**/*_test.dart"],
  scala: ["**/*Spec.scala", "**/*Test.scala"],
  clojure: ["**/*_test.clj", "**/*_test.cljs"],
};

/**
 * Flat, deduped union of every per-language bucket — the shape existing
 * consumers (the test classifier, codegraph exclusion) keep importing. Derived
 * from {@link TEST_PATTERNS_BY_LANGUAGE} so there is one source of truth.
 */
export const TEST_PATTERNS: readonly string[] = [...new Set(Object.values(TEST_PATTERNS_BY_LANGUAGE).flat())];

/**
 * Languages whose test-file naming is mixed-case, so a capitalised suffix in
 * their bucket is only the PascalCase spelling of a convention that is just as
 * often lowercase (googletest's `parser_test.cc`, `unittest.c`). The retired
 * basename regex said the same with `[Tt]ests?`. Their suffixes stay
 * case-insensitive.
 */
const MIXED_CASE_TEST_CONVENTION_LANGUAGES: ReadonlySet<string> = new Set(["c", "cpp"]);

function hasCapitalisedFilename(pattern: string): boolean {
  return /[A-Z]/.test(pattern.slice(pattern.lastIndexOf("/") + 1));
}

/**
 * Test patterns matched case-sensitively: a capitalised filename suffix
 * (`*Test.java`, `*IT.java`, `*Spec.scala`) names a PascalCase convention, and
 * matching it case-insensitively turns `Latest.java`, `Contest.kt` and
 * `Audit.java` into tests (bd tea-rags-mcp-ezm9o). Derived from
 * {@link TEST_PATTERNS_BY_LANGUAGE}, so a new PascalCase bucket lands here with
 * no second edit. Directory patterns and lowercase suffixes are never in it.
 */
export const CASE_SENSITIVE_TEST_PATTERNS: readonly string[] = [
  ...new Set(
    Object.entries(TEST_PATTERNS_BY_LANGUAGE)
      .filter(([language]) => !MIXED_CASE_TEST_CONVENTION_LANGUAGES.has(language))
      .flatMap(([, patterns]) => patterns.filter(hasCapitalisedFilename)),
  ),
];

/** The rest of {@link TEST_PATTERNS}, matched case-insensitively (`Tests/`, `*.spec.ts`, `*Test.cc`). */
export const CASE_INSENSITIVE_TEST_PATTERNS: readonly string[] = TEST_PATTERNS.filter(
  (pattern) => !CASE_SENSITIVE_TEST_PATTERNS.includes(pattern),
);

/**
 * Development tooling that lives beside the product: scripts (`script/` is the
 * Rails spelling), spikes, benchmarks, examples and fixtures, at any depth
 * (bd tea-rags-mcp-r8hme.9). Source code — indexed, chunked, searchable, in the
 * codegraph — but not part of the architecture a boundary diagnostic judges:
 * a spike deep-importing a worker pool is not a leaking abstraction, and a
 * report script importing the detector does not stabilise it. `bin/` is left
 * out on purpose — it holds the shipped entry points of a CLI package.
 * `.gitignore` syntax: a trailing `/` names a directory at any depth.
 */
export const NON_PRODUCTION_PATTERNS: readonly string[] = [
  "scripts/",
  "script/",
  "spikes/",
  "benchmarks/",
  "bench/",
  "examples/",
  "fixtures/",
  "__fixtures__/",
];

/** First-N-lines markers that identify generated files with non-standard names. */
export const GENERATED_CONTENT_MARKERS: readonly RegExp[] = [
  /Code generated .* DO NOT EDIT/i,
  /@generated\b/,
  /^\s*#\s*Autogenerated/im,
];

/**
 * User-supplied extra generated patterns via `TEA_RAGS_GENERATED_PATTERNS`
 * (comma-separated gitignore globs). Shared knob — affects both git-skip and
 * codegraph graph-exclusion. The legacy `CODEGRAPH_CUSTOM_EXCLUDE` env keeps
 * working independently in codegraph's own filter.
 */
export const USER_GENERATED_PATTERNS: readonly string[] = (process.env.TEA_RAGS_GENERATED_PATTERNS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
