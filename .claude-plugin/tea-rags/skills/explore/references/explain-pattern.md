# EXPLAIN Pattern

Sub-patterns for human-explanation intents in the explore flow. Structure the
EXPLAIN step by what was asked.

- **"How does X work?"** → flow: entry → processing → output. Key files + roles.
- **"Architecture of X?"** → components, responsibilities, connections,
  boundaries.
- **"Where is X used?"** → hybrid_search (BM25 = full recall for exact symbol
  names, dense = semantic context). Paginate with offset until all usages found
  (see `references/pagination.md`).
- **"How is X different from Y?"** → contrastive decomposition:
  1. ONE hybrid_search for the shared concept (e.g., "preloading" for
     lazy_preload vs includes) — BM25 catches both names, semantic catches
     context
  2. Scan results for X-only, Y-only, and both groups by file path
  3. Present as three groups: only-X, only-Y, both Do NOT run two separate
     semantic searches — close concepts produce 80%+ overlap.
- **"What changed recently in X?"** → rank_chunks with `rerank="codeReview"` +
  pathPattern for X + `maxAgeDays=14`. Shows recent changes ranked by review
  relevance (recency, burstActivity, chunkChurn).
- **"Who owns X?" / "Who knows about X?"** → rank_chunks with
  `rerank="ownership"` + pathPattern. Overlay shows `blameDominantAuthor`,
  `blameDominantAuthorPct`, `blameAuthors[]` (live-line ownership from
  `git blame HEAD`). Report ownership distribution.
- **"Who recently committed to X?"** → rank_chunks with
  `rerank="recentActivityConcentration"` + pathPattern. Overlay shows
  `recentDominantAuthor`, `recentDominantAuthorPct`, `recentAuthors[]`
  (commit-based, useful for finding who's mentally loaded in for fast review).
  Different from ownership: a long-time owner who stopped contributing still
  shows in `blame*` but not in `recent*`.
- **"Is X tested?" / "Show tests for X"** → hybrid_search for X name with
  `testFile: "only"` — typed filter, convention-agnostic, no test-dir discovery
  needed (built-in Glob prohibited for code discovery — search-cascade).
  `metaOnly=true` for existence check, `metaOnly=false` for test content. Zero
  hits → find_symbol X `metaOnly=true` to split "exists but untested" from
  "wrong name" before concluding.

## Evidence discipline (broad EXPLAIN)

- Explanation built from SOURCES axis first (behavior truth). Tests = executable
  spec — cite for "should do". Docs = intent/hypothesis — cite for "why", NEVER
  as sole evidence of behavior.
- Behavioral claim taken from a doc chunk → verify via find_symbol /
  hybrid_search BEFORE it enters the answer. Conflict → code wins, flag drift
  ("docs say X, code does Y"). Full rule: `rules/references/axis-splitting.md` +
  search-cascade Principles.

Code citations: `file:line`. Quote 3-5 relevant lines, don't dump functions.
