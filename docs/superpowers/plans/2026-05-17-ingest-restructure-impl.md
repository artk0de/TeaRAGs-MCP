# Ingest Domain Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `src/core/domains/ingest/` so the top level holds only
barrels + composition (`constants.ts`, `errors.ts`, `factory.ts`, `index.ts`),
public orchestrators live under `operations/`, cross-cutting helpers under
`infra/`, and the flat `sync/` is split into `snapshot/`, `deletion/`, `infra/`
subdomains. All subdomains have mandatory barrels.

**Architecture:** Pure structural refactor — no behavior changes. Files move,
imports update, barrels propagate. Each Task moves one coordinated group (files
that import each other together), updates internal + external imports, mirrors
test files, runs build + targeted tests, commits. High-blast-radius files
(`deletion-outcome` 9 importers, `merkle` 6, `snapshot` 6, `collection-stats` 5)
move inside their group's Task; the build+test step catches missed updates.

**Tech Stack:** TypeScript, vitest, `git mv` for history-preserving moves,
ripgrep for import discovery.

## Constraints

- **No behavior changes.** Tests must stay green; do NOT rewrite business-logic
  tests (project rule: `feedback_business_logic_tests_immutable`).
- **Coverage thresholds must not drop.** If a move causes coverage to dip,
  escalate — do NOT lower thresholds or add `v8 ignore` (project rules:
  `feedback_never_lower_thresholds`, `feedback_no_eslint_disable`).
- **Use `git mv`** for every file move so history follows. Never `cp` + `rm`.
- **Sequence matters.** Task 1 (rule update) MUST land before any file-move Task
  so the new "subdomain barrels mandatory" rule is in force when subdomains are
  created.
- **One Task = one beads task.** Create the beads epic + 8 child tasks before
  starting execution (per `.claude/rules/.local/plan-beads-sync.md`).

---

## File Structure

### Target tree

```
src/core/domains/ingest/
├── index.ts                       (UPDATE — re-export from new paths)
├── constants.ts                   (stays)
├── errors.ts                      (stays)
├── factory.ts                     (stays — DI composition, neither op nor infra)
├── operations/
│   ├── index.ts                   (NEW barrel)
│   ├── indexing.ts                (MOVE from ingest/indexing.ts)
│   └── reindexing.ts              (MOVE from ingest/reindexing.ts)
├── infra/
│   ├── index.ts                   (NEW barrel)
│   ├── alias-cleanup.ts           (MOVE from ingest/alias-cleanup.ts)
│   ├── collection-stats.ts        (MOVE from ingest/collection-stats.ts)
│   ├── heartbeat-guard.ts         (MOVE from ingest/heartbeat-guard.ts)
│   ├── optimizer-lifecycle.ts     (MOVE from ingest/optimizer-lifecycle.ts)
│   └── stats-recompute.ts         (MOVE from ingest/stats-recompute.ts)
├── pipeline/                      (UNTOUCHED)
└── sync/
    ├── index.ts                   (NEW barrel)
    ├── synchronizer.ts            (stays)
    ├── parallel-synchronizer.ts   (stays)
    ├── snapshot/
    │   ├── index.ts               (NEW barrel)
    │   ├── snapshot.ts            (MOVE)
    │   ├── sharded-snapshot.ts    (MOVE)
    │   └── snapshot-cleaner.ts    (MOVE)
    ├── deletion/
    │   ├── index.ts               (NEW barrel)
    │   ├── strategy.ts            (MOVE + RENAME from deletion-strategy.ts)
    │   ├── batch-executor.ts      (MOVE + RENAME from batch-delete-executor.ts)
    │   ├── retry-helper.ts        (MOVE + RENAME from deletion-retry-helper.ts)
    │   ├── outcome.ts             (MOVE + RENAME from deletion-outcome.ts)
    │   └── reindex-coordinator.ts (MOVE)
    └── infra/
        ├── index.ts               (NEW barrel)
        ├── merkle.ts              (MOVE)
        └── consistent-hash.ts     (MOVE)
```

### Test mirror

Every source move is mirrored in `tests/core/domains/ingest/`:

