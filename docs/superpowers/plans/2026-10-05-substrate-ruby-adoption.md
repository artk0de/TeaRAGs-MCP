# Substrate audit: which wave-2 Python mechanisms become kernel engines that Ruby uses

Epic `tea-rags-mcp-m99j1.1`. Base: `integration/py-ruby-substrate` @
`37c5b93d5`. Spec:
`docs/superpowers/specs/2026-10-05-python-ruby-resolver-substrate-design.md` (§3
approach, §4 kernel contracts, §4.3 "explicitly NOT in the kernel").

This is an audit. It implements nothing. For each Python mechanism it records
whether the engine is already in `kernel/`, whether Ruby has the same problem
(with a measurement where one was cheap), and a verdict. Each LIFT item then
gets a brief an agent can carry out within ~150k tokens.

## Measurements taken

All runs were on this base. Ruby tallies used
`codegraph-chain-tally.ts --lang ruby --time-only --kind-stats --dump-edges`.
The sinatra dump is byte-identical to `substrate-baseline/ruby-sinatra.tsv`, so
the base is clean.

Per-kind recall at base (`resolved/denominator`, plus `MISS`):

| corpus   | dynamic               | chain                 | ivar                 | super       | TOTAL             |
| -------- | --------------------- | --------------------- | -------------------- | ----------- | ----------------- |
| sinatra  | 0.922 343/372 (29)    | 0.925 37/40 (3)       | 0.772 44/57 (13)     | 0.278 10/36 | 0.908 1141/1256   |
| octokit  | 0.462 43/93 (50)      | 0.692 9/13 (4)        | 0.500 5/10 (5)       | 1.000 2/2   | 0.958 1354/1413   |
| huginn   | 0.685 556/812 (256)   | 0.770 94/122 (28)     | 0.947 125/132 (7)    | 0.640 16/25 | 0.895 3089/3451   |
| mastodon | 0.881 4068/4616 (548) | 0.879 1866/2124 (258) | 0.978 1784/1825 (41) | 0.940 78/83 | 0.932 20561/22063 |

Three offline probes (throwaway scripts, not committed) sized the Python
mechanisms on Ruby source.

**A. The dynamic fan on assigned locals.** These are `dynamic`/`localVar` sites
that carry `runner:dynamic` edges, where the receiver head is a bare lowercase
name assigned (`x =` / `x ||=`) between the enclosing `def` and the call.
Parameters and block parameters are excluded. "Core member" means the member is
a Ruby core or stdlib verb (`empty?`, `present?`, `size`, `first`, `shift`,
`reject!`, `get`, `post`, `path`, `type`, …), which makes a project-class target
almost certainly fabricated.

| corpus   | fanned sites | fanned edges | **assigned-local sites** | **their edges** | core-member share | param | blockParam | other (bare self-method head) |
| -------- | ------------ | ------------ | ------------------------ | --------------- | ----------------- | ----- | ---------- | ----------------------------- |
| sinatra  | 320          | 538          | **53**                   | **81**          | 47/53             | 142   | 22         | 103                           |
| octokit  | 41           | 46           | **14**                   | **17**          | 9/14              | 5     | 8          | 14                            |
| huginn   | 359          | 669          | **63**                   | **125**         | 33/63             | 104   | 98         | 94                            |
| mastodon | 2415         | 7871         | **377**                  | **1044**        | 182/377           | 363   | 368        | 1307                          |

Samples: `ext.empty?`, `hash.reject!`, `route.empty?`, `res.shift`
(sinatra/base.rb), `conn.get(...)` (octokit manage_ghes.rb), `stripped.empty?` →
5 edges, `subs.first` (huginn). Some are plausibly right, for example
`agent.valid?` in huginn `dry_runs_controller.rb`, where `agent` is a huginn
`Agent`. So the decline costs some recall, and that is why its gate is a manual
triage rather than "lost 0".

**B. Branch-union returns.** These are defs whose body tail is
`if/unless/case/ternary` with an else arm and every arm ending in `Const.new`.

| corpus   | defs | branch tail | all arms `Const.new` | same const | **different consts (union)** |
| -------- | ---- | ----------- | -------------------- | ---------- | ---------------------------- |
| sinatra  | 583  | 27          | 0                    | 0          | **0**                        |
| octokit  | 701  | 16          | 0                    | 0          | **0**                        |
| huginn   | 1572 | 141         | 0                    | 0          | **0**                        |
| mastodon | 7973 | 492         | 7                    | 6          | **1**                        |

