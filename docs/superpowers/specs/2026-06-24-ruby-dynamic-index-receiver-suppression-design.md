# Ruby dynamic-edge precision — Increment A: index-access receiver suppression

**Beads:** tea-rags-mcp-mktkk (child of epic tea-rags-mcp-m99j1) **Date:**
2026-06-24 **Status:** design approved, pre-implementation

## Problem (measured, not assumed)

A "dynamic" codegraph edge is a **fan-out**: `RubyDynamicDispatchResolver`, for
a call `recv.member` whose receiver `recv` has no statically-known type, emits
an edge to **every** in-project Ruby method named `member`
(`confidence = discount / n`). At runtime at most one is the real target.

Measured on huginn (force-reindexed, 8215 method edges):

- 5465 edges (66.5%) are `dynamic`; `exactRatio = 0.335`.
- Adversarial sampling (62 call-sites): dynamic-edge **precision ≈ 8–15%**;
  **~63% pure noise** (the receiver is external / gem / ruby-core, so NO
  in-project method is ever the runtime target).
- Of 2251 ruby dynamic call-sites, **371 have an index-access receiver**
  (`recv[k].member` — `options['subject']`, `payload[key]`, `columns_hash[…]`,
  `context.registers[:agent]`). An index access on an **untyped** container
  yields an element whose type is statically untrackable and is essentially
  always core/external (Hash/Array element). These 371 are structural noise.

Typed containers are NOT in this set: `@param x [Array<Post>]` already binds the
**element** type `Post` via `parseYardBracketType`, so element-method calls
resolve exactly and never reach the dynamic fan-out. Only **untyped** containers
hit dynamic fan-out.

## Goal (Increment A only)

Suppress the dynamic fan-out for **index-access receivers** and reclassify those
calls as **external** (not in-project misses), so:

- the fan-out noise edges are not emitted (precision ↑, `exactRatio` ↑);
- the calls leave the `inProjectEdgeRecall` denominator as `externalSkipped`
  (they have no in-project target), instead of being counted as resolver misses.

Out of scope for A (deferred to Increment B — type inference):

- **chain receivers** (`a.b.member`) — measured 205 call-sites, MIXED: external
  (`type.constantize`, `e.backtrace`, `req.headers`) AND in-project
  (`event.user.agents`, `Agent.types`, `config.strategy`) plus `self.class`
  metaprogramming. Blanket chain suppression would mislabel in-project chains as
  external. B types the trackable chains (`event.user` → `User` → exact edge)
  and suppresses only provably-external chains.
- **bare-identifier untyped locals** (`obj.member`) — 1607 call-sites; may be
  in-project. B extends binding collection (block params, Relation tails) to
  type them.

## Architecture: one predicate, two consumers

A single shape predicate keeps suppression and reclassification in lockstep so
they can never disagree.

### Predicate — `receiverIsIndexAccess(receiverText): boolean`

Lives in `src/core/domains/language/ruby/resolver/strategies/shared.ts`
alongside the existing text-shape predicates (`isRubyPath`,
`receiverLooksLikeArRelationChain`). Text-based on `call.receiver` exactly like
`CONSTANT_RE.test(r)` and `receiverLooksLikeArRelationChain(r)` already are —
**does NOT touch the `CallRef` contract** (the fanIn-68 / transitiveImpact-118
hub) nor the walker.

