# Project Registry Hardening — Design

**Date:** 2026-05-13 **Status:** Approved (brainstorm), pending implementation
plan **Predecessor:** `2026-05-12-project-registry-design.md` (initial registry
shipped on `feature/project-registry`)

## Motivation

A post-merge audit of the freshly landed Project Registry (commits `ab59d9f3` →
`350d6f1b`, merged to main as `eea242c5`) surfaced 15 issues across three risk
tiers. Four of them can silently destroy user data (concurrent writes, stale
in-process cache, corrupt-file overwrite, error-class duplication that bypasses
the validation middleware). Six are user-visible papercuts (empty-string
poisoning, dead `recoverFromQdrant`, orphan collections in Qdrant, regex
duplication, missing format migrations). Five are polish (input validation,
unregister hint, symlink drift, fake `indexedAt`, `process.exit` inside a
library function).

The registry is shared between the long-lived MCP server and short-lived CLI
processes that all hold their own `CollectionRegistry` instances and write to
the same `registry.json`. Today nothing prevents them from clobbering each
other's writes, and nothing tells the MCP-server cache that the file changed.
This design closes those gaps without changing the on-disk format (`v1`) or the
public `App` API surface (`registerProject` / `listProjects` /
`unregisterProject` stay byte-compatible).

`src/core/infra/collection-name.ts:resolveCollection` is flagged by all three
risk lenses (hotspots / ownership / techDebt with `bugFixRate=50%` critical). We
**do not** touch its signature in this work — the registry refactor must be
non-invasive to that function.

## Decisions

### A. Concurrency — merge-on-write + fs.watch + CAS

`registry-file.ts` already does atomic `rename`, but the read–mutate–write step
on top of it (in `CollectionRegistry.flush`) is not atomic between processes.

Resolution:

1. **`flush()` re-reads disk first.** Inside `CollectionRegistry.flush`, load
   the on-disk file, merge it with the in-memory delta (per-`collectionName`
   last-writer-wins), and `saveRegistryFile` the merged result.
2. **CAS via inode + mtime.** Snapshot `fs.stat` before the read, snapshot again
   after the merge, and only `rename` when both inode and mtime match. Otherwise
   back off (10 ms, 20, 40, 80, 160) and retry up to 5 times. After the 5th
   failure throw a typed `RegistryConcurrencyError` (subclass of `InfraError`).
3. **`fs.watch` in the long-lived MCP server.** `CollectionRegistry` exposes
   `startWatching(): () => void` (returns a stop handle). When called, it
   subscribes to `fs.watch(registryPath)` and on every change event clears
   `this.cache` so the next `ensureLoaded` re-reads. Bootstrap in
   `src/bootstrap/factory.ts` calls `startWatching` only when constructing the
   MCP server (long-lived); CLI commands never call it (cache invalidation is
   moot for one-shot processes).

