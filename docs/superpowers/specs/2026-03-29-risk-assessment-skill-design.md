# Risk Assessment Skill Design

**Date:** 2026-03-29 **Status:** Draft **Scope:** New tea-rags plugin skill for
project/domain health assessment

## Problem

The `bug-hunt` skill is designed for tracing a specific symptom to its root
cause (single search + checkpoint loop). When used for broad risk analysis it
produces results but applies the wrong algorithm: it stops at the first
plausible suspect instead of scanning the full risk surface.

`refactoring-scan` is closer (multi-preset merge) but focuses on refactoring
candidates, not on risk dimensions like ownership, test gaps, or bug density.

There is no skill for answering: "What are the riskiest parts of this
project/domain and why?"

## Solution

A new skill `risk-assessment` in the tea-rags plugin. Multi-dimensional scan
using `rank_chunks` with 4 rerank presets, cross-referenced by overlap count.
Semantic/hybrid search resolves intent-based scopes before scanning.

## Skill Metadata

```yaml
name: risk-assessment
description: >
  Assess project or domain health by scanning for risk zones across multiple
  dimensions (bugs, hotspots, ownership, tech debt). Use when asked to evaluate
  risks, find problematic areas, assess code health, or identify zones that need
  attention.
argument-hint: "[scope — domain, subsystem, or 'whole project']"
user-invocable: true
```

## Trigger Examples

- "assess risks in ingest pipeline"
- "what are the riskiest parts of this project"
- "health check for explore domain"
- "find problem areas"
- "where should we focus testing"
- "what's the most fragile code"

## Algorithm

### Phase 0: SCOPE RESOLUTION

Translate user intent into a `pathPattern` for rank_chunks.

```
$ARGUMENTS describes...
├─ Broad scope ("whole project", "all code", no specific area)
│   → pathPattern = none (scan everything)
│   → scopeType = "broad"
│
├─ Domain/directory ("ingest domain", "explore/", "adapters")
│   → pathPattern = "**/ingest/**" (use directory name matching
│     from explore skill's scope extraction rules)
│   → scopeType = "domain"
│
└─ Intent/concept ("enrichment pipeline", "error handling", "auth")
    → semantic_search or hybrid_search:
      query = extracted concept
      language = primary language from session metrics
      limit = 10
    → extract unique directory prefixes from result relativePaths
    → build pathPattern from common prefix:
      - All results share prefix (e.g. enrichment/) → "**/enrichment/**"
      - Results cluster in 2-3 dirs → "{**/dir1/**,**/dir2/**}"
      - Results scattered → no pathPattern (scan everything, rely on
        semantic overlap in MERGE for signal convergence)
    → scopeType = "intent"
```

**Intent pathPattern rules:** Never use braces with full file paths containing
slashes — this breaks picomatch glob matching. Always extract directory-level
prefixes from results.

**Tool selection for intent scope:** Follow search-cascade decision tree.
Typically hybrid_search (concept + symbol names) or semantic_search (pure
concept). One call is sufficient — scope resolution is not exhaustive.

### Phase 1: SCAN

Run `rank_chunks` with 4 presets. All calls can execute in parallel.

| Preset      | What it surfaces                           |
| ----------- | ------------------------------------------ |
| `bugHunt`   | Burst activity + volatility + bug fix rate |
| `hotspots`  | Chunk-level churn + burst + instability    |
| `ownership` | Single-author code, knowledge silos        |
| `techDebt`  | Old + churny + bug-prone + dense code      |

Parameters for each call:

```
rank_chunks:
  path: <project path>
  rerank: <preset>
  language: <primary language from session metrics>
  pathPattern: <from Phase 0, if any>
  metaOnly: false          ← REQUIRED (default is true; code content needed
                              for EXPAND phase positiveCode)
  limit: 10
```

**Polyglot handling:** On polyglot codebases (2+ languages each >10% of chunks),
omit `language` filter — rank_chunks scans all languages. Group results by
language in OUTPUT phase. On monoglot codebases, set `language` to primary
language to exclude config/docs noise.

