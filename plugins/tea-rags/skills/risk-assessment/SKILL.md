---
name: risk-assessment
description:
  Assess project/domain health — multi-preset risk scan (bugs, hotspots, tech
  debt) into tiers. Use to evaluate risks, assess code health, find zones
  needing attention — NOT one-preset asks like bug-prone areas
  (analytics-rerank), NOT bug symptoms (bug-hunt) or an unframed "something's
  off in X" (dinopowers:systematic-debugging), NOT refactoring candidates
  ("what to refactor in X", "cleanup X" → explore), NOT risks of named
  `Class#method` symbols (explore PRE-GEN). Answer: phases 0–5,
  Critical/High tables (Symbol, File:Line, Risk Type, Key Signals, Tests), final
  Output: line
codex-description:
  Project/domain health — multi-preset risk scan (bugs, hotspots, tech debt)
  into tiers; "evaluate risks", "assess code health", "zones needing attention".
  NOT one-preset asks like bug-prone areas (analytics-rerank). NOT bug symptoms,
  even with zones to check ("проверь зоны A, B") (bug-hunt). NOT an unframed "something's off in X"
  (dinopowers:systematic-debugging). NOT refactoring candidates, "what to
  refactor in X" (explore).
argument-hint: "[scope — domain, subsystem, or 'whole project']"
---

# Risk Assessment

!`tea-rags resource "tea-rags://project/{alias}/metrics?section=labelMap,resolve" --path "$PWD" || true`

**Not this skill — check first:** user feels something is wrong / off in an area
and names no risk dimension (risk, health, debt, hotspots) → stop here, route to
dinopowers:systematic-debugging (unframed symptom: bug-hunt skipped there). No
scan. Prompt names symbol ids (`Class#method`, `Class.static`), even beside an
area word ("pipeline") → stop here, explore PRE-GEN PG-2 replaces this scan;
plan line copied with the prompt's ids:
`find_symbol(symbols=["<id1>", "<id2>", …], rerank="techDebt", metaOnly=false)`.

**Answer contract — reports AND plan-only answers.** Copy the skeleton below:
plan-only → its numbered steps first, one line per phase, never merged or moved
to a preamble; then the Phase 5 tables themselves (format: Phase 5), headings +
header rows, `[planned; not run]` in cells not gathered yet. Prose, a column
list or `Output:` alone is NOT the map. Hand-off only when the prompt mentions
generation ("before implementing" / "generate"): resolved scope + per-symbol
overlay labels, no extra block or scan. `Output:` = last line, verbatim:

```
0. SCOPE (Phase 0): "<word> <process noun>" → ONE semantic_search(query=<phrase>, pathPattern="**/<word>/**") → hits: pathPattern="**/<word>/**" kept; location test: pass → pathPattern; concept → ONE semantic_search → prefixes; whole project → none
1. SCAN — primary + stratified presets, both MUST run; each call pathPattern=<resolved>
   stop per preset: gradient drop > 2× avg gap | < 3 new files | page 3 (offset 20)
1b. STRUCTURAL — same parallel block, pathPattern=<resolved>
2. MERGE — negativeIds dedup, never manual filtering
3. EXPAND — healthy-demoted candidates
4. ENRICH — tiers, fix cost, signal pairs
5. OUTPUT:
## Critical
| # | Symbol | File:Line | Risk Type | Key Signals | Tests |
## High
| # | Symbol | File:Line | Risk Type | Key Signals | Tests |
## Structural risks   (codegraph active)
## Summary
Hand-off: pathPattern + per-symbol File:Line + labels
Output: Critical/High | Symbol | File:Line | Risk Type | Key Signals | Tests(path/none/unverified) + Structural + Summary
```

No `## Label maps` above → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap,resolve`
(ReadMcpResourceTool). `## Codegraph resolve` present = codegraph active.

## Phase Order (MANDATORY — do not skip any phase)

🛑 STOP — read all phases before scanning. Order = the numbered steps of the
skeleton at the top. Phase 1b MUST run in the same parallel block — structural
debt is git-blind, a big quiet method never reaches Phase 1. Stratified scan
MUST run even when Phase 1 found enough hits — single-preset risk maps are
biased. Report signal pairs — single-signal reports mislead.

## Top Anti-patterns (read before scanning)

- **Scanning tests and docs as risk.** Dimension presets pick a risk profile,
  not a code population — tests are often half the corpus and churn hardest.
  Every Phase 1/1b call carries `testFile: "exclude"` +
  `documentation: "exclude"`.
- **One batched hybrid_search for test coverage.** BM25 collapses onto the
  domain with the biggest test files; every other candidate returns empty and
  gets reported "untested". Stratify by domain — see Phase 4 step 2.
