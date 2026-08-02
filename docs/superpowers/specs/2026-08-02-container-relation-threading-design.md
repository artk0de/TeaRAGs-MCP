# Container-relation threading — design and verdict (bd tea-rags-mcp-vfo3e)

**Verdict: designed, measured, NOT implemented.** The mechanism below is sound
and would cost about a day. It buys **zero call edges** on taxdome. The oracle
(`CODEGRAPH_CONTAINER_RELATION_ORACLE=1` in
`scripts/taxdome-codegraph-recall-forensics.ts`) sized the whole population at
**32 call sites**, projected **0** new exact edges, and found the only
observable effect to be a **-16 shift of the recall denominator** — misses
reclassified as `externalSkipped` without a single new edge being drawn. That is
metric inflation, so the change stays unbuilt and this document records why,
plus the mechanism a future re-funding would start from.

The bead's premise — "the real blocker capping relation-verb typing corpus-wide"
— does not survive measurement. The blocker is one hop earlier: **89 % of
dotted-chain misses never get a type for the chain HEAD**, so no rule about what
happens at hop 2 can fire.

## 1. What the engine does today

`returnTypeOf` (`ruby/resolver/type-propagation.ts`) answers a container
receiver from exactly one set:

```ts
if (recv.form === "container") {
  return CONTAINER_ELEMENT_RETURNING_METHODS.has(member)
    ? recv.element
    : undefined;
}
```

Ten members — `first`, `last`, `[]`, `fetch`, `sample`, `find`, `detect`, `min`,
`max`, `dig` — unwrap to the element. Everything else answers `undefined`, and
`resolveChain`'s stop-at-unknown-hop invariant kills the rest of the chain.
Rails' own query verbs are in "everything else", so `documents.where(…)`,
`documents.page(1)` and `scope.ransack(…)` on a `container(Document)` are all
silence.

The gem grammars that DO know these verbs — kaminari's `page`/`per`, ransack's
`ransack`/`result`, will_paginate's `paginate` — live in the `relationReturning`
facet, which today is read only by the walker's CONSTANT-rooted inference
(`ast-inference.ts::relationRootConst`) and by `activeRecordQueryReturn`'s
class-receiver branch. Neither fires on a container receiver.

## 2. The mechanism

One branch, one file. `returnTypeOf`'s container arm gains a second question,
asked only after element extraction has declined:

```ts
if (recv.form === "container") {
  if (CONTAINER_ELEMENT_RETURNING_METHODS.has(member)) return recv.element;
  return relationVerbPreservesContainer(recv.element, member, ctx)
    ? recv
    : undefined;
}
```

`relationVerbPreservesContainer` returns `true` when either of two sources says
the member yields a relation:

1. **Vocabulary** — `catalogueForGemfile(ctx.gemfileContent).relationReturning`.
   That set is already the composed fold over `FRAMEWORKS`
   (`dsl/catalogue.ts::composeFacetSet`), so Rails core
   (`where`/`order`/`limit`/…), kaminari, ransack and will_paginate all arrive
   through one registry and a new gem needs no edit here. No inline disjunction,
   per `.claude/rules/resolver-architecture.md` rule 2.
2. **Declared scope on the element class** —
   `declaredReturnType(element.name, member, ctx)` resolves to a `container`
   ref. `scope :active` writes
   `structuredReturnTypes["Post.active"] = container(instance Post)` via
   `associations.ts`'s `scope-relation` shape, so a project's own scopes are
   covered by the fact channel that already records them rather than by a name
   heuristic. This is how a scope name is known to be a scope: the model
   declared it, and the declaration says "relation".

**The verb PRESERVES the receiver, it never re-types it.** Source 2 is used as a
predicate only — the returned ref is `recv`, not the declared fact. This matters
because a scope declared inside a concern types its relation as the CONCERN:
`app/controllers/tax_preparation/api/v1/firm/irs/organizations_controller.rb:7`
threads `current_firm.irs_organizations.without_deleted` and the declared fact
says `container(SoftDeletable)`, not `container(IrsOrganization)`. Adopting the
fact would swap a correct element for a mixin name and poison every downstream
hop. Preserving `recv` keeps the model.

Everything else stays where it is:

- **Element extraction remains tail-only.** The element set is consulted FIRST
  and is unchanged, so `documents.where(x).first.title` threads
  `container(Document) → container(Document) → Document → String`. A relation
  verb never unwraps; only the ten element members do.
