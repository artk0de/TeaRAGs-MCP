---
name: risk-assessment
description:
  Assess project or domain health by scanning for risk zones across multiple
  dimensions (bugs, hotspots, tech debt). Use when asked to evaluate risks, find
  problematic areas, assess code health, or identify zones that need attention —
  NOT for specific bug symptoms (use bug-hunt instead)
argument-hint: "[scope — domain, subsystem, or 'whole project']"
---

# Risk Assessment

Multi-dimensional risk scan using rank_chunks with 4 rerank presets,
cross-referenced by overlap count. Semantic/hybrid search resolves intent-based
scopes.

## Rules

1. **Execute YOURSELF** — no subagents.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
3. **No built-in Search/Grep for code discovery** — use tea-rags tools only.
4. **Search results contain code when metaOnly=false.** Evaluate from search
   results BEFORE any Read or navigation.
5. **Partial reads only.**
   `Read(path, offset=startLine, limit=endLine-startLine)` using coordinates
   from search results. Never read full files.
6. **Minimize tool calls.** Batch where possible: all rank_chunks in one
   message, all Critical UUIDs in one find_similar, all symbol names in one
   hybrid_search. Target: ≤12 calls for domain scope, ≤16 for broad scope.

## Flow

```
0. SCOPE RESOLUTION   → pathPattern + scopeType
1. SCAN               → rank_chunks × 4 presets (parallel)
2. MERGE              → cross-reference by relativePath, assign tiers
3. EXPAND             → find_similar from Critical only
4. ENRICH             → partial Read + test coverage check + classify
5. OUTPUT             → top-10 risk map
```

## Phase 0: SCOPE RESOLUTION

Translate $ARGUMENTS into `pathPattern` and `scopeType`.

**Shortcut:** If `pathPattern` is provided directly as argument (e.g., delegated
from explore PG-2) → use it as-is, `scopeType = "domain"`, skip resolution.

```
$ARGUMENTS describes...
├─ Broad ("whole project", "all code", no specific area)
│   → pathPattern = none
│   → scopeType = "broad"
│
├─ Domain/directory ("ingest domain", "explore/", "adapters")
│   → pathPattern = "**/ingest/**"
│   → scopeType = "domain"
│
└─ Intent/concept ("enrichment pipeline", "error handling")
    → ONE search call (concept/behavior → semantic_search,
      named symbol + context → hybrid_search):
      query = extracted concept, language = primary, limit = 10
    → extract directory prefixes from result relativePaths:
      - Shared prefix → "**/enrichment/**"
      - 2-3 clusters → "{**/dir1/**,**/dir2/**}"
      - Scattered → no pathPattern (scan everything)
    → scopeType = "intent"
```

**pathPattern rules:** Never use braces with full file paths containing slashes
— breaks picomatch. Always extract directory-level prefixes.

**One call only.** Scope resolution is not exhaustive.

## Phase 1: SCAN

Run `rank_chunks` × 4 presets. **All 4 calls in ONE message** (parallel).

| Preset      | Surfaces                                         |
| ----------- | ------------------------------------------------ |
| `bugHunt`   | Burst activity + volatility + bug fix rate       |
| `hotspots`  | Chunk-level churn + burst + instability          |
| `techDebt`  | Old + churny + bug-prone + dense code            |
| `dangerous` | Bug-prone + volatile + single-owner (bus factor) |

Parameters per call:

```
rank_chunks:
  path: <project>
  rerank: <preset>
  language: <primary language>     ← omit on polyglot codebases
  pathPattern: <from Phase 0>
  metaOnly: false                  ← REQUIRED (content needed for EXPAND)
  limit: 10
```

**Polyglot:** If 2+ languages each >10% chunks → omit `language` filter. Group
by language in OUTPUT.

**Domain-stratified scanning (broad scope only):**

Unfiltered `rank_chunks` returns results dominated by the highest-churn domain.
Other domains are invisible regardless of their actual risk.

