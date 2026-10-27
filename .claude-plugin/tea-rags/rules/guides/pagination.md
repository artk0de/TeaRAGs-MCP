# Pagination, Reformulation & Stop Conditions

## Pagination and Reformulation

Two independent mechanisms, separate counters.

**Pagination** — results relevant, need more:

```
offset=0 → offset=15 → offset=30 → ... (no iteration limit)
```

Same query, same filters, increasing offset.

**Response budget — `truncated`** — any tool answer over ~12k tokens is cut to
fit and says so: `truncated: {returned, omitted, next?, message}`. `returned` /
`omitted` = rows kept / dropped; `next` = the ready call for the omitted rows
(`offset` moved, remaining `limit`, `reportId` for an architecture report);
`message` names the knobs that shrink the answer (`limit`, `pathPattern`,
`metaOnly`, `detectors`…). Next step, in order:

1. Need the omitted rows → run `truncated.next` verbatim (`tool` + `args`).
2. Need fewer rows → re-call with the knob `message` names.
3. Never re-run the identical call — it is cut the same way.

An answer with `truncated` is partial: a count or "none found" claim reads the
answer's totals (`<key>Count`, `summary`), never the listed rows.

**Reformulation** — results NOT relevant:

```
Max 3 attempts: different query / different filters / different rerank
After 3: report "could not find, here's the best match"
```

## Disambiguation (MANDATORY after every search)

After EVERY search scan result paths for domain clustering. Top-10 split into 2+
unrelated directory groups (e.g. `services/qbo/` vs `services/crm/`), none over
70% → MUST NOT silently pick one. Ask user: "Found results in two areas: [area
A] and [area B]. Which context?" Then re-search with `pathPattern` for chosen
area.

## Stop Conditions

Score = ranking signal, NOT cutoff — absolute values meaningless across presets,
collections, queries.

**Score-driven (rank_chunks, rerank-driven analytics):**

- **Gradient drop:** gap between last result of current page and first of next
  page > 2x average gap between adjacent results → stop
- **Diminishing returns:** page has < 3 new unique files not seen in previous
  pages → stop
- **Hard cap:** 3 pages max (offset 0, 15, 30 = 45 results), safety net

**Query-driven (semantic_search, hybrid_search):**

- **Relevance judgment:** content vs query intent — stop when clearly unrelated
  (judgment, not score)
- Reformulation rules apply (max 3 attempts)

**Multi-preset scans:**

- Per-preset: apply score-driven rules independently
- Cross-preset: stop when merge produces < 2 new candidates appearing in 2+
  presets per additional page

## Empty answers — act on `empty.reason`

An empty answer carries `empty: {reason, message, suggestions?}` when the tool
can say why. The reason is the next step; an empty list is never "absent" on its
own. No `empty` block → the tool's own fallback (`find_symbol`: partial name,
then `hybrid_search`). `missing[]` rows of a batched
`find_symbol(symbols: [...])` carry the same kind of `message`.

| `empty.reason`                | Next call                                                                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknownSymbol`               | `find_symbol(symbol: <suggestions[0] verbatim>)` — the id that exists (other `#`/`.` separator, `#partN` parent, same short name); none → partial name (`Class`, bare method) → `hybrid_search(metaOnly: true)`; never "symbol does not exist" before that |
| `unknownProject`              | `list_projects` `project` names no alias: retry `list_projects(project: <suggestions alias>)` — its full record answers embedding / Qdrant / env, not `get_index_status`; none → `list_projects()` (compact rows) and pick by `path`                       |
| `reportStale`                 | the `reportId` page no longer matches a held report: re-call once WITHOUT `reportId` (same scope) for a fresh report, then page that one's `reportId`                                                                                                      |
| `ambiguous`                   | pick the id from `suggestions` that the task names (path, class) → `find_symbol(symbol: <that id>)`                                                                                                                                                        |
| `unknownPath` / `unknownFile` | asked path = typo of a dir the `suggestions` share (`lib/ingst` → `lib/ingest`) → `find_symbol(relativePath: <that corrected dir>)`, not each suggestion; else a `suggestions` path; never report "file/dir does not exist" before that                    |
| `pathPatternMatchesNothing`   | fix the glob: a bare dir matches nothing → `**/<dir>/**`; a named root-relative path stays as-is                                                                                                                                                           |
| `filteredOut`                 | the filter / preset default removed rows: drop or relax the one `message` names, same query                                                                                                                                                                |
| `noEdges`                     | a lower bound, not "no callers": client's standard code search tool `"<name>" <dir>` (literal, files-with-matches) for name-match usages                                                                                                                   |
| `notBuilt`                    | co-change never built for this index: say so; no "no co-change" claim                                                                                                                                                                                      |
| `noHistory`                   | the file has no commits in the window (new / untracked): say "no history", never fabricate                                                                                                                                                                 |
| `noMatch`                     | reformulate (rules above, max 3)                                                                                                                                                                                                                           |

`get_callers` with a wrong `#` / `.` separator resolves through a swap and
reports `resolvedSymbolId` — use that id in every later call.

## No-Match Detection

Detect "no relevant results" via relative patterns in result set:

1. **Score spread:** `(max_score - min_score) / max_score`. If < 0.06 across
   top-10 → flat distribution, no discriminative power → likely noise.
2. **Lexical overlap:** Do any query terms appear in top-5 file paths, symbol
   names, or chunk content? Zero overlap → strong no-match signal.
3. **Path clustering:** Do top-10 cluster in ≤3 directories? Scattered across >7
   unrelated directories → noise.

**Decision:**

- Any 2 of 3 triggered → warn: "results may not be relevant." Validate with text
  search before reasoning about them.
- All 3 triggered → treat as "no match." Report to user.
- 0 or 1 triggered → proceed normally.
