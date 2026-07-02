# mn00t — AST-Inference Type-Source Expansion (Design)

**Bead:** `tea-rags-mcp-mn00t` (epic `tea-rags-mcp-fxcjq`, post-d9o7o
precision/recall follow-ups) **Status:** approved (Approach A) **Date:**
2026-07-02

## Problem

Untyped receivers are the dominant recall+precision hole in the Ruby resolver. A
receiver with no type routes through the dynamic short-name fan-out (N may-edges
at confidence discount/N); a typed receiver routes through
`type-propagation.ts::typeOfReceiver` → chainType/localType and resolves to ONE
exact edge. Supplying types from AST + Rails conventions (no YARD/Sorbet needed)
is therefore a DUAL lever: recall UP (dynamic misses become exact resolutions)
and precision UP (the collapsed fan-out removes N−1 may-edges) simultaneously —
and it works on un-annotated Rails, where annotation-driven type sources are
ceiling-bound (mastodon has 0 YARD; huginn is un-annotated).

### Baselines (2026-07-02)

| receiverKind | bench-mastodon (`code_41feebdd`)    | huginn (`code_d2c81d68`) |
| ------------ | ----------------------------------- | ------------------------ |
| dynamic      | 0.865 / 9749 attempted (noDef 3889) | 0.660 / 3097             |
| chain        | 0.842 / 6075 (noDef 1945)           | 0.488 / 914              |
| index        | 0.485 / 1641 (worst bucket)         | 0.333 / 1092             |

Edge shape (mastodon): `edgeKinds.dynamic` 60270 (88% of 68282 total),
exactRatio 0.117. Contrast octokit (annotated): exactRatio 0.946 — type supply
is what turns fan-out into exact edges.

## Coverage holes found (exploration)

Already covered by the existing substrate: plain local assignments
(`x = Const.new/find`, `var = CONST`, copy-propagation, multi-assignment, param
defaults), block-parameter element typing over already-typed collections,
relation tails with a terminal instance verb (`Const.where(...).first`), plain
ivar assignments (`local-bindings.ts::collectRubyIvarFieldTypes` /
`recordIvarAssignment`).

Not covered (this bead, families F1–F3):

1. **`||=` memoization** — `recordIvarAssignment` and
   `ast-inference.ts::extract` match only `node.type === "assignment"`;
   `operator_assignment` (`@u ||= User.find(id)`, `x ||= Post.find(id)`) falls
   through. Mass Rails pattern.
2. **Bare relation assignment** — `posts = Post.where(...)` emits NO fact
   (`constInstanceType` requires a terminal `instanceReturning` verb; there is
   no container-fact emission path). Feeds the index bucket (`h4d5s`),
   block-param typing, and element lift.
3. **Identifier-rooted element lift** — `user = users.first` on a typed
   collection: `constInstanceType` only handles Const-rooted chains.

Deferred beyond this bead: AST return-type inference
(`def build_user; User.new; end` → `structuredReturnTypes`) as increment 2 after
the live measurement; per-model `scope :name` grammar as a separate bead; ivar
container facts; `&&=`; unions from conditional assignment.

## Approaches considered

- **A. Walker-side type-supply expansion (chosen).** All changes in
  `ast-inference.ts` + `local-bindings.ts`; `latestBinding` upgraded from
  `string` to `RubyTypeRef`; container facts for locals only. Hub chunks
  (`walker.ts::extractFromRubyFile`, `type-propagation.ts::typeOfReceiver` —
  both hotspot+hub per tea-rags enrichment) untouched. Downstream is already
  wired: `ruby-dynamic-dispatch.ts:85-99` (typed-container index base),
  `type-propagation.ts:137-150` (element lift),
  `CONTAINER_ELEMENT_RETURNING_METHODS` in `returnTypeOf`, and
  `LocalBinding.typeRef?: RubyTypeRef` (INFRA-A) carries container refs over the
  existing localBindings channel — no CallContext change.
- **B. Resolver-side lift** — teach `typeOfReceiver` to recognize relation
  chains by receiver text at resolve time. Rejected: edits a hub chunk,
  re-parses text instead of AST, duplicates grammar knowledge across layers.
