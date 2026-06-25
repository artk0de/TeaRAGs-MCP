# Ruby External-Member Suppression (Increment D) — Design

**Bead:** `tea-rags-mcp-i9id8` (epic `tea-rags-mcp-m99j1` — Codegraph
precision + recall roadmap, LSP-free) **Date:** 2026-06-24 **Status:** approved
(brainstorm), pending spec review

## Goal

Stop the Ruby dynamic-dispatch resolver from fanning out to coincidental
in-project method definitions when the call is `untyped_receiver.member` and
`member` is an ActiveRecord/core instance method whose true target is an
external base class. Reclassify such calls as external so they neither produce
noise dynamic edges nor count as in-project misses.

## Background — why this, measured not assumed

This increment is the surviving lever after two huginn measurement spikes
(`jobs/e78046bc/tmp/measure.mjs`, 2026-06-24) killed the original i9id8 plan.

- **Original plan REJECTED.** Arity/visibility pruning + unique-survivor
  promotion: of 83 prune-collapsed `N≥2 → 1` survivors, **78 were wrong-type**
  (`agent.id → feedjira_extension#id`, `agent.save → DryRunnable#save` —
  coincidental name matches on AR/Hash/gem external receivers). Promoting a
  coincidental survivor to an exact edge is net-negative. Same
  un-annotated-Rails ceiling as Increment B.
- **The pivot, measured.** The wrong-type traps share a shape: the call is
  `untyped_receiver.member` where `member` is an AR/core instance method
  (`id`/`update`/`destroy`/`to_json`…) and the in-project def with that name is
  an unrelated collision (a controller action, a gem monkeypatch, an unrelated
  helper). Suppressing the fan-out for a curated member set yields **409 edges
  removed on huginn (8.4% of the 4861 dynamic baseline) with zero verified
  false-suppress**. Profile matches Increment A (surgical, exactRatio ≈ +2pp =
  2748/7202, recall denominator cleaner, zero exact-edge loss).

### The hole this exploits

`ExternalCallClassifier.targetsExternal` routes classification asymmetrically:

```
call.receiver === null
  ? vocab.isBareCallExternal(member)            // bare m()  → MEMBER vocab check
  : vocab.isQualifiedReceiverExternal(receiver) // recv.m    → RECEIVER check only
```

For a qualified call the **member is never vocab-checked** —
`isQualifiedReceiverExternal` only tests whether the receiver is an unresolved
constant (`/^[A-Z]/ && resolveConstant === null`). So `agent.save` (lowercase
untyped receiver, AR-core member) is neither receiver-external nor
member-checked, and `RubyDynamicDispatchResolver` fans it out to the
coincidental `DryRunnable#save`. This lever adds a **member axis** to
qualified-untyped classification, mirroring the member-vocab path that already
exists for bare calls.

## Soundness principle (what makes a member eligible)

A member belongs to the suppression set (`V_core`) **iff** it is an AR/core
**identity / introspection / persistence-write(non-`save`) / serialization**
method that the Rails idiom does **not** override on a domain object as a public
instance method invoked via an explicit untyped receiver.

The principle is _not-overridable-by-idiom_, **not** _huginn-showed-zero_ — that
is what keeps the set defensible on unseen Rails apps rather than overfit to one
corpus. Two members illustrate the boundary:

- `id` — AR primary key; domain code never meaningfully overrides it as a
  dynamic-receiver target. **Eligible.**
- `save` — AR lifecycle; the Rails idiom commonly wraps/overrides it (huginn's
  `DryRunnable#save` is `include`d into `Agent < ActiveRecord::Base`, and
  `agent.save` genuinely dispatches there on a dry-run agent). **Excluded.**

### Chain-order safety (the generic-soundness guarantee)

This is the same invariant that already protects `RAILS_RUNTIME_BUILTINS` (bd
`5os8y`): a project method that shadows a `V_core` name resolves first via the
strategy chain and never reaches this guard, so the set can never mis-mark a
real project method. The suppression only fires for a receiver that is _already_
untyped after every earlier guard (super / self / constant / typed-local /
AR-relation / index / external-chain-tail), i.e. a receiver the resolver could
only ever fan out blindly.

## V_core membership (v1)

A single flat `Set<string>`, grouped by doc-comment (not split into per-category
sets). Members:

