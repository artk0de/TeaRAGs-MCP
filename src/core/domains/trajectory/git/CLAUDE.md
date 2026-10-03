# domains/trajectory/git — commit and blame history stamped onto file and chunk payloads

`infra/metrics/` and `infra/churn-walk/` knowledge lives here rather than in
their own navigators.

## Mechanics

- **File and chunk signals are walked over DIFFERENT windows, and alpha is not a
  bare ratio.** `TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS` (default 12,
  `trajectoryGitSchema` in `bootstrap/config/schemas.ts`) bounds the file walk;
  `TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS` (default 6, same schema) bounds the
  chunk churn walk — so `git.file.commitCount` and `git.chunk.commitCount` count
  over different histories and no commit-derived signal (commitCount,
  bugFixRate, ageDays, churnVolatility) is a lifetime figure. `payloadAlpha`
  (`rerank/derived-signals/helpers.ts`) delegates to `computeAlpha`
  (`contracts/signal-utils.ts`); its formula is
  `.claude/rules/derived-signals.md` → "Alpha-Blending (L3)". Why: the maturity
  damper — not the cross-window coverage ratio — is what suppresses alpha for
  low-commit chunks, so tuning aimed at the ratio alone explains none of the
  observed values; on files older than six months the two effects compound.

- **The chunk walk follows renames, and the ORDER of the slice is what makes
  that correct.** A commit older than a rename names the file by its old path,
  so `sliceCommitsFollowingRenames` (`infra/rename-following.ts`) re-queries
  discovery with every predecessor path a rename row reveals, to a fixpoint;
  `resolveHeadPaths` then walks the slice newest → oldest with an alias map
  rewritten at each rename row. The off-thread path widens its slice in
  `GitEnrichmentProvider#walkChunkChurnOffThread` the same way. Why: the alias
  map is only correct in log order — resolved in any other order, an old path
  RE-CREATED after the rename would merge with the renamed file's history. The
  slice must stay one query result, never a concatenation of per-path queries.
  Pure moves (numstat `0 0`) still credit no chunk: following changes which file
  a commit lands on, not whether it has hunks.

- **The file walk follows renames through the same alias map.**
  `aggregateFileChurnFollowingRenames` (`infra/rename-following.ts`) folds
  per-commit numstat onto HEAD paths for both `FileChurnDiscovery#fileChurn` and
  the per-path backfill `buildFileSignalsForPaths`. The discovery resolves
  aliases over its entries in LOG order and only folds in its committer-date
  order; the persisted snapshot keeps raw per-commit rows, so a pre-rename
  commit cached under its old path is re-resolved on every build. The backfill
  widens with `sliceCommitsFollowingRenames` over
  `VcsGitAdapter#readCommitFileNumstatForPaths`, which re-reads add/delete
  commits without the pathspec — a pathspec detects renames only between paths
  it names, so on the HEAD path alone the rename prints as a plain add. Unlike
  the chunk side, a pure move DOES count as a file commit (it is what
  `git log --follow` lists). Why: the file side used to key each commit by the
  path it recorded, so a directory rename reset every moved file to
  `commitCount: 1` while its chunks kept 20–30 commits (bd tea-rags-mcp-aikfk).
  `readNumstatLog` / `readNumstatLogForPaths` still aggregate raw; only the
  discovery-less legacy branch of `buildFileSignalMap` /
  `buildFileSignalDiscovery` reads them, and the provider never takes it.

- **A changed-file row is a PAIR, and the two halves address different
  commits.** `git log --numstat` runs with rename detection on, so the parsers
  split git's `pre{old => new}post` column into
  `CommitChangedPath { path, previousPath? }`. `collectHunks` matches the row's
  resolved HEAD path against `relativeChunkMap` (keyed on HEAD paths);
  `collectOneFile` reads the COMMIT side at `path` and the PARENT side at
  `previousPath ?? path` (both in `infra/walk-commits.ts`). Why: read the parent
  at the post-rename path and it comes back `""`, so `structuredPatch` returns
  one hunk spanning the file and the rename lands on EVERY chunk — measured 6/6
  chunks and 351 attributed lines against the correct 2/6 and 178 on
  `tests/core/domains/maintenance/drift/schema-drift-monitor.test.ts`. Keeping
  the column raw is the opposite failure: nothing matches, the commit is dropped
  before any blob read, and every chunk publishes `commitCount: 0`. For a
  pre-rename commit `path` itself is the old name; the alias map above resolves
  it, and both blob reads stay at the path that commit used. A root commit has
  no parent side at all: it is diffed against `""`, the same add a non-root
  creating commit gets. Skipping it (the old "nothing to diff") dropped the
  creating commit of every file born in the repo's first commit, which read as a
  rename bug on a renamed file whose control had a non-root creation (bd
  tea-rags-mcp-z8w16).

