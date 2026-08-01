---
name: risk-assessment
description:
  Assess project/domain health — scan risk zones across dimensions (bugs,
  hotspots, tech debt). Use when asked evaluate risks, find problematic areas,
  assess code health, identify zones needing attention — NOT for specific bug
  symptoms (use bug-hunt instead)
argument-hint: "[scope — domain, subsystem, or 'whole project']"
---

# Risk Assessment

## Phase Order (MANDATORY — do not skip any phase)

🛑 STOP — read all phases before scanning.

1. Phase 1 — SCAN with primary preset
2. Phase 1b — STRUCTURAL scan (**MUST run in the same parallel block —
   structural debt is git-blind, a big quiet method never reaches Phase 1**)
3. Phase 2 — SCAN with stratified second preset (**MUST run, even if Phase 1
   found enough hits — single-preset risk maps are biased**)
4. Phase 3 — MERGE results with negativeIds dedup (**MUST use negativeIds, NEVER
   manual filtering**)
5. Phase 4 — CLASSIFY into severity tiers, score fix cost
6. Phase 5 — REPORT pair-diagnostics (**MUST surface signal pairs, single-signal
   reports are misleading**)

## Top Anti-patterns (read before scanning)

- **Using bug-hunt for risk assessment.** bug-hunt finds ONE root cause. This
  skill scans the risk surface.
- **Single unfiltered scan for broad scope.** Dominant-churn domain takes 100%
  of slots. Always run stratified second scan with `!**/dominant/**`.
- **Classifying from a single signal.** "High churn" alone implies no class.
  Check companion signals (`imports`, `bugFixRate`, `ageDays`, `blockPenalty`)
  before picking a label. See `../../rules/references/signal-interpretation.md`.
- **Folding structural debt into overlap tiers.** Size is not risk. Structural
  hits get their own section, annotated with risk, never a tier slot.

Full list: [references/anti-patterns.md](./references/anti-patterns.md).

---

Multi-dimensional risk scan via rank_chunks × 4 rerank presets, cross-referenced
by overlap count, plus a git-independent structural axis (2 presets) reported
separately. Semantic/hybrid search resolves intent-based scopes.

## Rules

1. **Execute YOURSELF** — no subagents.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
3. **No built-in Search/Grep for code discovery** — use tea-rags tools only.
4. **Search results contain code when metaOnly=false.** Evaluate from search
   results BEFORE any Read or navigation.
5. **Partial reads only.**
   `Read(path, offset=startLine, limit=endLine-startLine)` using coordinates
   from search results. Never read full files.
6. **Minimize tool calls.** Batch: all rank_chunks one message, all Critical
   UUIDs one find_similar, all symbol names one hybrid_search. Target: ≤14 calls
   domain scope, ≤18 broad scope. Phase 4 god-class fallback adds ≤7 (2 probes +
   5 outlines) — only when symbol-mass fields are absent.

## Flow

```
0. SCOPE RESOLUTION   → pathPattern + scopeType
1. SCAN               → rank_chunks × 4 risk presets      ─┐ one parallel block
1b STRUCTURAL         → rank_chunks × decomposition, godModule ─┘
2. MERGE              → risk presets ONLY — structural results never enter tiers
3. EXPAND             → find_similar from Critical only
4. ENRICH             → partial Read + test coverage + codegraph axis + fix cost
                        + god-class attribution + classify
5. OUTPUT             → top-10 risk map + structural risks + structural debt
```

## Phase 0: SCOPE RESOLUTION

Translate $ARGUMENTS into `pathPattern` and `scopeType`.

**Shortcut:** `pathPattern` provided directly as argument (e.g., delegated from
explore PG-2) → use as-is, `scopeType = "domain"`, skip resolution.

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

**pathPattern rules:** Never brace full file paths with slashes — breaks
picomatch. Always extract directory-level prefixes.

**One call only.** Scope resolution not exhaustive.

## Phase 1: SCAN

Run `rank_chunks` × 4 presets. **All 4 calls in ONE message** (parallel).

| Preset      | Surfaces                                         | Filter preset       |
| ----------- | ------------------------------------------------ | ------------------- |
| `bugHunt`   | Burst activity + volatility + bug fix rate       | `panicZone`         |
| `hotspots`  | Chunk-level churn + burst + instability          | `godMethods`        |
| `techDebt`  | Old + churny + bug-prone + dense code            | `abandonedHotspots` |
| `dangerous` | Bug-prone + volatile + single-owner (bus factor) | `fragileSilo`       |