True when the receiver expression's **outermost** operation is an element
reference — heuristically the trimmed receiver ends in `]` with a matching
unbracketed `[` (so `options['x']`, `arr[i]`, `Hash[k]` are index; `event.user`,
`a[0].b` are NOT — the latter's outermost op is `.b`, a chain, deferred to B).
Exact boundary conditions are pinned by the RED tests.

### Consumer 1 — suppression (`RubyDynamicDispatchResolver.resolveDispatch`)

Add an early guard mirroring the existing receiver-exclusion guards:

```ts
if (receiverIsIndexAccess(r)) return []; // untyped element — external, no fan-out
```

Placed with the other "receivers the exact chain owns / external" guards
(`CONSTANT_RE`, `localBindings`, `receiverLooksLikeArRelationChain`).

### Consumer 2 — reclassification (`ExternalCallClassifier` / `targetsExternalImport`)

`RubyCallResolver.targetsExternalImport` must return `true` for an unresolved
index-access call so the codegraph provider counts it as `callsExternalSkipped`
(excluded from the recall denominator) rather than a genuine miss. Wire
`receiverIsIndexAccess` into the Ruby external-classification path
(`RubyExternalVocabulary` / the classifier) as an additional external signal.

## Data flow

1. Walker emits `CallRef{ receiver: "options['subject']", member: "fetch" }`
   (unchanged).
2. Provider runs `resolveDispatch` first → `RubyDynamicDispatchResolver` sees
   `receiverIsIndexAccess` → returns `[]` (no fan-out edges).
3. Exact chain `resolve` returns `null` (untyped receiver).
4. Provider classification: `targetsExternalImport` → `true` (index shape) →
   `callsExternalSkipped += 1` (NOT a miss, NOT a dynamic edge).

## Metric impact (measured, accepted)

Index-access calls were previously **"resolved"** (they emitted dynamic edges),
so they inflated the `inProjectEdgeRecall` numerator with ~10%-precision noise.
After A they move to `externalSkipped`:

| metric                        | before | after A (index-only)           |
| ----------------------------- | ------ | ------------------------------ |
| `inProjectEdgeRecall` (ruby)  | 0.8733 | **0.8641 (−0.92pp)**           |
| `exactRatio`                  | 0.335  | ↑ (≈ +900 noise edges removed) |
| dynamic-edge precision        | ~8–15% | ↑ (pure-noise class removed)   |
| `callsExternalSkipped` (ruby) | 1661   | +~371                          |

The −0.92pp recall change is the **honest correction** of a number that counted
noise fan-out as success; true recall (edges to correct targets) is unchanged.
Decision (i) — accept the honest drop — applies; no `inProjectEdgeRecall`
redefinition is warranted at this magnitude.

## Testing

Golden unit fixtures (extend `strategies.test.ts` / dynamic-dispatch tests),
RED-first:

1. Index-access receiver (`options['k'].fetch`, `arr[i].run`) →
   `resolveDispatch` returns `[]` AND `targetsExternalImport` returns `true`.
2. **Regression guards (must NOT change):** constant receiver, typed local
   (`x = Foo.new; x.bar`), `@ivar` with known type, `self.x`, super, AR-relation
   chain — all resolve exactly as before.
3. **Boundary:** bare-identifier untyped local (`obj.foo`) → STILL fans out (not
   suppressed — that is Increment B). Chain receiver (`a.b.foo`) → STILL fans
   out (not suppressed — Increment B).
4. Provider-level: an index-access call increments `callsExternalSkipped`, not
   `callsResolved` and not the `missWithInProjectDef` recall hole.

## Live validation (huginn)

Build worktree → reconnect MCP (fresh codegraph daemon picks up new code) →
force-reindex huginn → assert via `get_index_status` + a direct RO edge query:

- `exactRatio` up; ruby dynamic edge count down by ≈ the suppressed fan-out;
- `callsExternalSkipped` (ruby) up ~371; `inProjectEdgeRecall` ≈ 0.864 (within
  the predicted −0.92pp);
- **no in-project EXACT edge lost** (exact-edge count not reduced) — the
  suppression touches only `dynamic` edges;
- re-sample a handful of suppressed call-sites to confirm they were noise.

## Risks

- **Predicate false-positive** (a non-index receiver ending in `]`): bounded by
  the matching-bracket rule + RED boundary tests; worst case suppresses a rare
  real edge (already low-precision dynamic).
- **Deep-silo file** (`shared.ts` / dynamic-dispatch — artk0de-owned): pair on
  review per silo-pairing rule; the change is additive (one guard + one
  predicate) and fully covered by golden tests.
- **No `CallRef` contract change** — blast radius confined to the ruby resolver
  strategies (leaf), not the 118-transitiveImpact hub.
