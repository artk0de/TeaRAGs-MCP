---
title: Line-based ownership signals (git blame as source of truth)
date: 2026-05-06
status: draft
beads_epic: TBD
---

# Line-based ownership signals from `git blame HEAD`

## Problem

Current ownership signals (`dominantAuthor`, `dominantAuthorPct`, `authors[]`,
`contributorCount`) are computed from `git log` commits within the
`TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS` window (default 12 months) by **commit
count** in `computeFileSignals`
(`src/core/domains/trajectory/git/infra/metrics.ts:124`).

Two failure modes:

1. **Window cuts history.** A file written 2 years ago by Alice with one recent
   fix-commit by Bob now reports Bob as 100% dominant — Alice is invisible.
2. **Metric is "commits", not "lines".** One commit of 500 lines vs ten one-line
   commits — current logic assigns ownership to the latter.

Chunk-level ownership is **absent entirely** — `ChunkChurnOverlay`
(`src/core/domains/trajectory/git/types.ts:73-96`) only carries
`contributorCount` (a number); author names are not published per-chunk.

## Solution overview

Introduce a second source of truth — `git blame HEAD` — and compute ownership as
**share of live lines per author**. One blame pass per file feeds both file and
chunk levels (chunk = subset of blame lines in `startLine..endLine`).

