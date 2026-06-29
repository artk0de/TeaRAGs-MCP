import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "ruby",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    hooks: ["rspecFilter", "commentCapture", "rspecScopeChunker", "bodyChunker"],
  },
  tests: { tier: "high", detection: "*_test.rb / *_spec.rb", tech: "RSpec scope chunker (parent setup injected)" },
  codegraph: {
    tier: { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" },
    tech: "11-strategy + 4 dispatch components (table/union/cone/dynamic) + YARD type-source",
  },
  notes:
    "Codegraph trust is corpus-dependent: high untyped, maximum YARD-annotated; un-annotated Rails drops (a prime number, not a language property).",
};