```
After first scan (4 presets × no pathPattern):
1. Identify dominant domain:
   Count unique relativePath directory prefixes across all results.
   The domain with the most slots is dominant.

2. ALWAYS run second scan (broad scope):
   4 presets × pathPattern = "!**/dominant-domain/**"
   Same parameters, same limit.
   Feed both scans into Phase 2 MERGE.
```

This doubles the scan calls for broad scope (8 instead of 4), but guarantees
every domain gets representation. The cost is acceptable: rank_chunks is a
scroll operation, not vector search. No threshold — always run both scans.

**Empty results:** If a preset returns 0 results, exclude from overlap count. N
= number of presets with results (may be < 4).

**Pagination:** Stop conditions per-preset:

- Gradient drop > 2× average adjacent gap → stop
- < 3 new unique files on page → stop
- Hard cap: 3 pages (offset 0, 10, 20)

One page is usually sufficient.

## Phase 2: MERGE

Cross-reference by `relativePath` (primary key). Within same file, chunks
overlap if `[startLine, endLine]` ranges intersect by >50%.

| Overlap | Tier     | Meaning                             |
| ------- | -------- | ----------------------------------- |
| N/N     | Critical | All active dimensions converge      |
| N-1/N   | High     | Strong multi-signal risk            |
| N-2/N   | Medium   | Two signals, may be expected        |
| 1/N     | —        | Single signal — exclude from output |

**Sorting within tier:** Label severity scores: `critical/extreme` = 4,
`concerning/erratic/high` = 3, `typical` = 1, `healthy/low/stable` = 0. Sum
across all overlay signals. Sort descending.

**Healthy demotion:** If a candidate's bugFixRate is `healthy` across ALL
presets that found it, demote by one tier (Critical → High, High → Medium). High
overlap with healthy bugFixRate = active development churn, not risk.

**Zero Critical/High:** Skip EXPAND + ENRICH. Output Medium candidates + "No
critical risks found. Codebase appears healthy by multi-signal analysis."

## Phase 3: EXPAND

`find_similar` from **Critical (N/N) candidates only**.

**Negative contrast (healthy-demoted as negativeIds):**

Phase 2 MERGE produces healthy-demoted candidates: high preset overlap but
healthy bugFixRate. These are structurally similar to Critical candidates but
well-maintained — the exact opposite of antipatterns. Use them as negative
examples to sharpen find_similar toward risky code:

```
find_similar vector direction:
  positive = Critical candidates (buggy, churny, oversized)
  negative = healthy-demoted from MERGE (active but clean)
  → result space shifts AWAY from "active development" TOWARD "antipattern"
```

Collect negativeIds from ALL healthy-demoted candidates in Phase 2 (any tier).
If no healthy-demoted candidates exist, skip negativeIds.

**Batch expansion** — pass ALL Critical chunk UUIDs in one call:

```
find_similar:
  positiveIds: [<all Critical UUIDs>]   ← batch, not per-candidate
  negativeIds: [<demoted UUIDs>]        ← healthy-demoted from MERGE
  path: <project>
  limit: 10
  rerank: bugHunt                       ← surface risky similar, not just similar
  pathPattern: <see scope rules>
```

**Two-pass for broad scope only:**

- Pass 1 (in-domain): no pathPattern → 1 call
- Pass 2 (cross-domain): `pathPattern = "!**/dominant-domain/**"` → 1 call

Domain/intent scopes: Pass 1 only (same pathPattern as Phase 0). Total: 1 call.

Label results as "Related risk" (pass 1) or "Cross-domain risk" (pass 2).

Scope rules are embedded in the two-pass description above.

**Filter by overlay:** Include only results with concerning+ signals (bugFixRate
concerning+, OR churnVolatility erratic+, OR contributorCount = 1). Healthy
overlay → ignore.

Add qualifying results as "Related risk" under parent Critical candidate.

## Phase 4: ENRICH

