import { describe, expect, it } from "vitest";

import {
  buildCodegraphExclusionFilter,
  CODEGRAPH_TEST_PATTERNS,
} from "../../../../../src/core/domains/trajectory/codegraph/exclusion.js";

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

  it("produces a no-op filter when both excludeTests=false and customPatterns is empty", () => {
    const ig = buildCodegraphExclusionFilter({ excludeTests: false, customPatterns: [] });
    expect(ig.ignores("anything.ts")).toBe(false);
    expect(ig.ignores("tests/foo.ts")).toBe(false);
    expect(ig.ignores("src/foo.test.ts")).toBe(false);
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
});
