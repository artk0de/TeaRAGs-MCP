# Deferred symbol resolution — a fourth `SymbolResolutionOutcome` state

**Bead:** tea-rags-mcp-5onmn **Investigation:** tea-rags-mcp-pmxuv (measurement
tables) **Date:** 2026-08-10

## Problem

Three TypeScript passes end with the same line:

```ts
return resolved({ targetRelPath: targetFile, targetSymbolId: null });
```

`namedImport` (pass 5), `importBasename` (pass 6) and `receiverSymbol` (pass 7)
each locate the target FILE, fail to pin the member inside it, and commit to a
file-only edge anyway. Committing stops the chain, so the four `typeChecker`
passes at positions 11–14 — which can often pin that exact member — never run.

The obvious fix does not work. `pmxuv` flipped pass 5's last line to `CONTINUE`
and measured it against `ts.TypeChecker` over tea-rags' own `src` (893 files,
14688 call sites):

| Oracle verdict (`constant` receivers) | Baseline | CONTINUE | Delta |
| ------------------------------------- | -------- | -------- | ----- |
| match                                 | 20       | 26       | +6    |
| wrongFile                             | 6        | 0        | −6    |
| phantom                               | 95       | 77       | −18   |

Strictly better — on the sites the checker answered. But the checker has no
opinion on 2307 sites (`checkerUnknown` 889 + `nodeNotLocated` 1418), and there
the file-only edge is the only signal that exists. Total edges over the same
corpus:

| Metric     | Baseline | CONTINUE | Delta |
| ---------- | -------- | -------- | ----- |
| edges      | 7669     | 7513     | −156  |
| fileOnly   | 737      | 559      | −178  |
| unresolved | 7018     | 7173     | +155  |

CONTINUE loses 156 edges, 2.0% of all TypeScript edges. 178 file-only module
edges drop and only 22 come back pinned from a later pass. 18 of the remainder
were provably-external phantoms, good to lose; the other ~138 are calls where
the caller literally imports the receiver from that module. The import statement
is the evidence, and nothing downstream replaces it. `fanIn` / `fanOut` /
PageRank are file-granularity, so that is a direct graph regression.

Both states are wrong for these passes. `resolved` commits too early and costs
precision; `continue` abandons an answer nothing else can produce.

## What the passes actually need

A third thing: **offer a weak answer, let the chain keep looking, use the offer
only if nothing better turns up.** The pass owns a real fact — this call's
receiver is imported from this module — but that fact is module-level, and a
later pass may know the symbol.

## Approaches considered

### A — a fourth outcome state (chosen)

Add `deferred` to `SymbolResolutionOutcome`. `resolveViaChain` parks the first
deferred target, keeps iterating, and emits the park when the chain produces
nothing stronger.

### B — no contract change: split each pass, move the weak half to the chain tail

The chain is first-decisive-wins, so a strategy placed last fires only on
exhaustion — behaviourally the same as parking, without touching the contract.

Rejected on a functional ground, not an aesthetic one: **it cannot express what
Ruby needs.** Ruby's `receiverSetDrop` sits at position 13 and drops every
remaining call with a receiver. A tail strategy at position 17 never runs,
because the chain already returned `null` four passes earlier. B also duplicates
the import→file mapping between the head pass and its tail twin, and generalises
to nothing — every future weak-answer pass needs its own bespoke split.

### C — reorder: move the `typeChecker` passes ahead of 5/6/7

Rejected. The `typeChecker` passes build a `ts.Program`; running them before the
cheap syntactic passes on every call site is a large performance regression, and
reordering changes precedence for every receiver kind rather than for the
file-only case alone. No measurement supports it.

## Design

### Contract

`contracts/types/language.ts`:

```ts
export type SymbolResolutionOutcome =
  | { kind: "resolved"; target: SymbolResolutionTarget }
  | { kind: "deferred"; target: SymbolResolutionTarget }
  | { kind: "drop" }
  | { kind: "continue" };
```

`contracts/resolution.ts` gains the matching constructor:

```ts
export function deferred(
  target: SymbolResolutionTarget,
): SymbolResolutionOutcome {
  return { kind: "deferred", target };
}
```

