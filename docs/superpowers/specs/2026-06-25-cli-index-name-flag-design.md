# Design: `index-codebase --name <alias>` — register-then-index in one command

**Date:** 2026-06-25 **Status:** approved (design), pre-implementation **Scope
class:** sub-epic (single CLI flag + handler wiring + skill/doc updates)

## Problem

**Primary case — first-time index of a new project.** When a brand-new project
is indexed for the first time, registering it under a stable alias is a separate
step. Today the `tea-rags:index` skill indexes first and then offers
`register_project` **after** the fact (or the operator runs `projects register`
separately). So the first index produces a `name: null` registry entry, and the
alias only appears on a follow-up action — easy to forget, and every later
search has to fall back to `path`/`collection` instead of the stable alias.

The two-step shows up in both directions:

```bash
# register-after (current tea-rags:index skill): index, then register separately
tea-rags index-codebase <dir>
tea-rags projects register --path <dir> --name <alias>

# register-before: two commands / two MCP calls (register_project + index_codebase)
tea-rags projects register --path <dir> --name <alias>
tea-rags index-codebase --project <alias>
```

There is no single-command "index this new project **and** give it an alias now"
entry point. (The `test-self-reindex` skill hits the same two-step; the
`worktree create` clone flow does **not** need this — see the worktree
clarification below.)

## Goal

Add `--name <alias>` to `tea-rags index-codebase`. When present, the command
registers the resolved path under `<alias>` in the collection-registry
**before** spawning the indexing worker, then indexes. One command gives a new
project its alias at first index — no register-after, no two-step.

```bash
# first index of a new project, aliased in one shot:
tea-rags index-codebase /path/to/new-project --name new-project
tea-rags index-codebase . --name myproj --wait-enrichments --json
```

## Non-goals (YAGNI)

- No change to `--project` semantics (still resolves an **existing** alias →
  path).
- No auto-name derivation (no basename/branch magic). Alias is explicit.
- No change to `tea-rags worktree create` registration (it already
  auto-registers with worktree provenance — see the worktree clarification
  below).
- No new shared CLI module — registration logic already lives in
  `ProjectRegistryOps.register`; we call it directly.

## Component

**What it does:** registers `path → alias` in the collection-registry, then runs
the normal indexing path. **Who owns it:** `src/cli/commands/index-codebase.ts`
(builder + handler). **Interface:**
`tea-rags index-codebase [path] --name <alias> [...existing flags]`.

### Handler ordering (critical — env-seeding correctness)

The registration step is inserted into the existing handler at a specific
position so it does not break worker env seeding:

1. `applyProjectDefaults(argv)` — **unchanged**. `--name` is write-side; it does
   not resolve `path`. (`--project` is the read-side resolver.)
2. Resolve `path` (positional or cwd).
3. Resolve `registryEnv` via
   `resolveRegistryEnv(pickRegistryEntry(registry, …))` — **before** register.
   Rationale: for a brand-new project, `pickRegistryEntry` falls back to the
   most-recently-indexed entry to seed `EMBEDDING_*` / codegraph env. If we
   registered first, the fresh stub entry (chunksCount 0, empty embedding
   config) would shadow that fallback via the path match, leaving the worker
   without embedding config. Resolve env first, register second.
4. **If `argv.name`:**
   `await new ProjectRegistryOps({ registry }).register({ path, name })`.
   - No `qdrant` / `embeddings` in deps: the collection does not exist yet
     (first index), so `tryEnrichFromQdrant` would only do a wasted round-trip.
   - On a thrown typed error (see Error handling): render and `process.exit(1)`
     **before** `forkWorker`. Registration validation gates indexing.
5. `projectName = argv.name ?? argv.project ?? resolveProjectName(registry, path) ?? undefined`
   for the status block (so the live progress header shows the new alias).
6. `forkWorker(...)` + `superviseIndexing(...)` — **unchanged**.

### Reuse vs duplicate

Registration logic stays in `ProjectRegistryOps.register` — the same unit
`tea-rags projects register` (`runRegister`) uses. `index-codebase` calls
`ops.register` **directly**, NOT `runRegister`, because `runRegister` does
`process.exit(1)` + plain-stderr on error, which is wrong inside
`index-codebase` (it must honor `--json` and its own colorizer). The shared unit
is the ops method; the CLI wrappers legitimately differ in their error UX.

### `--name` vs `--project`

`.conflicts("name", "project")` in the yargs builder. They are mutually
exclusive entry modes:

- `--project <alias>` — use an **existing** alias (resolve path from registry).
- `--name <alias>` — **create** an alias for this path, then index.

**Alternative considered (rejected):** overload `--project` to upsert (register
when the alias is unknown instead of throwing). Rejected because it removes the
`ProjectNotRegisteredError` guardrail — a typo'd `--project` name would silently
create a wrong alias instead of erroring. The user explicitly asked for a
separate `--name`, which is the cleaner separation.

## Idempotency & collisions — already handled by `ProjectRegistryOps.register`

No new logic; these are the existing `register` semantics the flag inherits:

