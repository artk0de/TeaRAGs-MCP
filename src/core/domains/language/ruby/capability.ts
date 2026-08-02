import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "ruby",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    hooks: [
      { name: "rspecFilter", short: "RSpec block grouping" },
      { name: "commentCapture", short: "comment attachment" },
      { name: "rspecScopeChunker", short: "spec scope splitting" },
      { name: "bodyChunker", short: "method-body splitting" },
    ],
  },
  tests: { tier: "high", detection: "*_test.rb / *_spec.rb", tech: "RSpec scope chunker (parent setup injected)" },
  codegraph: {
    tier: { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" },
    tech: "15-strategy chain + 4 dispatch components (table/union/cone/dynamic) + 20-grammar DSL catalogue + arity/kwarg-narrowed fan-out (corpus-adaptive p99 cap) + YARD type-source + db/schema.rb column accessors + naming-convention receiver typing (subtype-gated)",
  },
  notes:
    "Codegraph trust is corpus-dependent: high untyped, maximum YARD-annotated; un-annotated Rails drops (a prime number, not a language property).",
};