```
tests/core/domains/ingest/
├── errors.test.ts                 (stays)
├── indexer.test.ts                (stays — integration smoke, multi-file)
├── enrichment-await.test.ts       (stays — pipeline-level)
├── enrichment-module.test.ts      (stays — pipeline-level)
├── __helpers__/test-helpers.ts    (stays)
├── operations/
│   ├── indexing.test.ts
│   ├── reindexing.test.ts
│   └── reindexing-block.test.ts
├── infra/
│   ├── alias-cleanup.test.ts
│   ├── collection-stats.test.ts
│   ├── heartbeat-guard.test.ts
│   ├── optimizer-lifecycle.test.ts
│   └── stats-recompute.test.ts
├── pipeline/                      (UNTOUCHED)
└── sync/
    ├── synchronizer.test.ts       (stays)
    ├── parallel-synchronizer.test.ts (stays)
    ├── snapshot/
    │   ├── snapshot.test.ts
    │   ├── sharded-snapshot.test.ts
    │   └── snapshot-cleaner.test.ts
    ├── deletion/
    │   ├── strategy.test.ts       (RENAMED from deletion-strategy.test.ts)
    │   ├── retry-helper.test.ts   (RENAMED from deletion-retry-helper.test.ts)
    │   ├── outcome.test.ts        (RENAMED from deletion-outcome.test.ts)
    │   └── reindex-coordinator.test.ts
    └── infra/
        ├── merkle.test.ts
        └── consistent-hash.test.ts
```

Note: there is no `batch-delete-executor.test.ts` in the current tests tree —
`batch-executor.ts` is exercised through `strategy.test.ts`. No test rename
needed for it.

### Import update protocol (used by every move Task)

For each moved file:

1. Identify every importer with ripgrep (project + tests):
   ```bash
   rg -l --type ts "from [\"'][^\"']*<basename-no-ext>(\.js)?[\"']" src/ tests/
   ```
2. For each importer, replace the import path. Use `Edit` per importer — never
   bulk `sed` (project rule: `feedback_small_edits`).
3. For files moved **inside** the same group (e.g. inside `sync/deletion/`),
   update relative imports between them (e.g. `./outcome.js` instead of
   `./deletion-outcome.js`).

---

## Pre-flight: create beads epic + tasks

Run BEFORE Task 1. This creates the epic and 8 child tasks so `bd ready`
reflects plan ordering.

```bash
# Epic
bd create --title="Refactor: restructure ingest domain layout" \
  --description="Group top-level helpers into operations/ and infra/; split flat sync/ into snapshot/, deletion/, infra/ subdomains with mandatory barrels. Plan: docs/superpowers/plans/2026-05-17-ingest-restructure-impl.md" \
  --type=feature --priority=2
# → records EPIC_ID

# 8 child tasks (titles match plan Tasks 1:1)
bd create --title="Update barrel-files.md: mandatory subdomain barrels rule" --type=task --priority=2
bd create --title="Move ingest top-level orchestrators into operations/" --type=task --priority=2
bd create --title="Move ingest top-level helpers into infra/" --type=task --priority=2
bd create --title="Split sync/ snapshot files into sync/snapshot/" --type=task --priority=2
bd create --title="Split sync/ deletion files into sync/deletion/ with renames" --type=task --priority=2
bd create --title="Split sync/ shared algorithms into sync/infra/" --type=task --priority=2
bd create --title="Update sync/ and ingest/ barrels for new paths" --type=task --priority=2
bd create --title="Final verification: full build + tests + coverage" --type=task --priority=2

# Add dependencies: each task depends on previous; all depend on the epic.
# Use the IDs printed by the create commands above.
# Example: bd dep add <task-2-id> <task-1-id>; bd dep add <task-1-id> <EPIC_ID>; ...

# Labels (per .claude/rules/.local/beads-labels.md)
bd label add <each-task-id> architecture
```

---

## Task 1: Update `.claude/rules/barrel-files.md` — mandatory subdomain barrels

**Files:**

- Modify: `.claude/rules/barrel-files.md`

- [ ] **Step 1: Read current rule**

Run: `cat .claude/rules/barrel-files.md`

- [ ] **Step 2: Replace the "Subdirectory barrels are optional" clause**

Use `Edit` to replace the existing rule #3:

OLD:

```
3. **Subdirectory barrels are optional.** `strategies/index.ts`,
   `rerank/presets/index.ts` etc. exist for convenience but are not mandatory
   for every subdirectory. Internal infra/utils directories don't need barrels.
```

NEW:

```
3. **Every subdomain directory MUST have an `index.ts` barrel.** A "subdomain"
   is a directory under a domain (`domains/<x>/`) that groups multiple files
   with a shared public surface — examples: `ingest/operations/`,
   `ingest/infra/`, `ingest/sync/snapshot/`, `ingest/sync/deletion/`,
   `ingest/sync/infra/`. Single-file helper directories (e.g. `__helpers__/`)
   do not need a barrel. Cross-subdomain imports MUST go through the barrel,
   not the file directly.
```

- [ ] **Step 3: Update the "Domain boundaries with barrels" list to add new
      subdomain barrels**

After Step 2, add to the existing list (under "Domain boundaries with barrels"):