The merge function is per-collection last-writer-wins keyed on `collectionName`.
`name` stays sticky with a directional bias: if the in-memory delta has a
non-null name, it wins (the local process intent is an explicit user action —
`setName`); if the in-memory delta has `null` and disk has a non-null name, disk
wins (we don't accidentally erase a concurrent rename). This rule lives in
`mergeRegistryDelta` next to `mergeRegistryEntries`, both pure functions, both
unit-tested.

We deliberately reject `proper-lockfile` (adds a dep, doesn't solve cache
invalidation) and JSONL append-only (breaks current format, needs compaction).

### B. Migration framework — inline, single-version

`loadRegistryFile` becomes:

```ts
parsed.version === CURRENT_VERSION   → return as RegistryFileVN
KNOWN_MIGRATIONS[parsed.version]     → transform, save back, return
otherwise                            → backupCorruptFile + throw
```

`KNOWN_MIGRATIONS: Record<number, (raw: unknown) => RegistryFileVN>` lives at
the top of `registry-file.ts`. For shipping V1 it is an empty record — the
infrastructure exists, no transformations registered. When V2 lands the
migration is added in the same PR as the schema change.

We do **not** create a `src/core/infra/registry/migrations/` directory yet. One
inline function per supported old version is cheaper to read than a factory +
descriptor pattern for zero current migrations.

### B-bonus. Corrupt-file backup

`backupCorruptFile(path)` renames `registry.json` to
`registry.json.corrupt-<ISO-timestamp>.bak` (no extension reuse — easier to spot
in `ls`). Called from three sites in `loadRegistryFile`:

- JSON parse failure
- Root is not an object
- `version` is neither `CURRENT_VERSION` nor in `KNOWN_MIGRATIONS`

The function is best-effort: if the rename itself fails (disk full, EACCES), log
to stderr and re-throw the original corruption error. Never silently overwrite a
corrupt file.

### C. Recovery completeness — best-effort path

`recoverFromQdrant` keeps writing `path: ""` for collections whose path is not
known from registry state. The indexing-marker payload stays as-is —
`absolutePath` is **not** added to it, because the marker is supposed to
describe "how this collection was built" (model, version, completedAt), not
"where the user mounted it". `path` is user-controlled binding that lives in
`registry.json` only.

The user-facing failure is moved to `applyProjectDefaults`: when
`entry.path === ""`, throw a new typed error
`ProjectPathMissingError(name, hint)` whose `hint` field contains the exact
shell command to fix it
(`tea-rags projects register --path <dir> --name <alias>`). The CLI handler in
`commands/projects.ts` (or wherever `applyProjectDefaults` is consumed) catches
the typed error, writes the hint to stderr, and exits 1.

### D. Orphan-collection UX — diagnose + act + assist

Three additions, each in its own file/command:

1. **`tea-rags projects orphans`** (`src/cli/commands/projects.ts`, read-only):
   list every collection present in Qdrant that has no registry entry. Output is
   tab-separated `collectionName\tchunksCount\tindexedAt` for easy piping.
   `--json` flag available.
2. **`tea-rags projects unregister --purge`**: when `--purge` is set, after
   removing the registry entry, also call
   `qdrant.deleteCollection(entry.collectionName)`. Without `--purge` the
   behaviour stays the same (registry-only removal). Output makes the side
   effect explicit:
   `Removed 'foo' from registry; deleted Qdrant collection 'code_abc' (12345 chunks)`.
   Without `--purge`:
   `Removed 'foo' from registry. Note: Qdrant collection 'code_abc' was not deleted — run with --purge or 'tea-rags projects unregister --name foo --purge' to remove it.`
   (covers audit issue #12).
3. **`tea-rags doctor` shows orphan summary** and **gains a `--recover-registry`
   flag** that calls `ProjectRegistryOps.recoverFromQdrant`. Without the flag,
   `doctor` prints the orphan count and the suggested invocation. With the flag,
   it runs the recovery, then prints a summary
   (`Recovered N entries; paths are empty — re-register them to enable applyProjectDefaults`).

`doctor` does not yet exist as a CLI command (verified during brainstorm), so
PR2 introduces it under `src/cli/commands/doctor.ts`. It is a natural home for
diagnostic + repair operations and we expect more checks to land there over time
(Qdrant reachability, embedding endpoint, stale lockfiles, etc.) — but only the
registry-related surface is in scope for PR2.

### E. Pipeline race semantics — no retry, CAS suffices

`base.ts:recordRegistryEntry` stays exactly as it is. The merge-on-write + CAS
loop inside `flush()` guarantees that `record()` either succeeds in a finite
number of attempts or throws `RegistryConcurrencyError`. The pipeline already
wraps the call in `try/catch` and logs failures to stderr without aborting
indexing — that's the right behaviour. We don't add an outer retry; if CAS gave
up after 5 retries, the system is under sustained contention and a sixth attempt
won't help.

## What we explicitly DO NOT do

- Do not change `src/core/infra/collection-name.ts:resolveCollection` signature
  (main risk node per all three rerank lenses).
- Do not add `absolutePath` to indexing-marker payload (rejected in §C).
- Do not introduce a `migrations/` directory (rejected in §B — zero current
  migrations, inline is cheaper).
- Do not pull in `proper-lockfile` or any locking dep (rejected in §A — native
  merge-on-write + CAS is enough for the workload).
- Do not change `RegistryFileV1` shape (forward-compatible — V2 happens when a
  payload change demands it).

## Implementation roadmap

Three sequential PRs by layer. Each PR ships independently green.

### PR1 — `feat(registry)` (foundation, minor bump)

Files:
`src/core/infra/registry/{registry-file,collection-registry,types, errors,index}.ts`,
`src/core/api/errors.ts` (remove duplicate `ProjectNameNotUniqueError`),
`src/bootstrap/factory.ts` (wire `startWatching` for MCP-server context only).

Closes audit items: **#1** (CAS + merge-on-write), **#2** (fs.watch
invalidation), **#3** (corrupt-backup), **#4** (`ProjectNameNotUniqueError`
dedup — keep the typed `InputValidationError` subclass in `api/errors.ts`,
delete the plain `Error` subclass from `collection-registry.ts`, update all
imports), **#9** (single `PROJECT_NAME_RE` constant exported from
`registry/constants.ts` (new file — `types.ts` keeps type definitions, not
runtime values), consumed by `collection-registry`, `project-registry-ops`, and
`mcp/tools/register-project`), **#10** (migration framework, no V1→V1 migration
registered), **#11** (`record()` rejects entries with empty or malformed
`collectionName`, negative `embeddingDimensions`, invalid `name`).

New types: `RegistryConcurrencyError extends InfraError`.

### PR2 — `feat(cli)` + `improve(api)` (recovery + UX, patch bump)

Files: `src/core/api/internal/ops/project-registry-ops.ts`,
`src/cli/commands/projects.ts`, `src/cli/commands/doctor.ts` (new).
`tea-rags doctor` is CLI-only — no `App` surface change, no MCP tool change. Out
of scope for this PR: exposing `purge` through the MCP `unregister_project` tool
(destructive Qdrant action through MCP needs its own consent model — track
separately if requested).