- **A chunk is credited only for rows a commit changed, never for diff
  context.** `collectOneFile` diffs with `structuredPatch(..., { context: 0 })`
  and every per-chunk walk signal — commitCount, authors, timestamps (ageDays,
  churnVolatility), bugFixRate, taskIds, linesAdded / linesDeleted
  (relativeChurn) — goes through the one predicate `changedRowsInRange`
  (`infra/offset-tracker.ts`). A pure deletion credits a chunk only when its
  seam lies strictly inside it; one on the seam between two chunks credits
  neither, which is what `git log -L` does. Why: with the default 4 context rows
  every short method next to an edited one inherited its commits — a fixture
  chunk never edited after creation read 4 commits against a `git log -L` oracle
  of 1 (bd tea-rags-mcp-z3cnd). Anything new that reads the walk's hunks must
  use that predicate, not the hunk's raw `newStart`/`newLines` span.

- **The walk addresses HEAD rows; a chunker hands it WORKING rows.** Before the
  walk, `GitEnrichmentProvider#buildChunkSignals` carries every file with
  uncommitted edits onto HEAD (`carryDirtyChunkMapOntoHead`,
  `infra/working-rows.ts`), and a row made only of uncommitted lines gets the
  walk's zero block instead of a walk. The working-tree overlay's on-demand rows
  (`buildOnDemandGitSignals`) go through the same module, so a delta row and a
  reindex of a dirty tree agree. Why: walked as HEAD rows, four lines added
  above a symbol credited it with its neighbour's commits (parity harness
  `working-tree-git-parity.test.ts`, bd tea-rags-mcp-xi2r9). The chunk map
  reaches the provider keyed REPO-RELATIVE from ingest (`ChunkPhase`, the
  recompute scroll) and absolute from other callers; code that selects files by
  key must accept both, as `relativizeChunkMap` does — the first cut matched
  absolute keys only, so ingest never carried a dirty file while the unit tests,
  keyed absolute, stayed green.

- **An index carries the git algorithm revision that computed it.**
  `GIT_TRAJECTORY_ALGORITHM_VERSION` (`algorithm-version.ts`) is the provider's
  `algorithmVersion`; a run that rebuilt git for every point stamps it on the
  registry entry and `TrajectoryVersionDriftMonitor` reports a stale one with
  `--force-enrichments git`. Bump it once per release whenever the same history
  writes different `git.*` values — no payload-key drift can see that change.

## Gotchas

- **The file→chunk blame handoff is held per path, never per batch, and survives
  `finalizeSignals`.** A chunk batch is gated only on ITS OWN file batch, so
  later file batches finish before earlier chunk walks, one file's chunks span
  several batches, and `CompletionRunner` calls `finalizeSignals` BEFORE it
  drains streaming chunk work. `GitEnrichmentProvider#blameByRelPath` therefore
  lives until every file-batch hold on the path is released by a chunk walk
  (`holdForChunkPhase` / `releaseChunkHandoff`); unreleased holds are evicted
  one run later (`evictStaleChunkHandoff`). Why: the old per-batch map swap left
  53,836 of 107,428 touched chunks on a taxdome `--force-enrichments git` at
  `blameDominantAuthor: "unknown"` — the recompute fires every file batch at
  once, so the race was maximal there and near-absent on embedding-paced
  streaming. Clearing at `finalizeSignals` would reintroduce it.
