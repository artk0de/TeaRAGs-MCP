# EXPLAIN Pattern

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Structure EXPLAIN step by what was asked.

- **"How does X work?"** → flow: entry → processing → output. Key files + roles.
  Codegraph on → `get_callees(symbolId: <anchor id>, depth: 2)` tree → ONE
  `find_symbol(symbols: [...])` of only the methods the answer needs.
- **"Architecture of X?"** → components, responsibilities, connections,
  boundaries.
- **"Where is X used?"** → hybrid_search (BM25 = full recall on exact names,
  dense = context). Paginate with offset until all usages found
  (`tea-rags://guide/pagination`).
- **"How is X different from Y?"** → contrastive decomposition:
  1. ONE hybrid_search for shared concept (e.g. "preloading" for lazy_preload vs
     includes) — BM25 catches both names, dense catches context
  2. Split results into X-only, Y-only, both by file path
  3. Present three groups. Do NOT run two separate semantic searches — close
     concepts overlap 80%+.
- **"What changed recently in X?"** → rank_chunks `rerank="codeReview"` +
  pathPattern + `maxAgeDays=14` (recency, burstActivity, chunkChurn).
- **"Who owns X?" / "Who knows about X?"** → rank_chunks `rerank="ownership"` +
  pathPattern. Overlay: `blameDominantAuthor`, `blameDominantAuthorPct`,
  `blameAuthors[]` (live-line ownership, `git blame HEAD`). Report distribution.
- **"Who recently committed to X?"** → rank_chunks
  `rerank="recentActivityConcentration"` + pathPattern. Overlay:
  `recentDominantAuthor`, `recentDominantAuthorPct`, `recentAuthors[]`
  (commit-based — who's loaded in for fast review). Differs from ownership:
  owner who stopped contributing shows in `blame*`, not `recent*`.
- **"Is X tested?" / "Show tests for X"** → hybrid_search X with
  `testFile: "only"` — typed filter, convention-agnostic, no test-dir discovery
  (Glob prohibited — `tea-rags://guide/prohibited-patterns`). `metaOnly=true` =
  existence, `metaOnly=false` = test content. Zero hits → find_symbol X
  `metaOnly=true` to split "exists but untested" from "wrong name".

## Evidence discipline (broad EXPLAIN)

- Build from SOURCES axis first (behavior truth). Tests = executable spec → cite
  for "should do". Docs = intent/hypothesis → cite for "why", NEVER sole
  evidence of behavior.
- Behavioral claim from doc chunk → verify via a `documentation:"exclude"`
  search + `find_symbol` BEFORE it enters answer. Conflict → code wins; answer
  states the code value and names the drifted doc: "`<doc path>` says X, code
  does Y at `file:line`". Full rule: `../../../references/axis-splitting.md`.

Citations `file:line`. Quote 3-5 lines, don't dump functions.
