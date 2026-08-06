# Search confidence — distribution-shape signal for no-match detection

Status: approved 2026-08-06 (design fixed by the owner, this document records
it). Implements `tea-rags-mcp-7vzo`; supersedes the `matchQuality` sketch in
`tea-rags-mcp-v6aa`.

## Problem

A query for something the project does not contain still comes back with ten
results and a top score around `0.55`. A legitimate reranked query comes back
with a top score of `0.36`–`0.46`. The absolute number is not merely
uninformative — it is inverted.

The consumer of that response is an LLM agent, and the agent has no way to tell
"found it" from "there is no such thing here". It gets ten plausible-looking
chunks and proceeds as if they answered the question. That is a hallucination
source, not a UX blemish, and it is the reason this ships as a response field
rather than as a paragraph in the search-cascade rules.

## Non-negotiable: no absolute score thresholds

The obvious fix — "warn below 0.5" — is wrong. Raw score magnitude is a property
of the embedding model, not of the match. Swap `jina-embeddings-v2-base-code`
for anything else and every hard-coded cut-point silently means something
different, with no test failing to say so.

`Reranker#computeAdaptiveBounds` already settled this argument for signal
normalisation: bounds come from the p95 of the result batch, floored by the
collection's own p95, never from a constant. Confidence follows the same rule
one level up. It describes the SHAPE of the distribution inside a single
response — how the returned scores relate to each other — and reads no absolute
magnitude at all.

## The three components

Each maps into `[0,1]`; higher means "this looks like a real find".

### peak — leader separation

```
peak = (s1 − median(s2..sn)) / s1
```

A real hit stands out from its own tail. A nonsense query returns a flat sheet
of near-identical scores because everything is equally unrelated to the query,
so the leader has nothing to separate from.

Scale-free by construction: dividing by `s1` removes the model's magnitude.
Median rather than mean for the tail, so a second genuine hit does not collapse
the number.

### spread — coefficient of variation

```
spread = norm(σ / μ)
```

The same intuition from the other side: a flat plateau is noise. CV is already
scale-free; the `norm` step is a saturating map `cv / (cv + k)` with `k`
calibrated on the corpus below — no clipping, no hard ceiling, and `k` is the CV
at which the component contributes exactly `0.5`.

### locality — path entropy

```
locality = 1 − H / ln(n),  H = Shannon entropy over directory buckets
```

A real answer clusters. Ten hits in one directory is a subsystem; ten hits in
ten unrelated directories is the index shrugging.

**This component is deliberately the weakest of the three.** Legitimate queries
like "error handling" are honestly scattered across the tree and score near zero
on locality. It refines, it does not decide. Any weighting that lets locality
overturn `peak` + `spread` is a bug in the weights.

### Convolution

```
value = w_peak · peak + w_spread · spread + w_locality · locality
w_peak = w_spread = 0.4,  w_locality = 0.2
```

Weights are a design decision and stay fixed; only `k` and the label cut-points
are calibrated against measurement.

## Placement

A pure computer in a new module, `src/core/domains/explore/confidence.ts`: an
array of `{score, relativePath}` in, `{value, label}` out. No Qdrant, no
Reranker, no payload readers. It is testable on bare arrays of numbers, which is
the whole point — the corpus calibration below runs the same function the server
runs.

Explicitly NOT in `BaseExploreStrategy#postProcess`. That method already does
five things (rerank, offset, trim, metaOnly, groupByFile). Its file is a
structural hub — fanIn 6, `isHub`, transitiveImpact 7 — and simultaneously a
deep silo at 100% single-author. A sixth responsibility there costs more than a
separate module does.

It is called once, where the response envelope is assembled
(`ExploreOps#executeExplore`). The envelope already exists:
`{results, level, driftWarning}`. `confidence` sits next to `level`, so no
client breaks.

## Output

```json
{ "confidence": { "value": 0.23, "label": "low" } }
```

