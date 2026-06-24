# Ruby dynamic-edge precision+recall — Increment B: receiver type inference

**Beads:** tea-rags-mcp (child of epic tea-rags-mcp-m99j1; complement of the
shipped+validated Increment A `mktkk`). **Date:** 2026-06-24 **Status:** design
approved, pre-implementation.

## Problem (measured, post-A on huginn 2026-06-24)

A "dynamic" edge is a 1/n fan-out emitted when a call receiver has no
statically-known type. Increment A removed the structurally-untrackable case
(index-access receivers). The remaining fan-out comes from receivers the walker
**fails to type**. Post-A ruby buckets (`get_index_status` byReceiverKind):

| bucket   | attempted | resolved | recall | note                                             |
| -------- | --------- | -------- | ------ | ------------------------------------------------ |
| dynamic  | 3100      | 1601     | 0.863  | untyped receivers → fan-out                      |
| bareCall | 3617      | 1803     | 0.859  | no receiver (separate epic vh0yh)                |
| chain    | 914       | 289      | 0.812  | `a.b.c` — NOT walked today; 356 noInProjectDef   |
| localVar | 121       | 43       | 0.741  | typed-local misses (relation tail / block param) |
| index    | 1092      | 54       | 0.771  | A-suppressed; 155 residual chain-off-index       |

Earlier estimate: `uniqueTargetPickable ≈ 30.6%` — receivers a smarter binding
collection could pin to ONE type, converting a fan-out into a single EXACT edge
(precision AND recall up).

## The single seam (mechanism, from investigation)

Every exact-receiver strategy funnels into ONE function:
`resolveTypeMethod(typeName, member, ctx, mode): SymbolResolutionTarget | null`
(`resolver/strategies/shared.ts:253`). The dispatch defer and
`RubyLocalTypeSymbolResolutionStrategy` key on `call.receiver`:

- bare identifier (`user`) for single-var receivers;
- the FULL compound text (`event.user`) for chain receivers — currently
  unmatched, so chains fan out.

**Consequence that shapes every slice:** the resolver already turns a
`(receiverKey → typeName)` binding into an exact edge. So each slice's job is
ONLY to populate the right `(receiverKey → type)` into `localBindings` /
`classFieldTypes`. No slice emits edges or adds a resolver strategy, EXCEPT
where noted (var=CONST adds a class-method branch inside the shared resolver).

Strategy order (exact chain): super → selfMember → **localType** → **ivarField**
→ returnTypeBinding → constant → require → arRelationGuard → receiverSetDrop →
bareCall. Dispatch components: table → cone → **dynamic**.

## Goal

Type more receivers so the dynamic fan-out collapses to single exact edges,
**without ever emitting a wrong-type edge** (a wrong exact edge is worse than an
honest fan-out — it is invisible in aggregate `exactRatio`). Net: `exactRatio`
↑, ruby `dynamic` ↓, recall ↑ or flat, **zero exact-edge loss**.

## Architecture — three tracks (by file / concern)

Tracks 1 & 2 both own `walker/local-bindings.ts` → one sequential owner. Track 3
lives in `resolver/strategies/shared.ts` + the external classifier → disjoint
files → runs in parallel with 1+2. One combined huginn validation.

### Track 1 — walker binding additions (`local-bindings.ts`)

#### B2 — Relation tails

`x = Model.where(...).first` / `.last` / `.find_by(...)` / `.take` → bind `x` to
`Model` (instance). Extend `constInstanceType` to walk a relation chain rooted
at a `YARD_CONST` receiver: `Const.<rel>(...)[.<rel>(...)]*.<instance-method>`.

- New `RELATION_RETURNING_METHODS` set: `where`, `not`, `order`, `joins`,
  `includes`, `eager_load`, `preload`, `references`, `group`, `having`, `limit`,
  `offset`, `distinct`, `select`, `reorder`, `unscope`, `except`, `all`,
  `readonly`, `lock`, `merge`, `none`, `where_not`. (Methods that return a
  Relation of the SAME element type.)
- Terminal instance-returning method (reuse `INSTANCE_RETURNING_METHODS` +
  `first`/`last`/`take`/`find`/`find_by`) closes the chain → the root Const.
- Soundness **100%**: `Relation<Const>.{first,last,find_by,take,find}` is a
  `Const` instance or `nil`; never another type. A bare `Const.where(...)` (no
  terminal instance method) used directly as an iterable is handled by B-block,
  not bound as a single instance here.

#### B-block — block parameters

