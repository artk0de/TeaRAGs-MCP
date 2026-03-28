# Post-Search Validation (MANDATORY)

**After EVERY search call** (semantic_search, hybrid_search, search_code,
find_similar, rank_chunks), run these checks before reasoning about results.

## No-Match Detection

Absolute scores are meaningless — a nonsensical query can score 0.55 while
legitimate reranked results score 0.27. Detect "no relevant results" using
relative patterns:

1. **Score spread:** `(max_score - min_score) / max_score`. If < 0.06 across
   top-10 → flat distribution, no discriminative power → likely noise.
2. **Lexical overlap:** Do any query terms appear in top-5 file paths, symbol
   names, or chunk content? Zero overlap → strong no-match signal.
3. **Path clustering:** Do top-10 results cluster in ≤3 directories? If
   scattered across >7 unrelated directories → noise.

**Decision:**

- 2 of 3 triggered → warn user: "Results may not be relevant to your query."
  Validate key findings with ripgrep before acting on them.
- All 3 triggered → treat as **no match**. Report to user: "No relevant results
  found for this query." Do NOT reason about irrelevant results.
- 0 or 1 triggered → proceed normally.

## Disambiguation

If top-10 results split into 2+ unrelated directory groups with no single group
holding >70% of results → MUST present clusters to user before proceeding.

"Found results in two areas: [area A] and [area B]. Which context?"

Do NOT silently pick one domain. Do NOT reason about mixed results as one topic.

## Enforcement

These checks are NOT optional. Skipping them leads to:

- Confident analysis of irrelevant code (no-match)
- Wrong domain conclusions ("client" = QBO vs CRM)
- Wasted user time correcting wrong assumptions
