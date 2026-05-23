/**
 * Codegraph-specific exclusion filter — applied AFTER the FileScanner
 * `ignoreFilter` (BUILTIN_IGNORE_PATTERNS + user .gitignore / .contextignore)
 * inside `CodegraphEnrichmentProvider.discoverSupportedFiles`.
 *
 * Why a second layer instead of merging into FileScanner. Test files are
 * legitimate search targets for Qdrant ingest — answering "show me tests for
 * AuthService" relies on `*_spec.rb` / `*.test.ts` chunks being indexed. But
 * they pollute the codegraph fan-graph: a test calls many services and is
 * called by none, so its `fanOut` is high and `fanIn=0` skews preset
 * rankings (`isHub`, instability, PageRank) without representing actual
 * dependency structure. Excluding tests at codegraph layer keeps Qdrant
 * ingest unaffected while cleaning the graph signal.
 *
 * Patterns follow `.gitignore` syntax (the `ignore` npm package). Defaults
 * cover the conventional test file shapes for every language with a
 * codegraph walker. `CODEGRAPH_EXCLUDE_TESTS=false` opts back into
 * including tests; `CODEGRAPH_CUSTOM_EXCLUDE` adds project-specific
 * patterns on top.
 */

import ignore, { type Ignore } from "ignore";

/**
 * Generated / machine-authored files that look like source but never participate
 * in the runtime call or import graph. Excluded unconditionally — there is no
 * env-var opt-out because including them is never the right behaviour for a
 * code-graph (no human edits, no real callers, no real callees).
 */
export const CODEGRAPH_GENERATED_PATTERNS: readonly string[] = [
  // Rails generated AR schema — re-authored by `rails db:migrate`, declarative
  // table defs with no method calls into the rest of the application.
  "**/db/schema.rb",
  // Vendored third-party code (bd tea-rags-mcp-pl7k). `vendor/` is the
  // conventional location for bundled gems (`vendor/bundle/`) and asset
  // libraries (`vendor/assets/javascripts/*.js`). These never participate
  // in the project author's call graph — including them pollutes the
  // global short-name lookup with cross-language ghost callees (e.g.
  // huginn's `agents.map(&:id)` mis-resolving to `d3.js#map`).
  "**/vendor/**",
];

export const CODEGRAPH_TEST_PATTERNS: readonly string[] = [
  // Generic test directories — match anywhere in tree.
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/spec/**",
  // JS / TS — Vitest / Jest / Mocha conventions
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.mjs",
  "**/*.spec.cjs",
  // Python — pytest / unittest conventions
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
  // Ruby — Minitest / RSpec conventions
  "**/*_test.rb",
  "**/*_spec.rb",
  // Java — JUnit conventions
  "**/*Test.java",
  "**/*Tests.java",
  "**/*IT.java",
  // Go — built-in testing framework
  "**/*_test.go",
  // Rust — built-in #[cfg(test)] convention for separate files
  "**/*_test.rs",
];

export interface CodegraphExclusionOptions {
  /**
   * When true, applies `CODEGRAPH_TEST_PATTERNS`. Default is wired via the
   * `CODEGRAPH_EXCLUDE_TESTS` env var (default true) so tests stay out of
   * the graph unless the user opts in.
   */
  excludeTests: boolean;
  /**
   * Project-specific `.gitignore`-shaped patterns layered on top of the
   * test exclusions. Empty when the user has not set
   * `CODEGRAPH_CUSTOM_EXCLUDE`.
   */
  customPatterns: readonly string[];
}

/**
 * Build a fully-loaded `Ignore` instance for the codegraph-specific layer.
 * Caller invokes `.ignores(relPath)` per file; the underlying `ignore`
 * package supports `.gitignore` glob semantics so directory-trailing-slash
 * patterns (`tests/`) and file globs (`*.test.ts`) coexist.
 *
 * The returned instance is safe to share across `discoverSupportedFiles`
 * invocations (immutable after construction). Both `excludeTests=false`
 * AND `customPatterns=[]` is a valid configuration — the resulting filter
 * matches nothing, so `ignores()` always returns false. The `ignore`
 * package tolerates an empty add gracefully.
 */
export function buildCodegraphExclusionFilter(options: CodegraphExclusionOptions): Ignore {
  const ig = ignore();
  // Generated files are always excluded — invariant, not configurable.
  ig.add(CODEGRAPH_GENERATED_PATTERNS as string[]);
  if (options.excludeTests) {
    ig.add(CODEGRAPH_TEST_PATTERNS as string[]);
  }
  if (options.customPatterns.length > 0) {
    ig.add(options.customPatterns as string[]);
  }
  return ig;
}
