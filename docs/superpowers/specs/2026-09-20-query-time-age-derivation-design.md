# Query-Time Age Derivation

- **Date:** 2026-09-20
- **Bead:** tea-rags-mcp-9ot33 (P1, `needs-design`)
- **Status:** design approved by user 2026-09-20; path (a) confirmed
- **Effect:** age and recency stop reading the enrichment-time `ageDays` stamp
  on every read path; they derive from `git.{file,chunk}.lastModifiedAt` at
  query time. No payload rewrite.

## Problem

Age is stamped at enrichment time and never moves until a point is re-enriched.
The drift is not theoretical: validator C (2026-09-19) measured 8,666 self-index
chunks carrying stored `chunk.ageDays <= 7` while only 3,980 have a real
`lastModifiedAt` within 8 days. Stale code is labelled `recent`, which produces
false fresh suspects in bug-hunt triage (mopt7).

9mwny already made the TYPED age sugar drift-free (`minAgeDays` / `maxAgeDays`
compile to now-relative `lastModifiedAt` ranges). Everything else still reads
the stored stamp:

- `AgeSignal#extract` / `RecencySignal#extract`
  (`src/core/domains/trajectory/git/rerank/derived-signals/{age,recency}.ts`)
- `Reranker#computeAdaptiveBounds` (`src/core/domains/explore/reranker.ts`) —
  collection floor is the index-time p95 of stored ageDays
- the rankingOverlay `ageDays` value + label
- the filter presets `freshLegacyEdits`, `battleTested`, `abandonedHotspots`

## Decision

Path (a): derive age at READ time from `lastModifiedAt` everywhere. Rejected
path (b) — periodically refreshing stamps with a git enrichment recompute —
keeps the same drift class between refreshes and adds watcher load.

## Design

### 1. One derivation unit, one owner

All knowledge "ageDays means `now − lastModifiedAt`" lives in a single module
owned by the git trajectory (`age-derivation.ts` under
`src/core/domains/trajectory/git/`): age computation, percentile inversion,
now-relative thresholds, label selection. Four consumers call it; none
reimplement the math. (Age p75 ⇔ lastModifiedAt p25; the median is symmetric.)

### 2. Derived signals

`AgeSignal#extract` / `RecencySignal#extract` read `lastModifiedAt` from
rawSignals instead of the stored ageDays key; the descriptors' `sources` gain
`git.{file,chunk}.lastModifiedAt`. `ExtractContext` gains `now: number`,
injected by the Reranker, defaulting to `Date.now()` — deterministic tests.
Normalization by bounds is unchanged.

### 3. Adaptive bounds

For age sources, the batch p95 stays computed over derived ages; the collection
floor becomes `now − p5(lastModifiedAt of the same level)` — drift-free by
construction, both sides move with now. The branch lives in `signal-floors.ts`.

### 4. Filter preset compiler — translation, not redefinition

Presets keep their defs in domain language (`ageDays gte {percentile p75}`); the
compiler translates ageDays conditions to now-relative lastModifiedAt
conditions. Precedent: 9mwny already translates the typed sugar in the same
compiler.

| Preset condition                            | Compiled to                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `ageDays gte/lte <N days>`                  | `lastModifiedAt lte/gte now ∓ N·86400e3`                                     |
| `ageDays gte {percentile p75, fallback 60}` | `lastModifiedAt lte {percentile p25, fallback now − 60d}`                    |
| `ageDays gte {percentile p50, fallback 30}` | `lastModifiedAt lte {percentile p50, fallback now − 30d}` (median symmetric) |

Rejected alternative: redefining the preset defs directly on lastModifiedAt with
a new now-relative value type in `FilterPresetDef`. Rejected because it
distributes the inversion knowledge across three def files and degrades the
defs' readability; the single translation point keeps the contract untouched.

`validateSignalDependencies` already enforces that referenced percentiles are
declared, so the translation gets its guard for free.

### 5. Ranking overlay

Preset overlay masks stay naming `ageDays`; the overlay builder resolves ageDays
entries through the derivation unit — value = computed age, label from
now-relative percentile bands. Zero churn across presets, honest values. The one
canonical statement of this fact lives in `signal-interpretation.md` (see Plugin
guidance propagation).

### 6. Stats and backfill