Closes audit items: **#5** (`tryEnrichFromQdrant` returns `null` for unknown
fields instead of `""`; ops layer skips writing those keys; entry is left
partial with explicit `(unknown)` rendering in `info`), **#6** + **#7**
(`recoverFromQdrant` wired to `tea-rags doctor --recover-registry`; the no-arg
`doctor` prints orphan summary; path stays empty by design — handled by §C),
**#8** (orphans command + `--purge` flag + doctor surface), **#12** (unregister
stdout/stderr explicitly states the Qdrant collection's fate), **#14**
(`tryEnrichFromQdrant` no longer fakes `indexedAt = new Date()` for markerless
collections — leaves empty, `projects info` renders `(unknown)`).

New error: `ProjectPathMissingError(name, hint) extends InputValidationError` in
`core/api/errors.ts`.

### PR3 — `improve(cli)` (polish, patch bump)

Files: `src/cli/registry-resolver.ts`, `src/cli/commands/projects.ts`.

Closes audit items: **#13** (`projects info` renders both the stored `path` and
`realpath(path)`, marking them when they diverge — a hint that the user may want
to re-register), **#15** (`applyProjectDefaults` no longer calls
`process.exit(1)` — it throws `ProjectNotRegisteredError` (already typed) or
`ProjectPathMissingError`; the CLI dispatcher in `commands/projects.ts` catches
and exits with the appropriate code).

## Test plan

PR1:

- `tests/core/infra/registry/registry-file.test.ts` (extended): CAS retry
  succeeds when stat changes mid-flush (mock `fs.statSync` to flip ino on second
  call); migration framework calls registered transform and persists result;
  corrupt file is renamed to `.bak` before empty Map fallback;
  `RegistryConcurrencyError` thrown after 5 failed CAS attempts.
- `tests/core/infra/registry/collection-registry.test.ts` (extended):
  `startWatching` returns a stop fn; external write triggers cache clear; next
  `get()` re-reads from disk and sees the external change.
- `tests/core/infra/registry/migrate.test.ts` (new): no-op for V1, error for
  unknown version, calls `backupCorruptFile`.
- `tests/core/api/errors.test.ts` (extended): `ProjectNameNotUniqueError` is an
  `InputValidationError` and only defined once in the codebase.

PR2:

- `tests/core/api/internal/ops/project-registry-ops.test.ts` (extended):
  `tryEnrichFromQdrant` returns partial entry when marker is missing —
  `embeddingModel` / `qdrantUrl` left absent in the saved entry;
  `recoverFromQdrant` writes `path: ""`.
- `tests/cli/commands/projects.test.ts` (extended): `orphans` lists
  collections-not-in-registry; `unregister --purge` deletes the Qdrant
  collection; `unregister` without purge prints a hint mentioning `--purge`.
- `tests/cli/commands/doctor.test.ts` (new or extended): summary prints orphan
  count; `--recover-registry` calls `ProjectRegistryOps.recoverFromQdrant`.
- `tests/cli/registry-resolver.test.ts` (extended): `applyProjectDefaults`
  throws `ProjectPathMissingError` when entry path is empty (no `process.exit`).

PR3:

- `tests/cli/commands/projects.test.ts` (extended): `info` renders both stored
  path and resolved realpath when they differ.
- `tests/cli/registry-resolver.test.ts` (extended): no `process.exit` invoked;
  typed errors propagate; CLI dispatcher catches and exits.

## Telemetry / observability

None added. Registry write contention is rare enough that
`RegistryConcurrencyError` to stderr is sufficient. If we see it in real-world
support requests we can layer metrics on top later.

## Risks and rollback

- **CAS loop livelock:** if both processes write infinitely they could keep
  flipping inode. Exp.backoff + 5-retry cap bounds this; the loser throws
  `RegistryConcurrencyError`. Worst case: one process gives up and logs,
  pipeline indexing continues (it ignores registry-record failures already).
- **fs.watch reliability:** Linux/macOS file watching is event-based and can
  miss events under load. We accept this — the next `record()` re-reads anyway
  because of merge-on-write. fs.watch is a freshness optimization, not a
  correctness primitive.
- **Rollback:** each PR is self-contained. Reverting PR2 leaves PR1's improved
  foundation in place. Reverting PR1 puts us back to the pre-audit state (no
  CAS, plain cache, corrupt-overwrite) — undesirable but possible.

## References

- Audit: in-chat 2026-05-13 (15 issues categorized critical / serious / minor).
- Predecessor spec:
  `docs/superpowers/specs/2026-05-12-project-registry-design.md`.
- Risk signals: `tea-rags semantic_search` with
  `rerank=hotspots/ownership/ techDebt` over the registry tree —
  `collection-name.ts:resolveCollection` flagged in all three.