The union member is additive. Roughly 40 strategy files across five languages
import `SymbolResolutionOutcome`, but every one of them only CONSTRUCTS
outcomes; `resolveViaChain` is the sole reader of `kind`. Nothing else has an
exhaustive switch to break.

### Engine

`domains/language/resolver-chain.ts`:

```ts
let parked: SymbolResolutionTarget | null = null;
for (const strategy of strategies) {
  const outcome = strategy.attempt(call, ctx);
  if (outcome.kind === "resolved") return outcome.target;
  if (outcome.kind === "drop") return parked;
  if (outcome.kind === "deferred") parked ??= outcome.target;
}
return parked;
```

Four invariants:

1. **`resolved` beats a park from any position.** A pinned symbol always
   outranks a module-level guess.
2. **The first park wins.** Chain order is precedence, unchanged from today.
3. **`drop` stops the chain and emits the park.** See below.
4. **Exhaustion emits the park.** These are the 178 file-only edges the
   measurement showed nothing else can produce.

### Invariant 3, in full

`drop` means "no LATER pass may answer this call". It is not a retroactive veto
over an EARLIER pass's offer.

This follows from the engine's founding invariant, stated in its own docblock:
_the order IS the resolution precedence — a strategy earlier in the array wins
over a later one._ A pass that parks waives precedence in favour of a better
positive answer, not in favour of a later guard's "I don't know".

The alternative — `drop` clearing the park — inverts that precedence and loses
edges. Ruby shows it concretely. `constant` sits at position 8,
`receiverSetDrop` at 13:

```
today:            constant(8) resolved(file-only) → edge; pass 13 never runs
park, drop emits: constant(8) parks → 9..12 may pin → 13 drops → same edge
park, drop clears: constant(8) parks → 9..12 miss → 13 drops → edge lost
```

Under invariant 3 as chosen, the change is **edge-preserving by construction**:
no edge that exists today can disappear, and the only possible movement is
file-only → pinned. Under the alternative, Ruby would shed parked edges
wholesale at position 13 — the same regression class as the −156 measured in
TypeScript.

The `4rgg` case that motivated `drop` is untouched: `super` is pass 1, so
nothing can be parked before it, and a `super` without `classExtends` still
returns `null`.

A guard that positively knows no edge should exist — an external-call guard, say
— would need to veto a park rather than merely drop. No such guard exists today:
TypeScript's external checks return `CONTINUE`, not `DROP`. Adding a fifth state
for a consumer that does not exist is YAGNI; when one appears, either move it
ahead of the parking pass or add the state then.

### Call sites

Change to `deferred(...)`:

| Language   | File                                                   | Line |
| ---------- | ------------------------------------------------------ | ---- |
| TypeScript | `typescript/resolver/strategies/ts-named-import.ts`    | 43   |
| TypeScript | `typescript/resolver/strategies/ts-import-basename.ts` | 30   |
| TypeScript | `typescript/resolver/strategies/ts-receiver-symbol.ts` | 39   |
| Ruby       | `ruby/resolver/strategies/ruby-constant.ts`            | 43   |
| Ruby       | `ruby/resolver/strategies/ruby-explicit-require.ts`    | 50   |

Deliberately NOT changed: the intra-strategy `fileOnlyFallback` locals in
`ts-super.ts`, `javascript-resolver.ts` and
`ruby/resolver/strategies/shared.ts`. Those are a pass choosing a file-only edge
over nothing WITHIN its own answer, not preempting later passes — `super`
resolution is definitive for `super` calls, and no later pass knows better.

Out of scope, filed separately: Python (`python-import-match.ts:32`,
`python-local-binding.ts:90`) and Java (`java-import-receiver.ts:88`) carry the
same shape and want the same treatment, each with its own corpus measurement.
(Measured under bd `86qfb` and REJECTED for all three — see "Measured outcome
(Python and Java)" below. `python-local-binding.ts:90` turned out not to be the
preempting shape at all.)

JavaScript carries the defect too, at `javascript-resolver.ts:78`, but cannot be
fixed the same way: that resolver is still a monolithic if-ladder with no
`resolveViaChain`, so its file-only edge preempts the global short-name fallback
below it through control flow rather than through a chain outcome. Making it
deferrable means migrating the JS resolver to the strategy chain first — a
larger job than the one-line change every other language needs.

### The import file-edge path has to stop asking the call chain

