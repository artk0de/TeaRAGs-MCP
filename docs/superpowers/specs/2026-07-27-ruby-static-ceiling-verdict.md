# Ruby call-graph: the one-hop static ceiling — verdict

Status document, not a design. It states what "done" means for the Ruby
precision program (`tea-rags-mcp-cai0`), proves it with the final measurement,
decomposes the residual into cause classes, and closes the last hypothesized
storey (the worklist fixpoint) with its own oracle measurement.

## The claim

**Every one-hop static mechanism with positive ROI has shipped, and the
remaining misses are decomposed into measured cause classes** — each closed by a
verdict a reader can check, or handed to a named, sized successor lead. The
program target ("resolveSuccessRate 0.25 → 0.80 syntactic") is exceeded on the
honest denominator.

## Final measurement (taxdome, harness 2026-07-27, all mechanisms on)

9 297 ruby files, 225 562 call sites. Honest denominator (externals,
no-in-project-def, and core-ambiguous carved out — bd ykj7 + 83cl7):

| Metric                                    | Value                              |
| ----------------------------------------- | ---------------------------------- |
| resolveSuccessRate == inProjectEdgeRecall | **86.52 %** (program start: ~25 %) |
| distinct edge targets                     | 20 995                             |
| callsResolved                             | 118 833                            |
| misses with an in-project def             | 18 522                             |

Per receiverKind (attempted / resolved / rate / holes):

| kind       | att    | res    | rate     | hole  |
| ---------- | ------ | ------ | -------- | ----- |
| constant   | 33 138 | 21 614 | 100 %\*  | 0     |
| localVar   | 5 088  | 4 464  | 99.9 %\* | 6     |
| selfMember | 655    | 261    | 95 %\*   | 13    |
| bareCall   | 86 903 | 55 069 | 92.3 %\* | 4 448 |
| super      | 165    | 89     | 74.8 %\* | 26    |
| chain      | 27 237 | 7 826  | 63.6 %\* | 2 639 |
| dynamic    | 54 426 | 24 059 | 62.7 %\* | 8 631 |
| ivar       | 11 130 | 4 884  | 61.1 %\* | 2 659 |
| index      | 6 820  | 567    | 48.2 %\* | 100   |

\* in-project rate = res / (att − externalSkipped − noInProjectDef −
coreAmbiguous).

## What shipped to get here (the ceiling wave, branch `worktree-ruby-ceiling`)

| Mechanism                                                     | Bead                | Measured contribution                                                                                                       |
| ------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Self-dispatch v1/v2 + instance template redirect              | u7d9l, c5i9e        | 3 547 exact `.call → #perform` edges onto 1 840 concrete hooks; `KindOfService#call` fanIn 0 (live)                         |
| AR association + query-interface return types                 | 6ch0z               | +493 targets; `firm.owner` 4 634-edge fan-out killed                                                                        |
| Cross-pass exclusion guard (DEFECT-1 root cause)              | lx8sb               | spec/ aggregates 338→0 live; `Capybara` external again                                                                      |
| Service Result return threading                               | j9xpf               | 4 399 sites fan-out → single exact edge                                                                                     |
| Core-homonym denominator (migration 015)                      | 83cl7               | −3 503 phantoms; honest recall +2.17 pp                                                                                     |
| schema.rb column-declares (structural anti-explosion)         | 8l5fo               | 11 007 synthesized defs; −215 bareCall-in-model; aggregate growth 0                                                         |
| `@!method` directive ownership                                | 8ypeu               | **1 500 poison directives** disarmed; −1 166 false "resolved" exposed as honest holes; +correct `Service.call→Result` facts |
| Registry symbol form + factory pass-through + declared scopes | exmwr, va9ng, 6zpds | class/instance emission correct; custom-scope chain roots type                                                              |
| stub-REDIRECT terminal + persistence                          | bcdfe, wceck, eikry | three-state policy complete; migration 016 keeps it honest on incremental                                                   |
| ivarTypeName authority (premise falsified)                    | wr7ku               | latent Sorbet-era trap removed; census re-routed the roadmap                                                                |
| Constructor-arg param typing, Increment 1                     | bvalc               | mechanism proven; **input-starved: 94/4 338 typeable sites** — the fixpoint funding evidence                                |

## The residual, by cause class (~18.5 k misses)