```
- `domains/ingest/operations/index.ts`
- `domains/ingest/infra/index.ts`
- `domains/ingest/sync/index.ts`
- `domains/ingest/sync/snapshot/index.ts`
- `domains/ingest/sync/deletion/index.ts`
- `domains/ingest/sync/infra/index.ts`
```

- [ ] **Step 4: Mark beads task in_progress, commit**

```bash
bd update <task-1-id> --status=in_progress
git add .claude/rules/barrel-files.md
git commit -m "docs(rules): mandatory subdomain barrels for ingest restructure"
bd close <task-1-id>
```

---

## Task 2: Move ingest top-level orchestrators into `operations/`

**Files:**

- Create: `src/core/domains/ingest/operations/index.ts`
- Move: `src/core/domains/ingest/indexing.ts` →
  `src/core/domains/ingest/operations/indexing.ts`
- Move: `src/core/domains/ingest/reindexing.ts` →
  `src/core/domains/ingest/operations/reindexing.ts`
- Move: `tests/core/domains/ingest/indexing.test.ts` →
  `tests/core/domains/ingest/operations/indexing.test.ts`
- Move: `tests/core/domains/ingest/reindexing.test.ts` →
  `tests/core/domains/ingest/operations/reindexing.test.ts`
- Move: `tests/core/domains/ingest/reindexing-block.test.ts` →
  `tests/core/domains/ingest/operations/reindexing-block.test.ts`

- [ ] **Step 1: Mark beads task in_progress**

```bash
bd update <task-2-id> --status=in_progress
```

- [ ] **Step 2: Create the new directories and barrel**

```bash
mkdir -p src/core/domains/ingest/operations
mkdir -p tests/core/domains/ingest/operations
```

Write `src/core/domains/ingest/operations/index.ts`:

```typescript
export { IndexPipeline } from "./indexing.js";
export { ReindexPipeline } from "./reindexing.js";
```

- [ ] **Step 3: Move source files with git mv**

```bash
git mv src/core/domains/ingest/indexing.ts src/core/domains/ingest/operations/indexing.ts
git mv src/core/domains/ingest/reindexing.ts src/core/domains/ingest/operations/reindexing.ts
```

- [ ] **Step 4: Move test files with git mv**

```bash
git mv tests/core/domains/ingest/indexing.test.ts tests/core/domains/ingest/operations/indexing.test.ts
git mv tests/core/domains/ingest/reindexing.test.ts tests/core/domains/ingest/operations/reindexing.test.ts
git mv tests/core/domains/ingest/reindexing-block.test.ts tests/core/domains/ingest/operations/reindexing-block.test.ts
```

- [ ] **Step 5: Update internal imports inside the moved source files**

The moved files previously imported siblings via `./...`. Now they live one
level deeper, so all `./` imports become `../`. Use `Edit` per file:

For `src/core/domains/ingest/operations/indexing.ts` — replace every line
matching `from "./<X>.js"` with `from "../<X>.js"` (e.g. `./factory.js` →
`../factory.js`, `./constants.js` → `../constants.js`). Cross-domain imports
(`../../...`) become `../../../...`.

Same for `src/core/domains/ingest/operations/reindexing.ts`.

Verify after editing:

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "operations/(indexing|reindexing)" || echo "OK"
```

- [ ] **Step 6: Update imports inside the moved test files**

For each test file, paths to source must reflect the new location. The tests
live at depth `tests/core/domains/ingest/operations/`, importing from
`../../../../../src/core/...`. Before the move they were at
`tests/core/domains/ingest/`, importing from `../../../../src/core/...`. Add one
more `../` to every `src/core/...` import path.

Use `Edit` per file.

- [ ] **Step 7: Find all external importers of `./indexing.js` and
      `./reindexing.js`**

```bash
rg -l --type ts "from [\"'][^\"']*ingest/(indexing|reindexing)(\.js)?[\"']" src/ tests/
```

For each importer, update the import path to point at
`ingest/operations/<file>.js` or, when crossing the ingest domain boundary,
prefer the existing `ingest/index.js` barrel. (Task 7 updates the barrel
itself.)

Expected importers (from blast-radius scan):

- `src/core/domains/ingest/factory.ts` (probable)
- `src/core/api/internal/composition.ts` or `api/public/app.ts` (probable)
- `tests/core/domains/ingest/indexer.test.ts` (probable smoke import)

Run the rg again until empty.

- [ ] **Step 8: Build + run affected tests**

```bash
npm run build
npx vitest run tests/core/domains/ingest/operations/ tests/core/domains/ingest/indexer.test.ts
```

Expected: build passes, both test files green.

- [ ] **Step 9: Commit**

```bash
git add src/core/domains/ingest/ tests/core/domains/ingest/
git commit -m "refactor(ingest): move IndexPipeline/ReindexPipeline into operations/"
bd close <task-2-id>
```

---

## Task 3: Move ingest top-level helpers into `infra/`

**Files:**

- Create: `src/core/domains/ingest/infra/index.ts`
- Move (5): `alias-cleanup.ts`, `collection-stats.ts`, `heartbeat-guard.ts`,
  `optimizer-lifecycle.ts`, `stats-recompute.ts` from `ingest/` →
  `ingest/infra/`
- Move (5): mirror tests from `tests/core/domains/ingest/` →
  `tests/core/domains/ingest/infra/`

- [ ] **Step 1: Mark beads task in_progress**

```bash
bd update <task-3-id> --status=in_progress
```

- [ ] **Step 2: Create dirs + barrel**

```bash
mkdir -p src/core/domains/ingest/infra
mkdir -p tests/core/domains/ingest/infra
```

Write `src/core/domains/ingest/infra/index.ts`:

```typescript
export { cleanupOrphanedVersions } from "./alias-cleanup.js";
export { computeCollectionStats } from "./collection-stats.js";
export { HeartbeatGuard } from "./heartbeat-guard.js";
export { OptimizerLifecycle } from "./optimizer-lifecycle.js";
export { StatsRecomputeService } from "./stats-recompute.js";
```

Note: confirm exported symbol names by reading the top of each source file
before writing the barrel. If a file exports types as well as values, add
`export type { ... } from "./<file>.js"`.

- [ ] **Step 3: git mv all 5 source files**

```bash
for f in alias-cleanup collection-stats heartbeat-guard optimizer-lifecycle stats-recompute; do
  git mv "src/core/domains/ingest/$f.ts" "src/core/domains/ingest/infra/$f.ts"