`git.{file,chunk}.lastModifiedAt` descriptors gain
`stats.percentilesToCompute: [5, 25, 50]`. No new payload keys → no schema
drift. The percentile values appear after ONE `--force-enrichments git`
recompute (user-gated, run before the live gate).

### 7. Stored ageDays fate

`git.{file,chunk}.ageDays` keeps being written to payload (compatibility: prime
threshold rows, analytics, the raw-filter escape hatch) but leaves the hot read
path. Dropping the key is a separate bead with its own drift and migration cost.

## Plugin guidance propagation

The guidance layers are mostly written against the LABEL vocabulary (`recent` /
`legacy` / `burst`), which keeps its names and meaning — only its computation
moves. Edits are therefore limited to the places that document the stamp
mechanism:

| File                                                                                    | Change                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/tea-rags/rules/references/signal-interpretation.md` (ageDays row)       | canonical rewrite: overlay/derived/preset value = query-time `now − lastModifiedAt`; the enrichment-time stamp remains only in the raw payload key (raw-filter escape hatch) — the ONE place stating this |
| `.claude-plugin/tea-rags/skills/filter-building/SKILL.md` ("Reading overlay `ageDays`") | rewrite: overlay + `age`/`recency` rerank + the three age presets are query-time; the only remaining lag is a raw `filter` on `git.*.ageDays` (the existing NEVER-raw guidance stays)                     |
| `.claude-plugin/tea-rags/skills/tests-as-context/SKILL.md` (introduction-order sort)    | sort key `git.chunk.ageDays` → `git.chunk.lastModifiedAt` descending — same order, no stamp lag                                                                                                           |
| payload + derived-signal descriptor `description` fields (src)                          | one-line notes "stored stamp" / "computed at query time"; tool schema and `tea-rags://schema/signals` regenerate                                                                                          |

Explicitly unchanged (still true against labels): risk-assessment SKILL +
classification-tiers + anti-patterns, bug-hunt (fresh-suspect triage becomes
honest — this IS the mopt7 fix), data-driven-generation + strategies,
extract-project-patterns, pre-gen-pattern, mr-review playbook, dinopowers
brainstorming / writing-plans (raw-filter discouragement still valid),
runtime-introspection (format example unchanged), use-cases.md labelMap pointer,
prime threshold rows (descriptors untouched). dinopowers does not change → no
bump; tea-rags plugin → patch bump; no new rule files →
`inject-rules.sh --count` unchanged.

## Files touched

- `src/core/domains/trajectory/git/age-derivation.ts` (new — derivation unit)
- `src/core/domains/trajectory/git/rerank/derived-signals/age.ts`, `recency.ts`
- `src/core/domains/trajectory/git/payload-signals.ts` (percentilesToCompute,
  description notes)
- `src/core/contracts/types/reranker.ts` (`ExtractContext.now`)
- `src/core/domains/explore/reranker.ts` (`computeAdaptiveBounds` age branch,
  ctx.now injection)
- `src/core/domains/explore/signal-floors.ts` (now-relative collection floor)
- `src/core/domains/explore/label-resolver.ts` (overlay value + label through
  the derivation unit)
- `src/core/domains/trajectory/filter-presets/compiler.ts` (ageDays translation)
- plugin files per the propagation table

## Tests

- New: extract with injected now (fresh + stale + missing lastModifiedAt);
  compiler translation (fixed, percentile, fallback, no-stats fallback);
  now-relative floor; overlay label bands.
- Consciously updated:
  `tests/core/domains/trajectory/composite/filter-presets.test.ts` expects
  `git.file.ageDays gte 30/42` — the compiled output legitimately changes to
  lastModifiedAt conditions; this is the product change, noted in the commit
  message.

## Validation gate and success metrics

Query-path change → per the epic gate: build + link + `/mcp reconnect`, then
exercise `mcp__tea-rags__*`. Before the gate: the one user-gated
`--force-enrichments git` backfill for p5/p25/p50.

Success = the validator-C divergence collapses (stale-labelled-recent vs
real-recent → equal by construction), mopt7 false-fresh suspects gone, overlay
ageDays on never-re-enriched old points shows real age.

## Out of scope

- Dropping the stored `ageDays` payload key (separate bead, drift-gated).
- prime threshold-table presentation changes.
- The auto-update tracks (deferred by user 2026-09-20 to a separate session).