**identity / introspection:** `id` `to_param` `persisted?` `new_record?`
`destroyed?` `attributes` `attribute_names` `errors`

**persistence-write (non-`save`):** `update` `update!` `update_attribute`
`update_attributes` `update_column` `update_columns` `destroy` `destroy!`
`delete` `touch` `increment!` `decrement!` `reload` `becomes`

**serialization:** `to_json` `to_xml`

### Excluded — deliberately, with rationale

- `save` / `save!` — lifecycle, idiomatically overridden (DryRunnable, state
  machines, callbacks). Verified-real on huginn (14 edges).
- `present?` / `valid?` — `present?` is overridden on value objects
  (`Location#present?` on huginn, 80 edges); `valid?` wraps validations.
- `to_s` / `each` / `map` / `select` / `first` / `last` / `size` / `class` /
  `count` — Object/Enumerable universals. `to_s` is idiomatically overridden on
  models (`def to_s; name; end`); the rest collide with legitimate domain
  Enumerable methods and would require receiver-type discrimination to suppress
  safely. Out of scope (see below).

### Disputed — excluded in v1, candidates pending a huginn measure

`as_json` (subagent flagged a Drop collision distinct from `to_json`), `count`
and `select` (AR ↔ Enumerable ambiguity), `find` / `where` / `create` (these are
predominantly **class** methods `Model.find` — the constant receiver takes the
constant path, not the untyped-receiver path — so their untyped-instance
incidence is low). They are left out of v1; a follow-up huginn measure can
promote any that show edge volume with a clean safe/risky split.

## Architecture — where V_core lives and how it is consumed

Stored in `dsl/`, flat Set, **no facet / no interface change / no separate
structural units** (per the approved decision). Mirrors the existing
`RAILS_RUNTIME_BUILTINS` placement.

1. **`dsl/rails-runtime.ts`** — add
   `ACTIVE_RECORD_INSTANCE_BUILTINS: ReadonlySet<string>` next to
   `RAILS_RUNTIME_BUILTINS` (same home: Rails external instance surface; same
   standalone-Set shape). The two sets are distinct axes —
   `RAILS_RUNTIME_BUILTINS` is consulted for **bare** calls (`params`/`render`);
   `ACTIVE_RECORD_INSTANCE_BUILTINS` for **qualified untyped-receiver** calls
   (`agent.update`). Doc-comment each clearly.
2. **`dsl/catalogue.ts`** — add
   `isExternalQualifiedMember(member: string): boolean = ACTIVE_RECORD_INSTANCE_BUILTINS.has(member)`,
   a direct predicate beside `isExternalBareCall` (no fold-over-`FRAMEWORKS` —
   single source).
3. **`dsl/index.ts`** — export `isExternalQualifiedMember`.

### Consumer 1 — the fan-out guard (suppress the edge)

`RubyDynamicDispatchResolver.resolveDispatch`
(`strategies/ruby-dynamic-dispatch.ts`): add a guard after the existing
`receiverChainTailIsExternal` guard and before `lookupByShortName`:

```ts
// AR/core instance member on an untyped receiver: the true target is an
// external base class (ActiveRecord::Base, ActiveSupport). Fanning out to a
// coincidental in-project def of the same name is wrong-type noise. Suppress;
// the external classifier (Consumer 2) reclassifies so recall is not penalised.
if (isExternalQualifiedMember(call.member)) return [];
```

The receiver is already untyped at this point (all typed/constant/relation/index
receivers returned `[]` earlier), so the guard needs only the member.

### Consumer 2 — the classifier arm (reclassify as external, not a miss)

The call must count as `externalSkipped`, not `noInProjectDef`, or the guard
trades a noise edge for a recall penalty. The reclassification path is
`RubyCallResolver.targetsExternalImport → ExternalCallClassifier.targetsExternal → RubyExternalVocabulary.isQualifiedReceiverExternal`.

**Interface note (finalize exact shape in the plan):** unlike Increment A's
index-suppression — whose discriminator was a _receiver_ property
(`receiverIsIndexAccess(receiver)`) and so fit `isQualifiedReceiverExternal`'s
existing `(receiver, ctx)` signature — this discriminator is a _member_
property. The member must reach the qualified branch. `ExternalCallClassifier`
already holds the full `CallRef` (it reads `call.member` for the bare branch),
so the minimal change is to let the qualified branch also consult a member-aware
predicate. Two candidate shapes, decided in the plan by weighing the
`ExternalVocabulary` (per-language) interface blast:

