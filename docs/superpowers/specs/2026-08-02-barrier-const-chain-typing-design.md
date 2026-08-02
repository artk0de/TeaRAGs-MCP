# Barrier-time `Const.<chain>` RHS typing — design and verdict

Design document for bd `tea-rags-mcp-ikyqu`, written after the oracle it
mandated. It designs the three mechanisms the bead names, and it also reports
that the measurement **falsifies the bead's premise**: the `current_firm` miss
class does not need any of them. The design is still worth having — the
mechanisms are real, they are cheap, and two of them will be needed eventually —
but the increment split at the end puts all three behind a fourth thing the same
oracle found, which is 35× larger and already paid for.

Corpus: taxdome, harness `scripts/taxdome-codegraph-recall-forensics.ts` at
`399f960b`, 8 615 ruby files, 228 640 call sites, 16 431 recall-hole misses,
`inProjectEdgeRecall` 88.30 %. Oracle: `CODEGRAPH_CONSTCHAIN_ORACLE=1`, added in
commit `b089b77e`. Raw run: `~/.claude/jobs/24baee70/tmp/constchain-oracle.txt`,
per-coordinate detail in `.../ikyqu/constchain-oracle-report.json`.

## The worked example, and what is actually wrong with it

The bead's example is `HostHelper.current_firm`:

```ruby
# lib/host_helper.rb, inside `class << self`
def current_firm(request_host)
  return Firm.without_deleted.find_by!(subdomain: subdomain(request_host)) if firm_subdomain?(request_host)
  Firm.without_deleted.find_by_custom_domain(request_host) if firm_custom_domain?(request_host)
rescue ActiveRecord::RecordNotFound
  nil
end

# lib/platform/concerns/auth_methods.rb
def current_firm
  @current_firm ||= HostHelper.current_firm(request.host)
end
```

Three things stop the walker from typing that:

1. the tail is a `Const.<chain>` whose middle hop (`without_deleted`) is a
   project scope — no vocabulary knows it, and the fact describing it lives in
   another file, so `constInstanceType` returns `null` at walk time;
2. `find_by_custom_domain` is not in `CONTAINER_ELEMENT_RETURNING_METHODS`, so
   even with the relation typed, `container(Firm).find_by_custom_domain` is
   silence;
3. `scope :without_deleted` is declared inside `SoftDeletable`, so the
   associations type-source keys it
   `SoftDeletable#without_deleted → container(SoftDeletable)` — an includer
   reaching it through its MRO gets a relation over the MODULE.

All three are real. The oracle confirms each one and shows the composition
produces the honest fact: with mechanisms 1+2+3 on,
`HostHelper#current_firm → Firm|nil` and, one wave later,
`Platform::Concerns::AuthMethods#current_firm → Firm|nil`.

**And it changes nothing**, because the receiver was already typed:

```
current_firm  .clients   before=Firm  after=Firm   [Bookkeeping::…::ApplicationController]
```

`scopedReceiverType` (bd `adx5p.9`, the devise `current_<scope>` convention)
already answers `Firm` for every one of those receivers. The derived fact
replaces a correct answer with the same correct answer. The 90 `current_firm`
misses in the hole are unresolved for a reason that has nothing to do with the
receiver's type.

## Measurement

### (a) `Const.<chain>` def tails — the barrier pass's working set

26 548 defs have an enclosing class/module scope; 24 481 have a readable tail;
**3 740** of those tails are rooted at a constant.

| chain shape         | tails | coordinate already has a fact | walk-time `constInstanceType` types it | memo `\|\|=` | nilable |
| ------------------- | ----: | ----------------------------: | -------------------------------------: | -----------: | ------: |
| `Const.m`           | 2 953 |                           442 |                                    403 |          135 |     288 |
| `Const.a.b`         |   461 |                             7 |                                      3 |           26 |      37 |
| `Const.a.b.c+`      |   316 |                             6 |                                      5 |           10 |      24 |
| `Const.a.find_by_*` |    10 |                             2 |                                      2 |            2 |       3 |

The bead's own shape (`Const.scope.find_by_*`) is **10 sites corpus-wide, 2
already covered**. The volume lives in the one-hop `Const.m` bucket.

### (b) single-record finder call sites

| member                  | sites |
| ----------------------- | ----: |
| `find_by`               |   755 |
| `find_by!`              |   137 |
| `find_by_<attr>`        |    39 |
| `find_or_initialize_by` |    34 |
| `take`                  |    20 |
| `find_or_create_by!`    |    17 |
| `first!`                |    16 |
| others                  |    10 |

