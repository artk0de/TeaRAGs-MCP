# Search confidence — collection-relative no-match detection

Status: **shipped design, revision 2** (2026-08-06). Implements
`tea-rags-mcp-7vzo`; supersedes the `matchQuality` sketch in
`tea-rags-mcp-v6aa`.

This document has two halves, and the order is deliberate.

- **Part I** records revision 1 — confidence from the SHAPE of the score
  distribution — and the measurement that killed it. It is kept in full,
  including the AUC table, because "read the shape instead of the magnitude" is
  an attractive idea that will occur to the next reader too. It has been
  measured. It does not work.
- **Part II** is what shipped: magnitude read against the collection's own
  similarity scale, plus path locality.

---

# Part I — rejected: distribution shape (revision 1)

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

**Carried into Part II unchanged.**

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

**Carried into Part II unchanged**, with one addition: when the collection's
similarity scale is unknown the field is omitted entirely.

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

**Superseded — Part II narrows this to `semantic_search` alone, on measurement.**

| Tool              | Confidence | Why                                                            |
| ----------------- | ---------- | -------------------------------------------------------------- |
| `semantic_search` | yes        | dense score answers "is this in the project"                   |
| `hybrid_search`   | yes        | same, plus BM25 fusion                                         |
| `find_similar`    | yes        | recommend-API score, same semantics                            |
| `rank_chunks`     | **no**     | scroll + rerank; score ranks candidates, does not attest match |
| `find_symbol`     | **no**     | exact lookup — the question does not arise                     |

Attaching confidence to `rank_chunks` would be a lie with a number on it: every
chunk in the filtered set is "there", the score only orders them. That reasoning
survives; the `hybrid_search` and `find_similar` rows did not.

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

This is a design change, not a calibration tweak. It was taken to the owner with
the numbers above and approved, and Part II is the result.

## Why revision 1 failed, in one line

Confidence built on shape asked the score sheet a question it does not answer.
The sheet decays at roughly the same relative rate whether or not the project
contains the answer (`peak` AUC 0.517, `spread` 0.518); what changes is how high
the sheet sits. The design forbade looking at exactly that.

Secondary findings from the same run, all carried into Part II:

- **Hybrid (RRF) scores encode rank, not similarity.** `peak` reads 0.542 for
  nonsense against 0.553 for legitimate because the fusion formula generates the
  shape. Hybrid is out of scope in Part II for this reason.
- **`locality` was the only working component and was under-weighted** at 0.2.
- **`medium` was not actionable**: 31 of 50 nonsense measurements landed there.

---

# Part II — shipped: magnitude against the collection's own scale

## The correction

The objection to absolute thresholds stands: a hard-coded `0.5` belongs to
`jina-embeddings-v2-base-code` and would rot on a model swap. What was wrong was
the conclusion drawn from it. Magnitude is not unusable — it is unusable
*against a constant*. Read against the collection's own similarity distribution
it is both the strongest discriminator available and model-independent.

That is the same move `Reranker#computeAdaptiveBounds` already makes for
signals: normalise against the collection, never against a constant. Confidence
now makes it one level up.

## The collection score background

`ScoreBackground` — the cosine similarity between random pairs of stored vectors
— is the collection's similarity scale:

```ts
interface ScoreBackground {
  mean: number;
  stddev: number;
  sampleCount: number; // vector PAIRS
}
```

Measured on the tea-rags index: `mean 0.256, sd 0.146` over 1000 pairs. A
nonsense query's result set means 0.46 (z ≈ 1.4); a legitimate one means 0.63
(z ≈ 2.5). Same numbers, expressed in units the collection defines.

**This did not exist in `StatsCache`** — it holds per-signal percentiles over
payload fields and categorical distributions, nothing about scores. What was
added:

| Piece                                                | Cost                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ScoreBackground` on `CollectionSignalStats`         | six numbers                                                                                                      |
| stats-cache file `v6` (readers for v4/v5 unchanged)  | one field, absent-means-undefined                                                                                |
| `sampleVectors` — bounded scroll with vectors        | 1200 vectors ≈ 3.7 MB at 768 dims, one scroll, does NOT scale with index size                                    |
| `computeScoreBackground` — 600 disjoint-pair cosines | milliseconds                                                                                                     |
| call site in `IndexingOps#refreshStatsByCollection`  | runs where stats are already recomputed; failure is non-fatal — signal stats still save, confidence stays absent |

Indexes built before v6 carry no background. Confidence is then **omitted from
the response** rather than guessed — the same convention the project already
uses for new payload fields: a reindex fills it in.

## Components

```
z         = (mean(result scores) − background.mean) / background.stddev
magnitude = clamp01((z − Z_FLOOR) / (Z_CEILING − Z_FLOOR))
locality  = 1 − H / ln(n)      # Shannon entropy over result directories

value     = 0.75 · magnitude + 0.25 · locality
```

`peak` and `spread` are gone. Keeping them at a token weight would mean mixing
two coin flips into the score; there is no number that justifies it.