**Codegraph transparency:** when codegraph active (prime `## Enrichment` lists
`codegraph.symbols`), `techDebt` and `dangerous` already absorb structural
signals via reranker override — no parameter change, risk map sharpens
automatically. Explicit structural axis (blast-radius hubs + cycles) added in
Phase 4, not here.

Parameters per call:

```
rank_chunks:
  path: <project>
  rerank: <preset>
  filter: { presets: "<filter-preset>" }   ← dimension-specific (see table above)
  language: <primary language>             ← omit on polyglot codebases
  pathPattern: <from Phase 0>              ← AND-composes with filter preset
  metaOnly: false                          ← REQUIRED (content needed for EXPAND)
  limit: 10
```

**Empty dimension result = clean.** Filter preset narrows to that dimension's
problem population (`godMethods` = oversized methods only) → zero results = "no
such risk in scope", valid answer. Report "✓ No [dimension] risk detected", do
NOT widen filter or retry without preset. Two-pass domain-stratified scan (broad
scope) stays as-is; filter preset AND-composes with `pathPattern` exclusion.

**Polyglot:** 2+ languages each >10% chunks → omit `language` filter. Group by
language in OUTPUT.

**Domain-stratified scanning (broad scope only):**

Unfiltered `rank_chunks` returns results dominated by highest-churn domain.
Other domains invisible regardless of actual risk.

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

Doubles scan calls for broad scope (8 instead of 4), but guarantees every domain
gets representation. Cost acceptable: rank_chunks is scroll operation, not
vector search. No threshold — always run both scans.

**Empty results:** preset returns 0 → exclude from overlap count. N = presets
with results (may be < 4).

**Pagination:** Stop conditions per-preset:

- Gradient drop > 2× average adjacent gap → stop
- < 3 new unique files on page → stop
- Hard cap: 3 pages (offset 0, 10, 20)

One page usually sufficient.

## Phase 1b: STRUCTURAL SCAN

Two more `rank_chunks` calls, SAME message as Phase 1, same `pathPattern`,
`limit: 10`, `metaOnly: false`.

| Preset          | Axis   | Surfaces                                        |
| --------------- | ------ | ----------------------------------------------- |
| `decomposition` | method | Large + dense + high outgoing load (god-method) |
| `godModule`     | file   | Interface mass — god classes, god modules       |

**Why a separate phase.** Structural debt is git-blind. A 300-line method nobody
has touched in two years never churns, never bug-fixes, never reaches Phase 1 —
and never will while decomposition runs as a post-filter over risk hits.

**Results DO NOT enter Phase 2 overlap tiers.** Size is not risk. They get their
own OUTPUT section, annotated with risk and fix cost.

Degradation:

- **Codegraph off** (prime `## Enrichment` lacks `codegraph.symbols`) →
  `decomposition` resolves the size-only static variant. Note "god-method lens
  unavailable — codegraph off". `godModule` resolves the mass-only static
  variant, still valid.
- **Symbol-mass fields absent** (overlay carries no `fileSymbolCount` — index
  predates the signals) → `godModule` ranks flat. Use the Phase 4 fallback
  finder and label the output accordingly.

## Phase 2: MERGE

Cross-reference by `relativePath` (primary key). Within same file, chunks
overlap if `[startLine, endLine]` ranges intersect >50%.

| Overlap | Tier     | Meaning                             |
| ------- | -------- | ----------------------------------- |
| N/N     | Critical | All active dimensions converge      |
| N-1/N   | High     | Strong multi-signal risk            |
| N-2/N   | Medium   | Two signals, may be expected        |
| 1/N     | —        | Single signal — exclude from output |

**Sorting within tier:** Label severity scores: `critical/extreme` = 4,
`concerning/erratic/high` = 3, `typical` = 1, `healthy/low/stable` = 0. Sum
across all overlay signals. Sort descending.

**Healthy demotion:** candidate's bugFixRate `healthy` across ALL presets that
found it → demote one tier (Critical → High, High → Medium). High overlap +
healthy bugFixRate = active development churn, not risk.

**Zero Critical/High:** Skip EXPAND + ENRICH. Output Medium candidates + "No
critical risks found. Codebase appears healthy by multi-signal analysis."

## Phase 3: EXPAND

