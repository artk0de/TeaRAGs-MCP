import { describe, expect, it } from "vitest";

import type { LanguageFactoryDescriptor, LanguageProvider } from "../../../../../src/core/contracts/types/language.js";
import {
  buildCodegraphExclusionFilter,
  CODEGRAPH_GENERATED_PATTERNS,
  CODEGRAPH_TEST_PATTERNS,
} from "../../../../../src/core/domains/trajectory/codegraph/exclusion.js";
import { languageFactory } from "./__helpers__/language-factory.js";

/**
 * Minimal `LanguageFactoryDescriptor` test double mapping a language name to the
 * codegraph-exclusion globs its provider declares (`undefined` = declares none).
 * Lets the ENGINE's language-agnostic aggregation be exercised without loading
 * any real grammar — it proves `buildCodegraphExclusionFilter` hardcodes neither
 * a language nor a `db/` rule of its own (bd tea-rags-mcp-biwbq).
 */
function fakeLanguageFactory(byLang: Record<string, readonly string[] | undefined>): LanguageFactoryDescriptor {
  return {
    supported: () => Object.keys(byLang),
    create: (lang: string): LanguageProvider =>
      ({ codegraphExclusionGlobs: byLang[lang] }) as unknown as LanguageProvider,
  };
}

describe("buildCodegraphExclusionFilter", () => {
  it("matches conventional test paths across languages when excludeTests=true", () => {
    const ig = buildCodegraphExclusionFilter({ excludeTests: true, customPatterns: [] });
    // Generic dirs.
    expect(ig.ignores("tests/integration.ts")).toBe(true);
    expect(ig.ignores("app/__tests__/foo.ts")).toBe(true);
    expect(ig.ignores("project/test/helpers.ts")).toBe(true);
    expect(ig.ignores("spec/models/user.rb")).toBe(true);
    // JS / TS conventions.
    expect(ig.ignores("src/service.test.ts")).toBe(true);
    expect(ig.ignores("src/component.test.tsx")).toBe(true);
    expect(ig.ignores("src/foo.spec.js")).toBe(true);
    expect(ig.ignores("legacy/old.spec.mjs")).toBe(true);
    // Python conventions.
    expect(ig.ignores("pkg/test_user.py")).toBe(true);
    expect(ig.ignores("pkg/user_test.py")).toBe(true);
    expect(ig.ignores("pkg/conftest.py")).toBe(true);
    // Ruby conventions.
    expect(ig.ignores("app/models/user_test.rb")).toBe(true);
    expect(ig.ignores("app/models/user_spec.rb")).toBe(true);
    // Java conventions.
    expect(ig.ignores("src/main/java/AuthTest.java")).toBe(true);
    expect(ig.ignores("src/main/java/AuthTests.java")).toBe(true);
    expect(ig.ignores("src/main/java/UserIT.java")).toBe(true);
    // Go convention.
    expect(ig.ignores("internal/repo_test.go")).toBe(true);
    // Rust convention.
    expect(ig.ignores("crate/src/parser_test.rs")).toBe(true);
  });

  it("does NOT match production source paths when excludeTests=true", () => {
    const ig = buildCodegraphExclusionFilter({ excludeTests: true, customPatterns: [] });
    expect(ig.ignores("src/service.ts")).toBe(false);
    expect(ig.ignores("src/component.tsx")).toBe(false);
    expect(ig.ignores("app/models/user.rb")).toBe(false);
    expect(ig.ignores("pkg/user.py")).toBe(false);
    expect(ig.ignores("src/main/java/AuthService.java")).toBe(false);
    expect(ig.ignores("internal/repo.go")).toBe(false);
    expect(ig.ignores("crate/src/parser.rs")).toBe(false);
  });

  it("treats test patterns as inert when excludeTests=false", () => {
    const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] });
    expect(ig.ignores("tests/integration.ts")).toBe(false);
    expect(ig.ignores("src/service.test.ts")).toBe(false);
    expect(ig.ignores("pkg/test_user.py")).toBe(false);
    expect(ig.ignores("internal/repo_test.go")).toBe(false);
  });

  it("layers customPatterns on top of test exclusion", () => {
    const ig = buildCodegraphExclusionFilter({
      excludeTests: true,
      customPatterns: ["vendor/**", "*.pb.go"],
    });
    // Custom rules match.
    expect(ig.ignores("vendor/third-party/lib.go")).toBe(true);
    expect(ig.ignores("api/messages.pb.go")).toBe(true);
    // Test rules still match.
    expect(ig.ignores("src/foo.test.ts")).toBe(true);
    // Production paths unaffected.
    expect(ig.ignores("src/foo.ts")).toBe(false);
  });

  it("produces a no-op filter for tests and arbitrary files when both excludeTests=false and customPatterns is empty (generated files still excluded)", () => {
    const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] });
    expect(ig.ignores("anything.ts")).toBe(false);
    expect(ig.ignores("tests/foo.ts")).toBe(false);
    expect(ig.ignores("src/foo.test.ts")).toBe(false);
    // Generated files remain excluded — invariant.
    expect(ig.ignores("db/schema.rb")).toBe(true);
  });

  it("always excludes Rails-generated db/schema.rb regardless of options", () => {
    // excludeTests=true path
    const igStrict = buildCodegraphExclusionFilter({ excludeTests: true, customPatterns: [] });
    expect(igStrict.ignores("db/schema.rb")).toBe(true);
    expect(igStrict.ignores("backend/db/schema.rb")).toBe(true);
    // excludeTests=false path — still excluded
    const igLoose = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] });
    expect(igLoose.ignores("db/schema.rb")).toBe(true);
    // Real Ruby files in db/ are NOT excluded — only schema.rb itself
    expect(igStrict.ignores("db/migrate/20260101_create_users.rb")).toBe(false);
    expect(igStrict.ignores("db/seeds.rb")).toBe(false);
  });

  it("CODEGRAPH_GENERATED_PATTERNS is a non-empty readonly array", () => {
    expect(CODEGRAPH_GENERATED_PATTERNS.length).toBeGreaterThan(0);
    expect(CODEGRAPH_GENERATED_PATTERNS).toContain("**/db/schema.rb");
  });

  // BUG tea-rags-mcp-pl7k — `vendor/` directories hold third-party copies
  // (vendored Ruby gems under `vendor/bundle/`, JavaScript libs under
  // `vendor/assets/javascripts/`). They never participate in the project's
  // own call graph; their presence pollutes the global short-name lookup
  // with cross-language ghost callees (huginn: `agents.map(&:id)` →
  // `vendor/assets/javascripts/d3.js#map`). Always-exclude, not opt-out.
  it("always excludes vendor/ directories regardless of options", () => {
    const igStrict = buildCodegraphExclusionFilter({ excludeTests: true, customPatterns: [] });
    expect(igStrict.ignores("vendor/assets/javascripts/d3.js")).toBe(true);
    expect(igStrict.ignores("vendor/bundle/ruby/3.0/gems/foo-1.0/lib/foo.rb")).toBe(true);
    expect(igStrict.ignores("app/vendor/lib/some.rb")).toBe(true);
    // excludeTests=false path — still excluded
    const igLoose = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] });
    expect(igLoose.ignores("vendor/assets/javascripts/d3.js")).toBe(true);
    // Real project files outside vendor/ are NOT excluded.
    expect(igStrict.ignores("app/models/user.rb")).toBe(false);
    expect(igStrict.ignores("src/main.ts")).toBe(false);
  });

  it("CODEGRAPH_TEST_PATTERNS is a non-empty readonly array covering all walker languages", () => {
    expect(CODEGRAPH_TEST_PATTERNS.length).toBeGreaterThan(0);
    // Sanity: every language with a codegraph walker has at least one entry.
    // (Bash has no test convention — intentionally not listed.)
    const joined = CODEGRAPH_TEST_PATTERNS.join("\n");
    expect(joined).toMatch(/\*\.test\.ts/); // TS
    expect(joined).toMatch(/\*\.spec\.js/); // JS
    expect(joined).toMatch(/test_\*\.py|\*_test\.py/); // Python
    expect(joined).toMatch(/\*_spec\.rb|\*_test\.rb/); // Ruby
    expect(joined).toMatch(/\*Test\.java/); // Java
    expect(joined).toMatch(/\*_test\.go/); // Go
    expect(joined).toMatch(/\*_test\.rs/); // Rust
  });

  // bd tea-rags-mcp-biwbq — per-language non-app-code exclusion globs. Each
  // registered language provider carries its OWN codegraph-exclusion patterns
  // (Ruby: db/migrate, db/data, …); the engine aggregates them via the injected
  // factory and stays language-agnostic (no 'ruby' / 'db/' hardcoded here).
  describe("per-language exclusion globs aggregated from the injected LanguageFactory", () => {
    it("aggregates a provider's codegraphExclusionGlobs when a factory is injected", () => {
      const factory = fakeLanguageFactory({ ruby: ["**/db/migrate/**", "**/db/data/**"] });
      const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] }, factory);
      expect(ig.ignores("db/migrate/20260101_create_users.rb")).toBe(true);
      expect(ig.ignores("backend/db/migrate/20260101_create_users.rb")).toBe(true);
      expect(ig.ignores("db/data/20260101_backfill.rb")).toBe(true);
      // Application code stays in the graph.
      expect(ig.ignores("app/models/user.rb")).toBe(false);
    });

    it("contributes NOTHING when no factory is injected (backward-compatible)", () => {
      const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] });
      // Without a factory the engine adds no language globs — migrations remain.
      expect(ig.ignores("db/migrate/20260101_create_users.rb")).toBe(false);
      expect(ig.ignores("db/data/20260101_backfill.rb")).toBe(false);
    });

    it("is language-agnostic — excludes ONLY the globs a provider declares, hardcoding neither a language nor db/", () => {
      // An arbitrary language contributes its own globs; a provider that declares
      // none (typescript → undefined) contributes nothing. The engine invents no
      // db/ rule of its own.
      const factory = fakeLanguageFactory({
        elixir: ["**/priv/repo/migrations/**"],
        typescript: undefined,
      });
      const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] }, factory);
      expect(ig.ignores("priv/repo/migrations/001_init.exs")).toBe(true);
      expect(ig.ignores("db/migrate/001.rb")).toBe(false); // no self-invented db/ rule
      expect(ig.ignores("src/service.ts")).toBe(false); // language with no globs excludes nothing
    });

    it("keeps one language's globs from affecting another language's files", () => {
      const factory = fakeLanguageFactory({ ruby: ["**/db/migrate/**"], go: undefined });
      const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] }, factory);
      expect(ig.ignores("db/migrate/001_init.rb")).toBe(true);
      expect(ig.ignores("internal/repo.go")).toBe(false); // Go source untouched
    });

    it("layers language globs alongside test + custom patterns", () => {
      const factory = fakeLanguageFactory({ ruby: ["**/db/migrate/**"] });
      const ig = buildCodegraphExclusionFilter({ excludeTests: true, customPatterns: ["**/generated/**"] }, factory);
      expect(ig.ignores("db/migrate/001.rb")).toBe(true); // language glob
      expect(ig.ignores("src/foo.test.ts")).toBe(true); // test pattern
      expect(ig.ignores("build/generated/x.ts")).toBe(true); // custom pattern
      expect(ig.ignores("app/models/user.rb")).toBe(false); // app code
    });

    it("excludes Rails non-app db/ paths when wired with the real LanguageFactory (ruby owns the globs)", () => {
      const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] }, languageFactory());
      expect(ig.ignores("db/migrate/20260101_create_users.rb")).toBe(true);
      expect(ig.ignores("db/data/20260101_backfill.rb")).toBe(true);
      expect(ig.ignores("db/schema.rb")).toBe(true);
      expect(ig.ignores("db/data_schema.rb")).toBe(true);
      // Application code + seeds stay in the graph.
      expect(ig.ignores("app/models/user.rb")).toBe(false);
      expect(ig.ignores("db/seeds.rb")).toBe(false);
    });
  });
});
