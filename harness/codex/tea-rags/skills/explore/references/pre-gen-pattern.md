# PRE-GEN Pattern

The explicit pre-change branch gathers actionable context — files, risk signals,
overlay labels.

Only an explicit pre-change investigation uses this branch. A factual follow-up
inside a design discussion stays a factual question. Reuse held bodies and
overlay labels; do not repeat discovery or signal lookup for unchanged material.
Discovery starts with metadata and a small set; select targets before bodies. No
speculative class/header/tree reads for possible future questions.

## PG-1. DISCOVER

Target area files, first matching branch:

- **Anchor already in context** (a row or body naming the behaviour) →
  `get_callees(symbolId=<anchor id>, depth=2)` (callers for impact:
  `get_callers`) first, then PG-2 batch — no `semantic_search` /
  `hybrid_search`; new search only for code the graph does not reach
- **User names a file path** → `find_symbol(path=<cwd>, relativePath=<file>)`
  outline, then `find_symbol(symbol=<id from outline>)` — no symbol lookup, no
  `hybrid_search` / `semantic_search` on it
- **Behavior/intent** → `semantic_search` (query=$ARGUMENTS, metaOnly=true,
  limit=5 initially, documentation="exclude"; expand only for missing targets)
- **Known symbol** → `find_symbol` (symbol=<id>) for definition; surrounding
  area → `hybrid_search` (query=$ARGUMENTS, metaOnly=true, limit=5 initially,
  documentation="exclude")

Add `pathPattern` if module known, `language` if polyglot.
`documentation="exclude"` keeps RFC/docs out of result slots.

**Checkpoint:** enough relevant targets for the requested change context?

- YES → use those targets in PG-2; do not fill an arbitrary quota
- NO → search only for the missing responsibility, retry once

## PG-2. SIGNAL LOOKUP

Needed symbols from PG-1 (typically 2-5, not a minimum) in ONE `find_symbol`
with rerank for overlay labels (instant, no embedding; rows keyed by `request`,
misses in `missing[]`).

If bodies are held, fetch missing signals with `metaOnly:true`. Otherwise
include only method bodies that must be inspected for this change.

```
find_symbol:
  symbols: [<symbol names from PG-1>]   ← Class#method (instance) / Class.method (static)
  path: <your working directory>
  rerank: "techDebt"          ← its overlayMask labels the PG-2 fields; do not swap presets
  metaOnly: false             ← content + rerank = full raw payload (metaOnly drops git.*)
```

Labels → `rankingOverlay.{file,chunk}.<field>.label`; raw →
`payload.git.{file,chunk}.<field>` (never labelled).

Overlay = chosen preset's `overlayMask` only. `techDebt` covers all labelled
PG-2 fields (ageDays, commitCount, bugFixRate, churnVolatility,
blameDominantAuthorPct, recentDominantAuthorPct); other presets drop some
(`hotspots` has no `commitCount` label).

Extract per symbol: bugFixRate, ageDays, churnVolatility, commitCount,
blameDominantAuthor, blameDominantAuthorPct (live-line owner → silo, "who must
approve"), recentDominantAuthor, recentDominantAuthorPct (recent committer →
"who's loaded in"). Feed DDG strategy selection.

**Interpretation:** never read single signals in isolation — pair diagnostics in
`../../../rules/references/signal-interpretation.md`, esp. high churn / age /
ownership (high churn ≠ active development; mono ownership ≠ silo risk).

## PG-3. DEEP TRACE (optional)

Symbols need structure before generation:

- `find_symbol` for 1-2 key symbols (definition + imports)
- 0 results → `hybrid_search`

**Limit:** do NOT trace call chains or dependency trees.

## PG-4. OUTPUT

```
Pre-generation context for: [area]

Files: [list with pathPattern-ready format]
Language: [detected language]
Symbols with overlay:
  - symbolName: { bugFixRate, ageDays, churnVolatility, commitCount,
                  blameDominantAuthor, blameDominantAuthorPct,
                  recentDominantAuthor, recentDominantAuthorPct }

Context for generation:
  - pathPattern: [ready for data-driven-generation]
  - overlay labels: [per-symbol from PG-2]
```

Self-contained. data-driven-generation reads overlay labels directly.
