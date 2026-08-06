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

## Calibration result

Filled in by the corpus run — see the section appended to this file once
`scripts/search-confidence-corpus.ts` has been executed against the live index.
Until then the constants in `confidence.ts` are provisional and carry no claim.

## Where the mechanism is expected to be wrong

Failure modes anticipated at design time; the corpus run either confirms them
with numbers or replaces this list.

- **A legitimate query that is genuinely scattered** ("error handling",
  "logging") loses the entire locality component and part of peak.
- **A nonsense query that accidentally clusters** — a made-up token whose
  subtokens resemble one directory's vocabulary — gets a locality boost it has
  not earned. Locality's low weight is what keeps that out of `high`.
- **Reranked responses** are scored on the blended rerank score, not on raw
  similarity. A preset weighting git signals heavily flattens the peak of a
  genuine find, so confidence reads lower than the semantic evidence warrants.
  Calibration therefore runs on the un-reranked path.
- **Small result sets.** Below three results the shape statistics have almost no
  data — `n = 1` has no tail to separate from and no dispersion at all. The
  computer returns a defined value there by convention (documented in the
  module), and it is a convention, not a measurement.
- **Single-occurrence symbols.** A query for something that exists exactly once
  legitimately produces a flat response and reads `low`. This is why there is no
  gate.
