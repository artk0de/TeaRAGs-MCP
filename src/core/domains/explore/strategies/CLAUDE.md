# domains/explore/strategies — one class per search shape on the applyDefaults → executeExplore → postProcess spine

## Invariants

- **Pagination is client-side: `offset` is sliced AFTER rerank, never sent to
  Qdrant.** `BaseExploreStrategy#applyDefaults` inflates the fetch to
  `(requestedLimit + offset) * multiplier` (floor 20); `#postProcess` slices
  `offset` then `limit` after the rerank call. The caller thus sees a page of
  the RERANKED order. `SimilarSearchStrategy` forwards `offset: ctx.offset` to
  `qdrant.query` (`SimilarSearchStrategy#executeExplore`) AND inherits the base
  slice, so find_similar applies it twice — that is the standing
  counter-example, not the pattern to copy. Why: server-side paging would page
  Qdrant's pre-rerank order, making page 2 of a reranked search meaningless.
  Pushing `offset` down is the instinct a new strategy must resist.
- **`postProcess` receives the ORIGINAL context, not what `applyDefaults`
  returned.** `BaseExploreStrategy#execute` does
  `applyDefaults(ctx) → executeExplore(prepared) → postProcess(rawResults, ctx)`.
  Everything `applyDefaults` computed is invisible downstream and must be
  re-derived: the base repeats `Math.max(limit, 5)`
  (`BaseExploreStrategy#postProcess`), `ScrollRankStrategy` repeats
  `metaOnly !== false` in both halves (`ScrollRankStrategy#applyDefaults` and
  `#postProcess`). So `ctx.limit` means the inflated fetch limit inside
  `executeExplore` and the user's requested limit inside `postProcess`. Why: a
  default added to `applyDefaults` and read in `postProcess` arrives
  `undefined`, and the bug presents as a defaulting error rather than a plumbing
  one. Strategies overriding `applyDefaults` to identity
  (`SymbolSearchStrategy#applyDefaults`, `FileOutlineStrategy#applyDefaults`)
  invert the meaning of `ctx.limit` again.

## Boundaries

- **find_symbol and file-outline read one fixed 200-chunk scroll page and
  truncate silently.** Both override `applyDefaults` to identity (no overfetch)
  and scroll a hard-coded `SCROLL_LIMIT = 200`. find_symbol issues two such
  scrolls (symbolId + parentSymbolId, `SymbolSearchStrategy#executeExplore`) and
  unions them → hard ceiling 400 chunks before post-filtering; a file outline
  sees at most 200 chunks of that file. Neither `postProcess` emits a cursor or
  truncation flag. Why: a class with ~200+ member chunks, or a large file,
  yields a silently incomplete outline, and raising the request `limit` changes
  nothing — it only trims an already-truncated set.

## See also

- `../CLAUDE.md` — rerank/overlay/confidence contracts these strategies feed
  into.
- `.claude/rules/facade-discipline.md`, `.claude/rules/domain-boundaries.md`