- **Union substrate untouched.** `rubyReceiverForm` collapses a nilable receiver
  before the chain walk, and `unionReturnType` folds arms through
  `returnTypeOf`, so a `container(Post)|nil` arm reaches the new branch exactly
  as a plain container does, and a union of two containers still needs both arms
  to agree. No new form, no new equality case in `rubyTypeRefEquals`.
- **Chain seeding untouched.** `resolveChain` keeps its declared-fact-then-
  `instanceReturning` head rule and its hop cap.

### Conservatism gates

- **Unknown member on a container** → `undefined`, exactly as today. No
  name-shape guess ("looks like a scope"), no "assume relation because the
  element is an AR model".
- **Element extraction precedence** — the ten-member set is asked first, so a
  verb in both places (`find`, `select`) keeps its element/enumerable meaning.
- **Declared fact must BE a container** — a scope whose declared return is an
  instance does not preserve; it falls through to the vocabulary check and then
  to silence.
- **Gem gating** — `catalogueForGemfile` already gates on the project's Gemfile,
  so a project without ransack never threads `.ransack`.
- **No re-typing** — the predicate never replaces the element (see the
  concern-scope case above).

## 3. What it measures out at

Harness run at `399f960b`, taxdome, 8 615 ruby files, 228 640 call sites.
Baseline `resolveSuccessRate` = `inProjectEdgeRecall` = **88.30 %**, recall hole
16 431. (Same 88.30 % as the pre-6goqa documented figure — the collection-name
split did not move it.)

### Where the dotted-chain misses actually die

2 865 of the 16 431 holes have a dotted-chain receiver. Replaying each one over
the ctx the resolver was handed, under production's own splitter:

| Verdict                                                | Sites     |
| ------------------------------------------------------ | --------- |
| seed untyped — the chain HEAD carries no type          | **2 542** |
| blocked on a NON-container hop (a fact hole)           | 223       |
| over the hop cap                                       | 73        |
| container + relation verb → terminal stays a container | 16        |
| container + a member the proposal must stay silent on  | 7         |
| chain already types today (the miss is downstream)     | 4         |

Under a balanced (paren-aware) splitter the container bucket grows to 30 and
seed-untyped to 2 600; production's `split(".")` mangles 282 of the 2 865
receivers and the two splitters disagree on 75 verdicts. A splitter fix is a
separate, additive gate — and worth 14 extra sites.

### The verbs

Blocking verb at the container hop (balanced split, 32 sites, 8 distinct):
`ransack` 12, `where` 6, `includes` 4, `order` 3, `visible_for_firm` 2,
`ordered` 2, `joins` 2, `without_deleted` 1. Threaded verbs add `result` 2,
`for_creator`, `captured`, `select`.

Typing-blind, the miss receivers MENTION relation verbs far more often —
`.ransack` 158, `.where` 102, `.order` 35, `.select` 25, `.joins` 21 — which is
the number the bead was reasoning from. The gap between 158 mentions and 12
reachable sites IS the finding: those chains are rooted in receivers nothing
types (`firm` 201, `@firm` 109, `object` 102, `resource` 99, `actor` 88, `self`
78, `@actor` 69, `@user` 62 …).

### Projected recovery

| Outcome                                                      | Sites |
| ------------------------------------------------------------ | ----- |
| exact new edges (a symbolId target)                          | **0** |
| file-only targets                                            | 0     |
| terminal stays a container — no edge, receiver becomes typed | 16    |
| terminal types but the member is absent — DROP, no change    | 0     |

Zero, and the reason is structural rather than incidental: in every surviving
chain the MISS MEMBER is itself a relation verb — `result`, `order`, `includes`,
`ids`, `succeeded` — called on the relation. There is no `.first`-style
extraction at the tail anywhere in this population, so the terminal is a
container and `RubyChainTypeSymbolResolutionStrategy` CONTINUEs on any
non-nominal ref. Nothing to resolve.