Labels resolve through the existing `resolveLabel`
(`domains/explore/label-resolver.ts`) — the same contract every git signal
already uses, so an agent that understands `churn: high` understands this
without new vocabulary. Three labels: `high` / `medium` / `low`. A bare number
gets ignored; the label is what the agent acts on.

**No gate.** Results are always returned in full; low confidence filters
nothing. A query for a symbol that exists exactly once in the project also
produces a flat response, and cutting that off would be worse than the problem
being solved.

## Scope: three tools, not five

| Tool              | Confidence | Why                                                            |
| ----------------- | ---------- | -------------------------------------------------------------- |
| `semantic_search` | yes        | dense score answers "is this in the project"                   |
| `hybrid_search`   | yes        | same, plus BM25 fusion                                         |
| `find_similar`    | yes        | recommend-API score, same semantics                            |
| `rank_chunks`     | **no**     | scroll + rerank; score ranks candidates, does not attest match |
| `find_symbol`     | **no**     | exact lookup — the question does not arise                     |

Attaching confidence to `rank_chunks` would be a lie with a number on it: every
chunk in the filtered set is "there", the score only orders them.

## Acceptance — measured, not asserted

Without a separability measurement this is one more heuristic with plausible
prose around it. The gate:

- Two query sets against the live `tea-rags` index (`code_8b243ffe`): one
  deliberately nonsensical (random words, technologies absent from the project),
  one deliberately legitimate (symbols and subsystems taken from the real
  index).
- Pass: **at most 10% of nonsense queries labelled `high`**, and **at least 90%
  of legitimate queries above `low`**.
- Cut-points are fitted to that corpus. They are not eyeballed, and they are not
  nudged until the numbers look good — if separability is not reached, the
  measurement is reported with its numbers as the result.

Calibration constants (`k`, the two cut-points) and the measured separability
live in the section appended after the corpus run.

## Calibration result — the gate is NOT met

Measured 2026-08-06 by `scripts/search-confidence-corpus.ts` against the live
`code_8b243ffe` index (17110 chunks, 1743 files, embedding model
`unclemusclez/jina-embeddings-v2-base-code`), `limit=10`, `level=chunk`, no
rerank — the un-reranked path that produced the original complaint. Corpus: 25
nonsense queries, 25 legitimate queries, both the dense and the hybrid leg, 100
measurements. Constants fitted by quantile rule (`high` = p90 of nonsense,
`medium` = p10 of legitimate), `k` grid-swept for maximum margin, giving
`k = 0.11`, `medium = 0.19`, `high = 0.63`. The shipped `medium` is 0.21 rather
than 0.19 — at 0.19 a completely flat response that happens to sit in one
directory (locality 1.0 × weight 0.2) escapes `low`, which the design forbids;
the fitted cut-point and the design's own "locality never decides" rule are 0.02
apart, which is its own comment on how thin the separation is.

Gate under the shipped constants (`k = 0.11`, `medium = 0.21`, `high = 0.63`):

| Leg    | nonsense `high` (gate ≤ 10%) | legit above `low` (gate ≥ 90%) | verdict |
| ------ | ---------------------------- | ------------------------------ | ------- |
| dense  | 0/25 = 0.0% ✓                | 19/25 = 76.0% ✗                | FAIL    |
| hybrid | 6/25 = 24.0% ✗               | 25/25 = 100.0% ✓               | FAIL    |
| pooled | 6/50 = 12.0% ✗               | 44/50 = 88.0% ✗                | FAIL    |

At the unadjusted fit (`medium = 0.19`) the pooled numbers are 12.0% / 92.0% —
still a fail on the nonsense side.

No choice of cut-points fixes this, because the failure is upstream of the
cut-points. Per-component discrimination, as Mann-Whitney AUC (probability a
random legitimate query outscores a random nonsense one; 0.5 = coin flip):

