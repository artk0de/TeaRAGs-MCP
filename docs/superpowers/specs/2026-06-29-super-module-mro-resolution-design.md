# Ruby `super` Module-Method MRO Resolution — Design

**Bead:** `tea-rags-mcp-2oky5` (re-scoped) · parent program `cai0` · #1 recall
lever post-Option-A.

**Goal:** Resolve `super` calls written inside a method of a MODULE that is
included/prepended into classes — the dominant (80%) shape of unresolved Ruby
`super`. Recover ~330–380 of ~456 super attempts across the suite (huginn +
graphql-ruby) at **precision 1.0** (no false edges).

## Background — the measured gap

Post-Option-A honest `super` `inProjectEdgeRecall`: **huginn 0.44** (60
attempts), **graphql-ruby 0.51** (396 attempts). Forensic (2026-06-29): 80% of
the 432 super calls are the MODULE-ANCESTOR shape — `super` inside a method
DEFINED IN module M that is mixed into classes. graphql tracing modules
(`PerfettoTrace`/`AppOpticsTrace`/`CallLegacyTracers` included into
`GraphQL::Tracing::Trace` subclasses) dominate (~280–310 edges); huginn
`DryRunnable::Wrapper` (prepend) ~50–70.

## Root cause

`RubySuperSymbolResolutionStrategy.resolveSuper` keys on
`enclosingClass = ctx.callerScope.join("::")` then walks
`ctx.classAncestors[enclosingClass]`. For `super` inside module M's method,
`enclosingClass = M`, and `ctx.classAncestors[M]` is **M's OWN ancestors** (what
M itself includes — usually empty/irrelevant), NOT the ancestors of the class C
that included M. In Ruby's MRO, `super` from a module-method dispatches to the
next ancestor in the **including class's** linearization after M. The resolver
keys on the wrong entity (the lexical definition scope M, not the including
class C), so the walk misses.

## Design — reverse-consensus fallback (ADDITIVE)

`resolveSuper` runs the existing class-keyed walk FIRST (byte-identical). On a
**full miss** (returns `null` — exactly the module-method case, where
`classAncestors[M]` has no usable ancestor), a NEW reverse-consensus branch
runs.

### Components

1. **Reverse include-by index (run-global):
   `includedBy[X] = { C : X ∈ ancestors(C) }`.** Derived by inverting the
   existing run-global `runAncestors` AND `runPrependedAncestors` (prepend
   relationships included). Built once per run at the pass-1→pass-2 barrier —
   mirrors the pffv `runInstantiatedTypes` merge — and injected into
   `CallContext` as `ctx.includedBy`. The reverse-index derivation is
   walker-free and adds no payload-schema change. **(REVISED — see the Task-5
   addendum: the Ruby walker additionally fills the pre-existing, non-persisted
   `classExtends` field to enable the Ruby-MRO ancestor reorder. That is the one
   walker change in the delivered feature; the "no walker change" framing held
   only under the original assumption that `classAncestors` was MRO-ordered.)**

2. **`resolveSuper` reverse-consensus fallback (`ruby-super.ts`).** For
   `X = enclosingClass` on a class-keyed miss:
   - `targets = { firstDefinerAfter(X, member, C) : C ∈ includedBy[X] }`, where
     `firstDefinerAfter` walks C's prepend-aware MRO (`collectAncestorChain(C)`)
     from the position AFTER X, resolving `member` via
     `resolveInstanceMethodInClassChain` on each ancestor (first definer wins).
   - All non-null targets AGREE (same `targetSymbolId`; for file-only, same
     file) → **resolve** to that single target.
   - Targets disagree, or all null/empty → **DROP** (GUARD discipline, bd
     jsa0/lttd).

3. **`firstDefinerAfter` / "MRO of C after X" helper (`shared.ts`).** ADDITIVE —
   a new function; the existing `collectAncestorChain` /
   `resolveInstanceMethodInClassChain` backbone (isHub, fanIn 8) is NOT mutated.

### Decisions (locked)

- **Consensus-resolve, drop on disagreement (Option A).** Emit an edge only when
  the target is INVARIANT across every including class — guaranteeing the edge
  is correct for any runtime receiver. Precision 1.0; recovers the convergent
  multi-include bulk (graphql modules wrapping a shared `Trace` base).
- **Universal fallback, no module-vs-class flag.** Provably sound for classes
  too: for a class `Base` whose class-keyed walk misses (external parent),
  `includedBy[Base]` = subclasses, and `next-after-Base` in every subclass's MRO
  is Base's own parent (exactly where `super` from `Base` goes) → consensus is
  correct or drops. Avoids a new walker emission / module-set.
- **Class-keyed wins on any non-null result** (including a file-only fallback) →
  the reverse path is purely additive, tried ONLY on a full class-keyed miss →
  zero regression on the existing 20% class-direct shape and on self/bareCall.
