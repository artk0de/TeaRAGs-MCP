import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "ruby",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-ruby",
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
    summary:
      "15-strategy chain + 4 dispatch components + 20-grammar DSL catalogue + YARD type-source + db/schema.rb column accessors",
    tech: "15-strategy chain + 4 dispatch components (table/union/cone/dynamic) + 20-grammar DSL catalogue + arity/kwarg-narrowed fan-out (corpus-adaptive p99 cap) + YARD type-source + db/schema.rb column accessors + naming-convention receiver typing for bare and @ivar receivers (subtype-gated)",
  },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2 (bd tea-rags-mcp-kumq2): `lookupRubySymbolsByShortName` restricts every short-name
  // lookup to Ruby symbols, which moved resolver TARGETS on a polyglot repo (11 cross-language
  // picks on mastodon with its `.contextignore` skipped) — a persisted pass-2 result needs the
  // recompute. The kernel relocations in 63832af60..main stayed byte-identical on Ruby — both the
  // walker's extraction and the resolver's targets, measured cross-checkout against 63832af60
  // (bd tea-rags-mcp-e8wbs; the numbers live in that commit body, not here).
  versions: { chunking: 1, walker: 2, codegraphSchema: 2 },
  notes:
    "Codegraph trust is corpus-dependent: high untyped, maximum YARD-annotated; un-annotated Rails drops (a prime number, not a language property).",
};
