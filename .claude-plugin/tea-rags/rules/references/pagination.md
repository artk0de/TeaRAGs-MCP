# Pagination, Reformulation & Stop Conditions

## Pagination and Reformulation

Two independent mechanisms, separate counters.

**Pagination** — results relevant, need more:

```
offset=0 → offset=15 → offset=30 → ... (no iteration limit)
```

Same query, same filters, increasing offset.

**Reformulation** — results NOT relevant:

```
Max 3 attempts: different query / different filters / different rerank
After 3: report "could not find, here's the best match"
```

Paginate indefinitely. Reformulate max 3 times.

## Disambiguation (MANDATORY after every search)

After EVERY search, scan result paths for domain clustering. If top-10 split
into 2+ unrelated directory groups (e.g., `services/qbo/` vs `services/crm/`),
no single group >70% — you MUST NOT silently pick one. Present clusters to user:
"Found results in two areas: [area A] and [area B]. Which context?" Then
re-search with `pathPattern` for chosen area.

## Stop Conditions

Score = ranking signal, NOT cutoff threshold — absolute score values meaningless
across different presets, collections, queries.

**Score-driven (rank_chunks, rerank-driven analytics):**

- **Gradient drop:** gap between last result of current page and first of next
  page > 2x average gap between adjacent results → stop
- **Diminishing returns:** page has < 3 new unique files not seen in previous
  pages → stop
- **Hard cap:** 3 pages max (offset 0, 15, 30 = 45 results), safety net

**Query-driven (semantic_search, hybrid_search):**

- **Relevance judgment:** evaluate result content vs query intent — stop when
  clearly unrelated (agent judgment, not score-based)
- Reformulation rules apply (max 3 attempts)

**Multi-preset scans:**

- Per-preset: apply score-driven rules independently
- Cross-preset: stop when merge produces < 2 new candidates appearing in 2+
  presets per additional page

## No-Match Detection

Detect "no relevant results" via relative patterns within result set:

1. **Score spread:** `(max_score - min_score) / max_score`. If < 0.06 across
   top-10 → flat distribution, no discriminative power → likely noise.
2. **Lexical overlap:** Do any query terms appear in top-5 file paths, symbol
   names, or chunk content? Zero overlap → strong no-match signal.
3. **Path clustering:** Do top-10 cluster in ≤3 directories? Scattered across >7
   unrelated directories → noise.

**Decision:**

- Any 2 of 3 triggered → warn: "results may not be relevant." Validate with
  ripgrep before reasoning about them.
- All 3 triggered → treat as "no match." Report to user.
- 0 or 1 triggered → proceed normally.