| Class                                                                            | Est. size            | Verdict                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untyped params (method + constructor) feeding ivar/dynamic/chain                 | ~5–8 k gross         | **Fixpoint oracle measured the true ceiling: 510 misses (2.8 %)** — the hole does not live on parameter-typed receivers; storey closed (below). Successor leads: untyped-local widening (6 068) + typed-member lookup gap (568) |
| trueCollision bareCall (short-name genuinely multi-defined, receiver untyped)    | ~3.9 k               | Static analysis cannot pick a definer without a receiver type; the honest carve (83cl7) already removed the CORE-homonym half; the rest waits on receiver typing (same fixpoint dependency)                                     |
| `params[:x]` / hash / kwarg-value args, runtime `constantize` / `method_missing` | ~8 % of all attempts | Never statically typeable — the permanent floor                                                                                                                                                                                 |
| `name` and vetoed near-core members kept as real misses                          | ~0.9 k               | Deliberate reverse-precision guard (83cl7): swallowing them would hide real project methods                                                                                                                                     |
| index residual                                                                   | 100                  | Untyped container bases — same fixpoint class (h4d5s closed by measurement: 581→100)                                                                                                                                            |

## Closed by verdict — do not reopen without new evidence

VTA/G5 (oracle 4 050 < 5 000 gate; C-bucket is stdlib containers), duck-typing
engine (precision 94.5 % but volume 1 792 < 2 000; strictCore veto documented
for other corpora), conf-floor/G3b (navigation already hides the entire
population; a floor is a strict no-op under CONE_MAX ≤ 10), LSP track (owner
decision — jw9n/2bib dropped), dynamic fan-out cap/xdith (consumer-invisible
problem post-G3b), literal sharpening/u8m65 (below materiality; the 83cl7
vocabulary makes it a one-liner if ever justified), vh0yh (D3: 4 misses), "P3
+25 lever" (localVar 99.9 % — 6 holes).

## The fixpoint storey — measured and CLOSED (bd a2hrq, 2026-07-27)

The propagation cycle (param ← arg ← local ← return ← body ← param) was the last
hypothesized big lever. The oracle simulated the FULL worklist over the bvalc
substrate with the real propagation exports and scored by re-running the real
resolver:

- **Converges in 5 waves** (84 % of growth in wave 1; the cycle is shallow):
  typed params 19 → 1 433 (75×), contributing sites 94 → 11 316 (120×), derived
  returns 0 → 1 534. Zero regressions; rate 86.52 → 86.88 %.
- **Addressable ceiling: 510 of 18 522 misses (2.8 %)** — an UPPER bound (the
  body-tail return derivation is the least conservative piece). Kwarg variant
  adds +1 (taxdome declares only 680 kwarg-bearing methods — it is a
  positional/options-hash codebase).
- Verdict: **the worklist fixpoint dies by the same measure-first knife as VTA
  and the duck engine** — not for failing to converge, but because the recall
  hole does not live on parameter-typed receivers.

What the oracle's residual decomposition funds INSTEAD (the real next leads):

| Lead                                                                                                  | Size                              | Nature                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untyped locals the walker never binds — block params, destructuring, `rescue =>`, multiple assignment | **6 068** (largest single bucket) | walker-side local-binding widening; NOT interprocedural; block-param element typing stays VTA-OUT, the rest does not need it                                                                                                                                                                                              |
| Type-fact quality (was: "member-lookup gap")                                                          | **615**                           | FALSIFIED as a lookup problem — 0 MRO/macro/scope/schema gaps; all 615 are UPSTREAM fact defects: the flat bare-name return map types every same-named method project-wide (~374), and fictional annotation classes (`ServiceResult`, 241) shadow correct derived facts via the `.`/`#` key split. Two design leads filed |
| Callee never instantiated at a resolvable site (Rails DI, `constantize`)                              | 1 399                             | permanent floor                                                                                                                                                                                                                                                                                                           |
| `params[:x]` / hash / literal args, no-receiver bareCall residual                                     | ~10 k                             | permanent floor / receiver-typing-independent                                                                                                                                                                                                                                                                             |

## Method lessons this wave keeps

1. **Measure the population the consumer sees** — the G3b gate fired on raw DB
   rows and nearly funded a 17.4 %-of-centrality mistake; the xdith cap died the
   same way.
2. **A green suite proves the mechanism, the corpus proves the value** — G2,
   bvalc, and duck all shipped correct code whose measured corpus effect
   re-routed the roadmap instead of padding it.