**Empty results:** If a preset returns 0 results, exclude it from overlap
calculation. Effective preset count adjusts: e.g., if ownership returns 0
results, max overlap = 3/3 (not 4/4). Tier labels adjust accordingly.

**Pagination:** Apply search-cascade stop conditions per-preset:

- Gradient drop: gap between last result of page N and first of page N+1 exceeds
  2x average adjacent gap on page N
- Diminishing returns: page contains < 3 new unique files
- Hard cap: 3 pages (offset 0, 10, 20 = max 30 per preset)

Typically one page is sufficient. Paginate only when gradient stays flat.

### Phase 2: MERGE

Cross-reference results from all presets by `relativePath` (primary key). Within
the same file, use line range overlap to distinguish chunks (chunk A overlaps
chunk B if their `[startLine, endLine]` ranges intersect by >50%).

**File-level vs chunk-level presets:** `ownership` has `signalLevel: "file"`,
meaning it returns file-aggregated results (no per-chunk granularity). When
matching ownership results against chunk-level results from other presets: all
chunks from that file inherit the ownership hit (+1 overlap).

| Overlap | Tier     | Meaning                               |
| ------- | -------- | ------------------------------------- |
| N/N     | Critical | All active risk dimensions converge   |
| N-1/N   | High     | Strong multi-signal risk              |
| N-2/N   | Medium   | Two signals converge, may be expected |
| 1/N     | —        | Single signal, exclude from output    |

(N = number of presets that returned results; see empty results in Phase 1.)

**Sorting within tier:** Map each overlay signal label to severity score:
`critical/extreme` = 4, `concerning/erratic/high` = 3, `typical` = 1,
`healthy/low/stable` = 0. Sum severity across all overlay signals per candidate.
Sort by descending severity sum within each tier.

**Zero Critical/High after MERGE:** Skip EXPAND and ENRICH. Output Medium
candidates + summary: "No critical risks found. Codebase appears healthy by
multi-signal analysis."

### Phase 3: EXPAND

Run `find_similar` from **Critical (N/N) candidates only**.

```
find_similar:
  positiveIds: [<chunk UUID>]       ← preferred (when id available)
  positiveCode: [<chunk content>]   ← fallback (when id is empty/missing)
  path: <project path>
  limit: 5
  pathPattern: <scope-dependent, see below>
```

**ID availability:** `rank_chunks` returns chunk UUIDs in the `id` field. Use
`positiveIds` when id is present, fall back to `positiveCode` with the chunk's
content from results (requires `metaOnly: false`).

**Scope rules for EXPAND:**

```
scopeType from Phase 0:
├─ "broad"  → no pathPattern (cross-domain expansion allowed)
├─ "domain" → same pathPattern as Phase 0 (stay in domain)
└─ "intent" → same pathPattern as Phase 0 (stay in resolved scope)
```

**Filter by overlay:** Only include find_similar results where overlay shows
concerning+ signals (bugFixRate concerning+, OR churnVolatility erratic+, OR
contributorCount = 1). Healthy overlay = ignore.

Add qualifying results to the risk map as "Related risk" under the parent
Critical candidate.

### Phase 4: ENRICH

For **Critical and High candidates** (typically 5-10 chunks):

1. **Partial Read** — `Read(path, offset=startLine, limit=endLine-startLine)`
   using coordinates from rank_chunks results. Content is already in results if
   metaOnly=false, so Read only when additional context is needed (e.g.,
   surrounding code for understanding).

2. **Test coverage check** — For each candidate file, search for corresponding
   test file:
   - ripgrep MCP: search for filename stem in test directories (`**/tests/**`,
     `**/*.test.ts`, `**/*.spec.ts`)
   - If no test file found → flag as "untested risk zone"
   - If test file exists → note test file path (do NOT read/analyze test content
     unless explicitly asked)

