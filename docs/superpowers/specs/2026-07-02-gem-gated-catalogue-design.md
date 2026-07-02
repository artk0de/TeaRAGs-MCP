# Gem Grammar Pack + Gem-Gated Catalogue (Design)

**Epic:** `tea-rags-mcp-adx5p` (related: `tea-rags-mcp-lawlq.2` forensics input,
`tea-rags-mcp-lawlq.1` terminalPositions reuse) **Status:** approved (Approach
G1; data-driven gem selection) **Date:** 2026-07-02

## Problem

Two coupled needs:

1. **Scale gem grammars.** The dsl decision tree (`ruby-dsl.md`) models each
   convention as data on a framework module; today only ruby-core,
   activesupport, rails, rails-runtime, sidekiq exist. The next recall/
   precision wins on real corpora live in gem DSLs: rspec `let`/`subject`,
   `factory_bot` `create(:user)`, devise `current_<scope>`, graphql `field`,
   sinatra/grape routes, and more.
2. **Gate grammars on gem presence.** With 10–15 gem modules the risk of verb
   collisions grows: a project-owned `authorize` or `field` method would be
   misinterpreted by an absent gem's grammar (false reconstructed edges) or —
   worse — external-skipped by its `runtimeBuiltins` (recall loss + denominator
   gaming). Today all vocabularies are globally active: `Const.find`/`first`
   inflection fires on non-AR code (octokit, graphql-ruby corpora).

Gating is the PRECONDITION for scaling: it turns "add a grammar" from a
globally-risky operation into a locally-safe one.

## Structural constraint

`RUBY_INSTANCE_RETURNING` / `RUBY_RELATION_RETURNING` / `RUBY_DSL` are
module-level constants composed at import time (`composeMethodSet` /
`composeEntries` over the static `FRAMEWORKS` array) and consumed through the
`dsl/index.ts` hub (fanIn 6, transitiveImpact 18). Per-project gating requires
moving composition behind a factory consumed via DI.

## Approaches considered

- **G1 — per-project catalogue factory (chosen).**
  `composeRubyCatalogue(activeGems: ReadonlySet<string>): RubyDslCatalogue`;
  each `RubyFrameworkVocabulary` gains `activatedBy: ReadonlySet<string>` (rails
  → `rails|activerecord|actionpack`, sidekiq → `sidekiq`;
  ruby-core/activesupport unconditional). Readers migrate from imported
  constants to a DI-supplied catalogue; worker-thread DI serializes gem-name
  strings and composes in-thread (module-path DI rule). The `RUBY_*` constants
  remain as the FULL catalogue — default and test anchor.
- **G2 — framework tags on entries + checks inside interpreters.** Rejected:
  scattered `if active` checks are the inline-disjunction anti-pattern
  (resolver-architecture rule 2), and `composeEntries` flattening loses entry
  provenance.
- **G3 — static core + dynamic gems hybrid.** Rejected: readers consume the
  union either way — two composition paths instead of one, no simplification.

## Design

### Activation policy

- `Gemfile.lock` present → STRICT gating: grammar facets AND the
  external-classification surface (`runtimeBuiltins` / `hasExternalMember`) —
  without the gem, a same-named project method must NOT be external-skipped.
- No lockfile → FULL catalogue (today's behavior; zero regression on plain Ruby
  projects).
- `CODEGRAPH_RB_GEMS` env override (csv of gem names) for debugging/forcing.

### Components

1. **Gemfile.lock detector** — parse the `GEM/specs` section (~20 LOC), ruby/
   layer, fed the project root by the enrichment config.
2. **`RubyDslCatalogue` + `composeRubyCatalogue(activeGems)`** in `catalogue.ts`
   —
   `{ entries, instanceReturning, relationReturning, enqueueDispatch, frameworks }`.
3. **Reader DI migration** — ast-inference, walker, macro-expansion, external
   classifier receive the catalogue; `dsl/index.ts` hub keeps exporting the
   full-catalogue constants for tests/back-compat.
4. **Gem modules, data-driven selection.** Final 10–15 list chosen by the
   verb-frequency scan over 5 corpora + lawlq.2 forensics (expert prior: rspec,
   factory_bot, devise, graphql, sinatra, grape, mongoid, dry-struct,
   state_machines, draper, cancancan, paranoia/discard, carrierwave, rake).

### Gem taxonomy (each type maps to an existing facet/interpreter)

- **(a) Declaring macros** — rspec `let`/`let!`/`subject` (declares the method
  AND supplies its return type from the block's last expression — reuses lawlq.1
  `terminalPositions`/binding-env), mongoid `field`/`embeds_*`, dry-struct
  `attribute`.
- **(b) Call-site type conventions** — `factory_bot` `create(:user)` →
  symbol→Model inflection (`dsl/inflection.ts` exists; `create_list` →
  container), devise `current_<scope>` / `authenticate_<scope>!` — these are
  type-source/methodSemantics rules, NOT `entries`.
- **(c) Route/entry blocks** — sinatra `get/post` blocks + `helpers do`, grape —
  per the `action-dispatch-routing` emit precedent.
- **(d) Relation-verb data + ability dispatch** — paranoia/discard
  (`with_deleted`, `kept` → relationReturning), cancancan (`can?`/`authorize!` →
  `Ability#<action>` per the pundit policy-dispatch precedent).

### Honest gating effect on benches

mastodon/huginn: full stack in their lockfiles → gating is metric-NEUTRAL (gate
for task 1). octokit and graphql-ruby: rails facets DEACTIVATE — `Const.find`
inflection on non-AR code is a false premise today; metric movement there is
intended validation, not fallout. Audit explicitly in the final validation task.

## Epic structure (`tea-rags-mcp-adx5p`)

- adx5p.1 — gating infra (P1); gate: neutrality on mastodon/huginn, zero
  full-path regression.
- adx5p.2 — verb-frequency measurement (P1, related lawlq.2); decides the
  final list.
- adx5p.3–.6 — gem batches A–D by taxonomy (P2, blocked by .1+.2), order per
  measurement.
- adx5p.7 — final live validation + octokit/graphql-ruby gating-effect audit.

## Testing

TDD per component; existing tests immutable. Catalogue factory: composition
tests per activation set (empty lock / partial / full / no-lock default);
walker-emits parity test extension for every new emitting grammar (`ruby-dsl.md`
rule); per-gem module count tests (catalogue-method-semantics pattern).

## Forecast

Epic: P25 8 / P50 10 / P75 13 burst days (~3 calendar weeks with parallel
tracks). Anchors: n2kpz L2 (3 grammars ≈ 1 burst day), gating infra ≈ sub-epic
2–3 bd.
