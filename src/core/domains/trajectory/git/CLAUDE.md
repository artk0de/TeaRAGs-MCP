# domains/trajectory/git — commit and blame history stamped onto file and chunk payloads

`infra/metrics/` and `infra/churn-walk/` knowledge lives here rather than in
their own navigators.

## Mechanics

- **File and chunk signals are walked over DIFFERENT windows, and alpha is not a
  bare ratio.** `TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS` (default 12,
  bootstrap/config/schemas.ts:116) bounds the file walk;
  `TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS` (default 6, :127) bounds the chunk churn
  walk — so `git.file.commitCount` and `git.chunk.commitCount` count over
  different histories and no commit-derived signal (commitCount, bugFixRate,
  ageDays, churnVolatility) is a lifetime figure. `payloadAlpha`
  (rerank/derived-signals/helpers.ts:88) delegates to `computeAlpha`
  (contracts/signal-utils.ts:46-56); its formula is
  `.claude/rules/derived-signals.md` → "Alpha-Blending (L3)". Why: the maturity
  damper — not the cross-window coverage ratio — is what suppresses alpha for
  low-commit chunks, so tuning aimed at the ratio alone explains none of the
  observed values; on files older than six months the two effects compound.

## Gotchas

- **Two unrelated ownership families coexist: `recent*` (commit window) vs
  `blame*` (live lines).** `infra/metrics/file-assembler.ts:82-105` writes both
  side by side — `recentDominantAuthor*` / `recentAuthors` /
  `recentContributorCount` from `computeDominantAuthor(commits)` over the log
  window, `blameDominantAuthor*` / `blameAuthors` / `blameContributorCount` from
  one `git blame HEAD`. Consumers split: `OwnershipSignal`
  (`file.blameDominantAuthorPct`, `file.blameAuthors`) and `KnowledgeSiloSignal`
  (`*.blameContributorCount`) read blame; `RecentActivityConcentrationSignal`
  (`file.recentDominantAuthorPct`, `file.recentAuthors`) reads commits. Why:
  they routinely disagree — a file Alice wrote two years ago with one recent Bob
  fix reports Bob at 100% recent and Alice as blame owner — so the wrong family
  silently changes what a preset means. The blame cache is keyed by file blob
  OID, not HEAD (`infra/blame-store.ts:12-16`), precisely so ownership survives
  HEAD moves and outlives the log window.
- **With squash-aware sessions on, `commitCount` is a SESSION count and only
  some signals follow.** `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true` groups
  commits per author (gap ≥ `sessionGapMinutes`, default 30; merge commits
  dropped — `infra/metrics/sessions.ts:31,55`) into a synthetic
  one-commit-per-session `countSource` (file-assembler.ts:66-79). `commitCount`,
  `recencyWeightedFreq`, `changeDensity`, `churnVolatility` and `bugFixRate`
  then read sessions (:90,95-98), while authorship, `linesAdded` /
  `linesDeleted` / `fileChurnCount` / `relativeChurn` and `taskIds` stay
  per-COMMIT (:82-88,91-94,100). The chunk side mirrors it
  (`infra/metrics/chunk-assembler.ts`) and the file denominator is
  session-normalized in `infra/assemble-overlays.ts:45-49`. Why: the flag
  changes the unit of half the payload and leaves the other half alone, so
  churn-per-commit ratios and every `confidence.support: "commitCount"`
  threshold shift meaning — and percentiles computed under one setting are not
  comparable to an index built under the other.
- **Files past `chunkMaxFileLines` get an all-ZERO chunk block, not a missing
  one.** In the chunk churn walk a file whose largest chunk `endLine` exceeds
  the limit (default 10000, schemas.ts:129) is skipped wholesale —
  `out.skippedLargeFiles++; return` (`infra/walk-commits.ts:276-283`) — so it
  collects no hunks. But `infra/build-accumulators.ts:42-60` pre-seeds a zeroed
  accumulator per chunk and `infra/assemble-overlays.ts:75-95` emits an overlay
  for each, so every chunk still gets `commitCount: 0`, no authors, no churn;
  `payloadAlpha` then returns 0 and blended signals collapse to the file value.
  Why: that payload reads as "no commit ever touched this method" rather than as
  unenriched. The only honest tell is the `skippedLargeFiles` count in the
  walk's debug line (walk-commits.ts:472).

## See also

- `.claude/rules/git-cat-file-batch.md` — the only sanctioned way these readers
  touch git objects.
- `.claude/rules/payload-signals.md`, `.claude/rules/derived-signals.md`,
  `.claude/rules/signal-confidence.md`, `.claude/rules/rerank-presets.md`,
  `.claude/rules/deep-path-navigation.md`
- `../CLAUDE.md`, `../codegraph/CLAUDE.md`,
  `../../ingest/pipeline/enrichment/CLAUDE.md`