done
```

- [ ] **Step 4: git mv all 5 test files**

```bash
for f in alias-cleanup collection-stats heartbeat-guard optimizer-lifecycle stats-recompute; do
  git mv "tests/core/domains/ingest/$f.test.ts" "tests/core/domains/ingest/infra/$f.test.ts"
done
```

- [ ] **Step 5: Update internal imports inside each moved source file**

Each moved file previously imported siblings via `./...` and parents via
`../...`. Now one level deeper, so:

- `./<sibling>.js` → `../<sibling>.js` (or `./<sibling>.js` stays if importing
  another moved file inside `infra/`)
- `../<parent>.js` → `../../<parent>.js`
- `../../<grandparent>` → `../../../<grandparent>`

Per file, run `Edit` for each impacted import. After all 5 done:

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "ingest/infra/" || echo "OK"
```

- [ ] **Step 6: Update imports in moved test files**

Add one `../` to every `src/core/...` import path (depth increased by one).

- [ ] **Step 7: Find + update external importers**

```bash
rg -l --type ts "from [\"'][^\"']*ingest/(alias-cleanup|collection-stats|heartbeat-guard|optimizer-lifecycle|stats-recompute)(\.js)?[\"']" src/ tests/
```

For each importer, update to `ingest/infra/<file>.js`. **`collection-stats` has
5 importers** — verify all 5 update cleanly. Re-run rg until empty.

- [ ] **Step 8: Build + run affected tests**

```bash
npm run build
npx vitest run tests/core/domains/ingest/infra/
```

Expected: build passes, all infra/ tests green.

- [ ] **Step 9: Commit**

```bash
git add src/core/domains/ingest/ tests/core/domains/ingest/
git commit -m "refactor(ingest): group cross-cutting helpers under infra/"
bd close <task-3-id>
```

---

## Task 4: Split `sync/` snapshot files into `sync/snapshot/`

**Files:**

- Create: `src/core/domains/ingest/sync/snapshot/index.ts`
- Move (3): `snapshot.ts`, `sharded-snapshot.ts`, `snapshot-cleaner.ts` from
  `sync/` → `sync/snapshot/`
- Move (3): mirror tests

- [ ] **Step 1: Mark beads task in_progress**

```bash
bd update <task-4-id> --status=in_progress
```

- [ ] **Step 2: Create dirs + barrel**

```bash
mkdir -p src/core/domains/ingest/sync/snapshot
mkdir -p tests/core/domains/ingest/sync/snapshot
```

Write `src/core/domains/ingest/sync/snapshot/index.ts`:

```typescript
export { SnapshotManager } from "./snapshot.js";
export { ShardedSnapshotManager } from "./sharded-snapshot.js";
export { cleanupSnapshots } from "./snapshot-cleaner.js";
```

(Confirm exported symbol names by reading the top of each source.)

- [ ] **Step 3: git mv source files**

