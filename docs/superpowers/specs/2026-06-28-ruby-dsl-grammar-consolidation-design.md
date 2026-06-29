# Ruby DSL Grammar Consolidation — Design

**Epic:** `tea-rags-mcp-pg5ya` · **Date:** 2026-06-28 · **Status:** approved

## Problem

Ruby/Rails/gem DSL traversal is described **imperatively**, not declaratively —
violating the `resolver-architecture.md` rule #2 ("a classifier folds over a
typed registry of polymorphic sources; adding a convention = one data entry").
Four imperative remnants survive after the per-framework grammar split
(`RubyFrameworkVocabulary` in `dsl/{ruby-core,activesupport,rails}.ts`, composed
by `catalogue.ts`):

1. **Method-semantics vocabulary** — `INSTANCE_RETURNING_METHODS` /
   `RELATION_RETURNING_METHODS` live as flat `Set`s in
   `walker/type-sources/ast-inference.ts`, NOT owned by any framework module.
2. **Simple declaring macros** — `walker/macro-expansion.ts` carries per-macro
   **name** if-branches (`define_method`/`alias_method`/`delegate`/
   `store_accessor`/`attr_*`) to extract the synthesized method base.
3. **Structured macros** — `enum` and `aasm` are imperative branches in
   `macro-expansion.ts` (added in `ujm91`).
4. **Edge-emission** — `walker/walker.ts::collectRubyCalls` (~1055-1109) has
   four per-category if-branches (`callback`→`self#m`, `association`→model-ref,
   `delegate`→target, `alias`→redirect) + a hand-coded `extractCallbackSymbols`.

Framework **ownership** is also wrong: gems (Sidekiq, aasm) are not their own
modules. `dsl/enqueue.ts` is a flat `ENQUEUE_DISPATCH` map mixing Sidekiq (gem)
and ActiveJob (Rails) members.

## Goal

Grammar becomes the **single declarative source of truth for library method
semantics**. Adding a gem/convention grammar = **one module file + one
typed-array line**, with ZERO interpreter/resolver edits. `dsl/` stays
tree-sitter-free pure data; interpreters live in the walker layer and fold over
the registry.

This is the clean substrate the type-inference ladder (`pffv` RTA pruning,
`dujp`, …) consumes — `pffv` is **blocked-by** this epic precisely because RTA's
instantiation set must read a grammar-owned `instanceReturning` facet, not the
imperative flat `Set` (mechanism D below).

## Four mechanisms

All four make a different imperative remnant declarative. They share the
`RubyFrameworkVocabulary` registry + the typed-array fold style.

### (D) Method-semantics facet — `instanceReturning` / `relationReturning`

A third facet of `RubyFrameworkVocabulary` (after macro-`declares` and
external-`hasExternalMember`): "calling this method on a class-constant receiver
returns an INSTANCE of that constant."

```ts
// types.ts — RubyFrameworkVocabulary += two optional facets
readonly instanceReturning?: ReadonlySet<string>;  // ruby-core: {new}; rails(AR): find/create!/build/finders
readonly relationReturning?: ReadonlySet<string>;  // rails(AR): where/order/joins/…
```

`catalogue.ts` unions across modules (`composeMethodSet(FRAMEWORKS, facet)`) →
`RUBY_INSTANCE_RETURNING` / `RUBY_RELATION_RETURNING`. `constInstanceType` /
`relationRootConst` (`ast-inference.ts`) read the composed sets; the local flat
`Set`s are **deleted**. Ownership: `new`→`ruby-core.ts`; AR factories/finders +
relation methods→`rails.ts` (AR is Rails-core per the existing ownership map; a
future `activerecord.ts` split is possible but out of scope).

### (A) Operands descriptor — simple declaring macros

Declarative `operands` shape on `RubyDslEntry`: `'leading-symbols'`(+flags
`stopAtKwarg`/`allowArray`/`allowString`) | `'first-symbol'` | `'skip-first'` |
`'literal-name'` | `'second-symbol'`. A generic `extractOperands(node, shape)`
in the walker layer replaces the per-macro if-branches; it feeds
`entry.declares(base)`.

### (B) Structured macros — `STRUCTURED_MACROS` typed array

`enum`/`aasm` are too structural for an operands shape. Each becomes a
`StructuredMacroExpander` module `{ macroName; expand(node): DeclaredMethod[] }`
registered in a typed array `STRUCTURED_MACROS` (mirroring `FRAMEWORKS`).
`macro-expansion.ts` dispatches via the array, not an if-chain. `enum`'s
expander is owned by the rails-domain (enum IS ActiveRecord, not a gem);
`aasm`'s lives in the NEW `dsl/aasm.ts` gem module.

### (C) Emits descriptor — edge emission + `collectRubyCalls` decomposition

