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
 * codegraph walker. Test exclusion is unconditional (bd tea-rags-mcp-6xxh5) —
 * a graph over tests answers no architectural question, so there is no
 * configuration that turns it off. `CODEGRAPH_CUSTOM_EXCLUDE` adds
 * project-specific patterns on top.
 */

import ignore, { type Ignore } from "ignore";

import type { LanguageFactoryDescriptor, SchemaColumnAccessorSource } from "../../../contracts/types/language.js";
import { GENERATED_PATTERNS, TEST_PATTERNS } from "../../../infra/file-classification/index.js";

/**
 * Generated / machine-authored files that look like source but never participate
 * in the runtime call or import graph. Excluded unconditionally — there is no
 * env-var opt-out because including them is never the right behaviour for a
 * code-graph (no human edits, no real callers, no real callees).
 *
 * Sourced from the single source of truth in `infra/file-classification`
 * (consolidated 2026-06-05, tea-rags-mcp-sjxz). Re-exported under the codegraph
 * name for backward compatibility with existing importers.
 */
export const CODEGRAPH_GENERATED_PATTERNS: readonly string[] = GENERATED_PATTERNS;

/**
 * Conventional test-file shapes — sourced from `infra/file-classification`
 * (single source of truth). Re-exported under the codegraph name.
 */
export const CODEGRAPH_TEST_PATTERNS: readonly string[] = TEST_PATTERNS;

export interface CodegraphExclusionOptions {
  /**
   * Project-specific `.gitignore`-shaped patterns layered on top of the
   * unconditional generated + test exclusions. Empty when the user has not set
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
 * invocations (immutable after construction). An empty `customPatterns` is a
 * valid configuration — the generated + test layers still apply, and the
 * `ignore` package tolerates an empty add gracefully.
 *
 * `languageFactory` (optional) contributes each registered language's OWN
 * non-application-code globs (`LanguageProvider.codegraphExclusionGlobs` — e.g.
 * Ruby's `db/migrate/**`). The aggregation is language-agnostic: the engine
 * iterates `factory.supported()` and adds whatever each provider declares, with
 * no per-language knowledge baked in here. Omitting the factory (tests /
 * fixtures) yields the pre-existing behaviour — no language globs. bd
 * tea-rags-mcp-biwbq.
 */
export function buildCodegraphExclusionFilter(
  options: CodegraphExclusionOptions,
  languageFactory?: LanguageFactoryDescriptor,
): Ignore {
  const ig = ignore();
  // Generated and test files are always excluded — invariants, not configurable.
  ig.add(CODEGRAPH_GENERATED_PATTERNS as string[]);
  ig.add(CODEGRAPH_TEST_PATTERNS as string[]);
  // Per-language non-app-code globs, owned by each language provider. Aggregated
  // here so no language-specific pattern leaks into this generic engine.
  if (languageFactory) {
    for (const lang of languageFactory.supported()) {
      const globs = languageFactory.create(lang).codegraphExclusionGlobs;
      if (globs && globs.length > 0) {
        ig.add(globs as string[]);
      }
    }
  }
  if (options.customPatterns.length > 0) {
    ig.add(options.customPatterns as string[]);
  }
  return ig;
}

/**
 * Every registered language's persisted-schema column vocabulary
 * (`LanguageProvider.schemaColumnAccessors` — Ruby's `db/schema.rb` reader). Same
 * aggregation shape as `buildCodegraphExclusionFilter` above and for the same
 * reason: the codegraph engine must know THAT a language can declare columns
 * outside source, never WHICH file or WHICH convention. Omitting the factory
 * (tests / fixtures) yields no sources, so the schema pre-pass no-ops.
 * bd tea-rags-mcp-8l5fo.
 */
export function collectSchemaColumnSources(
  languageFactory?: LanguageFactoryDescriptor,
): readonly SchemaColumnAccessorSource[] {
  if (!languageFactory) return [];
  const sources: SchemaColumnAccessorSource[] = [];
  for (const lang of languageFactory.supported()) {
    const source = languageFactory.create(lang).schemaColumnAccessors;
    if (source !== undefined) sources.push(source);
  }
  return sources;
}