- **Extra scan for a named dimension.** "hotspots and ownership in X" = the same
  5 presets (4 codegraph off), scoped. Ownership / bus factor surfaces via
  `dangerous` (single-owner) + overlay `blameContributorCount` — never a
  standalone `ownership` call.
- **Annotating a structural violation instead of escalating** (Critical or High
  candidate) — Phase 4 step 3 prints the escalation line.

Full list: [references/anti-patterns.md](./references/anti-patterns.md).

---

## Rules

**Addressing:** every call passes `path=<your working directory>` +
`project=<alias>`; alias unknown / "not registered" → `path` alone, never ask. A
failed metrics / label-map read never stops the run: Phase 0 still resolves
`pathPattern`, the skeleton prints whole, missing values `[planned; not run]`.

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / `floors: []` / drift on an
answer = distance index↔tree, never licence for Bash `cat` / `sed` / `grep` /
`rg` or `Read` over code. Row without `treeState` = current; `treeState` row →
`find_symbol` re-call. Own checkout with `changedFiles` > 0 → incremental
`index_codebase` now (drift `Run:` with `--force*` → `AskUserQuestion`, never
awaited; print `--force not run; reads continue`; then keep working); subagent /
linked worktree → never reindex. Protocol: `tea-rags://guide/freshness` "Lag
never licenses leaving tea-rags".

1. **Execute YOURSELF** — never dispatch a subagent; you ARE one → run it.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
3. **No built-in Search/Grep for code discovery** — tea-rags tools only.
4. **Search results contain code when metaOnly=false.** Evaluate them BEFORE any
   Read or navigation.
5. **Depth → `find_symbol`, never Read** (`tea-rags://guide/navigation`
   After-Search Navigation): full body `symbol=<symbolId>`, file outline
   `relativePath`, neighbour `navigation.prev/nextSymbolId`. Partial `Read` only
   for non-symbol text (config, data). Never read full files.
6. **Minimize tool calls — but never batch across a ranking boundary.** Batch
   what shares a ranking space: all rank_chunks in one message (separate calls),
   all Critical UUIDs into one find_similar (vector math, order-free). Do NOT
   batch symbol names into one `hybrid_search` — BM25 scores the join as one bag
   of terms and the biggest-file domain takes every slot (see Phase 4 step 2).
   Target: ≤17 calls domain scope, ≤22 broad scope (codegraph off: −1 / −2 — no
   criticalPath). Phase 4 god-class attribution adds ≤5 (one outline per
   `godModule` hit).

## Flow

```
0. SCOPE RESOLUTION   → pathPattern + scopeType
1. SCAN               → rank_chunks × 5 risk presets      ─┐ one parallel block
1b STRUCTURAL         → rank_chunks × decomposition, godModule ─┘
2. MERGE              → risk presets ONLY — structural results never enter tiers
3. EXPAND             → find_similar from Critical only
4. ENRICH             → find_symbol depth + test coverage + codegraph axis + fix cost
                        + god-class attribution + classify
5. OUTPUT             → top-10 risk map + structural risks + structural debt
```

## Phase 0: SCOPE RESOLUTION

Translate $ARGUMENTS into `pathPattern` and `scopeType`.

**Shortcut:** `pathPattern` provided directly as argument (e.g., by a caller
skill) → use as-is, `scopeType = "domain"`, skip resolution.

```
$ARGUMENTS describes...
├─ Broad ("whole project", "all code", no specific area)
│   → pathPattern = none
│   → scopeType = "broad"
│
├─ "<word> <process noun>" — last word pipeline, flow, lifecycle, handling,
│   processing, logic, workflow, a word before it ("<dir> pipeline") — checked
│   BEFORE the location test; the area word is never dropped:
│   → ONE semantic_search(query=<whole phrase>, pathPattern="**/<word>/**",
│     language = primary, limit = 10)
│   → hits → pathPattern = "**/<word>/**" on every scan call, scopeType =
│     "domain"; the phrase stays the query only
│   → 0 hits → <word> is no directory → Concept below, unscoped
│
├─ LOCATION TEST passes — the phrase holds one of: a path ("explore/",
│   "src/x"); a name + container word (domain, module, package, directory,
│   layer, area); one component's agent-noun name ("the chunker", "the parser")
│   → pathPattern = "**/<name>/**" (noun → stem dir: "chunker" → "**/chunk*/**")
│   → scopeType = "domain"
│
└─ Concept (process noun alone, or test fails) — a process, behaviour or topic;
    never guess a directory from its nouns
    → ONE search call (concept/behavior → semantic_search,
      named symbol + context → hybrid_search):
      query = extracted concept, language = primary, limit = 10
    → extract directory prefixes from result relativePaths:
      - Shared prefix → "**/<dir>/**"
      - 2-3 clusters → "{**/dir1/**,**/dir2/**}"
      - Scattered → no pathPattern (scan everything)
    → scopeType = "intent"
```

