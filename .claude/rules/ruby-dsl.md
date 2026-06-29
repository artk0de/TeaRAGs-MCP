---
paths:
  - "src/core/domains/language/ruby/dsl/**"
  - "src/core/domains/language/ruby/walker/macro-expansion.ts"
  - "src/core/domains/language/ruby/walker/structured/**"
  - "src/core/domains/language/ruby/walker/walker.ts"
  - "src/core/domains/language/ruby/walker/type-sources/ast-inference.ts"
---

# Adding a Ruby DSL Grammar (MANDATORY)

Ruby/Rails/gem conventions are described **declaratively**: a convention is a
data entry on a framework module, never a new `if`-branch in an interpreter
(`resolver-architecture.md` rule #2). This rule is the decision tree for adding
one. Established by epic `pg5ya` (consolidation of the imperative remnants).

## The two layers

- **`dsl/` is PURE DATA** — no `tree-sitter` import, ever. Each framework owns a
  `RubyFrameworkVocabulary` module (`ruby-core.ts`, `activesupport.ts`,
  `rails.ts`); each **gem gets its OWN file** (`sidekiq.ts`, …). `catalogue.ts`
  composes them: `composeEntries` / `composeMethodSet` /
  `composeEnqueueDispatch` fold over the `FRAMEWORKS` array. Adding a
  framework/gem = one module file + one `FRAMEWORKS` line.
- **`walker/` holds the INTERPRETERS** — they walk the AST and read the facets.
  AST-walking code (structured-macro expanders, operand extraction, edge
  emission) lives here, NOT in `dsl/`.

A framework module is built by
`defineFrameworkVocabulary(framework, entries, runtimeBuiltins?, methodSemantics?)`.

## Decision tree — "I want codegraph to understand convention X"

Pick the facet by what X DOES. Most conventions need exactly one; some combine
(e.g. `has_many` both **declares** accessor methods AND **emits** a model edge).

| X is…                                                                                                                | Facet                                           | Where you add it                                                | Interpreter that reads it                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| a macro that **synthesises methods** from symbol args (`attr_accessor :a` → `a`/`a=`)                                | `RubyDslEntry.operands` + `declares`            | the framework module's `entries`                                | `walker/macro-expansion.ts::extractOperands`                                                                                                 |
| a **block-structured** macro (`enum`, `aasm`)                                                                        | a `StructuredMacroExpander`                     | `walker/structured/<name>.ts` + register in `STRUCTURED_MACROS` | `walker/macro-expansion.ts` array dispatch                                                                                                   |
| a macro that **emits a class-body call edge** (`before_action :auth`, `has_many :posts`, `delegate`, `alias_method`) | `RubyDslEntry.emits`                            | the entry                                                       | `walker/walker.ts::emitDslEdges`                                                                                                             |
| a method that **returns an instance** of its constant receiver (`User.find`, `User.create!`)                         | `instanceReturning` / `relationReturning` facet | `defineFrameworkVocabulary` 4th arg                             | `walker/type-sources/ast-inference.ts` (`constInstanceType` / `relationRootConst`) via `RUBY_INSTANCE_RETURNING` / `RUBY_RELATION_RETURNING` |
| a **background-job enqueue** verb (`perform_async`, `perform_later`)                                                 | `enqueueDispatch` facet                         | `defineFrameworkVocabulary` 4th arg                             | `resolver/strategies/ruby-enqueue-dispatch.ts` via `enqueueEntrypoint`                                                                       |
| an **external** gem/runtime method with no in-project `def`                                                          | `entries` / `runtimeBuiltins`                   | the framework module                                            | external classifier via `hasExternalMember`                                                                                                  |

### `operands` shapes (declaring macros)

The shape names HOW the walker pulls the base symbol name(s) fed to
`declares(base)`:

- `"literal-name"` — first arg, symbol **or string** (`define_method`).
- `"first-symbol"` — first `simple_symbol` only (`alias_method`, `scope`,
  `attribute` — the rest is a lambda / cast type / the alias's new name).
- `"skip-first"` — symbols **after** the first (`store_accessor` — the first is
  the JSON store column).
- `"leading-symbols"` — all leading symbols, **skipping** non-symbol args (the
  generic default: `attr_*`, associations, validations).
- `{ kind: "leading-symbols", stopAtKwarg: true }` — **break** at the first
  non-symbol (`delegate :a, :b, to: :x` stops at the `to:` pair).

### `emits` shapes (class-body edge macros)

- `"self-instance"` — per leading symbol → `{receiver:null, member:sym}`
  (callbacks: the resolver's same-class fallback pins `#sym`).
- `"model-constant-ref"` — associated model constant → `{receiver:C, member:C}`
  (associations: a file→file constant ref to the model's file).
- `"delegate-target"` — per delegated symbol → `{receiver:to, member:sym}`.
- `"alias-redirect"` — old name → `{receiver:null, member:old}` (paired with
  `redirectTarget: "second-symbol"`).

The `emits` membership MUST match the macro families exactly — a name that
currently fires an edge but lacks an `emits` entry silently DROPS that edge. The
parity test (`tests/.../walker/walker-emits.test.ts`) enforces the
`emits ⟺ category/predicate` equivalences; extend it when you add an emitting
macro.

## Discipline

- **Add data, not branches.** If you find yourself writing
  `if (macroName === …)` in an interpreter, you are doing it wrong — add a facet
  entry instead.
- **A gem is its own module.** Do not mix two libraries' verbs in one map (the
  deleted `dsl/enqueue.ts` did this; `sidekiq.ts` + `rails.ts` is the fix).
- **`dsl/` stays tree-sitter-free.** Need the AST? The interpreter lives in
  `walker/`.
- **Relocation is byte-identical.** Moving a convention between representations
  must not move `byReceiverKind` / `resolveSuccessRate`; the existing
  `macro-expansion.test.ts` / `ruby-walker.test.ts` cases are the oracle.

## Reference

- Spec:
  `docs/superpowers/specs/2026-06-28-ruby-dsl-grammar-consolidation-design.md`
- Plan:
  `docs/superpowers/plans/2026-06-28-ruby-dsl-grammar-consolidation-plan.md`
- See also `.claude/rules/resolver-architecture.md` (the fold-over-registry
  rule), `.claude/rules/domains-language.md`,
  `.claude/rules/codegraph-walkers.md`.