| Component               | dense AUC | hybrid AUC |
| ----------------------- | --------- | ---------- |
| **peak** (weight 0.4)   | **0.517** | **0.556**  |
| **spread** (weight 0.4) | **0.518** | **0.482**  |
| locality (weight 0.2)   | 0.862     | 0.819      |
| combined value          | 0.742     | 0.702      |

**The two components carrying 80% of the weight are coin flips.** `spread` on
the hybrid leg is below chance. The component the design deliberately
subordinated — locality — is the only one that separates anything, and the
weighting dilutes it.

Even where the gate's letter is nearly satisfiable, its spirit is not: under the
design weights, 48% of nonsense queries (dense) and 100% (hybrid) still land at
`medium` or above. A signal that calls half of all garbage "medium" does not
help an agent decide whether the project contains the thing.

### Why the shape does not carry the information

Raw top-10 scores, one query from each class, dense leg:

```
nonsense "opera libretto soprano aria"
  0.448 0.448 0.441 0.436 0.436 0.436 0.427 0.426 0.426 0.421
legit    "resolve label from percentile thresholds"
  0.797 0.784 0.734 0.670 0.661 0.657 0.647 0.630 0.628 0.624
```

Both are gently decaying sheets. What differs is not their shape — it is their
**height**, and height is precisely what the design rules out:

| Discriminator                | dense AUC | hybrid AUC |
| ---------------------------- | --------- | ---------- |
| mean score of the result set | **0.997** | 0.942      |
| top score `s1`               | **0.990** | 0.826      |
| peak + spread (shape)        | ~0.52     | ~0.52      |

Absolute magnitude separates the two classes almost perfectly on this index;
shape does not separate them at all.

The hybrid leg additionally makes the shape components meaningless by
construction. Qdrant's RRF fusion emits rank-derived scores — the nonsense query
above returns `0.500 0.333 0.250 0.200 0.167 …`, the harmonic series of
`1/(1+rank)`. Every hybrid response has the same peaked geometric shape whatever
the query, which is why `peak` reads 0.542 for nonsense and 0.553 for legitimate
and `spread` falls below chance.

### What this means for the design

The design's objection to absolute thresholds is sound as far as it goes: a
hard-coded `0.5` is a property of one embedding model and would rot on a model
swap. But the conclusion drawn from it — discard magnitude, use shape — is
refuted by the measurement above. The information lives in the magnitude.

The consistent answer inside this codebase is the one already used everywhere
else for exactly this problem: calibrate the absolute scale **against the
collection itself** rather than against a constant.
`Reranker#computeAdaptiveBounds` normalises signals against the batch p95
floored by the collection p95; `StatsCache` already persists per-collection
distributions. A per-collection score distribution, sampled at index time, would
let `s1` and the result-set mean be read as percentiles of that collection's own
scores — model-independent, no constant, and measured AUC 0.99 rather than 0.52.

This is a design change, not a calibration tweak, so it is not made here. The
implementation on this branch follows the approved design exactly; the numbers
above are the measurement result, reported rather than tuned away.

## Where the mechanism is wrong

Confirmed by the corpus run:

- **`peak` and `spread` do not discriminate at all** (AUC 0.517 / 0.518 dense).
  The score sheet decays at roughly the same relative rate whether or not the
  project contains the answer.
- **Hybrid (RRF) scores encode rank, not similarity.** Their shape is generated
  by the fusion formula, so `peak` and `spread` measure the formula rather than
  the match. `find_similar` (Qdrant recommend) was not separately measured and
  may share this defect.
- **`locality` is the only working component and is under-weighted.** It also
  fails exactly where the design predicted: legitimately scattered queries
  ("error handling") read as noise.
- **`medium` is not actionable** under the fitted cut-points: 31 of 50 nonsense
  measurements land there.
- **Small result sets.** Below three results the shape statistics have almost no
  data; `n = 1` has no tail and no dispersion. The module returns a defined
  value by convention, and it is a convention, not a measurement.
- **Single-occurrence symbols** legitimately produce a flat response and read
  `low`. This is why there is no gate.