3. **Risk classification** — Based on overlay labels + tier + test coverage,
   classify each candidate:

   | Classification   | Criteria                                            |
   | ---------------- | --------------------------------------------------- |
   | Bug magnet       | bugFixRate concerning+ AND churn high+              |
   | Fragile          | volatility erratic+ AND burst high+                 |
   | Knowledge silo   | contributorCount = 1 AND commitCount high+          |
   | Legacy debt      | ageDays legacy+ AND churn high+ AND bugFix high+    |
   | Untested hotspot | No test file AND tier Critical/High                 |
   | Race condition   | (agent judgment from code content, not signal-only) |

   Multiple classifications per candidate are allowed.

### Phase 5: OUTPUT

Top-10 risk map grouped by module, sorted by tier then worst signal.

```
Risk Assessment: [scope description]
Scanned: [N chunks across M presets], [K unique files]

## Critical (4/4 presets)

| # | Symbol | File:Line | Risk Type | Key Signals | Tests |
|---|--------|-----------|-----------|-------------|-------|
| 1 | ensureDaemon() | daemon.ts:129 | Race condition, Untested | bugFix:58% churn:high burst:extreme | 43 LOC (minimal) |
| 2 | ... | ... | ... | ... | ... |

  Related risks (via find_similar):
  - cleanupDaemonFiles() daemon.ts:85 — same race pattern [bugFix:50%]

## High (3/4 presets)

| # | Symbol | File:Line | Risk Type | Key Signals | Tests |
|---|--------|-----------|-----------|-------------|-------|
| 3 | getStatusFromCollection() | status-module.ts:149 | Fragile | bugFix:50% volatility:erratic | 776 LOC (good) |
| ... |

## Medium (2/4 presets) — [count] candidates

Listed as count only. "Show medium risks" to expand.

## Summary

- Critical zones: [count] — require immediate attention
- High zones: [count] — schedule for review
- Test gaps: [count] files with no tests among Critical/High
- Dominant risk type: [most common classification]
- Recommendation: [one-sentence actionable next step]
```

**Label mapping:** Use labelMap from `get_index_metrics` (loaded at session
start by search-cascade). Map raw signal values to nearest threshold label. Show
both raw value and label: `bugFix:58% concerning`.

## Rules

1. **Execute yourself** — no subagents.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
3. **No built-in Search/Grep for code discovery** — TeaRAGs + ripgrep MCP only.
4. **After every search call, run @post-search-validation.md checks.**
5. **Partial reads only** — use chunk coordinates from results.
6. **One search for scope resolution** — Phase 0 is not exhaustive.
7. **Single-signal results (1/4) are noise** — exclude from output.
8. **find_similar respects scope** — broad scope allows cross-domain, scoped
   stays within domain.
9. **Top-10 output** — paginate on request, never dump all candidates.
10. **Follow search-cascade stop conditions** — for rank_chunks pagination.

## Anti-patterns

- **Using bug-hunt for risk assessment.** bug-hunt finds ONE root cause.
  risk-assessment scans the risk surface.
- **Exhaustive scope resolution.** One semantic/hybrid call. Don't find_similar
  to expand scope — that's pattern-search's job.
- **Reading full files.** Chunk coordinates exist. Use them.
- **Paginating all 4 presets to page 3.** If gradient drops on page 1 — stop.
  Risk surface is usually visible in first 10 results per preset.
- **Reporting 1/4 overlap as risk.** Single-preset hits are expected noise.
  Threshold is 2/4 for Medium, 3/4 for output.
- **find_similar from Medium candidates.** Only Critical candidates warrant
  expansion. Medium is informational.

## Relationship to Existing Skills

| Skill              | When to use                         | How risk-assessment differs                                 |
| ------------------ | ----------------------------------- | ----------------------------------------------------------- |
| `bug-hunt`         | Specific symptom → root cause       | risk-assessment: no symptom, broad scan                     |
| `refactoring-scan` | What to refactor (structural focus) | risk-assessment: multi-dimensional (bugs, ownership, tests) |
| `explore`          | Understand how code works           | risk-assessment: evaluate code health                       |

## Implementation Notes

- Skill file: `.claude-plugin/tea-rags/skills/risk-assessment/SKILL.md`
- No code changes to tea-rags server — uses existing rank_chunks,
  semantic_search, hybrid_search, find_similar tools
- Plugin version: minor bump (new skill)