- **Prepend-aware:** `includedBy` inverts `runPrependedAncestors` too; the
  MRO-after-X walk reuses the prepend-aware chain (`DryRunnable::Wrapper`
  prepended into `Agent` → `next-after-Wrapper` = `Agent#m`).
- **superTargetsExternal untouched:** a module M with an empty own-chain yields
  `chain.length > 0 === false` → NOT classified external → reaches resolveSuper.

## Soundness / precision

Precision 1.0 by construction: a consensus target is invariant across all
including classes, so the emitted edge is correct for every possible runtime
receiver. The reverse path NEVER fires when the class-keyed path already
resolved (byte-identity preserved). Recall is bounded by reverse-index
completeness within the in-project closed world; a class including M outside the
project has an external super-target and yields no in-project edge (not a false
edge).

## Testing (TDD)

Unit (`ruby-super` strategy tests, sink/symbol-table fixtures):

- module M with `def m; super; end`, included by 2 classes whose `next-after-M`
  CONVERGES to a shared base `Base#m` → resolve to `Base#m`.
- same, but including classes DIVERGE (`A#m` vs `B#m`) → DROP.
- prepended module `Wrapper` (prepend into `Agent`) `super` → `Agent#m`.
- class-direct super (existing 20% shape) unchanged — existing tests are the
  byte-identity oracle.
- a module super with no including class → DROP.

Live validation (user-gated build+link+reconnect+reindex): `super`
`inProjectEdgeRecall` before/after on huginn + graphql-ruby; byReceiverKind
`resolved` for `super` goes UP, every other kind's counts unchanged on all 4
corpora (no precision regression).

## Files

- `src/core/domains/language/ruby/resolver/strategies/ruby-super.ts` — reverse-
  consensus fallback in `resolveSuper`.
- `src/core/domains/language/ruby/resolver/strategies/shared.ts` — additive
  `firstDefinerAfter` (MRO-of-C-after-X) helper.
- `src/core/domains/trajectory/codegraph/symbols/provider.ts` — build
  `runIncludedBy` (invert runAncestors + runPrependedAncestors) at the pass
  barrier; inject `includedBy` into per-call `CallContext`.
- `src/core/contracts/types/codegraph.ts` —
  `CallContext.includedBy?: Record<string, string[]>`.

## Out of scope

- mastodon bareCall recall-holes (cai0.1) share this MRO-completeness root but
  are a SEPARATE task; measure how much this dents them after landing, do not
  widen scope here.
- Fan-out / confidence-weighted super (Option B) — rejected (breaks GUARD
  discipline, precision regression).
- A module-set payload field — avoided by the universal derived fallback. (A
  Ruby `classExtends` walker emission WAS added in Task 5 — see the addendum; it
  is non-persisted resolve-time data, not a payload/schema field.)

## Addendum — Task 5: Ruby-MRO ancestor reorder (2026-06-29)

The plan's `firstDefinerAfter` (Task 2) linearized the including class's MRO via
`collectAncestorChain`, which reads `classAncestors` in the walker's stored
order `[superclass, ...includes]`. The Task-4 e2e revealed this is the REVERSE
of Ruby's true MRO `[...includes, superclass]`: for the DOMINANT graphql shape
`class Sub < Base; include M`, the module `M` lands LAST, so `firstDefinerAfter`
finds nothing after it and DROPs — the ~280–310 graphql tracing edges (the main
payoff) were not recovered. The original "no walker change" assumption rested on
`classAncestors` being usable as the MRO; it is not.

Fix (Task 5, additive):

- The **Ruby walker now fills `classExtends`** (`fqClass → superclass`). The
  field is PRE-EXISTING (`FileExtraction.classExtends`, populated by TS/JS) and
  NON-PERSISTED (resolve-time data, not a Qdrant payload — no migration). The
  walker already extracted the superclass; it now also records it here. No Ruby
  resolver path read `classExtends` before, so this changes no existing Ruby
  resolution (verified: existing super/self/bareCall read `classAncestors`).
- `firstDefinerAfter` uses a new additive `mroOrderedChain` helper that moves
  the superclass (from `ctx.classExtends`) LAST per Ruby MRO (includes first).
  The isHub backbone (`collectAncestorChain` /
  `resolveInstanceMethodInClassChain`) is NOT mutated. The reorder is gated on
  `classExtends` presence, so non-superclass fixtures are unchanged.

Residual (Minor, matches the pre-existing class-direct backbone, not a
regression): the reorder is applied per-level via `mroOrderedChain`, but the
per-element resolution still delegates to `resolveInstanceMethodInClassChain`,
whose own recursion walks raw `[superclass, ...includes]` order. For a DEEP
hierarchy where a nested ancestor's superclass AND a nested include BOTH define
the member, the picked target can be the nested superclass rather than the
strict-MRO-first nested include. Single-level shapes (the dominant case) are
exact; the "precision 1.0 by construction" claim narrows to the first-level MRO.