Receiver type at those sites under today's engine:

| receiver form  | sites | note                            |
| -------------- | ----: | ------------------------------- |
| untyped        |   896 | mechanism 2 cannot reach these  |
| `container(E)` |   119 | the mechanism-2 addressable set |
| bare (self)    |     9 |                                 |
| `instance`     |     4 |                                 |

Of the 119 on a container, only **1** is a `find_by_<attr>` (it is the bead's
own `find_by_custom_domain`); 97 are `find_by`, 15 `find_by!`. The narrow
prefix-only rule the bead describes addresses one site. The wide rule (every
single-record finder) addresses 119.

### (c) concern-scope keying

| quantity                                              | value |
| ----------------------------------------------------- | ----: |
| `scope` declarations, total                           | 1 460 |
| …declared in a MODULE (a concern)                     |    37 |
| …declared in the model class itself                   | 1 423 |
| container facts whose element is a module             |    39 |
| container facts whose element is a class              | 3 399 |
| "scope over SELF, declared in a concern" coordinates  |    37 |
| includer coordinates a barrier projection would write |   248 |

Concern-declared scopes are **2.5 %** of all scopes. The largest are
`SoftDeletable` (3 coords × 31 includers), `GettingPaid::QuickbookSyncable` (10
× 9), `GettingPaid::PaymentMethods` (4 × 6).

### (d) projected recovery, per mechanism and composed