**pathPattern rules:** Scope = directory-level prefixes. Brace of full file
paths matches ONLY those files — scan misses rest of domain.

**One call only.** Scope resolution not exhaustive.

## Phase 1: SCAN

Run `rank_chunks` × 5 presets. **All 5 calls in ONE message** (parallel).
Codegraph off → 4: skip `criticalPath` (composite, exists in the preset enum
only when codegraph registered — no fallback name).

| Preset         | Surfaces                                                               | Filter preset       |
| -------------- | ---------------------------------------------------------------------- | ------------------- |
| `bugHunt`      | Burst activity + volatility + bug fix rate                             | `panicZone`         |
| `hotspots`     | Chunk-level churn + burst + instability                                | `godMethods`        |
| `techDebt`     | Old + churny + bug-prone + dense code                                  | `abandonedHotspots` |
| `dangerous`    | Bug-prone + volatile + single-owner (bus factor)                       | `fragileSilo`       |
| `criticalPath` | Central methods (pageRank) with bugFix+churn history — regression cost | `hubs`              |

`criticalPath` decorrelates from the git-only rows by population: `hubs` narrows
to high-fanIn hub files (tests/docs already stripped by the mandatory per-call
exclusions — do NOT add `production` to the CSV, see Scan population), so an N/N
hit now also means "in the central population". Empty = no hubs in scope = valid
clean answer.

**Codegraph transparency:** when codegraph active (`## Codegraph resolve`
above), `bugHunt`, `techDebt` and `dangerous` already absorb structural signals
via reranker override (`bugHunt` gains method-level pageRank) — no parameter
change, risk map sharpens automatically. Explicit structural axis (blast-radius
hubs + cycles) added in Phase 4, not here.

Parameters per call:

```
rank_chunks:
  project: <alias>
  path: <your working directory>
  rerank: <preset>
  filter: { presets: "<filter-preset>" }   ← dimension-specific (see table above)
  language: <primary language>             ← omit on polyglot codebases
  pathPattern: <from Phase 0>              ← AND-composes with filter preset
  testFile: "exclude"                      ← REQUIRED — see Scan population
  documentation: "exclude"                 ← REQUIRED — see Scan population
  metaOnly: false                          ← REQUIRED (content needed for EXPAND)
  limit: 10
```

**Scan population — production code only (MANDATORY).** Dimension presets
(`panicZone`, `godMethods`, …) select a RISK profile, not a code population.
Omit the two exclusions and test + doc chunks compete for the 10 slots on equal
footing — on a typical index tests alone are ~half the corpus, and test churn
outranks production churn because tests change with every feature.

**Do NOT substitute `filter: { presets: "production,<dimension>" }`** — drops
block chunks (barrels, config); why: references/anti-patterns.md.

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
After first scan (5 presets × no pathPattern):
1. Identify dominant domain:
   Count unique relativePath directory prefixes across all results.
   The domain with the most slots is dominant.

2. ALWAYS run second scan (broad scope):
   5 presets × pathPattern = "!**/dominant-domain/**"
   Same parameters, same limit.
   Feed both scans into Phase 2 MERGE.