Deferral exposed a defect the old terminal commit had been masking, and the
coverage gate caught it: `provider.test.ts` "re-extracting same file via sink
keeps edge counts stable" went red, with `main.ts`'s file edge pointing at
`src/foo.ts` after the file had been rewritten to import `./bar`.

`defaultImportFileEdges` (`resolution-runner.ts`) asks the CALL chain a MODULE
question. Per import it synthesises `{ receiver: basename, member: basename }`
and keeps whatever comes back. That `member` is a filename, so any member-keyed
pass that answers it points the import's edge at whichever file declares a
symbol with the same short name — `import './bar'` landing on `Other.bar`.
Before deferral, `importBasename` committed the module edge and the chain
stopped before `globalShortName` could speak. Confirmed by experiment: making
the short name ambiguous across two files makes `globalShortName` decline under
strict mode, and the correct module edge comes back.

The fix does not restore the accident. `TSCallResolver` now implements
`resolveFileEdges`, mapping each import through `mapImportToFile` — the same
function `namedImport` and `importBasename` already consult, and the actual
definition of "which file does this specifier name". The `TypescriptLanguage`
adapter forwards it, mirroring Ruby's. Relative specifiers always resolve (the
mapper falls back to the first candidate extension when the probe finds no file
on disk), so no legitimate edge is lost; a bare package specifier matching no
`paths` pattern now yields no edge at all, which is right — it has no in-project
file, and the only edge the old loop could produce for it came from a
member-name coincidence.

Ruby has its own `resolveFileEdges`, but it synthesises the same shape, so its
exposure is structural rather than absent: `conventionReceiver` would have to
pin a method named after the module itself. Rare enough that nothing in the
suite or the corpus run trips it — recorded here rather than pre-emptively
changed.

### Ruby terminal-guard audit

The bead asked whether Ruby's other terminal guards carry the same latent
early-commit defect while the contract is open. They do not, and the reasons are
worth recording because they are what makes invariant 3 safe here.

| Pass                                     | Position | Interaction with a park                                                                          |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `super`                                  | 1        | Drops before anything can park. Unchanged.                                                       |
| `selfMember` / `localType` / `ivarField` | 2–4      | Same — every drop happens with an empty park.                                                    |
| `constant`                               | 8        | **Parks.**                                                                                       |
| `explicitRequire`                        | 9        | **Parks.**                                                                                       |
| `chainType`                              | 10       | Drops, but owns chained receivers (`a.b.c`) that both parking predicates reject. No interaction. |
| `arRelationGuard`                        | 11       | Drops, but owns AR-relation chains, likewise rejected upstream. No interaction.                  |
| `conventionReceiver`                     | 12       | Can upgrade a park — see below.                                                                  |
| `receiverSetDrop`                        | 13       | Catch-all drop; under invariant 3 it EMITS the park. This is what preserves Ruby's edges.        |
| `bareCall`                               | 14       | Unreachable for receiver-set calls, since 13 drops them first.                                   |

`conventionReceiver` is the interesting one, and the two parking passes differ:

- against `constant`, it cannot fire at all. Its receiver shape is
  `/^@{0,2}[a-z_][a-z0-9_]*$/` while `looksLikeConstant` demands an uppercase
  initial — **disjoint by construction**, so a parked constant edge reaches
  `receiverSetDrop` unchanged.
- against `explicitRequire`, it can. A bare `require 'payment'` makes `payment`
  the receiver, which is exactly the snake_case shape the convention claims. Its
  gate 3 refuses to emit anything but a PINNED target, so when it fires it
  strictly upgrades the parked module edge to a symbol edge. That is the Ruby
  win this change buys, and the reason the Ruby half needs its own corpus
  measurement rather than inheriting the TypeScript result.

`super`'s intra-strategy `fileOnlyFallback` stays terminal. For a `super` call
no later pass has better information, and its precision is already tuned in the
other direction — `ruby-super-runtime-hook` DROPs the file-only edge for runtime
hooks rather than emitting it.

### Tests

New engine invariants get new red-green tests in
`tests/core/domains/language/resolver-chain.test.ts` — one per invariant, plus
the degenerate case (a park with nothing else in the chain).