`find_similar` from **Critical (N/N) candidates only**.

**Negative contrast (healthy-demoted as negativeIds):**

Phase 2 MERGE produces healthy-demoted candidates: high preset overlap but
healthy bugFixRate. Structurally similar to Critical candidates but
well-maintained — exact opposite of antipatterns. Use as negative examples to
sharpen find_similar toward risky code:

```
find_similar vector direction:
  positive = Critical candidates (buggy, churny, oversized)
  negative = healthy-demoted from MERGE (active but clean)
  → result space shifts AWAY from "active development" TOWARD "antipattern"
```

Collect negativeIds from ALL healthy-demoted candidates in Phase 2 (any tier).
No healthy-demoted candidates → skip negativeIds.

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

Scope rules embedded in two-pass description above.

**Filter by overlay:** Include only results with concerning+ signals (bugFixRate
concerning+, OR churnVolatility erratic+, OR `blameContributorCount = 1` —
single live-line owner). Healthy overlay → ignore.

Add qualifying results as "Related risk" under parent Critical candidate.

## Phase 4: ENRICH

For **Critical and High** candidates (typically 5-10 chunks):

**1. Code review** — Content in results (metaOnly=false). Read only when
surrounding context needed. Use chunk coordinates.

**2. Test coverage check** — ONE `hybrid_search`, all Critical/High symbol names
joined as query, `pathPattern` targeting the project's test directory
convention, `metaOnly=true`. BM25 catches exact symbol names in test files. One
call covers all candidates.

- Symbol absent from results → "untested risk zone"
- Symbol present → note test path (do NOT read test content)

**3. Structural amplifier + cycles (codegraph axis).** ONLY when prime shows
`codegraph.symbols` under `## Enrichment`. Line absent → graph tools not
registered — skip, note structural risk not assessed (never claim "no cycles" /
"no hubs"). See search-cascade "Graph navigation" for off-routing.

- **Blast-radius amplifier (`architecturalHub`).** Run `rank_chunks`
  `rerank="architecturalHub"` scoped to same `pathPattern`. Cross-reference
  resulting `isHub=true` / high-`fanIn` files with Critical/High candidates by
  `relativePath`. Risk candidate ALSO a hub = **blast-radius hub** — escalate
  (tag Risk Type, sort to top of its tier): change there ripples across many
  dependents. Amplifier on already-identified risk, NOT a 5th MERGE preset —
  clean high-fanIn hub with healthy git signals is backbone, not risk.
- **Cycles (`find_cycles`).** Run `find_cycles scope=file pathPattern=<scope>`.
  Circular dependencies = structural risk churn presets cannot see. Noise guard:
  > 20 cycles unscoped → narrow by subdomain. Empty result with codegraph ON =
  > valid "no cycles (DAG)". Surface findings in OUTPUT Structural risks
  > section.

**4. Fix-cost classifier** — every Critical/High risk candidate AND every Phase
1b structural candidate. Scored from overlay signals already fetched — zero
extra calls.

| Input                   | 0                | 1         | 2        |
| ----------------------- | ---------------- | --------- | -------- |
| `chunk.fanIn`           | unused / typical | frequent  | central  |
| `file.transitiveImpact` | local            | regional  | systemic |
| `chunk.pageRank`        | peripheral       | important | critical |
| tests (step 2 result)   | present          | absent    | —        |

Sum → 0-2 `cheap`, 3-4 `moderate`, 5+ `expensive`.

Missing tests feeds BOTH risk (defect likelihood) AND cost (refactor safety).
Intentional: one input, two different quantities.

Codegraph off → those rows score 0; mark the estimate partial, never claim
`cheap` from missing signals.

**5. God-class attribution** — for `godModule` hits.

Primary path (overlay carries `fileSymbolCount` / `memberCount` / `classLines`)
— zero extra calls:

- One class holds most of the file's members → **god class**. Report the class
  symbol with `memberCount` + `classLines`.
- Symbols spread top-level, no dominant class → **god module**. Report the file
  with `fileSymbolCount`.

Fallback path (fields absent — index predates symbol-mass signals):

1. `rank_chunks` with
   `filter: { must: [{ key: "chunkIndex", range: { gte: 20 } }] }`,
   `metaOnly: true`, `limit: 20`. Any hit = file with ≥21 chunks — exact lower
   bound, size-unbiased (a class of 40 five-line methods is still caught).
   Adaptive threshold: empty at 20 → probe 10; >20 files → probe 40. Max 2
   probes.
