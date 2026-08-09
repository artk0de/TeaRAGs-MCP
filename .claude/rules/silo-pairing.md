---
paths:
  - "src/core/domains/language/ruby/walker/ast-utils.ts"
  - "src/core/domains/language/ruby/walker/local-bindings.ts"
  - "src/core/domains/language/ruby/walker/type-fact-store.ts"
  - "src/core/domains/language/ruby/walker/type-sources/ast-inference.ts"
  - "src/core/domains/language/ruby/walker/type-sources/yard.ts"
  - "src/core/domains/language/ruby/resolver/type-propagation.ts"
  - "src/core/domains/trajectory/codegraph/symbols/run-state.ts"
  - "src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.ts"
  - "src/core/adapters/embeddings/onnx/daemon-types.ts"
  - "src/core/adapters/embeddings/ollama/errors.ts"
---

# Silo Pairing (MANDATORY for deep-silo files)

A file whose live lines have exactly one author is a bus-factor risk. Mitigate
it without forcing awkward co-authorship: every commit touching one carries its
intent and trade-offs in the message, so the reasoning survives the author.

## Listing criterion

Single ownership alone is NOT enough to earn a place here. On this codebase
`blameDominantAuthorPct = 100` describes dozens of files — most of them small,
young, or reached by nobody. A list that long is a list nobody reads.

A file is listed when **both** hold:

1. `git.file.blameDominantAuthorPct = 100` with `blameContributorCount = 1` —
   one author owns every live line, and
2. `codegraph.file.transitiveImpact >= 10` (regional or systemic) — losing that
   knowledge costs something.

Reach is what turns single ownership into risk. Everything else is just a small
file one person happened to write.

## Files currently classified as deep-silo

Refreshed 2026-08-08 from `tea-rags:risk-assessment` + an `ownership`-reranked
file scan. Re-run quarterly.

- `src/core/domains/language/ruby/walker/ast-utils.ts` — fanIn 9 (hub),
  transitiveImpact 33
- `src/core/domains/language/ruby/resolver/type-propagation.ts` — fanIn 10
  (hub), transitiveImpact 30
- `src/core/domains/language/ruby/walker/type-sources/yard.ts` — fanIn 6 (hub),
  transitiveImpact 30
- `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts` — fanIn
  6 (hub), transitiveImpact 29
- `src/core/domains/language/ruby/walker/local-bindings.ts` — fanIn 1,
  transitiveImpact 25
- `src/core/domains/language/ruby/walker/type-fact-store.ts` — fanIn 1,
  transitiveImpact 25
- `src/core/domains/trajectory/codegraph/symbols/run-state.ts` — fanIn 2,
  transitiveImpact 12
- `src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.ts` —
  fanIn 3, transitiveImpact 10
- `src/core/adapters/embeddings/onnx/daemon-types.ts` — fanIn 2,
  transitiveImpact 10
- `src/core/adapters/embeddings/ollama/errors.ts` — fanIn 1, transitiveImpact 10

The Ruby type-propagation cluster is the concentration worth noticing: six of
the ten files, all one owner, all feeding the same resolver. Epic
`tea-rags-mcp-uetqq` treats reducing that bus factor as a deliverable rather
than a side effect.

**This list is a floor, not a census.** It comes from a top-30 ownership scan,
so a deep-silo file outside that window is absent rather than cleared. Widen the
scan when the next refresh runs.

### Removed at the 2026-08-08 refresh

Every file on the 2026-05-16 list had drifted out of deep-silo by the time it
was re-measured — all nine now read `shared`, most with two or three live-line
contributors:

`api/internal/ops/indexing-ops.ts` (67%),
`api/internal/ops/project-registry-ops.ts` (86%),
`ingest/pipeline/enrichment/recovery.ts` (59%), `adapters/qdrant/errors.ts`
(87%), `api/public/app.ts` (85%), `api/errors.ts` (88%),
`domains/explore/errors.ts` (76%), `domains/trajectory/errors.ts` (90%),
`adapters/errors.ts` (not re-measured — absent from the scan window).

A stale list is worse than no list: it demanded ceremony from files that had
already healed while saying nothing about the ones that had gone silo since.

### Deliberately not listed

`src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts` is
100% single-owner but has `transitiveImpact 1`, so it fails criterion 2. It is
named in epic `tea-rags-mcp-uetqq`, which opts it in for that epic's duration —
that is a scoped decision, not a listing.

## Rule

Commits touching any listed file MUST include a `Why:` line in the body stating
intent and trade-offs. Example:

```text
refactor(ingest): tighten recovery scrollUnenriched cursor lifetime

Why: previous cursor leak caused 3.5s hang on first re-poll after restart.
Trade-off: extra Qdrant call per cycle, acceptable given <50ms latency.
```

## Why no test-time enforcement

Process-only rule — automated enforcement (a commitlint check) would fire false
positives on non-listed files, and the list drifts between refreshes anyway, as
the 2026-08-08 refresh showed. Reviewers verify on PR.
