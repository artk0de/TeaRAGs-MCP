# domains/language/ruby — Ruby vertical: walker + type facts, DSL catalogue, resolver chain

## Invariants

- **`super` reverse-consensus emits an edge only when the target is INVARIANT
  across every including class.** The class-keyed walk necessarily misses for
  module methods (`classAncestors[M]` holds M's ancestors, not the includer's),
  so `resolveViaIncludingClasses` (`resolver/strategies/shared.ts`) inverts
  `includedBy`, runs `firstDefinerAfter` over each includer's prepend-aware MRO,
  and returns `null` on ANY disagreement. Why: "pick the most common target"
  looks like free recall and destroys the precision-1.0 argument it rests on.
- **A change that ADDS edges cannot be validated by aggregate metrics** — a
  wrong-type add is invisible in `exactRatio`, since a wrong exact edge still
  counts as exact. Every unit test for receiver/return typing asserts the EXACT
  `targetSymbolId` (`belongs_to :author, class_name: "User"` → `User#name`, NOT
  `Author#name`), paired with a negative guard. Why: a test asserting only "an
  edge exists" goes green while the graph is wrong and the corpus metric rises
  with it.
- **`conventionReceiver` and `constant` are disjoint BY CONSTRUCTION, which is
  what makes parking a constant safe.** The convention shape is
  `CONVENTION_RECEIVER` in `resolver/ruby-unbound-receiver-types.ts` (applied by
  `conventionReceiverType`, NOT in the strategy file); `looksLikeConstant`
  (`strategies/ruby-constant.ts`) demands an uppercase initial. Gate 3 of
  `conventionReceiver` (12) emits only a PINNED target, so its intentional
  overlap with `explicitRequire` (9) only upgrades. Why: loosening either regex
  couples two passes proved independent, and it shows up as moved edges, not a
  failing test.

## Gotchas

- **The external-member suppression set is `ACTIVE_RECORD_INSTANCE_BUILTINS` in
  `dsl/rails-runtime.ts` — not `dsl/core-members.ts`.** Membership means "the
  Rails idiom cannot override this on a domain object through an explicit
  untyped receiver", not "the corpus showed zero", so `save`/`save!`, `valid?`
  and `to_s`/`each`/`map`/`count` are excluded on purpose. `dsl/core-members.ts`
  is the unrelated bd-83cl7 core-homonym vocabulary, where `each`/`map`/`count`
  ARE members. Why: near-opposite membership — the wrong set flips which members
  get skipped as external.
- **Gem gating parses the `Gemfile` (never the lock), gates the EXTERNAL surface
  too, and the `RUBY_*` consts are the UNGATED full catalogue.**
  `catalogueForGemfile` (`gemfile.ts`) memoises by raw Gemfile text in a
  never-invalidated global `Map`; no Gemfile → full catalogue.
  `composeRubyCatalogue` folds grammar facets AND `isExternalBareCall` / runtime
  builtins over ACTIVE frameworks only, and `filterActiveFrameworks` keeps a
  framework whose `activatedBy` is `undefined`. Why: a gating defect reproduced
  against `RUBY_DSL` looks nonexistent, and a gem module added without
  `activatedBy` is active on every Ruby project.
- **Type-fact precedence is SEVEN ranks, and the residual is upstream FACT
  QUALITY, not lookup.** `DEFAULT_SOURCE_ORDER` (`walker/type-fact-store.ts`) is
  sorbet > rbs > yard > associations > draper > body-last-expr > ast, but only
  five have a registered source (`walker/type-sources/index.ts`); sorbet and rbs
  are reserved ranks with no implementation. The 615-miss bucket was FALSIFIED
  as a lookup problem: it is a flat bare-name return map plus fictional
  annotation classes shadowing derived facts via the `.`-vs-`#` key split. Why:
  chasing a wrong receiver type through the propagation engine or the MRO walk
  is the wrong layer.
- **Ruby recall numbers measured before 2026-07-28 sit on a different
  DENOMINATOR.** `RUBY_CODEGRAPH_EXCLUSION_GLOBS` (`codegraph-exclusions.ts`)
  has kept `db/migrate`, `db/data` and the schema snapshots out of the fan-graph
  since `d0e0d1d7` (biwbq), but the recall harness called
  `buildCodegraphExclusionFilter` WITHOUT the languageFactory argument and kept
  walking 939 of those files until bd 2l0pr made the parameter required. Why:
  earlier harness headlines are understated by ~0.5pp, so any A/B mixing pre-
  and post-parity measure-sets is invalid.

## Boundaries

- **Levers CLOSED BY VERDICT (2026-07-27) — do not reopen without new
  evidence.** Measured and rejected: VTA/G5 (oracle 4050 < its 5000 gate), the
  duck-typing engine (volume 1792 < its 2000 gate), conf-floor/G3b, the LSP
  track, the dynamic fan-out cap (xdith), literal sharpening (u8m65), and the
  interprocedural worklist fixpoint (addressable ceiling 510 of 18522 misses =
  2.8%). Self-dispatch v1 and the G2 service-result return types measured as
  exact no-ops on taxdome; ~8% of attempts (`params[:x]`, kwarg args,
  `constantize`, `method_missing`) is a permanent floor. Why: the honest rate is
  87.96% on the parity-corrected denominator, NOT the 87.19% quoted earlier.

## See also

- `../CLAUDE.md` — chain ordering, deferral economics, measurement harnesses.
- `.claude/rules/ruby-dsl.md`, `.claude/rules/resolver-architecture.md`
