---
paths:
  - "src/core/domains/language/ruby/dsl/**"
  - "src/core/domains/language/ruby/walker/macro-expansion.ts"
  - "src/core/domains/language/ruby/walker/structured/**"
  - "src/core/domains/language/ruby/walker/walker.ts"
  - "src/core/domains/language/ruby/walker/type-sources/ast-inference.ts"
---

# Adding a Ruby DSL Grammar (MANDATORY)

Ruby/Rails/gem conventions described **declaratively**: convention = data entry
on a framework module, never a new `if`-branch in an interpreter
(`resolver-architecture.md` rule #2). This rule = decision tree for adding one.
Established by epic `pg5ya` (consolidation of imperative remnants).

## The two layers

- **`dsl/` is PURE DATA** — no `tree-sitter` import, ever. Each framework owns a
  `RubyFrameworkVocabulary` module (`ruby-core.ts`, `activesupport.ts`,
  `rails.ts`); each **gem gets its OWN file** (`sidekiq.ts`, …). `catalogue.ts`
  composes them: `composeEntries` / `composeMethodSet` /
  `composeEnqueueDispatch` fold over `FRAMEWORKS` array. Add framework/gem = one
  module file + one `FRAMEWORKS` line.
- **`walker/` holds the INTERPRETERS** — walk AST, read facets. AST-walking code
  (structured-macro expanders, operand extraction, edge emission) lives here,
  NOT in `dsl/`.

Framework module built by
`defineFrameworkVocabulary(framework, entries, runtimeBuiltins?, methodSemantics?)`.

## Decision tree — "I want codegraph to understand convention X"

Pick facet by what X DOES. Most need exactly one; some combine (e.g. `has_many`
both **declares** accessor methods AND **emits** a model edge).

| X is…                                                                                                                | Facet                                           | Where you add it                                                | Interpreter that reads it                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| a macro that **synthesises methods** from symbol args (`attr_accessor :a` → `a`/`a=`)                                | `RubyDslEntry.operands` + `declares`            | the framework module's `entries`                                | `walker/macro-expansion.ts::extractOperands`                                                                                                 |
| a **block-structured** macro (`enum`, `aasm`)                                                                        | a `StructuredMacroExpander`                     | `walker/structured/<name>.ts` + register in `STRUCTURED_MACROS` | `walker/macro-expansion.ts` array dispatch                                                                                                   |
| a macro that **emits a class-body call edge** (`before_action :auth`, `has_many :posts`, `delegate`, `alias_method`) | `RubyDslEntry.emits`                            | the entry                                                       | `walker/walker.ts::emitDslEdges`                                                                                                             |
| a method that **returns an instance** of its constant receiver (`User.find`, `User.create!`)                         | `instanceReturning` / `relationReturning` facet | `defineFrameworkVocabulary` 4th arg                             | `walker/type-sources/ast-inference.ts` (`constInstanceType` / `relationRootConst`) via `RUBY_INSTANCE_RETURNING` / `RUBY_RELATION_RETURNING` |
| a **background-job enqueue** verb (`perform_async`, `perform_later`)                                                 | `enqueueDispatch` facet                         | `defineFrameworkVocabulary` 4th arg                             | `resolver/strategies/ruby-enqueue-dispatch.ts` via `enqueueEntrypoint`                                                                       |
| an **external** gem/runtime method with no in-project `def`                                                          | `entries` / `runtimeBuiltins`                   | the framework module                                            | external classifier via `hasExternalMember`                                                                                                  |

### `operands` shapes (declaring macros)

Shape names HOW walker pulls base symbol name(s) fed to `declares(base)`:

- `"literal-name"` — first arg, symbol **or string** (`define_method`).
- `"first-symbol"` — first `simple_symbol` only (`alias_method`, `scope`,
  `attribute` — rest is lambda / cast type / alias's new name).
- `"skip-first"` — symbols **after** the first (`store_accessor` — first is JSON
  store column).
- `"leading-symbols"` — all leading symbols, **skipping** non-symbol args
  (generic default: `attr_*`, associations, validations).
- `{ kind: "leading-symbols", stopAtKwarg: true }` — **break** at first
  non-symbol (`delegate :a, :b, to: :x` stops at `to:` pair).

### `emits` shapes (class-body edge macros)

- `"self-instance"` — per leading symbol → `{receiver:null, member:sym}`
  (callbacks: resolver's same-class fallback pins `#sym`).
- `"model-constant-ref"` — associated model constant → `{receiver:C, member:C}`
  (associations: file→file constant ref to model's file).
- `"delegate-target"` — per delegated symbol → `{receiver:to, member:sym}`.
- `"alias-redirect"` — old name → `{receiver:null, member:old}` (paired with
  `redirectTarget: "second-symbol"`).

`emits` membership MUST match macro families exactly — a name firing an edge but
lacking `emits` entry silently DROPS that edge. Parity test
(`tests/.../walker/walker-emits.test.ts`) enforces `emits ⟺ category/predicate`
equivalences; extend it when adding an emitting macro.

## Discipline

- **Add data, not branches.** Writing `if (macroName === …)` in an interpreter =
  wrong — add a facet entry instead.
- **A DSL verb is GRAMMAR, not an exclusion list.** Framework/gem verb static
  graph misses → model by what it DOES so codegraph reconstructs REAL edge —
  never dump verb into "external, skip it" set to shrink recall denominator.
  Before reaching for `runtimeBuiltins`, ask:
  - **synthesise methods**? → `declares` (`attr_accessor` → `a`/`a=`,
    `resources :posts` → `posts_path`/`post_path`/… route helpers).
  - **emit an edge**? → `emits` (`before_action :auth`, `has_many`,
    `resources :posts` → `PostsController`).
  - **dispatch to in-project target by convention**? → dispatch facet + resolver
    strategy (`enqueueDispatch` precedent: `Worker.perform_async` →
    `Worker#perform`; likewise `authorize @post` → `<Record>Policy#<action>?`,
    `policy_scope(Post)` → `PostPolicy::Scope#resolve`).

  `entries`/`runtimeBuiltins`-as-external = **LAST resort**, reserved for verbs
  with genuinely ZERO in-project effect (`params`, `render`, `puts`,
  `expires_in`). A module that's just `Set<verb>` marked external — or a
  `contextGate`/`callerFile` closure marking external conditionally — is the
  anti-pattern: games recall DENOMINATOR instead of building GRAPH (bd
  tea-rags-mcp-n2kpz L2 review). Model grammar; add edge.

- **A gem is its own module.** Don't mix two libraries' verbs in one map
  (deleted `dsl/enqueue.ts` did this; `sidekiq.ts` + `rails.ts` = fix).
- **`dsl/` stays tree-sitter-free AND `CallContext`-free.** Need AST? →
  `walker/`. Need caller state (`CallContext`) to decide? That's an INTERPRETER
  — lives in `walker/` or `resolver/`, never `dsl/`. A `dsl/` file importing
  `CallContext` is wrong.
- **Relocation is byte-identical.** Moving convention between representations
  must not move `byReceiverKind` / `resolveSuccessRate`; existing
  `macro-expansion.test.ts` / `ruby-walker.test.ts` cases = oracle.

## Reference

- Spec:
  `docs/superpowers/specs/2026-06-28-ruby-dsl-grammar-consolidation-design.md`
- Plan:
  `docs/superpowers/plans/2026-06-28-ruby-dsl-grammar-consolidation-plan.md`
- See also `.claude/rules/resolver-architecture.md` (fold-over-registry rule),
  `.claude/rules/domains-language.md`, `.claude/rules/codegraph-walkers.md`.
