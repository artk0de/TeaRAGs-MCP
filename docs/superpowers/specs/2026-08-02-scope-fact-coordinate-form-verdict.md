# `scope` return facts: `#` form vs `.` form — measurement and verdict

bd `tea-rags-mcp-yjh0l`. Corpus: taxdome, harness
`scripts/taxdome-codegraph-recall-forensics.ts` at `448475f9`, oracle
`CODEGRAPH_SCOPEKEY_ORACLE=1`.

**Verdict: measured and deferred.** Neither candidate is worth landing today.
Moving the fact to the `.` form buys **+0.0008 pp** of `inProjectEdgeRecall`,
costs one new recall-hole miss and 608 service-entry derivations, and breaks the
one reader that has no `.` fallback. Writing BOTH forms moves **exactly zero**
calls — 934 re-resolutions, every transition an identity — for 1 457 extra
run-global coordinates.

## The question

`scope :without_deleted, -> { … }` defines a CLASS method. The associations type
source (`walker/type-sources/associations.ts`) emits its return fact through the
same `RubyTypeFact` path every other macro uses, and
`RubyTypeFactStore.structuredReturnTypesMap()` joins a coordinate with `#`
unless the fact declares itself class-level (`classForm`, set today only by a
YARD `@!method self.x` directive). So the corpus carries
`Firm#without_deleted → container(Firm)`, a coordinate `declaredReturnTypeOn`
also answers for an INSTANCE receiver.

The M3 section of
`docs/superpowers/specs/2026-08-02-barrier-const-chain-typing-design.md` calls
the `.` form "strictly more precise" — it is consulted FIRST for a class
receiver and NEVER for an instance one (bd `8ypeu`) — and defers the source-side
switch to this bead because of its blast radius.

## Consumer map

Two code sites index `ctx.structuredReturnTypes` — `declaredReturnTypeOn` in
`resolver/type-propagation.ts` and `deriveServiceEntryReturnTypes` in the
barrier fold. Nothing else touches the map. The rows below are the entry points
that reach `declaredReturnTypeOn`, each with the `classReceiver` flag it passes.

| reader                                                              | coordinate form it asks for              | live reads (taxdome) |
| ------------------------------------------------------------------- | ---------------------------------------- | -------------------: |
| `declaredReturnType` → `resolveChain` (chain-root seed)             | `.` then `#`                             |                1 159 |
| `inheritedReturnType` → `declaredReturnType` (MRO walk of the seed) | `.` then `#`                             |                  587 |
| `returnTypeOf` → `boundCallTypeRef` (scope-qualified binding)       | `.` then `#` (class receiver)            |                   32 |
| `inheritedReturnType` → `returnTypeOf`                              | `.` then `#` (class receiver)            |                   16 |
| **`selfMemberReturnType` → `nullaryReceiverType`**                  | **`#` ONLY**                             |              **433** |
| **`selfMemberReturnType` → `boundCallTypeRef`**                     | **`#` ONLY**                             |               **13** |
| `deriveServiceEntryReturnTypes` (barrier fold, `run-state.ts` seal) | `#` for the template lookup; writes both |      608 derivations |

`selfMemberReturnType` passes `classReceiver = false` by construction: a bare
call binds `self`, and the function cannot tell from the member name whether
`self` is the class object or an instance. That is the whole cost of the switch
— 446 reads, and every non-identity transition in the A/B below came from a call
that made one. No class-receiver read moved anything, in either variant.

Split those 446 by the CALLER's own coordinate form, which does say whether
`self` is the class object:

| caller                         |   reads | what the `#` hit means             |
| ------------------------------ | ------: | ---------------------------------- |
| `Klass.m` — a class method     | **439** | correct; `scope` is callable there |
| `Klass#m` — an instance method |   **7** | wrong; Ruby raises on that call    |

**The imprecision the switch was proposed to remove is barely exercised.** Every
non-`selfMember` read arrives as a `.`-miss immediately followed by a `#`-hit —
the signature of `classReceiver = true`. Distinct scope coordinates hit through
the `#` form: 219. Distinct scope coordinates hit through the `.` form: **0**.
There is not one instance-RECEIVER read of a scope fact in 228 575 call sites:
`firm.without_deleted` is indeed not a thing, and nobody writes it. The only
reads where the coordinate answers a call Ruby would reject are the 7 bare calls
from an instance-method caller above.

## Write side

| quantity                                         | value |
| ------------------------------------------------ | ----: |
| `scope` declarations parsed                      | 1 458 |
| distinct `(owner, member)` coordinates           | 1 457 |
| owners declaring a scope — class                 |   196 |
| owners declaring a scope — module (concern)      |    13 |
| LIVE `#`-keyed scope facts in the sealed run map | 1 457 |
| `.` twin already claimed by a declared fact      | **0** |

(The ikyqu design counted 1 460 declarations with its own pass; the two counts
differ by 2 and the conclusions do not turn on it.)

Sealed through the production barrier order — walker facts, then
`deriveServiceEntryReturnTypes`, then the 2a5oo schema-column backfill:

| variant           | map keys | j9xpf derivations | schema backfill |
| ----------------- | -------: | ----------------: | --------------: |
| base (production) |   12 413 |             3 161 |           3 576 |
| `.` only          |   11 805 |         **2 553** |           3 576 |
| both forms        |   13 870 |             3 161 |           3 576 |