The 16 are not free. A container-typed receiver makes
`localBindingTypedReceiverIsExternal` answer TRUE, so each one moves from recall
hole to `externalSkipped`: recall rises with no edge behind it. For `.result` on
a ransack relation that reclassification is honest (it IS Ransack's method), but
buying +0.01 pp of recall with zero edges is not a reason to ship a resolver
change.

### The two adjacent mechanisms, also measured

**Element-class lookup on a container receiver** (make `chainType` dispatch the
member to the element class instead of CONTINUE-ing): 5 misses under the
production splitter, 7 under a balanced one — `clients`,
`with_notifications_enabled_for`, `credited`, `captured`,
`with_pending_payment`. Separable from this design and equally unfundable.

**The blind spot outside the hole.** A container-typed receiver is claimed by
the external classifier before it can become a miss, so scope calls on relations
never enter the recall hole at all. Of 36 494 `externalSkipped` calls with a
receiver, **511** already type to a container and only **6** call a member that
IS defined on the element class (`ordered` ×4, `secondary_default_sorting`,
`active`). The relation-verb rule would newly container-type **96** more, of
which **0** call an element member. The container axis is empty in both
directions.

**Regression risk: none.** 7 765 currently-RESOLVED dotted-chain calls have a
non-nominal receiver and reach `RubyDynamicDispatchResolver`'s speculative
short-name fan-out. Giving a chain a NOMINAL type makes that fan-out defer to
`chainType`, which can DROP — a resolved→DROP loss. Under this proposal **0**
chains become nominal (they all terminate as containers), so the loss channel
never opens. That is also why the change cannot pay: the same property that
makes it safe makes it worthless.

## 4. Risk analysis (had it shipped)

1. **Denominator inflation.** The primary risk, and the only one that
   materialises: 16 misses become `externalSkipped`, recall moves without edges.
   Any future version of this change must report edges and denominator
   separately.
2. **Wrong-container preservation.** `relationReturning` contains `merge`,
   `select`, `not`, `and`, `or`, `except`, `only`, `from`. On an ActiveRecord
   relation these are query verbs; on a plain `container(X)` that happens to be
   a Hash, `merge` returns a Hash and preserving `container(X)` would let a
   later `.first` claim an `X` where Ruby yields a `[k, v]` pair. Ungated, this
   is latent — measured at zero occurrences here, but an AR-model gate on the
   element (`ancestryReaches(element.name, modelBaseClasses)`) is the cheap
   containment if the rule is ever revived, at the cost of dropping plain-Array
   `select`/`reject` threading.
3. **Element degradation via concern scopes.** Covered by the
   preserve-not-retype rule above; without it, `without_deleted` alone would
   have swapped a real model for `SoftDeletable`.
4. **Exact-edge flips.** None available: `chainType` produces no target from a
   container terminal, so no currently-resolved call can change target.
   Confirmed empirically (0/7 765).

## 5. Rejected alternatives

- **Text-shape relation detection** (extend `receiverLooksLikeArRelationChain`'s
  `AR_RELATION_BUILDERS` list into the type engine). Rejected: it is a substring
  match with no element type behind it, it cannot tell a project `where` from
  AR's, and the engine's job is to produce a type, not a boolean.
- **Assume any unknown member on an AR-model container returns the relation.**
  Rejected outright — it is the "guess" the whole container branch exists to
  avoid, and it would type `documents.to_json` as `container(Document)`.
- **Adopt the declared scope fact's own type** instead of preserving the
  receiver's element. Rejected on evidence (the `SoftDeletable` case).
- **Fix the chain splitter as part of this bead.** Deferred: it is orthogonal
  (282 mangled receivers, 75 verdict disagreements), it changes `typeOfReceiver`
  for every chain rather than for containers, and on its own it moves the
  container recovery from 16 to 30 — still zero edges.
- **Element-class member lookup on a container receiver in `chainType`.** Sized
  at 5–7 misses; filed as the adjacent lead rather than folded in here.

## 6. What to fund instead

The 2 542 seed-untyped chain heads are the population. They are the same
receiver-typing hole the census already named — `firm`, `@firm`, `object`,
`resource`, `actor`, `self` — and they belong to the ivar/param typing family
(`27q0z`, `xn6ut`, `ooaz1`, `uuux9`), not to container semantics. Any work on
relation-verb threading should be re-measured only AFTER those heads carry
types, because until they do, the container branch is unreachable for 89 % of
the chains that would use it.

## 7. Reproducing

```bash
CODEGRAPH_CONTAINER_RELATION_ORACLE=1 \
CODEGRAPH_FORENSICS_OUT=<dir> \
npx tsx scripts/taxdome-codegraph-recall-forensics.ts
```

Additive and env-gated like every other oracle in that file: unset, the harness
behaves byte-identically and the A/B recall metrics are untouched. Report:
`<dir>/container-relation-oracle.json`; the run captured here is
`/Users/artk0re/.claude/jobs/24baee70/tmp/container-relation-oracle.txt`.