```

Doubles scan calls for broad scope (10 instead of 5), but guarantees every
domain gets representation. Cost acceptable: rank_chunks is scroll operation,
not vector search. No threshold — always run both scans.

**Empty results:** preset returns 0 → exclude from overlap count. N = presets
with results (may be < 5; codegraph off caps at 4).

**Pagination:** Stop conditions per-preset:

- Gradient drop > 2× average adjacent gap → stop
- < 3 new unique files on page → stop
- Hard cap: 3 pages (offset 0, 10, 20)

One page usually sufficient.

## Phase 1b: STRUCTURAL SCAN

Two more `rank_chunks` calls, SAME message as Phase 1, same `pathPattern`, same
`testFile`/`documentation` exclusions, `limit: 10`, `metaOnly: false`.

| Preset          | Axis   | Surfaces                                        |
| --------------- | ------ | ----------------------------------------------- |
| `decomposition` | method | Large + dense + high outgoing load (god-method) |
| `godModule`     | file   | Interface mass — god classes, god modules       |

**Scope to the source tree (MANDATORY).** These two presets rank on raw size, so
a single oversized non-shipping file wins every slot by construction — one
measurement harness at 14059 LOC / 283 methods took BOTH presets' full output
and buried every production module. `production` does NOT help here: it filters
by `isTest`/`isDocumentation`, and a script is neither.

Set `pathPattern` to the source root (`src/**`, `lib/**`, `app/**` — whatever
Phase 0 resolved) when scope is broad. Narrower Phase 0 scope already implies
it. Analysis-only trees — `scripts/`, `tools/`, `bench/`, `examples/` — are not
shipped debt; excluding them is not "hiding" anything.

**Why a separate phase.** Structural debt is git-blind. A 300-line method nobody
has touched in two years never churns, never bug-fixes, never reaches Phase 1 —
and never will while decomposition runs as a post-filter over risk hits.

**Results DO NOT enter Phase 2 overlap tiers.** Size is not risk. They get their
own OUTPUT section, annotated with risk and fix cost.

Degradation:

- **Codegraph off** (request says so, or prime / `metrics?section=registry` says
  off — an unseen graph tool alone is not off) → `decomposition` resolves the
  size-only static variant. Note "god-method lens unavailable — codegraph off".
  `godModule` resolves the mass-only static variant, still valid.

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
healthy bugFixRate — active but clean. Negative examples sharpen find_similar
toward risky code.

Collect negativeIds from ALL healthy-demoted candidates in Phase 2 (any tier).
No healthy-demoted candidates → skip negativeIds.

**Batch expansion** — pass ALL Critical chunk UUIDs in one call:

```
find_similar:
  positiveIds: [<all Critical UUIDs>]   ← batch, not per-candidate
  negativeIds: [<demoted UUIDs>]        ← healthy-demoted from MERGE
  project: <alias>
  path: <your working directory>
  limit: 10
  rerank: bugHunt                       ← surface risky similar, not just similar
  testFile: "exclude"                   ← REQUIRED — a candidate's own test file
                                          is its nearest neighbour by embedding
  pathPattern: <see scope rules>
```

**Two-pass for broad scope only:**

- Pass 1 (in-domain): no pathPattern → 1 call
- Pass 2 (cross-domain): `pathPattern = "!**/dominant-domain/**"` → 1 call

Domain/intent scopes: Pass 1 only (same pathPattern as Phase 0). Total: 1 call.

Label results as "Related risk" (pass 1) or "Cross-domain risk" (pass 2).

**Filter by overlay:** Include only results with concerning+ signals (bugFixRate
concerning+, OR churnVolatility erratic+, OR `blameContributorCount = 1` —
single live-line owner). Healthy overlay → ignore.

Add qualifying results as "Related risk" under parent Critical candidate.

## Phase 4: ENRICH

**MANDATORY: read [references/enrich.md](./references/enrich.md) before Phase
4** — Critical + High candidates (5–10 chunks), six steps in order:

1. Code review — content from results; context → `find_symbol`, never Read.
2. Test coverage — **stratified, one `hybrid_search` per domain cluster, NEVER
   one batched call** (batched BM25 fabricates "untested"); exact mirrored-path
   `find_symbol` preferred.
3. Structural amplifier + cycles — only with graph tools; else "not assessed".
   Critical OR High candidate in a component with an SDP / mainSequence /
   hubLike violation → open `../../repair/<family>.md` of that family only and
   print
   `structural-violation <candidate> — <component> <family>: escalated, Risk Type tagged, top of its tier; fix cost per repair/<family>.md`.
4. Fix-cost classifier. 5. God-class attribution. 6. Risk classification.

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
not assessed — codegraph off") when codegraph is off by that test.

- **Blast-radius hubs** — Critical/High candidates that are also `isHub` /
  high-`fanIn`: `symbol() file.ts:line — fanIn:N, blast-radius`.
- **Structural violations** — Critical/High candidates in a component with an
  SDP / mainSequence / hubLike violation:
  `symbol() file.ts:line — SDP|mainSequence|hubLike, <component>, fix: cheap|…`.
- **Cycles** — from `find_cycles`: `a.ts → b.ts → a.ts` (or "no cycles — DAG").

## Structural debt (independent of git risk)

| # | Symbol | File:Line | Smell | Size | Fix cost | Also risk? |
|---|--------|-----------|-------|------|----------|------------|
| 1 | Foo#bar() | foo.ts:120 | god-method | 180 LOC, fanOut:14 god-method | cheap | — |
| 2 | Baz | baz.ts:1-740 | god-class | 34 members, 661 LOC | expensive | High #3 |

## Summary

- Critical zones: [count] — require immediate attention
- High zones: [count] — schedule for review
- Test gaps: [count] confirmed-untested among Critical/High ([count] unverified)
- Structural debt: [count] — [count] cheap, [count] also in a risk tier
- Dominant risk type: [most common classification]
- Recommendation: [one-sentence next step]
```

**Structural debt section** — present whenever Phase 1b ran. Sorted by (size ×
cheapness): cheap decomposition candidates on top. `Also risk?` is the only link
back to the risk map; the intersection (structural debt AND risk tier) is the
"do now" quadrant and gets its own Summary line.

**Tests column vocabulary.** Three states, never two: the test path when found,
`none` only when the candidate was queried in its own domain cluster and missed,
`unverified` when coverage was not established for it. Never print `none` for a
candidate whose only query was one another domain dominated.

**Label mapping:** bands from `## Label maps` above. Show raw value + label:
`bugFix:58% concerning`.