```bash
git mv src/core/domains/ingest/sync/snapshot.ts        src/core/domains/ingest/sync/snapshot/snapshot.ts
git mv src/core/domains/ingest/sync/sharded-snapshot.ts src/core/domains/ingest/sync/snapshot/sharded-snapshot.ts
git mv src/core/domains/ingest/sync/snapshot-cleaner.ts src/core/domains/ingest/sync/snapshot/snapshot-cleaner.ts
```

- [ ] **Step 4: git mv test files**

```bash
git mv tests/core/domains/ingest/sync/snapshot.test.ts         tests/core/domains/ingest/sync/snapshot/snapshot.test.ts
git mv tests/core/domains/ingest/sync/sharded-snapshot.test.ts tests/core/domains/ingest/sync/snapshot/sharded-snapshot.test.ts
git mv tests/core/domains/ingest/sync/snapshot-cleaner.test.ts tests/core/domains/ingest/sync/snapshot/snapshot-cleaner.test.ts
```

- [ ] **Step 5: Update internal imports**

`sharded-snapshot.ts` and `snapshot-cleaner.ts` currently import `./merkle.js`,
`./consistent-hash.js`, and (in cleaner) other sync siblings. After this move,
those siblings still live at `sync/<sibling>.ts`. So inside
`sync/snapshot/<x>.ts`:

- `./merkle.js` → `../merkle.js`
- `./consistent-hash.js` → `../consistent-hash.js`
- `../<parent>.js` → `../../<parent>.js`

Cross-snapshot imports (e.g. `sharded-snapshot.ts` importing `./snapshot.js`)
stay `./snapshot.js` — both in the same new dir.

After Task 6 the merkle/consistent-hash paths shift again to `../infra/`. That
correction happens in Task 6, not here — keep this Task's edits aimed at the
**current** post-move state.

- [ ] **Step 6: Update test imports**

Add one `../` to every `src/core/...` path in the 3 moved test files.

- [ ] **Step 7: Find + update external importers**

```bash
rg -l --type ts "from [\"'][^\"']*sync/(snapshot|sharded-snapshot|snapshot-cleaner)(\.js)?[\"']" src/ tests/
```

For each, update to `sync/snapshot/<file>.js`. **`snapshot.ts` has 6 importers**
— verify each. Re-run rg until empty.

- [ ] **Step 8: Build + tests**

```bash
npm run build
npx vitest run tests/core/domains/ingest/sync/snapshot/ tests/core/domains/ingest/sync/synchronizer.test.ts tests/core/domains/ingest/sync/parallel-synchronizer.test.ts
```

Expected: build passes, all snapshot + synchronizer tests green (synchronizer
tests cover the most common downstream importers of SnapshotManager).

- [ ] **Step 9: Commit**

```bash
git add src/core/domains/ingest/sync/ tests/core/domains/ingest/sync/
git commit -m "refactor(sync): group snapshot persistence under sync/snapshot/"
bd close <task-4-id>
```

---

## Task 5: Split `sync/` deletion files into `sync/deletion/` with renames

**Files:**

- Create: `src/core/domains/ingest/sync/deletion/index.ts`
- Move + rename (4): `deletion-strategy.ts` → `deletion/strategy.ts`,
  `batch-delete-executor.ts` → `deletion/batch-executor.ts`,
  `deletion-retry-helper.ts` → `deletion/retry-helper.ts`, `deletion-outcome.ts`
  → `deletion/outcome.ts`
- Move (1): `reindex-coordinator.ts` → `deletion/reindex-coordinator.ts`
- Move + rename tests (3): `deletion-strategy.test.ts` →
  `deletion/strategy.test.ts`, `deletion-retry-helper.test.ts` →
  `deletion/retry-helper.test.ts`, `deletion-outcome.test.ts` →
  `deletion/outcome.test.ts`
- Move (1): `reindex-coordinator.test.ts` →
  `deletion/reindex-coordinator.test.ts`

(No test file exists for `batch-delete-executor.ts` — it's covered by
`strategy.test.ts`. No test rename for it.)

- [ ] **Step 1: Mark beads task in_progress**

```bash
bd update <task-5-id> --status=in_progress
```

- [ ] **Step 2: Create dirs + barrel**

```bash
mkdir -p src/core/domains/ingest/sync/deletion
mkdir -p tests/core/domains/ingest/sync/deletion
```

Write `src/core/domains/ingest/sync/deletion/index.ts`:

```typescript
export { DeletionStrategy, type DeletionConfig } from "./strategy.js";
export { BatchDeleteExecutor } from "./batch-executor.js";
export { DeletionRetryHelper, type RetryOptions } from "./retry-helper.js";
export { createDeletionOutcome, type DeletionOutcome } from "./outcome.js";
export { ReindexCoordinator } from "./reindex-coordinator.js";
```

(Verify class/type names by reading each source file before writing.)

- [ ] **Step 3: git mv + rename source files**

