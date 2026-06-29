import { describe, expect, it } from "vitest";

import type { LanguageCapability } from "../../../../src/core/contracts/types/language.js";

describe("LanguageCapability", () => {
  it("accepts a flat codegraph tier", () => {
    const cap: LanguageCapability = {
      language: "go",
      ast: { tier: "full", engine: "tree-sitter" },
      tests: { tier: "medium", detection: "*_test.go", tech: "generic AST" },
      codegraph: { tier: "moderate", tech: "6-strategy chain" },
    };
    expect(cap.codegraph.tier).toBe("moderate");
  });

  it("accepts a typing-tiered codegraph object (Ruby)", () => {
    const cap: LanguageCapability = {
      language: "ruby",
      ast: { tier: "full", engine: "tree-sitter", hooks: ["rspecScopeChunker"] },
      tests: { tier: "high", detection: "*_spec.rb", tech: "RSpec scope chunker" },
      codegraph: {
        tier: { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" },
        tech: "11-strategy + YARD",
      },
    };
    expect(cap.codegraph.tier).toMatchObject({ untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" });
  });

  it("accepts the partial AST tier for markdown", () => {
    const cap: LanguageCapability = {
      language: "markdown",
      ast: { tier: "partial", engine: "MarkdownChunker" },
      tests: { tier: "na", detection: "—", tech: "—" },
      codegraph: { tier: "none", tech: "no call graph" },
    };
    expect(cap.ast.tier).toBe("partial");
  });
});