- **C. Full VTA fixpoint** — dataflow lattice over method bodies. Rejected for
  this bead: the three families need only the established single forward-pass
  `latestBinding` pattern; algorithmic-novelty cost is not justified here.

## Design (Approach A)

### F1 — `||=` (operator_assignment)

- `ast-inference.ts::extract`: accept `node.type === "operator_assignment"` with
  operator `||=` alongside `assignment` — same RHS branches (`constInstanceType`
  / bare-CONST / copy-propagation) for identifier LHS.
- `local-bindings.ts::recordIvarAssignment`: same acceptance for
  `instance_variable` LHS → `@u ||= User.find(id)` flows through the existing
  `ivarTypes`/`classFieldTypes` channel into `resolveIvarType`.
- Soundness convention: the nil branch of memoization is ignored (happy-path
  receiver takes the RHS type). Only `||=`; `+=`/`&&=` out of scope.

### F2 — relation → container facts

- `extract`: when `constInstanceType(rhs)` is null and RHS is a call with method
  ∈ `RUBY_RELATION_RETURNING`, reuse `relationRootConst(rhs)` (it already folds
  the chain recursively) → emit
  `{ form: "container", element: { form: "instance", name: Const } }`.
- `emitFact` signature takes a `RubyTypeRef`; `latestBinding` stores
  `RubyTypeRef` instead of a bare string.
- Block-param branch: a container binding binds the first block parameter to its
  `element` (this is exactly what F2 supplies for `posts.each { |p| }`).
- Precision-safe by construction: non-element members on a container
  (`update_all`, `count`) return `undefined` from `returnTypeOf` → current path,
  no false exact edges.
- **Ivar containers explicitly deferred**: the string-valued `ivarTypes` map
  reduces container → element name (`refToName`), which would type `@posts` as
  instance Post and fabricate exact edges on `@posts.map`. Needs a
  `RubyTypeRef`-valued ivar map (CallContext touch) — increment 2+.

### F3 — element lift (`user = users.first`)

- `extract`: assignment RHS = call with identifier receiver whose
  `latestBinding` is container-form and method ∈
  `CONTAINER_ELEMENT_RETURNING_METHODS` (already imported by ast-inference) →
  emit instance fact of the element type.

### Verb audit (data-only)

Reconcile `instanceReturning` / `relationReturning` in `dsl/rails.ts` and
`dsl/ruby-core.ts` against the actual Rails API surface (`find_by`, `take`,
`sole`, …; `includes`, `joins`, `limit`, `distinct`, `or`, …). Pure data + count
tests; exact membership settled at implementation time against the API list.

## Files

- Touched: `ruby/walker/type-sources/ast-inference.ts`,
  `ruby/walker/local-bindings.ts`, `ruby/dsl/rails.ts`, `ruby/dsl/ruby-core.ts`
  (data only), tests.
- NOT touched: `ruby/walker/walker.ts`, `ruby/resolver/type-propagation.ts`,
  `ruby/dsl/types.ts`, `contracts/`.

## Testing

TDD per family (red-green, dinopowers:test-driven-development at execution).
Existing tests are immutable (business-logic test rule). Walker tests extend
`tests/.../type-sources/ast-inference.test.ts` with new describes per family;
`local-bindings` tests cover `||=` ivar facts; one resolver-level integration
test: container binding → index call → exact edge end-to-end.

## Live validation

Build+link the worktree (worktree build rules apply), reconnect MCP, force
reindex bench-mastodon + huginn (user-gated), compare against baselines above:
per-receiverKind `inProjectEdgeRecall`, `edgeKinds.dynamic`, exactRatio.
Honest-denominator gate (n2kpz L2 lesson): `externalSkipped` and
`callsNoInProjectDef` must NOT grow — no denominator gaming.

## Success criteria

- index recall moves visibly up from 0.485 (container facts feed exactly this
  bucket; ceiling = share of container base-vars that gain a type).
- dynamic recall > 0.865; exactRatio up from 0.117.
- Zero movement in denominator fields (`externalSkipped`, noInProjectDef beyond
  genuine resolutions).

## Forecast

Sub-epic class, substrate-exists discount ×0.5–0.7, anchor n2kpz L1 (~1 burst
day): P25 1.5 / P50 2–2.5 / P75 3.5 burst days including live iteration.