```bash
git mv src/core/domains/ingest/sync/deletion-strategy.ts     src/core/domains/ingest/sync/deletion/strategy.ts
git mv src/core/domains/ingest/sync/batch-delete-executor.ts src/core/domains/ingest/sync/deletion/batch-executor.ts
git mv src/core/domains/ingest/sync/deletion-retry-helper.ts src/core/domains/ingest/sync/deletion/retry-helper.ts
git mv src/core/domains/ingest/sync/deletion-outcome.ts      src/core/domains/ingest/sync/deletion/outcome.ts
git mv src/core/domains/ingest/sync/reindex-coordinator.ts   src/core/domains/ingest/sync/deletion/reindex-coordinator.ts
```

- [ ] **Step 4: git mv + rename test files**

```bash
git mv tests/core/domains/ingest/sync/deletion-strategy.test.ts     tests/core/domains/ingest/sync/deletion/strategy.test.ts
git mv tests/core/domains/ingest/sync/deletion-retry-helper.test.ts tests/core/domains/ingest/sync/deletion/retry-helper.test.ts
git mv tests/core/domains/ingest/sync/deletion-outcome.test.ts      tests/core/domains/ingest/sync/deletion/outcome.test.ts
git mv tests/core/domains/ingest/sync/reindex-coordinator.test.ts   tests/core/domains/ingest/sync/deletion/reindex-coordinator.test.ts
```

- [ ] **Step 5: Update intra-group imports** (files import each other under new
      names)

In `src/core/domains/ingest/sync/deletion/strategy.ts`:

- `from "./batch-delete-executor.js"` → `from "./batch-executor.js"`
- `from "./deletion-outcome.js"` → `from "./outcome.js"`
- `from "./deletion-retry-helper.js"` → `from "./retry-helper.js"`

In `src/core/domains/ingest/sync/deletion/batch-executor.ts`: no intra-group
imports (only Qdrant + DeletionOutcome). Update `./deletion-outcome.js` →
`./outcome.js` if present.

In `src/core/domains/ingest/sync/deletion/retry-helper.ts`:

- `from "./deletion-outcome.js"` → `from "./outcome.js"`

In `src/core/domains/ingest/sync/deletion/outcome.ts`: no intra-group imports
(leaf).

In `src/core/domains/ingest/sync/deletion/reindex-coordinator.ts`:

- `from "./deletion-outcome.js"` → `from "./outcome.js"`

- [ ] **Step 6: Update parent-level imports inside moved files**

Each moved file's `../<x>.js` paths now need one more level (since they're one
deeper):

- `../../adapters/qdrant/client.js` → `../../../adapters/qdrant/client.js`
- `../errors.js` → `../../errors.js`
- `../pipeline/infra/debug-logger.js` → `../../pipeline/infra/debug-logger.js`
- `../pipeline/infra/runtime.js` → `../../pipeline/infra/runtime.js`
- `../../../types.js` → `../../../../types.js`

