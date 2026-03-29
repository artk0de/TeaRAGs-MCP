# Pagination, Reformulation & Stop Conditions

## Pagination and Reformulation

Two independent mechanisms with separate counters.

**Pagination** — results are relevant, need more:

```
offset=0 → offset=15 → offset=30 → ... (no iteration limit)
```

Same query, same filters, increasing offset.

**Reformulation** — results are NOT relevant:

```
Max 3 attempts: different query / different filters / different rerank
After 3: report "could not find, here's the best match"
```

Can paginate indefinitely. Can reformulate max 3 times.

## Disambiguation (MANDATORY after every search)

After EVERY search, scan result paths for domain clustering. If top-10 results
split into 2+ unrelated directory groups (e.g., `services/qbo/` vs
`services/crm/`) with no single group holding >70% of results — you MUST NOT
silently pick one. Present clusters to the user: "Found results in two areas:
[area A] and [area B]. Which context?" Then re-search with `pathPattern` for the
chosen area.

## Stop Conditions

Score is a ranking signal, not a cutoff threshold — absolute score values are
meaningless across different presets, collections, and queries.

**Score-driven (rank_chunks, rerank-driven analytics):**

- **Gradient drop:** if gap between last result of current page and first result
  of next page > 2x the average gap between adjacent results → stop
- **Diminishing returns:** page contains < 3 new unique files not seen in
  previous pages → stop
- **Hard cap:** 3 pages max (offset 0, 15, 30 = 45 results) as safety net

**Query-driven (semantic_search, hybrid_search):**

- **Relevance judgment:** evaluate result content against query intent — stop
  when results are clearly unrelated (agent judgment, not score-based)
- Reformulation rules apply (max 3 attempts)

**Multi-preset scans:**

- Per-preset: apply score-driven rules independently
- Cross-preset: stop when merge produces < 2 new candidates appearing in 2+
  presets per additional page

## No-Match Detection

Detect "no relevant results" using relative patterns within the result set:

1. **Score spread:** `(max_score - min_score) / max_score`. If < 0.06 across
   top-10 → flat distribution, query has no discriminative power → likely noise.
2. **Lexical overlap:** Do any query terms appear in top-5 file paths, symbol
   names, or chunk content? Zero overlap → strong no-match signal.
3. **Path clustering:** Do top-10 results cluster in ≤3 directories? If
   scattered across >7 unrelated directories → noise.

**Decision:**

- Any 2 of 3 triggered → warn: "results may not be relevant." Validate with
  ripgrep before reasoning about them.
- All 3 triggered → treat as "no match." Report to user.
- 0 or 1 triggered → proceed normally.