An `emits` descriptor on `RubyDslEntry` (`'self-instance'` |
`'model-constant-ref'` | `'delegate-target'` | `'alias-redirect'`); one generic
loop in the walker replaces the four per-category if-branches +
`extractCallbackSymbols`. **Targeted improvement folded in (user directive
2026-06-28):** `collectRubyCalls` is a 263-line god-function hotspot (cc 21,
bugFixRate 14, changeDensity 20.55) — decompose it as part of this slice, since
we are already modifying it.

## Framework ownership (each macro owned by its framework; gems get own file)

| Module                 | Owns                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ruby-core.ts`         | `define_method`, `alias_method`, `alias`, `attr_*`, `instanceReturning: {new}`                                                                                                    |
| `activesupport.ts`     | `delegate`, `cattr_/mattr_`, `class_attribute`, `class_methods`/Concern, `delegate_missing_to`                                                                                    |
| `rails.ts`             | associations, validations, callbacks, scope, ENUM (structured), nested-attrs, attachments, ActiveJob enqueue (`perform_later`/`_now`), AR `instanceReturning`/`relationReturning` |
| `sidekiq.ts` (NEW gem) | `perform_async`/`_in`/`_at`/`_bulk` enqueue                                                                                                                                       |
| `aasm.ts` (NEW gem)    | `aasm` block state/event (structured)                                                                                                                                             |

## Decomposition — 6 slices (order = risk low→high, patterns compound)

| #   | Bead      | Slice                                                 | Mechanism                                                                   | Risk                                     |
| --- | --------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `pg5ya.1` | **D** method-semantics facet                          | facet on vocabulary                                                         | LOW (vocab, not call-graph) — RTA-gating |
| 2   | `pg5ya.2` | **E** enqueue split                                   | `sidekiq.ts` gem + ActiveJob→`rails.ts`; strategy reads per-framework vocab | LOW-MED                                  |
| 3   | `pg5ya.3` | **A** operands descriptor                             | `extractOperands(node, shape)`                                              | MED (macro synthesis → `cg_symbols`)     |
| 4   | `pg5ya.4` | **B** structured macros                               | `STRUCTURED_MACROS` array; enum→rails, aasm→`dsl/aasm.ts`                   | MED                                      |
| 5   | `pg5ya.5` | **C** emits descriptor + decompose `collectRubyCalls` | one generic emit loop                                                       | **HIGH** (god-function hotspot)          |
| 6   | `pg5ya.6` | **Deliverable 2** `.claude/rules/ruby-dsl.md`         | frontmatter how-to                                                          | TRIVIAL                                  |

**Dependencies:** B←A, C←B, rule←C. D, E, A have no blockers (different primary
files) and may run first / in parallel under worktree isolation. C is last so
the hotspot is touched only when D/A/B patterns are mature and the regression
net is fully tuned.

## Cross-cutting invariant (ALL slices)

This is a **relocation refactor**, not a feature:

- Behaviour **byte-identical**; `byReceiverKind` / `resolveSuccessRate` must NOT
  move (`resolver-architecture.md` rule #4).
- Business-logic tests stay green **untouched** (move OK, rewrite NO).
- Migration inverts TDD: relocate first → existing tests green → NEW unit tests
  for the new entity (`extractOperands` / `StructuredMacroExpander` /
  `composeMethodSet` / `emits` loop) authored LAST.
- Each slice = its own commit; the full ruby + provider suite (~1065 tests) is
  the regression net between slices.

## Parallel subagent-driven execution model

- **Wave 1 (parallel, worktree-isolated):** slices **D**, **E** — independent
  primary files (`ast-inference.ts` + grammar facets vs
  `enqueue.ts`/`sidekiq.ts`
  - strategy). Only overlap is the `catalogue.ts` `FRAMEWORKS`/facet-compose
    lines — isolate each subagent in its own worktree, merge sequentially,
    re-run tests after each merge.
- **Wave 2 (sequential):** **A** → **B** → **C**. All touch `macro-expansion.ts`
  / `collectRubyCalls`; no safe parallelism. C carries the `collectRubyCalls`
  decomposition.
- **Wave 3:** **Deliverable 2** rule doc, after all mechanism slices land + live
  validation.

Each subagent receives: its slice's bead, the cross-cutting invariant, the
search-cascade injection block, and the explicit "relocate → existing tests
green → new tests last" order. The orchestrating session verifies tests + metric
invariance between waves.

## Out of scope

- `pffv` RTA pruning itself (separate epic, blocked-by this one; design
  decisions already recorded on the `pffv` bead).
- A dedicated `activerecord.ts` module split (AR stays in `rails.ts` per
  existing ownership convention).
- Any change to the resolver's emitted edges, confidence, or metrics — pure
  relocation.