3. **Removing poison can lower the headline number** — 8ypeu cost −0.94 pp of
   fake recall and was the most valuable precision change of the wave.
4. **Oracles before epics** — G0/duck/fixpoint: a ~90 s harness fold decides
   epics cheaper than building them.

## Addendum — the finishing wave (2026-07-27, same day)

Four measure-first strikes after the verdict snapshot, final honest rate **87.19
%** (drift-adjusted corpus, 9 420 files):

- **rescue-clause typing** (02saq): the 6.6 k "untyped local" census showed the
  bucket is mostly NOT walker work; the one zero-ambiguity mass — 978 rescue
  locals — landed for +0.70 pp, dynamic hole −995, `message` (1 114) gone from
  the top-25 misses; new exact edges REPLACE fan-out guesses.
- **schema column value types** (2a5oo): completes the schema.rb feature — 17
  tokens → 7 core classes with id:/renamed-PK and boolean silences; a pure
  precision move (46 core-receiver fan-out guesses → externalSkipped, exact
  accounting).
- **member-lookup gap FALSIFIED** (1g7kz): 615/615 are upstream type-fact
  defects, the lookup never even starts. Two design leads: flat-map scoping and
  declared-fact invalidation (the `.`/`#` shadow between the 8ypeu directive key
  and the j9xpf derived key).
- **fixpoint oracle** (a2hrq): worklist ceiling 510 — closed above.

Deferred WITH numbers (the census's honest tails): nullary-receiver typing 1 800
· callee-return coverage 1 365 · `create_table` DSL block params 664 · iterator
block params 572 (VTA-OUT) · non-leading def params 378.

## Addendum 2 — the tails waves (2026-07-28)

Two agent waves closed every deferred tail above. Final honest rate **87.96 %**
on the PARITY-CORRECTED denominator (see below): 8 488 files, 119 613 resolved,
16 370 misses.

**Denominator correction (2l0pr).** Every number above this section was
measured on an inflated denominator: the harness called
`buildCodegraphExclusionFilter` without the languageFactory argument, so it
walked 939 `db/migrate`/`db/data` files production has excluded since
`d0e0d1d7` (biwbq). Parity is now enforced by a required parameter. The
correction alone is worth ~+0.5 pp — read every historical headline in this
document as understated by that much. The `create_table` tail (664) died with
it: all 427 blocks live in excluded files.

**Tails wave 1** (yt3im + h4hxh + lawlq.5, merged `e0b6b08a`): existence-gated
declared-fact precedence (fictions 251/539, misses on fictions 263→49), step-4
flat-map gate (805/871 firings provably foreign, 0 legitimate; bare branch left
open — a naive gate costs −758 honest edges), super bare-constant mixin
canonicalization (3 missing constant-lookup rules + self-edge guard;
graphql-ruby 89.11→89.78, bareCall +181). Super-miss mass = runtime-built
ancestry, permanent floor. Also: the harness barrier had never run the j9xpf
derive — 2 838 coordinates missing from every measurement above.

**Tails wave 2** (rwv3o + smvyk + pr7fu + jawn8 + 2l0pr, merged `7e8b22df`):
owner-qualified return-fact channel (addressable measured 298, not 4 143;
direct contribution ≈0 — it is the channel, not the prize), nullary-receiver
typing via caller-MRO fact lookup (real population 9 259, not the census's
1 800; +0.04 pp, hole −56, mostly precision), memoized-tail return inference
(the one funded shape of 1 678 factless callees). `jawn8` NO-GO: the
"non-leading def params" census bucket is actually a SIGNATURE GAP —
`collectRubyMethodSignatures` never indexes `class << self` (1 914 defs),
block-nested (38), top-level (11) = 17.6 % of positional-param defs carry no
arity/visibility/kwargs (lead: jn5j0); the bvalc-fold addressable subset is 23.

**Closed by these waves' oracles — do not reopen without new evidence:**
nullary/bare no-definer-on-MRO mass (5 639 + 2 309 — runtime `helper_method`/
view-helper inclusion, an include-graph problem, the largest remaining lever),
`Const.m()` one-hop closure (85 misses, 82 of them nilable — needs union/nilable
return types first), opaque memoized RHS (108 + 46 — needs bounded intra-class
flow), db/migrate carves (both dead — excluded in production).