- **Two unrelated ownership families coexist: `recent*` (commit window) vs
  `blame*` (live lines).** `assembleFileSignals`
  (`infra/metrics/file-assembler.ts`) writes both side by side —
  `recentDominantAuthor*` / `recentAuthors` / `recentContributorCount` from
  `computeDominantAuthor(commits)` over the log window, `blameDominantAuthor*` /
  `blameAuthors` / `blameContributorCount` from one `git blame HEAD`. Consumers
  split: `OwnershipSignal` (`file.blameDominantAuthorPct`, `file.blameAuthors`)
  and `KnowledgeSiloSignal` (`*.blameContributorCount`) read blame;
  `RecentActivityConcentrationSignal` (`file.recentDominantAuthorPct`,
  `file.recentAuthors`) reads commits. Why: they routinely disagree — a file
  Alice wrote two years ago with one recent Bob fix reports Bob at 100% recent
  and Alice as blame owner — so the wrong family silently changes what a preset
  means. The blame cache is keyed by file blob OID, not HEAD (the
  `infra/blame-store.ts` header docblock), precisely so ownership survives HEAD
  moves and outlives the log window.
- **With squash-aware sessions on, `commitCount` is a SESSION count and only
  some signals follow.** `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true` groups
  commits per author (gap ≥ `sessionGapMinutes`, default 30; merge commits
  dropped — `groupIntoSessions` in `infra/metrics/sessions.ts`) into a synthetic
  one-commit-per-session `countSource` (`assembleFileSignals`). `commitCount`,
  `recencyWeightedFreq`, `changeDensity`, `churnVolatility` and `bugFixRate`
  then read sessions, while authorship, `linesAdded` / `linesDeleted` /
  `fileChurnCount` / `relativeChurn` and `taskIds` stay per-COMMIT. The chunk
  side mirrors it (`infra/metrics/chunk-assembler.ts`) and the file denominator
  is session-normalized in `assembleOverlays` (`infra/assemble-overlays.ts`).
  Why: the flag changes the unit of half the payload and leaves the other half
  alone, so churn-per-commit ratios and every
  `confidence.support: "commitCount"` threshold shift meaning — and percentiles
  computed under one setting are not comparable to an index built under the
  other.
- **A file past `chunkMaxFileLines` is a POLICY decline, stamped
  `git.chunk.skippedAs: "oversized"` — never a walked zero.**
  `GitEnrichmentProvider#shouldEnrich` answers `"file-only"` when the
  `fileLines` it is handed exceeds the limit (default 5000,
  `trajectoryGitSchema`), so the file keeps every `git.file.*` signal and the
  pipeline stamps its chunks the way it stamps a doc's; `enrichmentSkipReason`
  names `"oversized"` only when no classification flag explains the decline (a
  generated file stays `"generated"`). `fileLines` comes from the chunker's
  `moduleLines`, carried on `ChunkLookupEntry` and read by `fileLinesOf`, so the
  answer is per FILE even when a batch holds only its head chunks; a caller with
  no `moduleLines` (a pre-symbol-mass index) falls back to the largest
  `endLine`, a lower bound. Absent ⇒ not oversized, which is why the provider
  declines only the chunk level: file-level dispatch never knows the count. The
  walk keeps a backstop — `buildAccumulators` drops such a file before
  discovery, so it gets no overlay at all (the applier's bare `enrichedAt`
  stamp, no numeric fields). Why: the old walk skipped the file after
  `buildAccumulators` had pre-seeded zeroed accumulators, and every chunk
  published `commitCount: 0` — byte-identical to "no commit ever touched this
  method", with `payloadAlpha` 0 and the chunk `maxAgeDays` filter blind (bd
  tea-rags-mcp-2brzq). Moving or changing the limit changes a policy answer, so
  the stale stamps it leaves need a `--force-enrichments git` recompute.

## See also

- `.claude/rules/git-cat-file-batch.md` — the only sanctioned way these readers
  touch git objects.
- `.claude/rules/payload-signals.md`, `.claude/rules/derived-signals.md`,
  `.claude/rules/signal-confidence.md`, `.claude/rules/rerank-presets.md`,
  `.claude/rules/deep-path-navigation.md`
- `../CLAUDE.md`, `../codegraph/CLAUDE.md`,
  `../../ingest/pipeline/enrichment/CLAUDE.md`