2. Dedupe by `relativePath` → `find_symbol({relativePath})` per candidate,
   cap 5. Exact member counts from the merged outline (distinct member
   symbolIds, `#partN` folded), spans from `startLine` / `endLine`.

Label the output "fallback path — index predates symbol-mass signals". Reported
numbers ALWAYS come from the outline (exact), NEVER from the finder window.

**6. Risk classification** — from overlay labels + tier + test coverage.

**BEFORE picking a class, consult pair diagnostics.** Single overlay signals
ambiguous. `../../rules/references/signal-interpretation.md` gives pair/triple
rules that disambiguate patterns (god module vs bug attractor, healthy owner vs
toxic silo, active development vs coupling, legacy minefield vs proven stable).
Read whenever overlay shows more than one strong signal.

**Key disambiguators** (always check before classifying):

- `imports` (fan-in, file-level) separates coupling (high) from bug attractor
  (low). **Codegraph on → prefer real `fanIn` / `isHub` / `transitiveImpact`
  signals over `imports` proxy** — they measure call/import edges, not raw
  import-line count. See signal-interpretation "Structural signals" +
  blast-radius-hub / cyclic-coupling patterns.
- `bugFixRate` separates healthy (stable) from fragile (unstable)
- `ageDays` inverts churn meaning (old+churn = minefield, young+churn = feature)
- `blameDominantAuthorPct` alone does NOT mean silo; pair with bugFixRate or age
- `recentDominantAuthorPct` = activity concentration (who's committing lately),
  NOT who owns live code — only `blame*` speaks to ownership
- path heuristic (`dto/`, `schema/`, `generated/`) flags boilerplate churn

**File × chunk refinement.** File-level signals point to which file. Chunk-level
signals (`chunk.bugFixRate`, `chunk.ageDays`, `chunk.relativeChurn`,
`chunk.blameContributorCount`, `chunk.recentContributorCount`) point to which
method inside. Overlay shows both → chunk-level locates exact problem:

- Coupling point → find chunk with highest `chunk.recentContributorCount`
  (recently-touched-by-many — overloaded API)
- Knowledge silo zoom-in → find chunk with `chunk.blameContributorCount = 1`
  (single live-line owner of a method inside a shared file)
- Legacy minefield → find chunk with highest
  `chunk.bugFixRate + chunk.relativeChurn`
- Bug attractor → find chunk with highest `chunk.bugFixRate`
- Fossil vs active legacy → `chunk.ageDays` inside old file

See `../../rules/references/signal-interpretation.md` § "Method-level (chunk)
pair diagnostics" for the full table.

See [references/classification-tiers.md](./references/classification-tiers.md)
for the full 13-tier table.

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

## Structural risks (codegraph axis)

Only when codegraph is active. Omit the whole section (or state "structural risk
not assessed — codegraph off") when prime has no `codegraph.symbols`.

- **Blast-radius hubs** — Critical/High candidates that are also `isHub` /
  high-`fanIn`: `symbol() file.ts:line — fanIn:N, blast-radius`.
- **Cycles** — from `find_cycles`: `a.ts → b.ts → a.ts` (or "no cycles — DAG").

## Structural debt (independent of git risk)

| # | Symbol | File:Line | Smell | Size | Fix cost | Also risk? |
|---|--------|-----------|-------|------|----------|------------|
| 1 | Foo#bar() | foo.ts:120 | god-method | 180 LOC, fanOut:14 god-method | cheap | — |
| 2 | Baz | baz.ts:1-740 | god-class | 34 members, 661 LOC | expensive | High #3 |

## Summary

- Critical zones: [count] — require immediate attention
- High zones: [count] — schedule for review
- Test gaps: [count] untested files among Critical/High
- Structural debt: [count] — [count] cheap, [count] also in a risk tier
- Dominant risk type: [most common classification]
- Recommendation: [one-sentence next step]
```

**Structural debt section** — present whenever Phase 1b ran. Sorted by (size ×
cheapness): cheap decomposition candidates on top. `Also risk?` is the only link
back to the risk map; the intersection (structural debt AND risk tier) is the
"do now" quadrant and gets its own Summary line.

**Label mapping:** Use labelMap from `get_index_metrics` (session start). Show
raw value + label: `bugFix:58% concerning`.
