import { describe, expect, it } from "vitest";

import { compilePathPatternMatcher } from "../../../src/core/infra/path-pattern.js";

const RUNNER = "src/core/domains/ingest/pipeline/enrichment/completion-runner.ts";
const COORDINATOR = "src/core/domains/ingest/pipeline/enrichment/coordinator.ts";

function matcherFor(pattern: string): (relativePath: string) => boolean {
  const matcher = compilePathPatternMatcher(pattern);
  if (!matcher) throw new Error(`expected a matcher for "${pattern}"`);
  return matcher;
}

describe("compilePathPatternMatcher (bd tea-rags-mcp-xf01b)", () => {
  it("selects the named file and not its directory siblings", () => {
    const matches = matcherFor("**/pipeline/enrichment/completion-runner.ts");
    expect(matches(RUNNER)).toBe(true);
    expect(matches(COORDINATOR)).toBe(false);
  });

  it("lets ** span any number of directories", () => {
    const matches = matcherFor("src/**/*.ts");
    expect(matches("src/a.ts")).toBe(true);
    expect(matches(RUNNER)).toBe(true);
    expect(matches("tests/a.ts")).toBe(false);
  });

  it("expands braces into alternatives", () => {
    const matches = matcherFor("{src/a/**,src/b/**}");
    expect(matches("src/a/x.ts")).toBe(true);
    expect(matches("src/b/deep/y.ts")).toBe(true);
    expect(matches("src/c/z.ts")).toBe(false);
  });

  it("negates the whole pattern on a leading !", () => {
    const matches = matcherFor("!**/tests/**");
    expect(matches("src/a.ts")).toBe(true);
    expect(matches("tests/core/a.test.ts")).toBe(false);
    expect(matches("packages/x/tests/b.test.ts")).toBe(false);
  });

  it("matches paths under dot directories — indexed files live there too", () => {
    const matches = matcherFor("**/rules/*.md");
    expect(matches(".claude/rules/naming.md")).toBe(true);
    expect(matcherFor("!**/tests/**")(".claude/tests/x.md")).toBe(false);
  });

  it("drops a leading slash, as the Qdrant pre-filter lowering does", () => {
    expect(matcherFor("/src/**")("src/a.ts")).toBe(true);
    expect(matcherFor("!/src/**")("src/a.ts")).toBe(false);
  });

  it("returns no matcher when there is no pattern to enforce", () => {
    expect(compilePathPatternMatcher(undefined)).toBeUndefined();
    expect(compilePathPatternMatcher("")).toBeUndefined();
    expect(compilePathPatternMatcher("!")).toBeUndefined();
  });
});