**C. Return-delegation shapes (the fixpoint's inputs).** This counts tails that
delegate to a same-class method, a memoised ivar tail (`@x ||= …`), and an
`@ivar` tail typed by agreement across all of the class's writes.

| corpus   | delegate tail | → typed sibling | `@x \|\|=` tail | `@x \|\|= Const.new` | ivar tail | ivar typed by all writes |
| -------- | ------------- | --------------- | --------------- | -------------------- | --------- | ------------------------ |
| sinatra  | 50            | 1               | 9               | 2                    | 9         | 0                        |
| octokit  | 48            | 0               | 5               | 2                    | 1         | 0                        |
| huginn   | 60            | 3               | 39              | 17                   | 6         | 0                        |
| mastodon | 223           | 1               | 218             | 28                   | 60        | 1                        |

These agree with the Ruby navigator's own record that the interprocedural
worklist fixpoint was measured and rejected, with an addressable ceiling of
510/18522 = 2.8% on taxdome.

## Prioritized table

| #   | Mechanism                                                                                                                      | Today                                                                                                                                                                                                                               | Does Ruby have the problem? Evidence                                                                                                                                                                                                                                                                                                                       | Verdict                                                                         | Predicted Ruby gain                                                                                                                                                                                                    | Effort | Risk                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| 1   | Assigned-locals channel + dynamic-fan assigned-local gate (`5a4bd68c8`)                                                        | Channel is shared: `ChunkExtraction.assignedLocals` / `CallContext.assignedLocals`, merged in `kernel/merge-extraction.ts`. **Gate and producer are Python-only**: `pythonDynamicFanoutSuppressed` and `python-assigned-locals.ts`. | **Yes.** `rubyDynamicFanoutSuppressed` only declines a receiver with a _typed_ `localBindings` entry, so an untyped assigned local fans. Probe A found 53/14/63/377 sites carrying 81/17/125/1044 edges, and 48–89% of those sites call a core member                                                                                                      | **LIFT+ADOPT**                                                                  | Precision: about −1270 discounted edges over the four corpora, roughly −13% of mastodon's fanned edges. Recall in the tally: dynamic resolved drops by at most the assigned-local site count (mastodon ≤ −377 of 4068) | S–M    | Medium: true edges on an assigned local whose value is a project object are lost (`agent.valid?`). Triage-gated |
| 2   | Undecidable classifier `targetsUndecidable` (K11)                                                                              | The hook is in contracts and the runner (`resolution-runner.ts` maps it to `unresolvable`). **Only Python implements it**: `python-undecidable.ts`.                                                                                 | **Yes, in the denominator.** The Ruby navigator lists `method_missing` as a permanent floor (~8% of taxdome attempts, together with `params[:x]` and `constantize`). Ruby vocabulary already knows the hooks (`ruby-external-vocabulary.ts`, rule 3) but only for the _member_ being `method_missing`, not for a typed receiver whose class defines it     | **LIFT+ADOPT** (hook exists; Ruby port needed)                                  | No edge change. MISS moves to `unresolvable` for typed receivers whose class or ancestors define `method_missing` and lack the member. Not measured; size it in step 1 of the brief                                    | S      | Low: no edges change. Edge-identity gate is exact                                                               |
| 3   | Dynamic dispatch gates (`python-dispatch-gates.ts`) as a whole                                                                 | Engine K1 `kernel/dynamic-dispatch.ts`; gate predicates are per-language data                                                                                                                                                       | Partly. Ruby has its own gate set (AR relation, index access, external chain). The Python gates that Ruby lacks: assigned locals (#1) and the stdlib-member vocabulary decline. Ruby's equivalent of the latter is `coreAmbiguous` via `RUBY_CORE_MEMBERS`, already present                                                                                | **STAY** except #1                                                              | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 4   | Union return policy `ReturnUnionPolicy` / `inferReturnTypeNames` (`6ca44f543`, **not yet merged** into the integration branch) | **Kernel engine** with an opt-in policy (`kernel/return-inference.ts` on that branch). Ruby passes no policy                                                                                                                        | **No.** Probe B found 0/0/0/1 union-returning defs                                                                                                                                                                                                                                                                                                         | **LIFT-ONLY** (already done; Ruby adoption not useful)                          | ≈0 (1 def on mastodon)                                                                                                                                                                                                 | —      | —                                                                                                               |
| 5   | Return-inference fixpoint `PythonReturnFixpoint` (`557aee80f`)                                                                 | Python-only class in `python-ast-type-source.ts`; it calls kernel `inferReturnTypeName` per def                                                                                                                                     | **Marginal.** Probe C found 0–3 delegations to typed siblings and ≤1 ivar typed by all writes per corpus. The navigator's rejected worklist fixpoint had a 2.8% ceiling. The one real Ruby shape here is `@x \|\|= Const.new` memo tails (2/2/17/28 defs), which is a `constInstanceType` gap, not a fixpoint                                              | **STAY.** Optional Ruby-only follow-up: memo tails (bead, not a substrate item) | ≈0 from the fixpoint; memo tails ≤28 defs on mastodon                                                                                                                                                                  | —      | —                                                                                                               |
| 6   | Ruby has two return-inference engines                                                                                          | Kernel `inferReturnTypeName` is used only by service-entry `body-last-expr.ts`. The flat/scoped `collectRubyBodyReturnTypes` → `bodyReturnInstanceType` → `constInstanceType` (`walker/local-bindings.ts`) bypasses the kernel      | Not a recall problem. It is a single-choice violation: two places decide "what a Ruby def returns"                                                                                                                                                                                                                                                         | **LIFT (identity)**, optional                                                   | 0 (identity)                                                                                                                                                                                                           | S      | Low. Identity gate on sinatra/octokit/huginn                                                                    |
| 7   | Container element facts (`125800c75`)                                                                                          | Python-only walker facet + Python iteration fold                                                                                                                                                                                    | **Weak.** Ruby already types block params from typed containers (`ast-inference.ts` block element typing, relation → container, `containerElementLift`). What it lacks is element-from-writes (`a = []; a << X.new`). The Python gain was +4 sites on django. Block-param fans (probe A) are 22/8/98/368 sites, an upper bound and not the addressable set | **STAY** (re-evaluate after #1 lands)                                           | Unknown, bounded by block-param fans; expected small                                                                                                                                                                   | M      | Medium                                                                                                          |
| 8   | Iteration / with / except / unpack derived bindings (`4dd96476d`, `fd52b669c`)                                                 | Python walker; kernel `TypeRef` tuple form (T)                                                                                                                                                                                      | Ruby has block-element typing and `rescue Const => e` typing already. `with` has no Ruby analogue. Destructuring `a, b = m` from a typed tuple is near-absent in Ruby (methods do not declare tuple returns)                                                                                                                                               | **STAY**                                                                        | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 9   | Callable-value flow / `callableParam` (`2ed3640ae`)                                                                            | Python-only (`python-callable-value-flow.ts`, `python-callable-param*.ts`)                                                                                                                                                          | Ruby's callables are blocks and procs. A block body is not a symbol, so there is no target to route `yield` / `block.call` to. `method(:x)` passing is rare. The sinatra misses `callback.call` / `@app.call` are Rack duck typing, not callable flow                                                                                                      | **STAY**                                                                        | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 10  | K7 constructor-argument feed + `knownTargetCalleeLocator` (`e958a57c1`, `45341503f`)                                           | The fold is kernel-side, and Ruby is the original producer. `knownTargetCalleeLocator` is an optional `LanguageProvider` hook only Python provides                                                                                  | Ruby already produces `knownTargetCallArgs` through its own walker (`param-arg-types.ts`). Python's widening (re-exports, inherited `__init__`) is Python module-resolution content                                                                                                                                                                        | **STAY**                                                                        | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 11  | Module-value types (`ae4d842d9`)                                                                                               | Python walker facet + `TypeFactStore` channel                                                                                                                                                                                       | Ruby's analogue is a value constant (`CLIENT = Faraday.new`). Constant receivers score 1.000 on all four corpora, so a value constant either resolves or exits as external. No miss bucket to recover                                                                                                                                                      | **STAY**                                                                        | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 12  | Union dispatch consumer (`4b1c1f73e`)                                                                                          | **Kernel K2**, lifted from Ruby                                                                                                                                                                                                     | Ruby is the origin                                                                                                                                                                                                                                                                                                                                         | **done**                                                                        | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 13  | Framework vocabulary registry (`bf40e7d29`)                                                                                    | **Kernel K8**; Ruby's Gemfile is a `DependencyManifestSource`                                                                                                                                                                       | Ruby already on it                                                                                                                                                                                                                                                                                                                                         | **done**                                                                        | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 14  | Member-return provenance (`61785ccb1`, `42e63db64`)                                                                            | **Kernel K6** `kernel/member-return-type.ts`; Ruby `returnTypeOf` on it                                                                                                                                                             | Shared                                                                                                                                                                                                                                                                                                                                                     | **done**                                                                        | —                                                                                                                                                                                                                      | —      | —                                                                                                               |
| 15  | External-constructor classification (`812a8a291`, K12)                                                                         | Python-only arm                                                                                                                                                                                                                     | Ruby: a local typed `Faraday::Connection` (external) already becomes external through `receiverChainIsExternal` / typed-local paths. The untyped case (`conn = connection_helper`) is #1's population, not this one's                                                                                                                                      | **STAY** (subsumed by #1)                                                       | —                                                                                                                                                                                                                      | —      | —                                                                                                               |

The order to run them: **#1, then #2, then #6 (optional).** Every other row is
either done or not worth a Ruby port.

## Brief 1 — Ruby dynamic fan declines assigned locals (LIFT+ADOPT)

**Goal.** Ruby's dynamic short-name fan should stop dispatching on a receiver
the caller's def assigns but no typed channel answers, which is what `5a4bd68c8`
did for Python. The predicate becomes one kernel function that both languages
call. The producer is per language.

**Kernel (lift).**

- New `kernel/dynamic-dispatch.ts` export (ask `get_naming_lexicon` before
  finalising):
  `receiverIsAssignedLocal(call: CallRef, ctx: CallContext): boolean`. It
  returns `ctx.assignedLocals?.includes(call.receiver) === true`. That
  expression is exactly the line Python has today.
- `pythonDynamicFanoutSuppressed` calls it in place of its inline check. The
  position in the chain stays the same, so Python identity holds.

**Ruby producer (walker).**

- `ruby/walker/bare-call-detection.ts` has `collectMethodLocalBindings`, which
  folds params and block params together with assignments. Add a sibling,
  `collectMethodAssignedLocals(methodNode): Set<string>`. It collects only the
  `assignment` / `operator_assignment` / multiple-assignment targets
  (`left_assignment_list`), and `rescue => e` names. It excludes method params
  and block params, and does not descend into nested `def` / `class` / `module`.
  Block bodies ARE descended, because Ruby blocks share method scope.
- Emit `ChunkExtraction.assignedLocals` per method chunk, the way the Python
  walker does (`python/walker/walker.ts`, `assignedLocals` per call line). The
  channel, merge rule and runner threading already exist.
- Ruby scoping makes the set exact. A name is a local only if it is assigned
  earlier in lexical order, and otherwise it is a self-method call. A local used
  before its first assignment, inside the same def, still reads as a method
  call. To stay faithful, check the receiver's assignment line `<` the call
  line, or document the gap.

**Ruby gate.**

- `rubyDynamicFanoutSuppressed`: add `receiverIsAssignedLocal(call, ctx)` as a
  disjunct right after `exactChainOwnsReceiverShape`. A typed local is already
  caught there, so the new gate only sees untyped ones. Every gate is a pure
  predicate, so position changes cost and not result. Keep it ahead of
  `exactPass.answers`, which is the expensive one.
- It sits behind `CODEGRAPH_RUBY_ASSIGNED_LOCAL_GATE` (new; read through
  `readResolverConfig`) for the measurement. Flip it on by default in the same
  commit once the gate passes.

**Tests (TDD, failing first).**

- Walker: `x = foo; x.bar` → `assignedLocals ∋ x`. Params, block params and
  nested-def locals are excluded. `x ||= …` and `a, b = …` are included.
- Resolver: an untyped assigned local with an in-project namesake → no `dynamic`
  edges with the flag on. A parameter receiver still fans. A typed local keeps
  its exact edge.
- Python: the existing assigned-locals tests pass unmodified.

**Gate.** Ruby has no jedi oracle.

1. Flag off: sinatra/octokit/huginn dumps byte-identical to
   `substrate-baseline/ruby-*.tsv`.
2. Flag on: delta per corpus, including mastodon at
   `~/Dev/Tools/tea-rags-bench/corpora/mastodon`. Every lost row must be a
   `runner:dynamic@…` edge whose receiver is in the site's `assignedLocals`.
   Lost exact edges (any non-`runner:dynamic` provenance) must be **0**.
   Expected volume is about 81/17/125/1044 edges (probe A).
3. Precision triage. Draw 40 random dropped sites from mastodon and 20 from
   huginn, and classify each as fabricated, true, or unknowable by reading the
   assignment. Pass when the fabricated share is ≥ 70% among decidable sites. If
   it falls below that, narrow the gate to assigned locals whose RHS is not a
   project-typed call before flipping the default.
4. `scripts/taxdome-codegraph-recall-forensics.ts` stays available for a taxdome
   run after merge. The orchestrator decides whether to run it, because taxdome
   only runs after the main merge.

**Files:** `kernel/dynamic-dispatch.ts`,
`python/resolver/dispatch/python-dispatch-gates.ts`,
`ruby/walker/bare-call-detection.ts`, `ruby/walker/walker.ts` (or the
chunk-extraction assembler),
`ruby/resolver/strategies/ruby-dynamic-fanout-gates.ts`, Ruby resolver config
reader, tests next to each. Walker version bump: re-pin only
(`npm run pin:lang-versions`), bump once per release.

## Brief 2 — Ruby `targetsUndecidable` for `method_missing` receivers (LIFT+ADOPT)

**Goal.** A call whose receiver is TYPED to a project class that lacks the
member on its ancestor chain, but whose class (or an ancestor) defines
`method_missing`, is statically undecidable. It should leave the denominator as
`unresolvable`, like Python P6 does for `__getattr__`.

**Kernel (lift).**

- The decision shape is common: typed receiver → member absent on the MRO → some
  type on the chain defines a language "dynamic member hook". Lift it as
  `kernel/undecidable-member.ts`,
  `memberIsUndecidableOnType(typeRef, member, ctx, ports)` with
  `UndecidableMemberPorts { typeOf(call, ctx); memberOnChain(typeRef, member, ctx) /* TypeMemberLookup */; chainDefinesHook(typeRef, ctx): boolean }`.
- Before writing the lift, read `python/resolver/python-undecidable.ts`. If
  Python's arm is that shape plus Python-only arms (`dynamicSend`, metaclass),
  move only the shared arm and keep the rest in Python. Python identity is
  required (flask diff 0, chain drift 0).

**Ruby port.**

- `typeOf` comes from `typeOfReceiver` (`ruby/resolver/type-propagation.ts`).
- `memberOnChain` is the Ruby `TypeMemberLookup` (`ruby-type-member-lookup.ts`).
- `chainDefinesHook` checks for a symbol `<Ancestor>#method_missing` on the
  linearized chain (`AncestorLinearizerCache`).
- Wire `targetsUndecidable` into the Ruby facade (`ruby/index.ts`), mirroring
  `python/index.ts`.

**Step 1 (size it first).** Count tally `MISS` sites whose typed receiver class
chain defines `method_missing`, on mastodon, huginn and octokit (octokit's
`Client` defines it). If the total is below about 20, file the brief as a bead
and stop.

**Tests.** Typed receiver, class defines `method_missing`, member absent →
`unresolvable`. Member present → resolves as before. Untyped receiver → not
undecidable.

**Gate.** Edge dumps byte-identical on all four corpora: no edge changes, only
the `--kind-stats` buckets move, MISS → `unresolvable`. Report the moved count
per kind.

## Brief 3 (optional) — one Ruby return engine (LIFT, identity)

Route `bodyReturnInstanceType` in `ruby/walker/local-bindings.ts` through the
kernel's `inferReturnTypeName`. Use a Ruby port set whose `isBinding` always
answers false. The flat channel never followed bindings, and identity requires
that it still does not. This leaves "what a Ruby def returns" decided in one
place.

Gate: sinatra/octokit/huginn diff 0 against `substrate-baseline/ruby-*.tsv`. Run
the Ruby walker composition parity spike
(`scripts/spikes/ruby-walker-composition-parity.ts`) on one corpus.

Do it only after `6ca44f543` (union policy) merges, so both changes do not
rewrite `kernel/return-inference.ts` at once.

## Notes

- `ReturnUnionPolicy` / `inferReturnTypeNames` exist only on agent branches
  (`worktree-agent-afc5f7e2165a1af58` and two copies, commit `6ca44f543`), not
  yet on `integration/py-ruby-substrate`.
- Probe A's "other" bucket (mastodon 1307 fanned sites) is a bare head never
  assigned in the def, which in Ruby is a self-method call (attr reader or
  helper) and not a parameter. These receivers could be typed through K6 member
  return types of the self method. That would be a Ruby-only follow-up to size
  separately. It is not a Python substrate item.
