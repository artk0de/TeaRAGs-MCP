import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

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
  testFiles,
  codegraph: {
    tier: { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" },
    summary:
      "15-strategy chain + 4 dispatch components + 20-grammar DSL catalogue + YARD type-source + db/schema.rb column accessors",
    tech: "15-strategy chain + 4 dispatch components (table/union/cone/dynamic) + 20-grammar DSL catalogue + arity/kwarg-narrowed fan-out (corpus-adaptive p99 cap) + YARD type-source + db/schema.rb column accessors + naming-convention receiver typing for bare and @ivar receivers (subtype-gated)",
    // Kind roles (bd tea-rags-mcp-jqvbn, spec §1a).
    // Ruby never calls a class by its bare name: `Money(x)` is a METHOD, and the
    // class is only the receiver of `Money.new`.
    symbolKindRoles: {
      callee: new Set(["function", "method"]),
      receiver: new Set(["class", "module", "constant", "function", "method"]),
    },
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
  // Same walker 5, bd tea-rags-mcp-ffxfc: every class / module body carries a
  // member census on `cg_type_declarations` (migration 040) — `def`s are
  // methods, `attr_*` names and `Struct.new` / `Data.define` symbols fields; the
  // resolver's `cg_symbols` rows are unchanged.
  // Same walker 5, bd tea-rags-mcp-bjfa0: a constant reached through a value
  // (`adapter::Client.new`) types no return, local or binding; the RTA
  // instantiation set keeps its lexical reading, so persisted edges do not move.
  // chunking 2: bd tea-rags-mcp-j4jrn — the class-body grouper sizes groups to
  // the cap less the reserved header prefix, so a group that the header used to
  // push over the cap is no longer line-cut into `#partN` windows; the cut
  // points and chunk ids of such classes move.
  // walker 6: bd tea-rags-mcp-0qaht — class variables (`@@x`) and memoization
  // (`x ||= v`) publish `identifierDeclarations` rows, and accessor macros
  // declare `field` rows; a walker-5 index carries none of them, so only the
  // recompute adds them to the naming lexicon.
  // walker 8: bd tea-rags-mcp-44cpv (c-1=a). A class whose own methods are all
  // `initialize` — or that defines none, its body holding only attr accessors
  // and constants — leaves the type-abstractness census. Recompute:
  // `--force-enrichments codegraph --languages ruby`.
  // walker 9: bd tea-rags-mcp-zy6hx — field-access facet pass. The walker
  // publishes `fieldAccesses` (`@x`, `@@x`, a parameter's `p.x`, read / write)
  // for `cg_symbols_edges_field`; a walker-8 index has no rows.
  // walker 10: bd tea-rags-mcp-2m83f.34 — `has_one_attached` / `has_many_attached`
  // readers return `ActiveStorage::Attached::One` / `::Many`, and the facade answers
  // `residualExclusion`, so a walker-9 index holds residual rows for column and
  // Rails-framework callees no menu can name.
  // walker 11: bd tea-rags-mcp-2m83f.35 — timestamp columns and attachment tails
  // beside non-project facts leave the residual rows.
  // walker 12: bd tea-rags-mcp-2m83f.32.3 — an AR relation chain resolves the
  // next scope on its model (`Firm.without_deleted.available_for`, a query-method
  // head, a concern's scope typed over the includer), so a walker-11 index holds
  // residual rows and namesake edges for those calls.
  // walker 13: bd tea-rags-mcp-2m83f.36 — attr_reader / attr_accessor return the
  // type of the @ivar they read, so a walker-12 index holds residual rows for
  // reader calls on typed fields.
  // walker 16: bd tea-rags-mcp-2m83f.32.5 — the dynamic fan-out defers a relation
  // chain the `relationChain` pass pins, so a walker-15 index holds residual rows
  // and namesake edges for convention-rooted chains (`document.….documents.ordered`).
  // walker 17: bd tea-rags-mcp-2m83f.42 — an untyped owner's link is typed by the
  // return every candidate agrees on (`record.firm` → `Firm`), so a walker-16
  // index lacks the downstream edges of overflow hops (`record.firm.name`).
  // walker 18: bd tea-rags-mcp-2m83f.24 — a Rails framework instance member on an
  // untyped receiver (`form.save!`, `value.presence`) is externalSkipped unless a
  // namesake sits in the AR model hierarchy, so a walker-17 index holds residual
  // rows and recall misses for those calls.
  // walker 19: bd tea-rags-mcp-2m83f.44 — calls carry `argExprs` and a parameter
  // is typed from its exact-edge callers (`perform(record)` called with an
  // `Invoice`), so a walker-18 index lacks the edges of calls on parameters.
  // walker 20: bd tea-rags-mcp-2m83f.43 — def chunks carry `localAssignmentLines`,
  // so residual receiver narrowing splits a reassigned receiver; a walker-19
  // index groups the calls of a reassigned local as one receiver.
  // walker 21: bd tea-rags-mcp-2m83f.48 — every argument of `include A, B`, `send(:include, X)`,
  // `X.include(Y)`, `X.class_eval { include Y }`, `base.include(Y)` in an `included` hook and a
  // top-level `include` are recorded; an unreadable mixin publishes `unresolvedMixinClasses`,
  // so a walker-20 index misses the reachable overrides of frameworkOverride residual sites.
  // walker 22: bd tea-rags-mcp-2m83f.49 — `argExprs` carry constant paths and
  // canonical literals, so a parameter is typed from `perform(Firm)` (class form)
  // and a literal caller disagrees with a project-typed one; a walker-21 index
  // lacks those parameter types and their edges.
  // walker 23: bd tea-rags-mcp-2m83f.46 — residual rows carry their receiver group and its
  // class targets (`[["Invoice", "Invoice#save"]]`), so the pass asks one class question per
  // group; a walker-22 index holds ungrouped rows and asks per site.
  // walker 24: bd tea-rags-mcp-2m83f.51 — each class target carries its return type and the
  // row names the group of the next chain hop, so an accepted class types `record.firm.name`;
  // a walker-23 index propagates nothing downstream.
  // walker 25: bd tea-rags-mcp-2m83f.53 — a receiver splits into hops at bracket depth
  // zero (`Serializer.new(result.data).as_json` types the constructor's class), `x.class`
  // types as x's class, and a member on an untyped `x.class` with no project class method
  // is external; a walker-24 index leaves those sites in the residual.
  // walker 26: bd tea-rags-mcp-2m83f.52 — a receiver named after a project module narrows to its
  // includers, a member reached only as a framework override no longer empties the constraint
  // set, and an `x.class` receiver is offered class-level members only; a walker-25 index keeps
  // the wider sets and offers `x.class` instance methods.
  // walker 27: bd tea-rags-mcp-2m83f.56 — `assoc.first` / `.find_by(...)` on a has_many / habtm
  // reader (and `@x ||= ` over it) returns the association's element class, read from
  // `source_type:` on a polymorphic through; a walker-26 index leaves `firm.owner.user` untyped.
  // walker 28: bd tea-rags-mcp-2m83f.55 — a class reading a member as a schema column stays in
  // the group's class targets (no target, the column type as its return), and a site every
  // narrowed class reads as a column moves to `noInProjectDef` (`schemaAttribute`) with its
  // over-cap aggregate dropped; a walker-26/27 index keeps column readers out of the menus and
  // the column reads in the miss.
  // walker 29: bd tea-rags-mcp-2m83f.58 — a `self.class` receiver in an instance method is the
  // enclosing class: `self.class.m` lands on its singleton `m` (coned over subclasses redefining
  // it) and `self.class.new` on its `initialize`; a walker-28 index leaves both to the residual.
  versions: { chunking: 2, walker: 29, codegraphSchema: 2 },
  // Ruby Style Guide: classes and modules CamelCase, methods and variables
  // snake_case, constants SCREAMING_SNAKE — though a constant naming a class or
  // module value is CamelCase, so pascal is accepted there too.
  naming: {
    // A bare call resolves against `self`, so a local named like a method
    // shadows it at the call site.
    implicitSelf: true,
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