`tests/core/domains/language/typescript/resolver/strategies/strategies.test.ts:172-179`
pins the current terminal behaviour ("emits a terminal file-only edge when the
member is not indexed (does NOT continue)"). That invariant is changing on
purpose, so it is rewritten red-first to the new one — a pass that defers rather
than commits — and the commit message says why, per
`.claude/rules/test-invariants.md`.

`tests/core/domains/trajectory/codegraph/symbols/resolve-regression-gate.test.ts:205-227`
holds exact per-receiverKind counts and must stay green. `pmxuv` established it
will not catch a fallback-only change — its three `namedImport` call sites all
hit the symbol-hit branches — so it is a guard against collateral damage, not
the acceptance signal.

### Measurement

`scripts/ts-codegraph-typechecker-oracle.ts` reports oracle verdicts but not the
number that decides this change. `pmxuv` had to hand-instrument a copy of the
harness to count total edges and then delete it, which is why the −156
regression was nearly missed. The edge tally becomes a permanent part of the
harness output:

- `edges` — call sites the chain resolved to anything
- `fileOnly` — of those, edges with `targetSymbolId === null`
- `unresolved` — call sites the chain declined

Note the name collision: the harness already has a `fileOnly` VERDICT, meaning
"chain and checker agree on the file, disagree on the symbol". The new counter
is a property of the chain's own output. It is reported in a separate
`CHAIN OUTPUT` block so the two never read as the same number.

Baseline is recorded before the first edit. Acceptance for the TypeScript half:

| Metric               | Requirement                                    |
| -------------------- | ---------------------------------------------- |
| `edges`              | ≥ baseline (invariant 3 makes this structural) |
| `wrongFile`          | < baseline                                     |
| `phantom`            | ≤ baseline                                     |
| `match`              | > baseline                                     |
| regression-gate test | green                                          |

### Measured outcome (TypeScript)

Both runs over tea-rags' own `src` — 895 files, 14722 call sites — with the same
instrumented harness, the baseline taken by reverting only `src/` so the harness
itself was identical on both sides.

| Chain output       | Baseline | Deferred | Delta   |
| ------------------ | -------- | -------- | ------- |
| edges              | 6385     | 6385     | **0**   |
| of which file-only | 738      | 720      | **−18** |
| unresolved         | 8336     | 8336     | 0       |

Not one edge lost, and 18 file-only edges upgraded to pinned ones — the shape
invariant 3 predicts. The oracle verdicts move only where `namedImport` lives:

| `constant` receiver kind | Baseline | Deferred |
| ------------------------ | -------- | -------- |
| match                    | 20       | 26       |
| wrongFile                | 6        | 0        |
| phantom                  | 29       | 29       |
| mismatch rate            | 23.1%    | **0.0%** |

Six of the eighteen upgrades were on sites the checker had an opinion about, and
every one of them agreed with it; the wrongFile bucket empties. The remaining
twelve landed in the checker's blind spots, which is exactly why the edge tally
had to exist — no verdict table can see them.

### Re-measured after merging main — the TypeScript win is gone

The table above is superseded. It was taken against a tree that did not yet have
bd `4kx9f` (the imported-container guard) or bd `hzsxy` (the barrel/re-export
hop), both of which landed on main while this branch was in flight and both of
which attack the same file-only population. Re-run on the merged tree, 896
files, 14737 call sites:

| Chain output       | Baseline | Deferred | Delta  |
| ------------------ | -------- | -------- | ------ |
| edges              | 6366     | 6366     | 0      |
| of which file-only | 560      | 559      | **−1** |
| unresolved         | 8370     | 8370     | 0      |

Every verdict bucket is byte-identical between the two runs. In particular the
`constant` receiver kind now reads match 26 / wrongFile 0 / phantom 0 / mismatch
0.0% on BOTH sides — main reached that on its own. The pre-merge measurement
credited deferral with 20→26 match and 6→0 wrongFile; those calls are now fixed
by the barrel hop and the container guard, more specifically and before the
chain ever reaches a fallback. File-only edges fell 738 → 560 for the same
reason, so most of the population deferral could have upgraded no longer exists.

What deferral is worth on this corpus today: **one upgraded edge, zero lost, no
verdict moved.** State it that way and nothing else. The pre-merge numbers
remain valid as evidence that the mechanism does what it claims when those
specific fixes are absent — they are not a live claim about main.

The reasons to keep it are therefore structural, not numeric:

- it is the contract Ruby (`xipzw`), Python and Java (`86qfb`) need, and it
  costs nothing measurable to carry;
- it removes the terminal-commit accident that the import file-edge defect was
  relying on — that defect was real, and it surfaced only because the accident
  went away;
- it unblocks `structuralTyping` for named-import receivers, which is the shape
  bd `icmnr` deferred in the first place and which no verdict on this corpus
  exercises.

A reader deciding whether to extend this to another language should measure that
language rather than inherit any number from here.

### Measured outcome (Ruby)

`scripts/taxdome-codegraph-recall-forensics.ts` turned out to need no reindex at
all — it re-resolves the corpus in process, read-only, without DuckDB — so the
Ruby half was measured in the same session rather than waiting on a user-gated
index rebuild. taxdome, 8711 Ruby files, 67177 symbols, no parse failures.
Baseline by reverting only the two Ruby strategy files, so engine, contract and
TypeScript were identical on both sides.

| Metric               | Baseline | Deferred | Delta      |
| -------------------- | -------- | -------- | ---------- |
| callsResolved        | 129425   | 129427   | +2         |
| callsExternalSkipped | 56719    | 56718    | −1         |
| callsNoInProjectDef  | 27562    | 27562    | 0          |
| callsCoreAmbiguous   | 3912     | 3912     | 0          |
| missWithInProjectDef | 14179    | 14180    | +1         |
| inProjectEdgeRecall  | 90.13%   | 90.13%   | **0.00pp** |

Ruby is flat. Two extra resolved calls out of 129k is 0.0015%, and recall does
not move at two decimal places; the +1 miss against −1 external is one call
reclassifying between buckets, not a lost edge — the edge count went up, not
down. The `conventionReceiver` upgrade the audit predicted, where a bare
`require 'payment'` lets pass 12 pin `Payment#<member>` over the parked module
edge, essentially never fires on this corpus.

That is the honest result and it should not be dressed up: the Ruby side buys no
recall today. What it buys is the removal of a latent early-commit defect and
one contract across both languages, at a measured cost of zero. Do not cite a
Ruby recall gain — there is none.

One trap for whoever reads the raw harness output: its
`87.74% → 90.13% (+2.39pp)` line is the harness's own annotation for bd 83cl7's
core-homonym carve-out, printed identically in both runs. It has nothing to do
with this change.

### Measured outcome (Python and Java) — deferral REJECTED for both

bd `86qfb`. The three call sites this design listed as "same shape, wants the
same treatment" were measured, and the measurement says do not convert any of
them. All three stay terminal.

The instrument is `scripts/codegraph-chain-tally.ts`: it walks a corpus, runs
the production chain, and — with `--defer <passName>` — runs a second chain that
differs only in that pass's file-only branch being converted to a park, then
diffs the two per call site. Both sides run in one process over one symbol
table, so there is no baseline to drift; the rebuilt chain is cross-checked
against the real `LanguageProvider.resolver` on every call site (`chain drift 0`
in every run below).

| Pass                  | Corpus       | Call sites | file-only | changed | upgraded-same-file | relocated | of which fabricated | lost |
| --------------------- | ------------ | ---------- | --------- | ------- | ------------------ | --------- | ------------------- | ---- |
| py `importMatch`      | flask        | 2172       | 148       | 2       | **0**              | 2         | 0                   | 0    |
| py `importMatch`      | ugnest       | 7331       | 315       | 2       | **0**              | 2         | **2**               | 0    |
| py `localBinding`     | ugnest       | 7331       | 315       | 68      | **0**              | 68        | 0                   | 0    |
| java `importReceiver` | commons-lang | 17641      | 1586      | 599     | **0**              | 599       | **599**             | 0    |

"Fabricated" = the parked edge named a file that does not exist in the corpus —
a phantom path both import mappers synthesise for an EXTERNAL import
(`mapPythonImportToFile("re")` → `re.py`,
`mapJavaImportToFile("java.util.Objects")` → `java/util/Objects.java`; neither
probes disk). A file-only edge on such a path is the resolver's de-facto "this
call leaves the project" marker, so replacing it with an in-project symbol does
not sharpen an edge — it invents one.

#### Why the zero column decides it

`upgraded-same-file` is **0 in every run**, and that is structural rather than
corpus luck. Each of these passes already searched its own target file for the
member and found nothing (or found it ambiguous, in which case a wider search is
more ambiguous still). So the parked file is the one place a later pass provably
cannot pin. A park here can only ever be RELOCATED, never sharpened in place.

That is the difference from TypeScript, and it is what does not transfer. TS's
tail is four `typeChecker` passes holding evidence the syntactic chain lacks, so
they can pin a symbol inside the parked file that the symbol table never
indexed. Python's and Java's tails are `globalShortName` — an unrestricted
`lookupByShortName(member)` with no receiver evidence at all. Deferring hands
precedence from the strongest surviving evidence to the weakest pass in the
chain.

**Deferral pays only where a later pass holds evidence the parking pass lacks.**
Where the tail is a global short-name guess, it cannot.

#### Per call site

**`java/resolver/strategies/java-import-receiver.ts:88` — REJECTED.** The chain
order does not pay off: pass 5 (`enclosingBareCall`) returns `continue` for
every receiver-present call, so the only pass that can ever beat the park is
pass 6, `globalShortName`. Its docblock already says why that must not happen —
the terminal guard is what keeps `random().nextBytes()` / `cs.charAt()` /
`Helper.compute()` from misrouting to a same-short-name project symbol. Deferral
reopens exactly that hole for the external population: 599 fabricated in-project
edges, 6.1% of commons-lang's 9821 Java edges, zero upgrades. 494 of them are
`Objects.requireNonNull(...)` reattributed to a project helper of the same name;
56 become self-loops in the calling file (`Array.newInstance` →
`ArrayUtils.newInstance`, a private static in the file making the call).

**`python/resolver/strategies/python-local-binding.ts:90` — REJECTED, and it was
never the preempting shape.** The file-only value is returned by the private
`resolveByLocalType`, whose `null` maps to `DROP` in `attempt`. So within its
own answer the choice is file-only edge versus NO edge, exactly the case this
design excluded for `ts-super` and `ruby/shared.ts`. It is terminal either way;
making it park would newly expose locally-bound receivers to passes 5 and 6,
which is the fall-through the bd `yrs0` guard exists to prevent. Measured on
ugnest — the project that produced that guard — deferral reproduces the
documented false positive verbatim, 68 times: `serializer.is_valid()` moving off
the bound serializer's file onto `ConfirmationCode#is_valid` in an unrelated
domain.

**`python/resolver/strategies/python-import-match.ts:32` — genuinely the
preempting shape, but not worth landing.** This pass is not a guard (its miss
path already returns `continue`), so it does preempt `globalShortName`.
Measured, it is a wash: flask moves 2 edges and both are right —
`app.update_template_context` comes off `sansio/app.py`, matched only because a
`TYPE_CHECKING` import's trailing segment collides with the receiver VARIABLE
name, and lands on the sole real definition in `app.py`. ugnest moves 2 and both
are wrong — `re.match(...)` comes off the phantom `re.py` and lands on an
unrelated `DistrictMatcher#match`. Four call sites out of 463 file-only edges,
net zero, with a new false-positive channel opened for stdlib receivers. No
measured gain is not a reason to ship added risk.

The Python case is the one that could be revisited, because the two outcomes
separate cleanly on a property the harness already reports: park when the mapped
file is IN-PROJECT, keep committing when it is a phantom external path. That
needs a "does this file exist in the corpus" query the `GlobalSymbolTable`
contract does not expose today, so it is a contract change with its own design,
not a one-line flip. Filed as its own bead rather than smuggled in here.

JavaScript (`javascript-resolver.ts:78`) remains out of scope for the reason
recorded above, and now for a second one: its chain tail is also a global
short-name fallback, so migrating it to `resolveViaChain` would buy the same
negative result unless the in-project gate lands first.

## Beads

| Bead               | Scope                                                    |
| ------------------ | -------------------------------------------------------- |
| tea-rags-mcp-5onmn | contract, engine, TypeScript passes 5/6/7, harness tally |
| tea-rags-mcp-xipzw | Ruby passes 8/9 + terminal-guard audit (same session)    |
| tea-rags-mcp-86qfb | Python and Java file-only fallbacks; JavaScript noted    |

Note that `86qfb` closed as REJECTED-with-evidence: the chain-tally harness
landed, no strategy changed.