`coll.each { |e| e.member }` (and `map`/`select`/…) → bind block param `e` to
`coll`'s already-bound type. brg9 already stores the ELEMENT type as a var's
flat `type` (YARD `@param coll [Array<Post>]` → `coll` bound to `"Post"`), so
the block param inherits `resolveLocalBindingType(out, receiverText, blockLine)`
directly — no unwrapping. Composes with B2 (a Relation-bound var iterated in a
block yields the element/model type).

- New `RUBY_BLOCK_ITERATOR_METHODS` set: `each`, `map`, `collect`, `select`,
  `filter`, `filter_map`, `reject`, `find`, `detect`, `find_all`, `flat_map`,
  `each_with_index`, `each_with_object`, `group_by`, `sort_by`, `min_by`,
  `max_by`, `partition`, `count`, `sum`.
- New `block` / `do_block` case in the `collectLocalBindingsForChunk` walk
  callback: when the block's parent `call` node's method ∈ iterator set and the
  receiver has a resolved binding, push each `block_parameters` identifier as a
  binding of that type at the block line. (`each_with_object`/`reduce` second
  param is the accumulator — bind only the FIRST positional block param to the
  element type; skip the rest.)
- Soundness: bound only when the iterated receiver already has a sound element
  type. Unknown receiver → no binding (honest fan-out preserved).

#### var=CONST — class-valued bindings

`klass = User; klass.find(id)` → `klass` holds the CLASS, so `klass.find`
resolves `User`'s CLASS method, not an instance method.

- **Contract change (additive, backward-compatible):** add
  `valueKind?: "instance" | "class"` to `LocalBinding`
  (`contracts/types/codegraph.ts`); absent ⇒ `"instance"` (every existing
  binding and every other language is unaffected).
- Walker: a single assignment `var = CONST` (RHS is a bare `YARD_CONST`
  constant, not a call) pushes `{ type: CONST, valueKind: "class" }`.
- Resolver: `resolveTypeMethod` (or the localType strategy) branches on
  `valueKind`: `"class"` resolves a STATIC method (`User.find`, symbolId
  `User.find`) instead of an instance method (`User#find`). Reuse
  `lookupByShortName` filtered to the type file with the static-scope match.
- Soundness: a constant reference is an unambiguous class identity; class-method
  resolution mirrors the existing instance path with the static symbolId shape.

### Track 2 — B1 chain-association typing (`local-bindings.ts` walker channel)

`event.user.agents` where `event : Event`, `Event belongs_to :user` (→ `User`),
`User has_many :agents` (→ `Agent`).

- **Walker channel — association map:** build a per-class
  `Record<className, Record<accessorName, modelType>>` (reuse the
  `classFieldTypes` shape, or a sibling `associationTypes` field on
  `FileExtraction`). Populate via the EXISTING
  `associationModelConstant(callNode)` (`walker.ts:679`) — which already parses
  the `class_name:` override (so `belongs_to :author, class_name: "User"` →
  `User`, NOT `Author`: the wrong-type pivot is already solved) — plus the
  association macro's `declares` accessor names and `singularizeAssociation` /
  `camelizeModelName` inflection.
- **Chain plumbing (option a — no new strategy):** within
  `collectLocalBindingsForChunk`, after single-var/ivar types are known, resolve
  compound chain receivers segment-by-segment and bind the COMPOUND TEXT into
  `localBindings`: for `event.user.agents`, given `event → Event` and the
  association map, push `localBindings["event.user"] = User`. The existing
  dispatch-defer + `RubyLocalTypeSymbolResolutionStrategy` (which key on the
  full `call.receiver` text) then resolve `event.user.agents` exactly. Multi-hop
  = iterate left-to-right, binding each prefix. A segment whose type or
  association is unknown stops the walk (honest fan-out for the remaining tail).
- Soundness: each hop is a typed association with `class_name` honored; an
  unresolvable hop binds nothing. The root segment must itself be typed (YARD
  param, ivar, or a B2/var=CONST binding) — otherwise the chain is not walked.

### Track 3 — B-suppress external chains (`shared.ts` + two consumers)

Mirrors Increment A exactly (one predicate, two consumers). Provably-external
chain receivers (`req.headers.to_h`, `e.backtrace.first`, `type.constantize`)
currently fall through `isQualifiedReceiverExternal` (lowercase, non-index,
non-ivar, non-constant → `false`) into the dynamic fan-out.

- New text predicate `receiverChainTailIsExternal(receiver): boolean` in
  `shared.ts`: an `EXTERNAL_CHAIN_TAILS` substring set (structural mirror of
  `AR_RELATION_BUILDERS`), narrow to UNAMBIGUOUS core/runtime tails: `.headers`,
  `.backtrace`, `.constantize`, `.deconstantize`, `.to_h`, `.to_json`,
  `.to_param`, `.class_name`. Ambiguous high-frequency tails (`.map`, `.each`,
  `.first`, `.last`) are EXCLUDED in this increment (they carry
  recall-regression risk as common in-project method names; revisit gated by a
  root-segment framework-vocab match in a follow-up).