Existing `dominantAuthor*` fields stay (semantics: "recent activity within
window"). New `lineDominantAuthor*` fields are added (semantics: "owner of live
lines in HEAD"). Derived signals `OwnershipSignal` and `KnowledgeSiloSignal` are
reoriented to read line-based fields — this is the **critical observable
behavior change**: every preset that uses `ownership` or `knowledgeSilo` weight
automatically switches to blame-based scoring.

A new derived signal `recentActivityConcentration` is introduced for cases where
commit-based concentration is the right lens (`codeReview`, `onboarding`).

## tea-rags impact enrichment

Custom rerank `{imports: 0.5, churn: 0.3, ownership: 0.2}` over the affected
src/ file set:

| File                                                                                                       | Owner (current) | commitCount label | Notes                                            |
| ---------------------------------------------------------------------------------------------------------- | --------------- | ----------------- | ------------------------------------------------ |
| `src/core/domains/trajectory/git/infra/chunk-reader.ts`                                                    | Arthur (silo)   | low               | core blame integration point                     |
| `src/core/domains/trajectory/git/infra/metrics.ts`                                                         | Arthur (silo)   | low               | `computeFileSignals` lives here                  |
| `src/core/domains/trajectory/git/infra/metrics/file-assembler.ts`                                          | Arthur (silo)   | low               | wires authorship into `GitFileSignals`           |
| `src/core/domains/trajectory/git/infra/metrics/extractors.ts`                                              | Arthur (silo)   | low               | `computeDominantAuthor`                          |
| `src/core/domains/trajectory/git/types.ts`                                                                 | Arthur (silo)   | low               | `GitFileSignals`, `ChunkChurnOverlay`            |
| `src/core/domains/trajectory/git/payload-signals.ts`                                                       | Arthur (silo)   | typical           | schema (8 new keys)                              |
| `src/core/domains/trajectory/git/rerank/derived-signals/ownership.ts`                                      | Arthur (silo)   | low               | `sources` reorientation                          |
| `src/core/domains/trajectory/git/rerank/derived-signals/knowledge-silo.ts`                                 | Arthur (silo)   | low               | `sources` reorientation                          |
| `src/core/domains/trajectory/git/rerank/presets/{ownership,tech-debt,dangerous,code-review,onboarding}.ts` | Arthur (silo)   | typical           | overlay masks; weights for codeReview/onboarding |
| `src/core/domains/trajectory/git/filters.ts`                                                               | Arthur (silo)   | typical           | new `lineDominantAuthor` filter                  |
| `src/core/domains/trajectory/git/stats/author-counts.ts`                                                   | Arthur (silo)   | low               | optional second accumulator                      |
| `src/mcp/resources/registry.ts`                                                                            | Arthur (silo)   | high              | docs auto-generation                             |
| `src/mcp/tools/output-schemas.ts`                                                                          | Arthur (silo)   | low               | zod output schema                                |

All affected files have a single owner — no coordinated-change risk across
contributors. High-blast-radius file: `payload-signals.ts` (consumed by every
search path via reranker), so payload schema additions must be additive only.

No connected taskIds across this set — work originates from this design session.

## Decisions

1. **Additive, not replacing.** Keep `dominantAuthor*` (recent activity
   semantics); add `lineDominantAuthor*` (true ownership). Renaming would break
   50+ call sites in src + plugins + docs.
2. **One blame pass per file feeds both levels.** `git blame HEAD -- file`
   returns `BlameLine[]`, file-level aggregates everything, chunk-level filters
   by range. Cache by `lastCommitHash`.
3. **Adaptive labels, not magic numbers.** Plugin SKILL.md files currently
   compare raw `dominantAuthorPct ≥ 95%` — anti-pattern that bypasses
   `stats.labels` and adaptive bounds. Sweep replaces hardcoded thresholds with
   `label === "deep-silo"` or `derived.ownership > 0.7`.
4. **Schema drift, not migration.** Eight new payload fields are additive; user
   runs `index_codebase forceReindex=true` to populate.
5. **Behavior change is a release-noted event.** `ownership` preset returns
   different top-N after this change. CHANGELOG entry is mandatory; consider
   `BREAKING CHANGE:` footer because plugin heuristics rely on prior smysl.

## Out of scope

- `linesByAuthor: Record<author, pct>` full distribution map — payload bloat;
  `lineAuthors[]` (top-N) is enough.
- Agent-vs-human commit labelling (separate roadmap question).
- Migration of existing payload to backfill `lineDominantAuthor*` without
  reindex (no partial-update mechanism for blame data).
- Renaming `dominantAuthor*` to `recentDominantAuthor*` (out of scope; would
  break too much; semantics clarified in docs instead).

## Tasks

### Task 1 — Adapter: `git blame HEAD` primitive

**Goal:** Ensure `BlameClient` exposes a fast file-level blame returning
`BlameLine[] = { lineNumber, author, authorEmail, sha, timestamp }`. Add or
verify the method; do not duplicate.

**Affected files**

| File                                                    | Change                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `src/core/adapters/git/types.ts`                        | Confirm `BlameLine`/`BlameResult` types (extend if needed) |
| `src/core/adapters/git/blame-client.ts` (or equivalent) | Confirm/add `blameAll(filePath): Promise<BlameLine[]>`     |

**Verification**

- [ ] Unit test: blame on a file with 2+ authors returns expected per-line
      authorship
- [ ] Empty/uncommitted file → empty array, no throw

### Task 2 — Compute layer: blame ownership extractor

**Goal:** New module that aggregates `BlameLine[]` into file and chunk ownership
signals.

**Affected files**

| File                                                                                | Change                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/trajectory/git/infra/ownership/blame-ownership.ts` _(new)_        | Export `BlameOwnership` type; `computeBlameOwnership(blameLines, chunkRanges?)` returning `{ file: BlameOwnership, chunks: Map<chunkId, BlameOwnership> }` |
| `src/core/domains/trajectory/git/infra/ownership/index.ts` _(new)_                  | Barrel                                                                                                                                                     |
| `tests/core/domains/trajectory/git/infra/ownership/blame-ownership.test.ts` _(new)_ | Unit tests                                                                                                                                                 |

**Output type**

```ts
interface BlameOwnership {
  lineDominantAuthor: string;
  lineDominantAuthorPct: number; // 0-100
  lineAuthors: string[]; // top-N (cap N=10)
  lineContributorCount: number;
}
```

**Verification**

- [ ] Aggregation: 80 lines Alice / 20 lines Bob →
      `{Alice, 80, [Alice, Bob], 2}`
- [ ] Range filter: chunk on lines 50-60 → only blame lines in that range
- [ ] Empty input → `{"unknown", 0, [], 0}`

### Task 3 — Payload schema: 8 new fields with adaptive labels

**Goal:** Register the line-ownership signals in `payload-signals.ts` so they
appear in overlays and `get_index_metrics` distributions.

**Affected files**

| File                                                      | Change                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/core/domains/trajectory/git/payload-signals.ts`      | Add 8 entries (4 file + 4 chunk)                                                                     |
| `src/core/infra/migration/...` (schemaDrift registration) | Mark new fields so `get_index_status` prompts user to reindex                                        |
| `src/core/domains/trajectory/git/types.ts`                | Extend `GitFileSignals` and `ChunkChurnOverlay` (or `GitChunkSignals` analog) with the 4 fields each |

**Field set (file-level — `git.file.*`)**

| Key                     | Type     | Description                                           | `stats.labels`                                                        | essential |
| ----------------------- | -------- | ----------------------------------------------------- | --------------------------------------------------------------------- | --------- |
| `lineDominantAuthor`    | string   | Author owning most live lines (git blame HEAD)        | —                                                                     | true      |
| `lineDominantAuthorPct` | number   | % of live lines owned by `lineDominantAuthor` (0-100) | `{p50: "shared", p75: "concentrated", p90: "silo", p95: "deep-silo"}` | true      |
| `lineAuthors`           | string[] | All contributors to live lines (top-N capped)         | —                                                                     | —         |
| `lineContributorCount`  | number   | Distinct authors of live lines                        | `{p25: "solo", p50: "pair", p75: "team", p95: "crowd"}`               | true      |

**Field set (chunk-level — `git.chunk.*`)** — symmetric

| Key                     | Type     | Description                                                          | `stats.labels`                                                        | essential |
| ----------------------- | -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | --------- |
| `lineDominantAuthor`    | string   | Author owning most live lines **inside chunk range**                 | —                                                                     | true      |
| `lineDominantAuthorPct` | number   | % of live lines in chunk range owned by chunk's `lineDominantAuthor` | `{p50: "shared", p75: "concentrated", p90: "silo", p95: "deep-silo"}` | true      |
| `lineAuthors`           | string[] | Distinct authors with lines in chunk range                           | —                                                                     | —         |
| `lineContributorCount`  | number   | Distinct authors of chunk's live lines                               | `{p25: "solo", p50: "pair", p75: "team", p95: "crowd"}`               | true      |

**Verification**

- [ ] `get_index_status` returns `schemaDrift` block listing the 8 new fields
      after upgrade-without-reindex
- [ ] After `forceReindex=true`, fields appear in `get_index_metrics`
      distributions with computed thresholds

### Task 4 — Pipeline wire-in

**Goal:** Hook the blame ownership computation into the existing enrichment
pipeline so file and chunk records receive the new fields.

**Affected files**

| File                                                                                    | Change                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/domains/trajectory/git/infra/metrics/file-assembler.ts`                       | After `assembleFileSignals` calls existing extractors, also call `computeBlameOwnership(blameLines)` and merge the file-level fields into the assembled `GitFileSignals` |
| `src/core/domains/trajectory/git/infra/chunk-reader.ts`                                 | After existing chunk accumulators run, distribute blame ownership per chunk range and merge the chunk-level fields into each `ChunkChurnOverlay`                         |
| `src/core/domains/trajectory/git/infra/cache/blame-cache.ts` _(new or extend existing)_ | Cache `BlameLine[]` by file path + `lastCommitHash` to avoid re-blaming on incremental reindex                                                                           |

**Critical:** the blame call is **per file, once**, not per chunk. Chunk
ownership is derived by filtering already-computed `BlameLine[]` by range.

**Verification**

- [ ] Indexed payload contains the 8 fields after fresh reindex
- [ ] Incremental reindex of a file with unchanged HEAD does **not** trigger a
      new `git blame` (cache hit)
- [ ] File with 2 chunks owned by different authors shows different
      `git.chunk.lineDominantAuthor` values for the two chunks

### Task 5 — Derived signals reorientation + `recentActivityConcentration`

**Goal:** Reorient `OwnershipSignal` and `KnowledgeSiloSignal` to read
line-based fields. Introduce new signal for commit-based concentration so
presets that need recent-activity semantics have an explicit lever.

**Affected files**

| File                                                                                              | Change                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/domains/trajectory/git/rerank/derived-signals/ownership.ts`                             | `sources` → `["file.lineDominantAuthorPct", "file.lineAuthors"]`; `extract()` body uses new sources; description updated to "live-lines author concentration"      |
| `src/core/domains/trajectory/git/rerank/derived-signals/knowledge-silo.ts`                        | `sources` → `["file.lineAuthors"]`; description updated                                                                                                            |
| `src/core/domains/trajectory/git/rerank/derived-signals/recent-activity-concentration.ts` _(new)_ | New `DerivedSignalDescriptor`, name `recentActivityConcentration`, sources `["file.dominantAuthorPct", "file.authors"]` (preserves old semantics for who needs it) |
| `src/core/domains/trajectory/git/rerank/derived-signals/index.ts`                                 | Register new signal                                                                                                                                                |
| `src/core/contracts/types/reranker.ts`                                                            | Add `recentActivityConcentration` to `ScoringWeights` keys                                                                                                         |
| `tests/core/domains/trajectory/git/rerank/derived-signals/*.test.ts`                              | Update existing tests for new sources; add tests for new signal                                                                                                    |

**Verification**

- [ ] Same query with `rerank: "ownership"` on a repo with old + new active
      author returns measurably different top-20 vs prior version
- [ ] Custom rerank `{recentActivityConcentration: 1.0}` ranks files by recent
      commits-based concentration

### Task 6 — Preset sweep

**Goal:** Update preset weights and overlay masks to reflect the split.
Critical: this is where observable behavior change is **explicitly** opted into
per use-case, not implicit via signal redirect.

**Affected files**

| File                                                                                                 | Change                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/trajectory/git/rerank/presets/ownership.ts`                                        | Same weights (`ownership`, `knowledgeSilo` now blame-based by virtue of Task 5). Overlay mask: add `lineDominantAuthorPct`, `lineContributorCount` alongside existing `dominantAuthorPct`, `contributorCount` |
| `src/core/domains/trajectory/git/rerank/presets/tech-debt.ts`                                        | Same weights. Overlay: add `lineDominantAuthorPct`                                                                                                                                                            |
| `src/core/domains/trajectory/git/rerank/presets/dangerous.ts`                                        | Same weights. Overlay: add `lineDominantAuthorPct`                                                                                                                                                            |
| `src/core/domains/trajectory/git/rerank/presets/code-review.ts`                                      | **Add** `recentActivityConcentration: 0.15` to weights. Overlay: keep `dominantAuthorPct` (recent activity matters for review CC)                                                                             |
| `src/core/domains/trajectory/git/rerank/presets/onboarding.ts`                                       | **Add** `recentActivityConcentration: 0.1`. Overlay: keep `dominantAuthorPct`                                                                                                                                 |
| `src/core/domains/trajectory/git/rerank/presets/{bug-hunt,hotspots,proven,stable,security-audit}.ts` | Overlay-only: add `lineDominantAuthorPct` next to existing `dominantAuthorPct`                                                                                                                                |

**Verification**

- [ ] `ownership` preset on this repo produces visibly different ranking from
      pre-change (smoke test: top-5 differs)
- [ ] `codeReview` preset surfaces files with high recent activity (not high
      blame share)
- [ ] All presets compile against updated `ScoringWeights` type

### Task 7 — Filters, stats, MCP schemas

**Affected files**

| File                                                     | Change                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/trajectory/git/filters.ts`             | Add `lineDominantAuthor` filter (exact match), keep existing `dominantAuthor` filter; document semantic difference in inline comments |
| `src/core/domains/trajectory/git/stats/author-counts.ts` | Add `LineAuthorCountsAccumulator` reading `git.file.lineDominantAuthor` (parallel to existing)                                        |
| `src/core/domains/trajectory/git/stats/index.ts`         | Register new accumulator                                                                                                              |
| `src/core/contracts/types/stats-accumulator.ts`          | If `STATS_ACCUMULATOR_KEYS` is consumed by ingest by name, add `lineAuthorCounts`                                                     |
| `src/mcp/tools/output-schemas.ts`                        | Add `lineDominantAuthor`, `lineDominantAuthorPct`, `lineAuthors`, `lineContributorCount` to file output schema; mirror on chunk       |
| `src/mcp/resources/registry.ts`                          | Update `buildFiltersDoc`, `buildSignalLabelsGuide`, `buildSignalsDoc` to include the new fields and the labels                        |

**Verification**

- [ ] `tea-rags://schema/filters` MCP resource lists the new filter key
- [ ] `tea-rags://schema/labels` lists labels for `lineDominantAuthorPct` and
      `lineContributorCount`
- [ ] `get_index_metrics` returns separate distributions for `dominantAuthorPct`
      and `lineDominantAuthorPct`

### Task 8 — Plugin sweep: kill hardcoded thresholds, switch to labels

**Goal:** Replace `dominantAuthorPct >= X` magic-number comparisons with
`label === "silo"` / `"deep-silo"` (or derived score thresholds in 0..1). Apply
the rule **everywhere it appears**, including pre-existing usage of the old
field — not only new line-based usage.

**Affected files (plugins)**

| File                                                                       | Change                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md`                | UNSAFE/CAUTION ladder: replace `dominantAuthorPct ≥ 95% AND commitCount ≥ 15` with `git.file.lineDominantAuthorPct.label === "deep-silo"`. Drop `commitCount` clause (blame already captures concentration). |
| `.claude-plugin/dinopowers/skills/verification-before-completion/SKILL.md` | Silo risk verdict on `lineDominantAuthorPct.label`                                                                                                                                                           |
| `.claude-plugin/dinopowers/skills/writing-plans/SKILL.md`                  | "owner" column in table = `lineDominantAuthor`                                                                                                                                                               |
| `.claude-plugin/dinopowers/skills/requesting-code-review/SKILL.md`         | Bundle "ownership" line uses `lineDominantAuthor`; reviewer-CC suggestion uses `dominantAuthor` (recent) — document both                                                                                     |
| `.claude-plugin/dinopowers/skills/receiving-code-review/SKILL.md`          | Same split                                                                                                                                                                                                   |
| `.claude-plugin/dinopowers/skills/brainstorming/SKILL.md`                  | Output line `<dominantAuthor> (<pct>%)` switches to `<lineDominantAuthor> (<lineDominantAuthorPct>%)`                                                                                                        |
| `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`           | DDG strategy table on `file.lineDominantAuthorPct.label`; silo style copy from line owner                                                                                                                    |
| `.claude-plugin/tea-rags/skills/risk-assessment/SKILL.md`                  | "Toxic silo" / "Healthy owner" patterns on `lineDominantAuthorPct.label`                                                                                                                                     |
| `.claude-plugin/tea-rags/skills/explore/SKILL.md`                          | Overlay output shows both `dominantAuthor` and `lineDominantAuthor` with explicit semantics                                                                                                                  |
| `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`        | New section "Ownership vs Recent Activity" + intent→field table; new anti-pattern entry: "never compare raw payload values to magic numbers — read labels or derived scores"                                 |
| `.claude-plugin/tea-rags/rules/references/use-cases.md`                    | Bus-factor row notes line-based field                                                                                                                                                                        |
| `.claude-plugin/tea-rags/rules/search-cascade.md`                          | Update example custom weight comments where they reference ownership semantics                                                                                                                               |

**Verification**

- [ ] `rg -n 'dominantAuthorPct\s*[<>=]\s*[0-9]'` returns no matches in
      `.claude-plugin/` (ignoring docs/examples that explicitly demonstrate the
      anti-pattern with a "wrong" tag)
- [ ] All SKILL.md files reviewed manually that signal usage is intent-correct
      (line-based vs recent-based per use-case)

### Task 9 — Documentation sweep in `/website/docs`

**Goal:** Synchronize public docs with the split. Files were enumerated by
ripgrep over `dominantAuthor|knowledgeSilo|ownership|contributorCount`.

**9a. Architecture & data model**

| File                                                   | Change                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `website/docs/architecture/data-model.md`              | Add 4+4 new payload rows under file-level and chunk-level tables; clarify `dominantAuthor*` semantics ("recent activity, windowed") |
| `website/docs/architecture/git-enrichment-pipeline.md` | New subsection "Phase 1b — Blame Ownership": one `git blame HEAD` pass, cached by lastCommitHash, distributes to file + chunk       |
| `website/docs/architecture/overview.md`                | One-line update where presets are listed                                                                                            |

**9b. Usage & advanced**

| File                                             | Change                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `website/docs/usage/advanced/git-enrichments.md` | Add `lineDominantAuthor*` row in metrics table; new section "Recent Activity vs Ownership" explaining the two field families                         |
| `website/docs/usage/advanced/filters.md`         | Add `git.lineDominantAuthor` and `git.lineDominantAuthorPct` filter rows; new example "find code Alice owns" vs "find code Alice recently committed" |
| `website/docs/usage/advanced/rerank-presets.md`  | Note that `ownership` preset semantics now compute from blame; `recentActivityConcentration` weight key documented                                   |
| `website/docs/usage/advanced/query-modes.md`     | Update preset listing                                                                                                                                |
| `website/docs/usage/use-cases.md`                | Bus-factor recipe: switch to `lineDominantAuthorPct` filter                                                                                          |
| `website/docs/usage/skills/index.md`             | Wrapper note: each `dinopowers:Y` switched to label-based thresholds                                                                                 |
| `website/docs/usage/indexing-repositories.md`    | One-line update if env var docs reference ownership semantics                                                                                        |

**9c. Agent integration (largest section)**

| File                                                                                 | Change                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `website/docs/agent-integration/agentic-data-driven-engineering/index.md`            | Silo behavior table on `lineDominantAuthorPct`; clarify why `dominantAuthor` ≠ `lineDominantAuthor`          |
| `website/docs/agent-integration/agentic-data-driven-engineering/prompt-examples.md`  | Replace numeric thresholds with label references; show both fields in expected overlays                      |
| `website/docs/agent-integration/agentic-data-driven-engineering/activating.md`       | "Use rerank=ownership" remains valid; clarify what changed in scoring                                        |
| `website/docs/agent-integration/agentic-data-driven-engineering/generation-modes.md` | Threshold table → label-based                                                                                |
| `website/docs/agent-integration/deep-codebase-analysis/index.md`                     | "Ownership analysis" row notes chunk-level is now available too                                              |
| `website/docs/agent-integration/deep-codebase-analysis/ownership-and-debt.md`        | Decision tables on `lineDominantAuthorPct` labels                                                            |
| `website/docs/agent-integration/deep-codebase-analysis/risk-assessment.md`           | Critical-row criterion on label                                                                              |
| `website/docs/agent-integration/deep-codebase-analysis/impact-analysis.md`           | Step 3 "Assess ownership" uses line-based                                                                    |
| `website/docs/agent-integration/common-mistakes.md`                                  | New entry: "comparing raw `dominantAuthorPct` to magic numbers" — anti-pattern that bypasses adaptive labels |
| `website/docs/agent-integration/mental-model.md`                                     | Note: ownership signals now reflect live state, not historical activity                                      |
| `website/docs/agent-integration/search-strategies/index.md`                          | Preset-row descriptions clarify `ownership` = blame-based                                                    |
| `website/docs/agent-integration/search-strategies/preset-mapping.md`                 | Diagram captions reflect new semantics                                                                       |
| `website/docs/agent-integration/search-strategies/custom-reranking.md`               | Add `recentActivityConcentration` to weight-keys list                                                        |
| `website/docs/agent-integration/search-strategies/prompt-examples.md`                | Bug-investigation pattern updated                                                                            |

**9d. Knowledge base**

| File                                                           | Change                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `website/docs/knowledge-base/code-churn-research.md`           | Add row "Author (state)" — `lineDominantAuthor*` from blame — alongside existing "Author (process)" row                                   |
| `website/docs/knowledge-base/agent-augmented-development.md`   | Note: `lineDominantAuthor*` is **not** affected by agent commit dilution (closes a known weakness); cite Bird et al. mapping to new field |
| `website/docs/knowledge-base/software-evolution-and-mining.md` | Citation map: `lineDominantAuthorPct` better operationalizes Bird's "concentrated ownership" than commit-count proxy                      |
| `website/docs/knowledge-base/signal-scoring-methods.md`        | Update `ownership` formula row: source = `lineDominantAuthorPct / 100`                                                                    |

**9e. Introduction & API**

| File                                                         | Change                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `website/docs/introduction/what-is-tearags.md`               | One-line update where `dominantAuthor` is name-checked                                                             |
| `website/docs/introduction/core-concepts/tea.md`             | Authorship row now lists both field families                                                                       |
| `website/docs/introduction/core-concepts/reranking.md`       | Update `ownership` derived signal description                                                                      |
| `website/docs/introduction/core-concepts/semantic-search.md` | Example overlay shows new fields                                                                                   |
| `website/docs/api/tools.md`                                  | Payload schema additions; preset description for `ownership`                                                       |
| `website/docs/extending/custom-enrichments.md`               | Update derived-signal example mentioning ownership                                                                 |
| `website/docs/config/project-level-setup.md`                 | Note ownership-tracking section now covers both flavors                                                            |
| `website/docs/roadmap/open-questions.md`                     | "Better dominantAuthor semantics under agent commits" — partially answered (line-based is robust); update or close |
| `website/docs/changelog.md`                                  | New entry: line-based ownership signals; behavior change note for `ownership`/`knowledgeSilo` presets              |

**Verification**

- [ ] `rg -n 'dominantAuthorPct\s*[<>=]\s*[0-9]' website/docs` returns only
      explicitly-marked anti-pattern examples
- [ ] All references to `dominantAuthorPct >= N%` updated to label form OR
      explicitly tagged as "recent activity concentration" (not ownership)
- [ ] Cross-links between docs (e.g. `/agent-integration/...` → `/usage/...`)
      remain valid
- [ ] `npm run docs:build` (or equivalent) passes

### Task 10 — Verification & release

**Goal:** Empirical validation, release notes, beads epic close-out.

**Affected files**

| File                                           | Change                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md` (root, semantic-release driven) | Commit messages drive this — ensure scope is `signals` (functional, minor bump) and `BREAKING CHANGE:` footer documents the `ownership` preset semantics shift |
| `.qdrant-required-version`                     | Untouched — no Qdrant feature dependency                                                                                                                       |

**Verification**

- [ ] `npm run build && npm test` green
- [ ] Reindex this repo with `forceReindex=true`; sample 5 files manually:
      compare `dominantAuthor` vs `lineDominantAuthor` — at least one file must
      show **different** values (otherwise blame integration is suspect)
- [ ] Run `semantic_search` with `rerank: "ownership"` before/after and compare
      top-20 — observable shift expected
- [ ] MCP server reconnect required — confirm via `AskUserQuestion` per project
      rule `.local/mcp-testing.md`
- [ ] Beads epic closed; all child tasks closed; `git push` succeeds

## Beads sync

Per `.local/plan-beads-sync.md`:

- Create epic for this plan (label: `architecture`, `metrics`, `api`, `docs`)
- One beads task per Task N above (1:1 mapping)
- Dependencies: 1 → 2 → 3 → 4; 4 → {5, 6, 7}; {5,6,7} → 8 → 9 → 10
- Link epic to parent feature epic if applicable

## Acceptance criteria (rolled up)

1. Two field families coexist on file and chunk levels with documented
   semantics.
2. `OwnershipSignal` and `KnowledgeSiloSignal` produce blame-based scores;
   `recentActivityConcentration` available for commit-based use-cases.
3. No plugin SKILL.md compares raw `*Pct` to magic numbers — all use labels or
   derived scores.
4. `/website/docs` consistently distinguishes "owner" (blame) from "recent
   activity" (log).
5. Behavior change documented in CHANGELOG with `BREAKING CHANGE:` footer.
6. Reindex verified; observable top-N shift on `ownership` preset confirmed.