Use `Edit` per file. Verify after all 5:

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "sync/deletion/" || echo "OK"
```

- [ ] **Step 7: Update intra-test imports** (test files reference moved sources
      by new name)

In each moved test file:

- Bump `src/core/...` depth by one `../`
- Replace any `from ".../sync/deletion-<x>.js"` with
  `from ".../sync/deletion/<new-name>.js"` if a test imports a sibling deletion
  file (rare; most tests import a single SUT).

- [ ] **Step 8: Find + update external importers**

```bash
rg -l --type ts "from [\"'][^\"']*sync/(deletion-strategy|batch-delete-executor|deletion-retry-helper|deletion-outcome|reindex-coordinator)(\.js)?[\"']" src/ tests/
```

Update each. **`deletion-outcome` has 9 importers** (the highest blast radius in
the whole refactor) — verify every single one updates cleanly. Re-run rg until
empty.

- [ ] **Step 9: Build + tests**

```bash
npm run build
npx vitest run tests/core/domains/ingest/sync/deletion/ tests/core/domains/ingest/pipeline/file-processor-coordinator.test.ts
```

`file-processor-coordinator.test.ts` is the most likely downstream test for
`ReindexCoordinator` — verify it stays green.

- [ ] **Step 10: Commit**

```bash
git add src/core/domains/ingest/sync/ tests/core/domains/ingest/sync/
git commit -m "refactor(sync): split deletion cascade into sync/deletion/ with shorter names"
bd close <task-5-id>
```

---

## Task 6: Split shared algorithms into `sync/infra/`

**Files:**

- Create: `src/core/domains/ingest/sync/infra/index.ts`
- Move (2): `merkle.ts`, `consistent-hash.ts` from `sync/` → `sync/infra/`
- Move (2): mirror tests

- [ ] **Step 1: Mark beads task in_progress**

```bash
bd update <task-6-id> --status=in_progress
```

- [ ] **Step 2: Create dirs + barrel**

```bash
mkdir -p src/core/domains/ingest/sync/infra
mkdir -p tests/core/domains/ingest/sync/infra
```

Write `src/core/domains/ingest/sync/infra/index.ts`:

```typescript
export { MerkleNode, MerkleTree } from "./merkle.js";
export {
  ConsistentHash,
  type ConsistentHashOptions,
} from "./consistent-hash.js";
```

- [ ] **Step 3: git mv source + test files**

```bash
git mv src/core/domains/ingest/sync/merkle.ts          src/core/domains/ingest/sync/infra/merkle.ts
git mv src/core/domains/ingest/sync/consistent-hash.ts src/core/domains/ingest/sync/infra/consistent-hash.ts
git mv tests/core/domains/ingest/sync/merkle.test.ts          tests/core/domains/ingest/sync/infra/merkle.test.ts
git mv tests/core/domains/ingest/sync/consistent-hash.test.ts tests/core/domains/ingest/sync/infra/consistent-hash.test.ts
```

- [ ] **Step 4: Update internal imports in moved files**

`consistent-hash.ts` imports `IngestInvariantError` from `../errors.js`. After
move: `../../errors.js`.

`merkle.ts` is a leaf — no internal imports beyond `node:crypto`.

- [ ] **Step 5: Update test imports**

Add one `../` to `src/core/...` paths in both test files.

- [ ] **Step 6: Update ALL importers — this is where `sync/snapshot/` paths
      shift too**

```bash
rg -l --type ts "from [\"'][^\"']*sync/(merkle|consistent-hash)(\.js)?[\"']" src/ tests/
```

Expected list includes:

- `src/core/domains/ingest/sync/synchronizer.ts` — `./merkle.js` →
  `./infra/merkle.js`
- `src/core/domains/ingest/sync/parallel-synchronizer.ts` — `./merkle.js`,
  `./consistent-hash.js` → `./infra/merkle.js`, `./infra/consistent-hash.js`
- `src/core/domains/ingest/sync/snapshot/snapshot.ts` — `../merkle.js` (from
  Task 4) → `../infra/merkle.js`
- `src/core/domains/ingest/sync/snapshot/sharded-snapshot.ts` — `../merkle.js`,
  `../consistent-hash.js` → `../infra/merkle.js`, `../infra/consistent-hash.js`

Update each. Re-run rg until empty.

- [ ] **Step 7: Build + tests**

```bash
npm run build
npx vitest run tests/core/domains/ingest/sync/
```

Expected: build passes, ALL sync tests green (including snapshot/, deletion/,
infra/, plus top-level synchronizer + parallel-synchronizer).

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/ingest/sync/ tests/core/domains/ingest/sync/
git commit -m "refactor(sync): extract merkle + consistent-hash into sync/infra/"
bd close <task-6-id>
```

---

## Task 7: Create `sync/index.ts` barrel + update `ingest/index.ts`

**Files:**

- Create: `src/core/domains/ingest/sync/index.ts`
- Modify: `src/core/domains/ingest/index.ts`

- [ ] **Step 1: Mark beads task in_progress**

```bash
bd update <task-7-id> --status=in_progress
```

- [ ] **Step 2: Write `sync/index.ts` barrel**

```typescript
export { FileSynchronizer } from "./synchronizer.js";
export { ParallelFileSynchronizer } from "./parallel-synchronizer.js";
export * from "./snapshot/index.js";
export * from "./deletion/index.js";
export * from "./infra/index.js";
```

(Verify `FileSynchronizer` / `ParallelFileSynchronizer` class names by reading
`synchronizer.ts` and `parallel-synchronizer.ts` top exports.)

- [ ] **Step 3: Replace `src/core/domains/ingest/index.ts` with new paths**

```typescript
export {
  IngestError,
  NotIndexedError,
  CollectionExistsError,
  SnapshotMissingError,
  PipelineNotStartedError,
  IngestInvariantError,
} from "./errors.js";
export type { IngestErrorCode } from "./errors.js";
export { IndexPipeline } from "./operations/indexing.js";
export { ReindexPipeline } from "./operations/reindexing.js";
export { computeCollectionStats } from "./infra/collection-stats.js";
export {
  createIngestDependencies,
  type IngestDependencies,
  type SynchronizerTuning,
} from "./factory.js";
export { INDEXING_METADATA_ID } from "./constants.js";
export { cleanupOrphanedVersions } from "./infra/alias-cleanup.js";
```

