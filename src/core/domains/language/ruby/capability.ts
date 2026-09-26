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
  tests: {
    tier: "high",
    detection: "*_test.rb / *_spec.rb",
    tech: "RSpec scope chunker (one chunk per example, ancestor setup injected)",
  },
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
  // walker 3 (bd tea-rags-mcp-39xca.9): `self.table_name` overrides are now persisted in each
  // file's pass-1 slice and hydrated at the barrier. Rows written earlier do not carry them,
  // and only a re-walk can backfill them, so the recompute is what makes incremental runs see
  // the overrides.
  // walker 5: a `Const.call` entry whose delegated `#call` is overridden below the
  // delegating class method now lands on that override, and a `super`-delegating
  // override inherits its ancestor template's hook (persisted as `superDelegates` in
  // the pass-1 slice). Edges that sat on the shared `KindOfService.call` node move,
  // and rows written earlier carry no `superDelegates`, so only the recompute moves them.
  // walker 7: bd tea-rags-mcp-nbf8q — the facade answers `hasInProjectDefinition`
  // from Ruby files only, so a miss whose only namesake is a `.ts` / `.py`
  // declaration books as `noInProjectDef` instead of `missWithInProjectDef`.
  // No edge moves; the persisted resolve rate does, and only a recompute
  // rewrites a `cg_run_stats` row the previous walker tallied.
  // walker 8: bd tea-rags-mcp-nbf8q item 4 — the dynamic fan-out cap reads Ruby's
  // own defs-per-member p99 (`RUBY_FANOUT_POPULATION`), not the polyglot corpus
  // one: taxdome 19, not 16. Fans of 17–19 survivors a walker-7 index recorded as
  // `ambiguous` become edges. Bumped past an unreleased 7 because a worktree
  // build may already have stamped an index at it.
  // walker 8: bd tea-rags-mcp-4p3sb.3 — the walker publishes `identifierDeclarations`
  // (params, locals, ivar fields, `X.new` constructor types) for the naming
  // lexicon. Rows written by walker 7 carry none, so only the recompute adds them.
  // walker 10: the naming-lexicon branch (4p3sb.3 as 8, 4p3sb.16 as 9 there)
  // merged with nbf8q item 4 (8 here); neither parent's index holds both.
  // walker 5: release v1.44.2 shipped walker 4 and a release cycle gets ONE
  // walker bump, so every branch-local number above collapses into 5.
  versions: { chunking: 1, walker: 5, codegraphSchema: 2 },
  // Ruby Style Guide: classes and modules CamelCase, methods and variables
  // snake_case, constants SCREAMING_SNAKE — though a constant naming a class or
  // module value is CamelCase, so pascal is accepted there too.
  naming: {
    casing: {
      type: ["pascal"],
      module: ["pascal"],
      method: ["snake"],
      param: ["snake"],
      local: ["snake"],
      field: ["snake"],
      constant: ["screamingSnake", "pascal"],
    },
    // Core classes, plus the YARD spellings (`Boolean`, `nil`, `void`) the YARD type source emits.
    nonConceptTypes: [
      "String",
      "Integer",
      "Float",
      "Numeric",
      "Symbol",
      "Hash",
      "Array",
      "Set",
      "NilClass",
      "TrueClass",
      "FalseClass",
      "Object",
      "BasicObject",
      "Proc",
      "Boolean",
      "nil",
      "void",
      // Core value types: a variable holding one is named by its role (`expires_at`, `cutoff`), not the type.
      "Time",
      "Date",
      "DateTime",
      "BigDecimal",
      "Rational",
      "Complex",
      "Range",
      "Regexp",
      "MatchData",
      "Struct",
      "OpenStruct",
      // Meta types: a class or method passed as a value is named by role (`handler`, `worker_klass`).
      "Class",
      "Module",
      "Method",
      "UnboundMethod",
      // IO and resource handles: named by what they hold (`entry_file`, `tmp_file`), not a concept.
      "IO",
      "File",
      "Tempfile",
      "StringIO",
      "Pathname",
      // ActiveSupport containers and values, listed qualified because the match is exact: role-named too (`payload`, `params`).
      "ActiveSupport::HashWithIndifferentAccess",
      "ActiveSupport::TimeWithZone",
      "ActiveSupport::Duration",
      "ActiveSupport::SafeBuffer",
    ],
  },
  notes:
    "Codegraph trust is corpus-dependent: high untyped, maximum YARD-annotated; un-annotated Rails drops (a prime number, not a language property).",
};