- Two consumers (identical sites to A): `RubyDynamicDispatchResolver`
  `resolveDispatch` guard (after the index-access guard) and
  `RubyExternalVocabulary.isQualifiedReceiverExternal` branch.
- Soundness: in-project association tails (`agents`, `user`, `team`) are NOT in
  the set → `event.user.agents` is never suppressed. Recall regression bounded
  by the explicitly-enumerated narrow set.

## Soundness discipline (the wrong-type defense)

Increment A only REMOVED edges → aggregate metrics proved correctness. **B ADDS
edges → a wrong-type add is invisible in `exactRatio`** (a wrong exact edge
still counts as "exact"). Two-layer defense:

1. **Per-slice unit tests pin the EXACT correct target**, not "an edge exists":
   `Model.where(active: true).first.save` → edge target is `Model#save`,
   asserted by symbolId; `belongs_to :author, class_name: "User"` →
   `event.author.name` resolves to `User#name` (NOT `Author#name`); block param
   over an `Array<Post>` → `Post#title`. A test that asserts only non-empty is a
   defect for this increment.
2. **Live validation samples NEW exact edges per category** (below).

## Testing (RED-first, per slice)

- B2: relation-tail RHS → bound type → exact edge to the Model method; bare
  `Model.where(...)` without a terminal instance method does NOT bind a single
  instance (it is a collection).
- B-block: typed-collection block param → element-type method edge; untyped
  receiver block param → still fans out (no binding).
- var=CONST: `klass = User; klass.find` → `User.find` (static symbolId);
  `obj = User.new; obj.find` → instance path unchanged (regression guard).
- B1: `event.user.agents` with the association map → `Agent` method edge;
  `class_name:` override honored; unknown root → not walked (fan-out preserved).
- B-suppress: `req.headers.to_h` → `resolveDispatch` `[]` AND
  `targetsExternalImport` true; `event.user.agents` → NOT suppressed (regression
  guard).

## Live validation (one huginn force-reindex, after the full batch)

Build worktree → `/mcp reconnect` (kill stale daemon) → force-reindex huginn →
assert via `get_index_status` + direct RO edge query:

- ruby `exactRatio` UP; ruby `dynamic` edge count DOWN; recall UP-or-flat;
- **ruby EXACT edge count NOT reduced** (no real edge lost — the additive slices
  only convert dynamic→exact; B-suppress only removes dynamic);
- **categorized new-edge sampling** (the wrong-type catch): sample N new exact
  edges whose source call-site is a relation-tail / block-param / chain-assoc
  receiver, and confirm the target type is CORRECT. Any wrong-type edge is a
  blocking regression for the responsible slice.

## Parallelism

Disjoint files → parallel implementation:
`{ Track 1 (B2 → B-block → var=CONST) → Track 2 (B1) }` sequential on
`local-bindings.ts` (one owner) **‖** `{ Track 3 (B-suppress) }` on
`shared.ts` + external classifier (independent). Both land on
`worktree-ruby-lsp-spike` (stacks on Increment A; A is NOT merged first).

## Out of scope (deferred)

- bareCall (no-receiver) typing — separate epic `vh0yh` (296 holes).
- JS resolver index/chain — separate epic `1nmeb`.
- Ambiguous external-chain tails (`.map`/`.each`/`.first`) — need a root-segment
  vocab gate; follow-up after B-suppress's narrow set is validated.
- Cross-file/global flow inference beyond the chunk window — VTA is intra-chunk.

## Risks

- **Wrong-type edge (precision poisoning)** — the headline risk; mitigated by
  exact-target unit tests + categorized new-edge sampling. B1 (`class_name`) and
  var=CONST (static-vs-instance) carry the most; both have the disambiguating
  data available (`associationModelConstant`, the constant identity).
- **god-method hub churn** — `collectRubyCalls` (walker.ts, methodLines 263,
  fanIn 16) and `local-bindings.ts` (deep-silo artk0de 100%): additive cases
  only, pair-review the silo files, full golden coverage preserved.
- **LocalBinding contract change** — additive optional `valueKind`; verify no
  other language's binding consumer regresses (tsc + full suite).
- **B1 intra-chunk fixpoint** — segment-walk must terminate (bounded by chain
  length); a cycle in the association map (self-referential `has_many`) must not
  loop — cap the walk at the literal receiver's segment count.