- [ ] **Step 4: Build to confirm barrels resolve**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/index.ts src/core/domains/ingest/sync/index.ts
git commit -m "refactor(ingest): wire sync/ barrel + repoint ingest/ barrel to new paths"
bd close <task-7-id>
```

---

## Task 8: Final verification — full build, full tests, coverage

**Files:** none (verification only)

- [ ] **Step 1: Mark beads task in_progress**

```bash
bd update <task-8-id> --status=in_progress
```

- [ ] **Step 2: Clean rebuild**

```bash
npm run build 2>&1 | tail -20
```

Expected: no errors, no warnings about missing modules.

- [ ] **Step 3: Type-check (strict)**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Full test suite**

```bash
npx vitest run
```

Expected: all green. If any test fails, the failure is from a missed import
update — re-run `rg` for the bare basename of the failing module and patch.

- [ ] **Step 5: Coverage check**

```bash
npx vitest run --coverage
```

Compare summary against `coverage/coverage-summary.json` from before the
refactor. Statements/lines/functions/branches percentages must be equal or
higher. If any metric drops, escalate — do NOT lower the threshold (per
`feedback_never_lower_thresholds`).

- [ ] **Step 6: Sanity grep — no stale paths remain**

```bash
rg "from [\"'][^\"']*ingest/(indexing|reindexing|alias-cleanup|collection-stats|heartbeat-guard|optimizer-lifecycle|stats-recompute)\.js[\"']" src/ tests/
rg "from [\"'][^\"']*sync/(snapshot|sharded-snapshot|snapshot-cleaner|deletion-strategy|batch-delete-executor|deletion-retry-helper|deletion-outcome|reindex-coordinator|merkle|consistent-hash)\.js[\"']" src/ tests/
```

Both must produce **zero output**. Any match is a missed update — patch and
re-run.

- [ ] **Step 7: Verify barrel files are at every subdomain**

```bash
ls src/core/domains/ingest/operations/index.ts \
   src/core/domains/ingest/infra/index.ts \
   src/core/domains/ingest/sync/index.ts \
   src/core/domains/ingest/sync/snapshot/index.ts \
   src/core/domains/ingest/sync/deletion/index.ts \
   src/core/domains/ingest/sync/infra/index.ts
```

All six must exist.

- [ ] **Step 8: Close beads task + epic**

```bash
bd close <task-8-id>
bd close <epic-id> --reason="Ingest restructure complete — all subdomains barreled, tests green, coverage held."
```

- [ ] **Step 9: Cleanup grep — no empty directories**

```bash
find src/core/domains/ingest -type d -empty
```

Expected: empty output. If any dir remains empty, remove it (`rmdir <path>`) and
amend nothing — refactor commits already landed.

---

## Self-review notes (filled in during writing)

**Spec coverage:**

- ✅ top-level → barrels + factory only — Tasks 2, 3, 7
- ✅ `indexing`/`reindexing` → `operations/` — Task 2
- ✅ `alias-cleanup`, `collection-stats`, `heartbeat-guard` → `infra/` — Task 3
  (also moves `optimizer-lifecycle`, `stats-recompute` for symmetry)
- ✅ `sync/` split into `snapshot/`, `deletion/`, `infra/` — Tasks 4, 5, 6
- ✅ deletion rename (drop `deletion-` prefix) — Task 5
- ✅ tests mirrored — every Task moves tests alongside sources
- ✅ mandatory subdomain barrels rule — Task 1 (front-loaded)
- ✅ beads epic + tasks — pre-flight section

**No placeholders:** every step has either exact code, an exact command, or a
clearly bounded `Edit` instruction with before/after fragments. No TBDs.

**Type consistency:** symbol names used in barrels (Tasks 2, 3, 4, 5, 6, 7) and
the final `ingest/index.ts` (Task 7) are kept consistent: `IndexPipeline`,
`ReindexPipeline`, `SnapshotManager`, `ShardedSnapshotManager`,
`DeletionStrategy`, `BatchDeleteExecutor`, `DeletionRetryHelper`,
`createDeletionOutcome`, `ReindexCoordinator`, `MerkleTree`, `ConsistentHash`,
`cleanupOrphanedVersions`, `computeCollectionStats`, `HeartbeatGuard`,
`OptimizerLifecycle`, `StatsRecomputeService`. Steps that write barrels include
a "verify export names" reminder because some symbols (e.g. `FileSynchronizer`,
`SnapshotManager`, `cleanupSnapshots`) need confirmation from source headers
before the barrel is written.

---

## Execution Handoff

Plan complete and saved to
`docs/superpowers/plans/2026-05-17-ingest-restructure-impl.md`. Two execution
options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per Task,
   review between tasks. Each Task is mechanical (move + import update + verify)
   so a subagent per Task is well-scoped.
2. **Inline Execution** — execute Tasks here using executing-plans, batched with
   checkpoints.

Which approach?