| Situation                                                                    | Behavior                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Same path + same name, already indexed (chunksCount > 0)                     | Rename fast-path: `setName` only, no Qdrant round-trip. Safe to re-run. |
| Name held by a **stale** entry (its path no longer on disk — worktree moved) | Re-point: keep collection/codegraph/chunks, update `path`. Transparent. |
| Name held by a **different live** path                                       | `ProjectNameNotUniqueError` → abort before index (guardrail).           |
| Bad regex / empty / >64 chars                                                | `ProjectNameInvalidError` → abort before index.                         |
| Path does not exist                                                          | `PathDoesNotExistError` → abort before index.                           |

`PROJECT_NAME_RE` validation is enforced by `register`; no duplicate validation
in the CLI.

## Error handling

Registration throws typed `InputValidationError` subclasses. The handler catches
them around the `ops.register` call and renders:

- **text mode:** colorized one-line error via the existing colorizer (same
  channel the index errors use), then `process.exit(1)`.
- **`--json` mode:** a single `{ "error": { "code", "message" } }` object to
  stdout, then `process.exit(1)` — symmetric with how index failures already
  surface in JSON mode, so agent consumers get a parseable failure.

Registration failure means **no fork** — indexing never starts on a bad alias.

## Clarification: `--name` is NOT for `tea-rags worktree create`

The original ask floated worktree as an example; it is a non-applicability note,
not the driver. `--name` is for **first index of a not-yet-registered project**.
The worktree distinction matters only because one worktree path already
registers:

1. **`tea-rags worktree create`** — clones an existing source index into a new
   collection and records the alias `<source>-worktree-<name>` **with**
   `setWorktreeProvenance`. The follow-up hint is
   `index-codebase --project <alias>` and stays that way: the alias is already
   registered with provenance, so `--name` here would create a **second**
   registration **without** provenance. Do not change this hint.
2. **Any fresh, not-yet-registered project** — a brand-new repo, or a fresh git
   worktree (e.g. session `EnterWorktree`, no tea-rags clone) whose source you
   want indexed under its own alias. There is no registration yet, so
   `index-codebase --name <alias>` registers from scratch in one step. The
   new-project first index and the `test-self-reindex` worktree index are the
   same shape.

## Skill / doc wiring (approved scope)

Ordered by priority — the `tea-rags:index` skill is the primary consumer (it
owns the first-index-of-a-new-project flow).

| Target                                                                   | Priority     | Change                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tea-rags:index` skill (`.claude-plugin/tea-rags/skills/index/SKILL.md`) | **primary**  | First-time index of an unregistered path uses `tea-rags index-codebase <path> --name <alias>` — register **inline** at first index instead of the current "index, then offer register **after**" flow. Register-after stays only as the fallback for an already-indexed entry that still has `name: null`.    |
| `.claude/skills/test-self-reindex/SKILL.md`                              | secondary    | Replace the two MCP steps (`register_project` → `index_codebase --project … forceReindex`) with a single CLI call: `tea-rags index-codebase <worktree-path> --name tea-rags-worktree --force --wait-enrichments --json`. Aligns with the project rule "prefer the CLI when testing enrichments with reindex". |
| `tea-rags worktree create` hint (`src/cli/commands/worktree.ts`)         | minor (note) | **Keep `--project`.** Add a one-line note that `--name` is for first-index of a fresh (non-cloned) project, not for the provenance-tracked clone flow. No behavioral change.                                                                                                                                  |

## Testing (TDD — RED first)

Handler-level tests in `tests/cli/commands/index-codebase*.test.ts` (or the
existing index-codebase handler test), mirroring the existing supervisor/worker
test style (inject fakes, assert ordering):

1. `--name` registers the path under the alias **before** the worker is forked
   (assert the registry entry exists with the name set, and fork is called after
   register resolves).
2. `--name` + `--project` together → yargs conflict error (command rejected).
3. `register` throwing a typed error aborts **before** fork (fork NOT called;
   exit code 1).
4. `--json` + register error → parseable `{ error: … }` shape on stdout.
5. `--name` re-run on an already-indexed same path → succeeds (rename
   fast-path), indexing proceeds.

No business-logic test rewrites; `ProjectRegistryOps.register` already has its
own coverage for the registration semantics above — we test the **CLI wiring**,
not re-test register internals.

## Affected files

- `src/cli/commands/index-codebase.ts` — `IndexCodebaseArgs.name`, builder
  `.option("name")` + `.conflicts`, handler register step + error render.
- `tests/cli/commands/index-codebase*.test.ts` — new wiring tests.
- `.claude/skills/test-self-reindex/SKILL.md` — single-command rewrite.
- `.claude-plugin/tea-rags/skills/index/SKILL.md` — mention `--name`.
- `src/cli/commands/worktree.ts` — optional one-line hint note (no behavior
  change).

## Versioning

`feat(api)` → minor bump (new user-facing CLI capability, additive; `cli` is not
a registered scope, `api` is the closest Public+Functional scope). No BREAKING
CHANGE (purely additive flag; existing invocations unchanged).