- (a) additive `ExternalVocabulary.isQualifiedMemberExternal?(member)` consulted
  by `targetsExternal`'s qualified branch (`|| `), Ruby impl =
  `isExternalQualifiedMember`, other languages default `false`; or
- (b) widen the qualified-branch call to pass `call.member` into a Ruby-side
  check. Prefer (a) — additive, language-neutral classifier stays neutral, no
  behavior change for TS/other vocabularies.

## Testing

RED-first unit tests, each pinning the EXACT target (never just non-empty — a
wrong outcome is invisible in aggregates):

- `agent.update` (untyped receiver, member ∈ V_core) → `resolveDispatch` returns
  `[]` **and** `targetsExternal` returns `true` (externalSkipped, not miss).
- Control: `agent.handle_details_post` (member ∉ V_core) → fan-out unchanged.
- Shadow-guard: a project class that defines `def update` and is called on a
  _typed_ receiver resolves exact via the chain — never reaches the guard, never
  suppressed (the chain-order-safety invariant, explicit test).
- `class` / `save` (excluded members) → fan-out unchanged (regression pins for
  the exclusion boundary).
- `dsl/catalogue.ts`: `isExternalQualifiedMember` membership unit (in-set vs
  out-of-set).

## Validation (live, mirrors A / B)

huginn force-reindex with categorized removed-edge sampling:

- exactRatio ↑ (target ≈ +2pp), dynamic ↓ by ≈ the curated count (~409), **zero
  exact-edge loss** (suppression only ever touches dynamic edges).
- `byReceiverKind`: dynamic bucket `externalSkipped` ↑, `noInProjectDef`
  unchanged-or-down (reclassification, not new misses).
- Spot-check the removed edges: every one is a `V_core` member on an untyped
  receiver; **no `save`/`save!`/`present?` edge removed** (they are excluded).
- Every other receiverKind (bareCall/constant/ivar/selfMember/localVar/super/
  chain) byte-identical before/after — the regression invariant.

## Scope

**In scope (one slice):** the curated `V_core` member-gate + its two consumers

- tests + one huginn validation.

**Out of scope — Slice 2 (receiver-shape guard) REJECTED.** Recovering the ~1400
`to_s`/`each` edges would require discriminating whether an untyped receiver
could be a Drop / override class. The only concrete discriminator on huginn
(`LiquidDroppable` / `Liquid::Drop`) is **project-specific** — exactly the
overfit this design rejects. A generic-sound receiver-shape guard for universals
does not exist without a receiver type (`to_s` is idiomatically overridden on
models; without the receiver's type a blanket suppress drops real edges). Not
split to a follow-up bead — closed by design.

## Affected files (~6, sub-epic, profile A)

- `src/core/domains/language/ruby/dsl/rails-runtime.ts` —
  `+ACTIVE_RECORD_INSTANCE_BUILTINS`
- `src/core/domains/language/ruby/dsl/catalogue.ts` —
  `+isExternalQualifiedMember`
- `src/core/domains/language/ruby/dsl/index.ts` — export
- `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`
  — guard
- `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts` —
  classifier arm
- `src/core/domains/language/external-classifier.ts` and/or
  `src/core/contracts/types/language.ts` (`ExternalVocabulary`) — member-aware
  qualified branch (interface shape per the plan; prefer additive)
- tests under `tests/core/domains/language/ruby/dsl/` and `.../resolver/`

## Risks

- **Interface blast (Consumer 2).** Touching `ExternalVocabulary` is a
  per-language seam. The additive-optional shape (a) keeps TS/other vocabularies
  at `false` with no behavior change; verify in the plan that no other
  `ExternalVocabulary` implementer regresses.
- **Deep-silo files.** `ruby-dynamic-dispatch.ts` +
  `ruby-external-vocabulary.ts` are artk0de 100% deep-silo (just touched by A /
  B-suppress). Pair-review.
- **Curation drift.** `V_core` is idiom-curated, not provable. The conservative
  boundary (exclude lifecycle + universals + disputed) plus chain-order safety
  bounds the downside to near-zero; aggressive additions require a fresh
  safe/risky measure, never a guess.