For **Critical and High** candidates (typically 5-10 chunks):

**1. Code review** — Content is in results (metaOnly=false). Read only when
additional surrounding context needed. Use chunk coordinates.

**2. Test coverage check** — ONE `hybrid_search` with all Critical/High symbol
names joined as query, `pathPattern` targeting the project's test directory
convention, `metaOnly=true`. BM25 catches exact symbol names in test files. One
call covers all candidates.

- Symbol absent from results → "untested risk zone"
- Symbol present → note test path (do NOT read test content)

**3. Decomposition check** — Run `rank_chunks` with `decomposition` preset,
scoped to the same pathPattern. Cross-reference with Critical/High candidates by
relativePath. If a risk candidate is also a decomposition candidate (methodLines
label = high+ from labelMap) → add "Oversized" classification. This is NOT a 4th
preset in MERGE — decomposition measures size, not risk. It's a post-filter on
already-identified risk zones.

**4. Risk classification** — from overlay labels + tier + test coverage:

| Classification   | Criteria                                                      |
| ---------------- | ------------------------------------------------------------- |
| Bug magnet       | bugFixRate concerning+ AND churn high+                        |
| Fragile          | volatility erratic+ AND burst high+                           |
| Legacy debt      | ageDays legacy+ AND churn high+ AND bugFix high+              |
| Untested hotspot | No test file AND tier Critical/High                           |
| Oversized        | methodLines high+ (from labelMap) AND in decomposition top-10 |
| Knowledge silo   | knowledgeSilo high+ AND contributorCount = 1                  |
| Race condition   | Agent judgment from code content                              |

Multiple classifications per candidate allowed.

## Phase 5: OUTPUT

Top-10 risk map, sorted by tier → severity sum.

```
Risk Assessment: [scope]
Scanned: [N chunks across M presets], [K unique files]

## Critical (N/N presets)

| # | Symbol | File:Line | Risk Type | Key Signals | Tests |
|---|--------|-----------|-----------|-------------|-------|
| 1 | symbol() | file.ts:42 | Bug magnet, Untested | bugFix:58% concerning churn:high | none |

  Related risks (find_similar):
  - relatedFn() file.ts:85 — same pattern [bugFix:50% concerning]

## High (N-1/N presets)

| # | Symbol | File:Line | Risk Type | Key Signals | Tests |
|---|--------|-----------|-----------|-------------|-------|
| 2 | symbol() | file.ts:149 | Fragile | volatility:erratic burst:extreme | 776 LOC |

## Medium (N-2/N) — [count] candidates

Count only. "Show medium risks" to expand.

## Summary

- Critical zones: [count] — require immediate attention
- High zones: [count] — schedule for review
- Test gaps: [count] untested files among Critical/High
- Dominant risk type: [most common classification]
- Recommendation: [one-sentence next step]
```

**Label mapping:** Use labelMap from `get_index_metrics` (session start). Show
raw value + label: `bugFix:58% concerning`.

## Anti-patterns

- **Using bug-hunt for risk assessment.** bug-hunt finds ONE root cause. This
  skill scans the risk surface.
- **Exhaustive scope resolution.** One semantic/hybrid call. Don't find_similar
  to expand scope — that's pattern-search's job.
- **Reading full files.** Chunk coordinates exist. Use them.
- **Paginating all 3 presets to page 3.** If gradient drops on page 1 — stop.
- **Reporting 1/N overlap as risk.** Single-preset hits are noise. Minimum 2/N
  for Medium.
- **find_similar from Medium candidates.** Only Critical warrants expansion.
- **Braces with slashes in pathPattern.** Extract directory prefixes instead.
- **Single unfiltered scan for broad scope.** Dominant-churn domain takes 100%
  of slots. Always run stratified second scan with `!**/dominant/**`.
- **find_similar without negativeIds.** Healthy-demoted candidates from MERGE
  are free negative examples. Always pass them to shift results toward
  antipatterns and away from active-but-clean code.