Two things fall out. The schema backfill is identical in all three, so vacating
a `#` coordinate never lets a column value type in — that risk is zero. And the
`.`-only variant loses **608 service-entry derivations**, because
`deriveServiceEntryReturnTypes` looks its template return up at
`<type>#<member>` and a scope fact sitting there stops answering.

## A/B re-resolution

934 calls read a coordinate on which the three sealed maps disagree; each was
re-resolved three times through the real `resolver.resolve` + `resolveDispatch`
with only `ctx.structuredReturnTypes` swapped. The base re-resolution agreed
with `resolvePass2`'s own verdict on all 934 (`mirrorDisagreed=0`).

| transition                          | `.` only | both forms |
| ----------------------------------- | -------: | ---------: |
| `resolved → resolved`               |      385 |        385 |
| `externalSkipped → externalSkipped` |      309 |        391 |
| `noInProjectDef → noInProjectDef`   |      141 |        141 |
| `coreAmbiguous → coreAmbiguous`     |        8 |         11 |
| `miss → miss`                       |        6 |          6 |
| `externalSkipped → noInProjectDef`  |       79 |          — |
| `coreAmbiguous → resolved`          |    **3** |          — |
| `externalSkipped → coreAmbiguous`   |        2 |          — |
| `externalSkipped → miss`            |    **1** |          — |

`gained=3, lost=0, targetChanged=7` for `.` only;
`gained=0, lost=0, targetChanged=0` for both forms. All 85 non-identity
transitions belong to calls whose reads included a `selfMemberReturnType` frame
— the `#`-only reader is not merely the risk, it is the entire mechanism of
every observed change.

Recall arithmetic for the `.`-only variant: `callsResolved` 124 622 → 124 625,
the recall hole 16 004 → 16 005, so `inProjectEdgeRecall` 88.6197 % → 88.6205 %,
**+0.0008 pp**. The 79 `externalSkipped → noInProjectDef` moves are
recall-neutral (both buckets sit outside the denominator) but are a real
classification change: losing the receiver type stops the external classifier
from recognising 79 gem calls as external.

All 7 target changes have the same shape — the baseline resolved through the
DISPATCH fan-out and the variant resolves through the exact chain instead (5
file-only edges, 2 method-level). Fewer, more precise edges, but they are a side
effect of losing a receiver type, not of fixing a coordinate.

## Why deferred

- **`.` only is not zero-loss.** It removes 446 reads from the one reader with
  no `.` fallback — 439 of them correct — drops 608 derivations from a channel
  every downstream hop trusts, adds a recall-hole miss, and returns +0.0008 pp.
  The precision it buys is 7 reads: bare scope calls from an instance-method
  caller, which Ruby would reject.
- **Both forms is free of risk and free of value.** Every one of the 934 calls
  lands in an identity cell. It buys nothing because `declaredReturnTypeOn`
  already falls back to `#` for a class receiver, so the `.` twin is never the
  answer that changes anything. 1 457 extra coordinates through the NDJSON spill
  and the run-global merge for a measured zero.

## What would change the verdict

`selfMemberReturnType` is `#`-only because it cannot infer whether `self` is the
class object — but `ctx.callerSymbolId` already carries that: a caller keyed
`Klass.m` IS a class method, and `scope` is legal there. Teaching that reader to
try the `.` coordinate when the CALLER is class-level recovers **439 of the
446** reads and leaves the other 7 correctly unanswered, which turns the switch
from "loses 446 reads to fix 7" into "fixes 7 and keeps the rest". It should
also recover the 79 `externalSkipped → noInProjectDef` reclassifications, since
those are the same reader going quiet — but that is a prediction, and the A/B
has to be re-run rather than assumed.

One thing does not follow from it. `deriveServiceEntryReturnTypes` looks its
template return up at `<type>#<member>` only, so under the `.` form it loses 608
derivations no matter what the resolver does. It needs the same two-coordinate
lookup `declaredReturnTypeOn` already performs.

Both are changes to shared resolver surfaces, not to the associations type
source, so they belong in their own bead alongside the `vfo3e`
container-relation work that owns those lines.

Until then the M3 projection stands unchanged: the barrier projection writes the
`.` form for CONCERN-declared scopes (a fact that does not exist today, so it
takes nothing away), while the source fact stays on `#` and keeps answering the
MRO lookup.

## Reproducing

```bash
CODEGRAPH_SCOPEKEY_ORACLE=1 npx tsx scripts/taxdome-codegraph-recall-forensics.ts
```

Additive and env-gated: with the flag unset no map is wrapped, no variant is
sealed, nothing extra is resolved. Verified byte-identical A/B metrics —
`inProjectEdgeRecall 88.62 %` with the flag on and off.

Stated divergence: the variants are built over the sealed RUN-GLOBAL map, while
production keys facts per file before merging. Under the `.`-only variant a
vacated `Owner#member` could, in production, be filled by that file's own
body-inference fact — which requires a class to carry both `scope :x` and
`def x`. That can only ADD facts, so the measured `.`-only numbers are an upper
bound on its losses.