`locality` moved from 0.2 to 0.25 — a real 0.862 AUC deserves a weight that can
move a verdict by one label. It still cannot overturn magnitude, which is
correct: legitimately scattered queries ("error handling") lose this component
entirely and must not be punished into `low` for it.

The mean over the returned results rather than the top score alone: measured AUC
0.997 against 0.990, and a mean is harder to move with one lucky hit.

## Scope: one tool, measured

| Tool              | Confidence | Why                                                                   |
| ----------------- | ---------- | ---------------------------------------------------------------------- |
| `semantic_search` | yes        | dense cosine, AUC 0.995 on the acceptance corpus                       |
| `hybrid_search`   | **no**     | RRF fusion emits `0.500 0.333 0.250 0.200 0.167 …` — rank, not distance |
| `find_similar`    | **no**     | separates perfectly but on a different scale — see below               |
| `rank_chunks`     | **no**     | scroll + rerank; the score orders candidates, it does not attest match  |
| `find_symbol`     | **no**     | exact lookup — the question does not arise                             |

### find_similar, checked separately

It does **not** have the RRF defect — its recommend score is a genuine cosine,
and within its own leg it separates perfectly: AUC **1.000**, nonsense mean
0.676 against legitimate 0.831.

It has a different defect. Its query is CODE, and unrelated code sits far closer
to a code corpus than unrelated prose does. Under the cut-points calibrated on
prose queries, **10 of 10 nonsense snippets label `high`** — the exact failure
this feature exists to prevent, with a number on it. Excluded until it has its
own calibration corpus; the mechanism is ready for it, only the cut-points are
missing.

## Calibration result — the gate is met

Measured 2026-08-06 by `scripts/search-confidence-corpus.ts` against the live
`code_8b243ffe` index (17149 chunks, 1746 files), `limit=10`, `level=chunk`, no
rerank. Corpus: the same 25 nonsense + 25 legitimate queries as revision 1, plus
10 + 10 code snippets for the find_similar leg.

Shipped constants: `Z_FLOOR = 1`, `Z_CEILING = 3`, weights `0.75 / 0.25`,
cut-points `medium = 0.35`, `high = 0.55`.

| Leg                  | nonsense `high` (gate ≤ 10%) | legit above `low` (gate ≥ 90%) | AUC   | verdict |
| -------------------- | ---------------------------- | ------------------------------ | ----- | ------- |
| **semantic_search**  | **0/25 = 0.0%**              | **25/25 = 100.0%**             | 0.995 | **PASS** |
| find_similar         | 10/10 = 100.0%               | 10/10 = 100.0%                 | 1.000 | out of scope |

Separation window on the semantic_search leg, which is what justifies the
cut-points rather than eyeballing them:

| Quantity                       | Value    |
| ------------------------------ | -------- |
| nonsense max                   | 0.47     |
| nonsense p90                   | 0.38     |
| legitimate min                 | 0.36     |
| legitimate p10                 | 0.51     |
| mean confidence — nonsense     | 0.200    |
| mean confidence — legitimate   | 0.659    |

Any `high` cut above 0.47 keeps nonsense out of `high` entirely; 0.55 has slack.
Any `medium` cut at or below 0.36 keeps every legitimate query above `low`; 0.35
has 0.01 of slack, which is tight and is the number to watch on another corpus.

Label mix: nonsense `high=0 medium=3 low=22`, legitimate `high=17 medium=8
low=0`. Compare revision 1, where 31 of 50 nonsense measurements read `medium`.

An alternative fit is worth recording: setting `medium = 0.51` (the legitimate
p10, which the quantile rule strictly prescribes) drops nonsense out of `medium`
altogether, at the cost of labelling 10% of legitimate queries `low`. The
shipped 0.35 keeps every real find visible and accepts 3 nonsense queries at
`medium`. For an anti-hallucination signal that trade is defensible either way;
it was chosen for recall, and `medium` is not `high`.

## Where the mechanism is wrong

- **`find_similar` is unserved** — perfect discrimination, wrong scale, no
  cut-points. Anyone adding them needs a code-snippet corpus, not a prose one.
- **`hybrid_search` is unserved** and cannot be served by this mechanism at all:
  RRF scores carry no distance information to normalise.
- **Cross-modality queries drift.** The background is measured chunk-to-chunk;
  prose queries sit lower against it than code queries do. Both are handled by
  the calibrated bounds, but a query mode unlike either — a stack trace, a UUID
  — has not been measured.
- **The `medium` cut has 0.01 of slack** against the legitimate minimum on this
  corpus. A corpus with a harder legitimate query would push someone below it.
- **A reranked response is scored on the blended rerank score**, not raw
  similarity, so a preset weighting git signals heavily reads lower than the
  semantic evidence warrants. Calibration ran on the un-reranked path.
- **Small result sets.** With one or two hits the mean is the whole sample. The
  magnitude reading stays honest; locality stops meaning much.
- **Single-occurrence symbols** still read low-ish when the one hit is
  isolated — which is why there is still no gate: results are always returned in
  full.