Projection method: for every recall-hole miss with a receiver and a locatable
chunk (12 575 of 16 431 — the remainder are bare calls with no receiver),
re-derive the receiver type under the mechanism's fact overlay and hop rule,
then apply the recall gate `icRecovery` already uses (the missed member must
have EXACTLY ONE definer on the derived type's ancestor closure). A type that
types nothing recoverable is not recall.

| variant                            | new facts | waves      | misses newly typed | RECOVERABLE | type CHANGED (precision risk) |
| ---------------------------------- | --------: | ---------- | -----------------: | ----------: | ----------------------------: |
| M1 alone (barrier chain typing)    |       689 | 674, 15, 0 |                  6 |           5 |                             0 |
| M2 alone (`container × find_by_*`) |         0 | —          |                  0 |           0 |                             0 |
| M2wide alone (every finder)        |         0 | —          |                  1 |           1 |                             0 |
| M3 alone (concern projection)      |       242 | —          |                  0 |           0 |                             0 |
| M1+M2                              |       691 | 675, 16, 0 |                  8 |           5 |                        **55** |
| M1+M2+M3                           |       933 | 675, 16, 0 |                  6 |           6 |                             0 |
| M1+M2wide+M3                       |       940 | 682, 16, 0 |                  8 |           8 |                             0 |

Three readings matter.

**The fixpoint is shallow and it terminates.** Wave 1 derives 674–682 facts,
wave 2 derives 15–16, wave 3 derives none. One barrier pass is not enough; three
are, with the second contributing 2 % of the total. A cap of 4 waves is safe
with room to spare.

**M2 without M3 is actively wrong.** M1+M2 moves 55 receivers from `Firm` to
`SoftDeletable` — the chain now threads through the concern-keyed relation and
lands on the module. Every one of those 55 loses its verdict ("member NOT on the
derived type's ancestor closure"). Adding M3 removes all 55 and turns the
composition net-positive. Mechanism 2 must never ship before mechanism 3.

**The ceiling is 8 misses.** Best composition recovers 8 of 16 431 — **+0.05
pp** of `inProjectEdgeRecall`, at the cost of 940 new run-global facts that
every downstream hop then trusts.

### The premise check — where the hole actually is

The same pass asks whether receiver typing is the blocker at all.

| population                                                           | misses |
| -------------------------------------------------------------------- | -----: |
| recall-hole misses with a receiver and a locatable chunk             | 12 575 |
| …receiver **ALREADY typed** by today's engine                        |    371 |
| …of those, a UNIQUE definer exists on the type's closure             |    284 |
| receiver untyped by `typeOfReceiver`, typed by `boundCallReturnType` |    295 |

Split by receiver SHAPE — which strategy is entitled to consume the type:

| receiver shape                                      |  misses |
| --------------------------------------------------- | ------: |
| **bare identifier — NO strategy consumes the type** | **363** |
| dotted chain (`chainType` owns it)                  |       4 |
| bound local (`localType` owns it)                   |       4 |

Of the 363, **282 have a unique definer on the closure** — they are resolvable
today, from a type the engine already computes, with no new fact of any kind.

The cause is one line in
`src/core/domains/language/ruby/resolver/strategies/ruby-chain-type.ts`:

```ts
const isDotChain = r.includes(".");
const rt = r.trimEnd();
const isIndexAccess = rt.endsWith("]") && rt.includes("[");
if (!isDotChain && !isIndexAccess) return CONTINUE;
```

Its docblock states the assumption: _"single-segment receivers (`user`,
`@client`) are already owned by the `localType` and `ivarField` passes"_. That
held when it was written. Two channels landed afterwards — `nullaryReceiverType`
(bd `pr7fu`: an unbound lowercase identifier in receiver position is a zero-arg
self-call) and `scopedReceiverType` (bd `adx5p.9`: the devise `current_<scope>`
convention) — and both type a BARE identifier that is neither a local binding
nor an ivar. `localType` needs a `localBindings` entry it does not have;
`ivarField` needs a `@`; `chainType` refuses it for lack of a dot. The type is
computed and then dropped, and the call falls through to the dynamic fan-out
over every same-name candidate in the corpus (43 of them for
`current_firm.clients`).

That is the real lead behind the bead's 82 misses, and it is 35× the whole ikyqu
mechanism set.

## Mechanism 1 — barrier-time `Const.<chain>` RHS typing

### Where it lives

The walker cannot do this: it has no run-global facts, by construction and by
the dependency-direction guard (`domains/language` may not reach
`domains/trajectory`). The resolver could, but re-deriving the same def's return
type at every call site that reads it is O(sites) work for an O(defs) answer.

The split follows `knownTargetCallArgs` / `classFieldParamLinks` (bd `bvalc`)
exactly: **the walker records the unresolved half, the barrier folds it.**

- **Walker** (`walker/type-sources/`, a new inline source or an extension of
  `body-last-expr.ts`) emits, per def whose return expression is rooted at a
  constant, a new `FileExtraction` field:

  ```ts
  /** A def whose return expression is a `Const`-rooted call chain, unresolved
   *  at walk time because the hops need run-global facts (bd ikyqu). */
  interface ConstChainReturnTail {
    /** `"<fqClass>#<method>"` — the `structuredReturnTypes` coordinate. */
    readonly coord: string;
    /** `[Const, m1, m2, …]` — head constant then one entry per hop. */
    readonly chain: readonly string[];
    /** `X if cond`, a `rescue` arm, or a `&.` hop — the value can be nil. */
    readonly nilable: boolean;
  }
  ```

  Plain arrays and strings so it round-trips the NDJSON spill, same discipline
  as every other extraction field.

- **Barrier** (`RunState.seal`) evaluates each chain through the REAL
  `returnTypeOf` and writes the result into `structuredReturnTypes`.

The chain is closed over CONSTANTS only — no local bindings, no ivars, no
per-file state. That is what makes the barrier a legal place to evaluate it: the
`CallContext` it needs is a minimal one carrying `structuredReturnTypes`,
`classAncestors`, `symbolTable`, `functionReturnTypes` and `gemfileContent`, all
of which the barrier already holds. The oracle proves this — it evaluates every
tail with exactly that context and the mirror agrees with production on 2 865
dotted receivers, 0 disagreements.

### Evaluation order and the fixpoint

Order inside `seal`, extending the sequence already there:

1. hierarchy view + reverse include-by index (existing);
2. schema-column definitions, VALUE types held back (existing, bd `8l5fo`);
3. self-dispatch discovery + `deriveServiceEntryReturnTypes` (existing, bd
   `j9xpf`);
4. **const-chain fold, iterated to fixpoint** (new);
5. schema-column VALUE types merged last, only where the coordinate is empty
   (existing, bd `2a5oo`);
6. `foldKnownTargetParamTypes` / `deriveClassFieldTypesFromParams` (existing, bd
   `bvalc`).

Step 4 sits after 3 because a service-entry derivation is a DECLARED fact from
the chain's point of view and must be visible to it; before 5 because a schema
column is the fallback of last resort and must not out-rank a derived chain.

Iteration is required, not optional: one def's tail can name another def whose
fact the same pass derives. Measured on taxdome: **wave 1 = 674, wave 2 = 15,
wave 3 = 0**. Bound it at 4 waves — beyond that a run reports non-convergence
and keeps what it has, exactly as `FIXPOINT_MAX_WAVES` does in the a2hrq oracle.
The worklist is over 3 740 tails; a wave is 3 740 chain walks of ≤ 4 hops each,
and the whole fold costs well under a second against a 167-second run.

A cheaper alternative exists and is NOT recommended: order the tails
topologically by head constant and evaluate once. It fails on cycles (`A#m`
reads `B.n`, `B#n` reads `A.m`), and the wave count is small enough that the
extra machinery buys nothing.

### Conservatism gates

Each of these already exists somewhere in the engine; the fold reuses them
rather than inventing a second policy.

- **Declared wins.** A coordinate already carrying a fact is skipped, never
  overwritten. Same rule `deriveServiceEntryReturnTypes` follows. On taxdome 442
  of 2 953 `Const.m` tails are already covered.
- **Stop at the unknown hop.** `resolveChain`'s invariant: the first `undefined`
  hop ends the chain and the fold emits nothing. Never fabricate past silence.
- **Hop cap.** `CHAIN_MAX_HOPS_DEFAULT` (4), the same cap receiver chains obey.
- **Nilable is stated, not erased.** An `if`/`unless` modifier tail, a body with
  a `rescue` arm, or a `&.` hop wraps the result through
  `rubyUnionOf([T, nil])`. The 27q0z substrate makes this expressible;
  `rubyReceiverForm` collapses it back to `T` at receiver position, so the
  honesty costs no edges. 288 of 2 953 `Const.m` tails are nilable — 10 %, not a
  corner case.
- **Existence oracle.** A derived type naming a class the run declares nowhere
  is an annotation fiction and is dropped, the same predicate `seal` already
  builds for `deriveServiceEntryReturnTypes`.
- **Memo ivars are a SEPARATE channel.** A `@x ||= <chain>` tail can also type
  `@x` in `ivarTypes`. Measured: 9 such facts. Ship it, if at all, as its own
  increment — an ivar fact is read by a different lookup with a different
  failure mode.

### Cost model and risk

Cost: one extra DFS field per file at walk time (the tails are found by the
traversal `body-last-expr` already performs), 3 740 records over the corpus, ≤ 4
× 3 740 chain walks at the barrier. Negligible against the existing barrier
work.

Risk is asymmetric and this is the reason for the verdict below. A wrong return
fact is run-global and poisons every downstream hop that reads it, and the fold
writes **689 of them** to buy **5 misses**. The oracle cannot price the false
edges a wrong fact creates — it measures the recall side only. At that ratio the
downside is not bounded by the upside.

## Mechanism 2 — container × dynamic finder

### Where it lives

One branch, in `returnTypeOf`:

```ts
if (recv.form === "container") {
  return CONTAINER_ELEMENT_RETURNING_METHODS.has(member)
    ? recv.element
    : undefined;
}
```

This is the same three lines bd `vfo3e` is rewriting. Do not add a second
`if`-branch beside it — that is the inline-disjunction anti-pattern
`.claude/rules/resolver-architecture.md` §2 forbids. The branch becomes a fold
over a typed policy list:

| policy               | matches                                       | yields         | owner   |
| -------------------- | --------------------------------------------- | -------------- | ------- |
| element-returning    | `CONTAINER_ELEMENT_RETURNING_METHODS`         | `E`            | today   |
| relation-preserving  | `catalogue.relationReturning`                 | `container(E)` | `vfo3e` |
| single-record finder | `find_by_<attr>` (+ named finders, see below) | `E \| nil`     | ikyqu   |
| bang finder          | any of the above ending in `!`                | `E`            | ikyqu   |

The sets must be disjoint and the disjointness must be a test, not a convention:
`find` and `detect` are in BOTH `CONTAINER_ELEMENT_RETURNING_METHODS` and the
Rails `instanceReturning` vocabulary, and `first`/`last`/`take` sit across the
element and finder families. Precedence is element → relation → finder, which
preserves today's answers byte-for-byte.

Since `vfo3e` owns that branch and lands first, mechanism 2 is **one row in its
policy list**, not a change of its own. Designing it as a separate edit would
guarantee a conflict on the same three lines.

### Conservatism

`find_by_<attr>` returns the record or `nil`; `find_by_<attr>!` raises. The
nilable form is therefore correct for the plain shape and wrong for the bang
shape, and `rubyReceiverForm` collapses `E|nil` to `E` at receiver position, so
stating it honestly is free. No agreement fold is needed — a container has one
element type by construction.

The one place it can be wrong is when the ELEMENT is wrong, which is exactly
what mechanism 3 fixes and what the 55-miss regression in M1+M2 demonstrates.

### Interaction with the external classifier

`RubyExternalVocabulary` classifies any `container`-form receiver as external
(`ruby-external-vocabulary.ts:185`), on the stated grounds that a typed element
would have been handled by the chain strategy first. Mechanism 2 changes which
chains reach that classifier: a finder tail that used to die at the container
hop now produces an `instance`, so the call moves out of `callsExternalSkipped`
and into the recall denominator. That is a denominator movement, not a
regression, but any A/B must watch `callsExternalSkipped` alongside
`callsResolved` or the rate will look worse than the graph is.

### Scope: narrow or wide

Narrow (`find_by_<attr>` prefix only) addresses 1 container site corpus-wide.
Wide (every single-record finder: `find_by`, `find_by!`, `find_sole_by`, `sole`,
`take`, `first!`, `last!`, `find_or_*`, `create_or_find_by`) addresses 119, and
measured +2 recoverable misses over the narrow rule in the full composition. If
the row is written at all, write it wide — the narrow version is the same code
for 1 % of the reach.

## Mechanism 3 — concern-scope element typing

### Where it lives — two candidates

**(a) Barrier projection.** At `seal`, for every fact keyed
`M#scope → container(M)` where `M` is a MODULE, write
`<includer>.scope → container(<includer>)` for each transitive includer. Pure
fact addition; the engine evaluates it unchanged. 37 source coordinates → 248
written coordinates on taxdome.

**(b) Resolve-time rebinding.** In `returnTypeOf`, when the fact came from the
MRO and its container element names the OWNING module rather than the receiver,
substitute the receiver's own class.

Prefer **(a)**, for three reasons. It is a fact, so it is inspectable in the
same map as everything else and the existing "declared wins" precedence applies
to it for free. It costs nothing per call. And it composes with mechanism 1
without a second code path, because mechanism 1's fold reads the same map.

(b) has one genuine advantage — it needs no enumeration of includers, so it also
covers a class that includes the concern at runtime and never appears in
`includedBy`. On taxdome that population is not measured and the static one is
248 coordinates, so the advantage is theoretical today. Revisit if the
include-graph work under `95a9l` ever makes runtime inclusion visible.

### Coordinate form — a correctness detail, not a nit

The associations type-source keys every macro return fact with `#`
(`returnCoordKey` → `<scope>#<method>`), so `SoftDeletable#without_deleted`
currently answers for an INSTANCE receiver too. `firm.without_deleted` is not a
thing — `scope` defines a class method. The projection should write the **`.`
form** (`Firm.without_deleted`), which `declaredReturnTypeOn` consults FIRST for
a class receiver and never for an instance one (bd `8ypeu`). That makes the
projected fact strictly more precise than the fact it projects from, and it is
the same coordinate discipline `@!method self.x` already uses.

Whether the SOURCE fact should also move to the `.` form is a separate question
with its own blast radius (1 460 scope declarations, 3 399 container facts) —
out of scope here, worth its own bead.

### Conservatism

- Project only a fact of the shape "container over the DECLARING module itself"
  — that is the `scope-relation` shape and nothing else. An association declared
  in a concern (`belongs_to :firm` inside `Crm::CustomFieldsStorage`) already
  names the right model and must not be touched.
- Never overwrite an existing coordinate. An includer that declares its own
  `scope :without_deleted` keeps it.
- Transitive includers, cycle-guarded: a concern included by another concern is
  the shape this mechanism exists for.

### Cost

37 source coordinates, one pass over `structuredReturnTypes` at the barrier, 248
writes. Free.

## Interplay with bd `vfo3e` (container-relation threading)

`vfo3e` is designing container preservation for relation verbs
(`container(X).where/.page/.ransack → container(X)`) at
`docs/superpowers/specs/2026-08-02-container-relation-threading-design.md`. It
owns the same three lines of `returnTypeOf` that mechanism 2 touches, and it has
the volume: 249 `ransack` sites and all pagination are identifier-rooted,
against 119 container-receiver finder sites here.

Compose, do not duplicate:

- **`vfo3e` lands first** and introduces the container-member policy fold.
  Mechanism 2 is one row added to that fold, with a disjointness test.
- **Mechanism 3 lands with or before mechanism 2**, never after. `vfo3e`'s own
  work makes this more urgent, not less: preserving `container(SoftDeletable)`
  through a longer relation chain propagates the wrong element further before
  anything notices. The 55-miss regression measured here is the small version of
  that failure.
- **Mechanism 1 is independent of both** — it touches `RunState.seal` and a
  walker type-source, no shared line.

## Risks

| risk                                                                    | mitigation                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A wrong barrier-derived fact is run-global and poisons downstream hops. | Declared-wins, stop-at-unknown-hop, existence oracle, nilable stated. Still the dominant risk at 689 facts for 5 misses. |
| M2 before M3 mis-types 55 receivers to the concern module.              | Ship M3 first. Non-negotiable; the number is measured, not hypothetical.                                                 |
| M2 moves calls out of `callsExternalSkipped` into the denominator.      | A/B must report both buckets, not the rate alone.                                                                        |
| The fold does not converge on another corpus.                           | Wave cap of 4, non-convergence reported, keeps what it has.                                                              |
| Mechanism 3's `.`-form projection diverges from the `#`-form source.    | Projection writes `.` only; the source fact is untouched and still answers the MRO lookup.                               |

## Rejected alternatives

**Type the chain at walk time by pre-loading scope facts.** Would need the
walker to see other files' facts, which the dependency-direction guard forbids
and the NDJSON spill would not survive. The barrier exists for exactly this.

**Resolve-time chain evaluation per call site.** Re-derives one def's return
type once per reader. O(sites) for an O(defs) answer, and it cannot memoize
without becoming the barrier fold with extra steps.

**Topological single pass instead of a worklist.** Breaks on mutual reference
between two defs' tails; the measured wave count (3) makes the saving
irrelevant.

**Add `find_by_*` to `CONTAINER_ELEMENT_RETURNING_METHODS`.** Wrong set: that
set means "returns an element", and a finder returns an element OR nil. Merging
them loses the nil arm that 27q0z was built to carry, and the set is also read
by `containerElementLift` at walk time where the nil arm matters for a local
binding.

**Fold the concern rebinding into `returnTypeOf` as a special case.** Puts a
hierarchy question inside a member-lookup function, which is the wrong owner,
and costs the check on every container hop instead of 37 times at the barrier.

## Recommended increment split

Ordered by measured yield per unit of risk. The first item is not from this
bead.

| #   | increment                                                           | expected yield (taxdome)     | risk     | blocks on  |
| --- | ------------------------------------------------------------------- | ---------------------------- | -------- | ---------- |
| 0   | **`chainType` consumes single-segment typed receivers** (new bead)  | **282 misses, ~+1.7 pp**     | low      | —          |
| 1   | Mechanism 3 — concern-scope projection, `.` form                    | 0 alone; unblocks 2          | trivial  | —          |
| 2   | Mechanism 2 — finder row in `vfo3e`'s container-member policy, WIDE | +2–3 with 1 and 4            | low      | `vfo3e`, 1 |
| 3   | Mechanism 1 memo-ivar channel                                       | ≤ 9 facts, unmeasured recall | medium   | 4          |
| 4   | Mechanism 1 — barrier chain fold                                    | 5–6 misses, +0.04 pp         | **high** | —          |

**Increment 0 is the finding.** 363 recall-hole misses carry a receiver the
engine has ALREADY typed and no strategy reads; 282 of them have a unique
definer on that type's closure. The change is to `ruby-chain-type.ts`'s entry
guard: admit a single-segment receiver when `typeOfReceiver` answers and neither
`localType` nor `ivarField` claimed it. It needs care around the `DROP`
semantics — a known type whose class is not in the symbol table drops rather
than falling through, and widening the guard widens what can drop — so it is a
bead with its own oracle pass, not a one-liner. File it under `95a9l` beside
this one.

**Increments 1 and 2 are worth doing** because they are nearly free, because
`vfo3e` is opening that code anyway, and because mechanism 3 is a latent
correctness bug that `vfo3e` will make worse. Do them in that order, together,
inside `vfo3e`'s change.

**Increment 4 — mechanism 1 — is DO-NOT-BUILD at current evidence.** 689
run-global facts for 5 recovered misses (+0.04 pp) is the wrong side of the risk
ledger for a fact channel every downstream hop trusts. It is not wrong, and it
is not expensive to run; it simply buys almost nothing on this corpus, and the
false-edge cost it might carry is unmeasured. Revisit only if increment 0 lands
and the residual hole shifts toward untyped receivers, or if a corpus with
heavier `Const.m` delegation (the shape is 2 953 tails here, 2 511 of them
uncovered) shows a materially different ratio.
