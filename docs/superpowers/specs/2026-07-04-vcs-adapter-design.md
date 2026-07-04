# VCS Adapter Seam + In-Process Git Library (es-git) — Design

**Date:** 2026-07-04
**Beads:** epic `tea-rags-mcp-w2dlu` (blocks `hi37c` taxdome measurement)
**Status:** approved in brainstorm session 2026-07-04

## Problem

All git history operations (blame, per-file log/numstat, cat-file) fork a fresh
`git` process. SentinelOne EDR caps process spawn + file-open at ~10 ops/s
machine-wide (`project_edr_git_throughput`), so cold-path enrichment on a large
repo (taxdome, 24k files) takes ~1h. The blame cache (v2mlw) only covers
warm/unchanged files. In-process libgit2 reads have zero per-op spawn and are
also faster than CLI parsing.

## Decision Log (user-approved 2026-07-04)

1. **Adapter value space.** Closed enum `GIT_ADAPTER=git|es-git`, default
   `git`. New adapter = new class + factory case. No public extension
   contract.
2. **Implementation shape.** Approach A: two independent full
   implementations. No per-op hybrid delegation; the library adapter ships
   complete or not at all. Supersedes the w2dlu "start with blame+OID,
   numstat stays CLI" increment.
3. **Missing-binding semantics.** Fail-loud. Explicit `es-git` selection +
   binding load failure → `VcsAdapterUnavailableError` with per-OS install
   hint, thrown at factory create. Surfaces in MCP tools, tea-rags CLI, and
   `tune`. Supersedes the w2dlu silent-CLI-fallback clause. Optionality core
   survives: optionalDependency, `npm install` succeeds without the binary,
   default stays `git`.
4. **Env persistence.** `GIT_ADAPTER` is always written explicitly to the
   project registry (even when default `git`). CLI indexing and `tune`
   auto-apply it from the registry.
5. **Binding.** es-git (napi-rs over libgit2). Verified 2026-07-04: no
   maintained gix napi binding exists on npm (w2dlu's "preferred if exists"
   conditional failed); es-git v0.7.0 has full Blame API
   (`Repository#blameFile`, hunk iterators), revwalk/diff, per-platform
   prebuilds. Custom napi-rs gix addon remains the perf-ceiling fallback if
   es-git fails equivalence/bench; nodegit stale, isomorphic-git rejected
   (no blame, slow pack walking).
6. **Adapter hierarchy.** Three levels: `VcsAdapter` (VCS-generic contract)
   → `VcsGitAdapter` (abstract class: git-family contract strengthening +
   shared substrate) → `GitCliAdapter` | `EsGitAdapter`. The git trajectory
   domain and the factory return type are `VcsGitAdapter`: trajectory's
   assumptions (object ids, pathspec syntax, merge-parent semantics) are
   git-strength, and typing against the weaker VCS-generic contract would
   admit non-substitutable implementations — an LSP violation by
   construction. `VcsAdapter` holds only the genuinely VCS-portable subset.

## Layout

```text
src/core/adapters/vcs/
├── types.ts        VcsAdapter (VCS-generic contract) + neutral types
│                   (CommitInfo/BlameLine/FileChurnData/RawNumstatEntry)
├── errors.ts       VcsAdapterUnavailableError (install hints), shared VCS errors
├── factory.ts      VcsAdapterFactory.create(config, repoRoot): VcsGitAdapter
└── git/
    ├── adapter.ts  abstract class VcsGitAdapter implements VcsAdapter —
    │               git-family contract strengthening (pathspec ops,
    │               object-id batch plumbing) + shared substrate
    ├── cli/        GitCliAdapter extends VcsGitAdapter — current client.ts +
    │               parsers.ts + errors.ts; parsers, withTimeout, buildCliArgs,
    │               execFileForPathspec stay private to this folder
    └── es-git/     EsGitAdapter extends VcsGitAdapter — full independent
                    in-process implementation
```

`adapters/git/` is deleted; all 21 importers switch to `VcsGitAdapter`
obtained via the factory. `resolveRepoRoot` stays a module-level helper in
`vcs/` (not a contract method).

## Contract Hierarchy

Repo-scoped instances (repoRoot in constructor — libgit2 opens the Repository
once; the CLI adapter stores it as a field).

**`VcsAdapter`** (`types.ts`) — the genuinely VCS-portable subset, the
top-level abstraction a future non-git VCS (hg, jj) would implement:

- `getHead()`, `isAncestor(ancestor, descendant)`
- `readNumstatLog(sinceDate?)` — current `buildViaCli`, neutral name
- `getCommitsSince(...)`, `getCommitsInRange(...)`
- `readBlobAsString(revision, filepath)`
- `blameFile(filePath, timeoutMs?)`

**`VcsGitAdapter`** (`git/adapter.ts`) — abstract class implementing
`VcsAdapter`, the common substrate for the two git implementations. Adds the
git-strength contract:

- `getCommitsByPathspec(...)` — git pathspec syntax
- `createBlobBatchReader()` — current `createCatFileBatch`
- `createOidBatchResolver()` — current `createCatFileBatchCheck`

Logic common to both implementations (argument validation, error
normalization, repo-root handling) lives in this base class, never duplicated
in siblings. CLI plumbing vocabulary (`cat-file`) disappears from contracts;
git-CLI helpers are implementation details of `vcs/git/cli/`.

**Consumers.** The git trajectory domain and the factory return type are
`VcsGitAdapter`, not `VcsAdapter`: trajectory's assumptions (object ids,
pathspec syntax, merge-parent semantics) are git-strength, so it depends on
the strongest contract it actually requires — `GitCliAdapter` and
`EsGitAdapter` are LSP-substitutable beneath it, enforced behaviorally by the
equivalence suite. Only genuinely VCS-portable future components would type
against `VcsAdapter`. (`GitCliAdapter`, not bare `GitAdapter`: both siblings
are git adapters, the qualifier is what disambiguates.)

Worker threads (churn-walk) construct their own adapter in-thread via the
factory from config — instances never cross thread boundaries (established
worker-DI pattern).

## Factory, Env, Config

- `VcsConfig { adapter: "git" | "es-git" }` in `contracts/types/config.ts`;
  env `GIT_ADAPTER`, default `git`.
- `GIT_ADAPTER` joins the `tuning-env.ts` allow-list so it flows through the
  MCP env block and the project registry snapshot.
- Factory semantics:
  - `git` → `GitCliAdapter`.
  - `es-git` → dynamic import of the binding; on load failure throw
    `VcsAdapterUnavailableError` (fail-fast at create → every git-dependent
    operation fails with the hint, in MCP and CLI alike). No runtime fallback
    path exists: the choice is explicit, the failure is explicit.
- `es-git` is an `optionalDependencies` entry — `npm install` succeeds on
  platforms without a prebuilt binary.

## Registry Persistence (corner case)

- Registration/setup always writes an explicit `GIT_ADAPTER` value into the
  project registry — the per-project choice is pinned; ambient shell env cannot
  silently flip the adapter.
- `tea-rags index-codebase` re-applies registry env automatically (existing
  tuning-env mechanism; exact registry-vs-process-env override order is pinned
  during planning from the current tuning-env semantics).
- `tea-rags tune` resolves the project (registry-resolver path shared with
  `prime`), loads `GIT_ADAPTER` from the registry, benchmarks the git
  trajectory against the **active adapter**, and labels the produced parameters
  with the adapter they were calibrated for. Concurrency/timeout params
  measured under the CLI adapter are meaningless for in-process and vice versa.
  Fail-loud applies to tune as well.

## Error UX — `VcsAdapterUnavailableError`

Thrown by the factory when `GIT_ADAPTER=es-git` is set and the binding fails
to load. One message template, single source of truth, rendered identically in
MCP tool errors, tea-rags CLI, and `tune`. Only the hint for the running
`process.platform` is printed:

```text
es-git adapter selected (GIT_ADAPTER=es-git) but the binding failed to load.
Cause: <one-line module load error>

Install (darwin):
  npm install -g es-git          # arm64 + x64 prebuilt binaries
  # If no prebuild exists for your platform, install the Rust toolchain first:
  #   brew install rustup && rustup-init -y
  # then re-run the npm install.

Install (linux):
  npm install -g es-git          # x64/arm64 gnu + musl prebuilt binaries
  # No prebuild: apt install build-essential (or dnf groupinstall
  # "Development Tools"), install rustup, then re-run the npm install.

Install (win32):
  npm install -g es-git          # x64 prebuilt binary
  # No prebuild: install Visual Studio Build Tools + rustup,
  # then re-run the npm install.

Then retry the command. Alternatively set GIT_ADAPTER=git to use the CLI
adapter for this project.
```

Resolution notes: for the global install (`npm i -g tea-rags-mcp`) a sibling
global `es-git` resolves via Node's parent-directory walk; for a dev tree /
npm-link setup the `optionalDependencies` entry places it in the local
`node_modules`. The same `npm install -g es-git` command covers the first
case; a plain `npm install` inside the checkout covers the second. Exact
prebuild coverage (napi-rs per-platform packages) is re-validated at
implementation; the message structure, per-OS selection, and the
`GIT_ADAPTER=git` escape hatch are contractual. The hint must be executable
by an agent as-is — install, retry, no human intervention.

## Setup Plugin (`tea-rags-setup`)

`skills/install/steps/step-7-git.md`, after the existing "Enable git
analytics?" question (when git enabled) — new AskUserQuestion:

- **Git history engine?** Options `git` (CLI) and `es-git` (in-process
  library), one marked **Recommended** dynamically from `analyze-project.sh`
  output: files > 10k ∨ LOC > 1M ∨ commits > 20k → recommend `es-git`
  ("large projects / monorepos"); otherwise recommend `git` ("small projects,
  short history").
- If `es-git` chosen: the step installs the binding immediately (same commands
  as the error hint), verifies the module loads, then proceeds.
- Step 9 (register) persists the explicit `GIT_ADAPTER` value into the project
  registry env block — for both choices.

## Website Docs Update

Shipped with phase 3, same PR as the setup UX:

- `website/docs/architecture/git-enrichment-pipeline.md` — 58-day-old page,
  known tech debt: rewrite the git-access layer description around the
  `VcsAdapter` → `VcsGitAdapter` → `GitCliAdapter`/`EsGitAdapter` hierarchy
  and the factory selection.
- `website/docs/usage/advanced/git-enrichments.md` — new "Git history engine"
  subsection: `GIT_ADAPTER` values, when to pick `es-git` (large repos /
  monorepos / EDR-throttled machines), install commands, fail-loud behavior
  and the `GIT_ADAPTER=git` escape hatch.
- Env/config reference page (exact page located at planning) — `GIT_ADAPTER`
  entry: enum values, default, registry persistence semantics, tune
  interaction.

## Testing & Validation

1. **Relocation phase:** existing `client.test.ts` / `parsers.test.ts` move to
   `tests/core/adapters/vcs/git/cli/` — moved, not rewritten (business-logic
   tests immutable during refactor).
2. **Equivalence suite (phase 2):** every `EsGitAdapter` op DEEP-EQUALs
   `GitCliAdapter` output on a fixture repo — blame lines (author/email/
   timestamp/ranges), numstat maps, pathspec commit sets, OIDs, head, ancestor
   checks — plus walkCommits-level pins covering merge-branch-resolution and
   rename-detection semantics (Approach A consequence: full-surface parity,
   not per-op only).
3. **Fail-loud tests:** `GIT_ADAPTER=es-git` without the binding →
   `VcsAdapterUnavailableError` with the correct hint for each mocked
   `process.platform`.
4. **Registry round-trip:** setup writes env → CLI indexing constructs the
   right adapter; tune reads the same value.
5. **Bench gate:** cold force reindex of tea-rags + mastodon under both
   adapters; expectation from w2dlu: cold blame ~350ms/file → sub-ms
   in-process. Green bench unblocks `hi37c` (taxdome measurement).

## Phasing

1. **Seam:** `adapters/vcs/` hierarchy (`VcsAdapter` → `VcsGitAdapter` →
   `GitCliAdapter`) + factory + `GIT_ADAPTER` (default `git`) + registry/tune
   plumbing. Pure refactor, byte-identical behavior, all 21 consumers
   switched.
2. **EsGitAdapter:** full implementation + optionalDependency + fail-loud
   error + equivalence suite.
3. **Setup UX** + website docs update (see "Website Docs Update" above).
4. **Bench + unblock `hi37c`.**

## Risks

- **Parity gaps:** libgit2 blame vs CLI blame edge cases (mailmap, whitespace
  handling), diff rename detection thresholds, merge-branch walk semantics —
  caught by the equivalence suite; any deviation is a phase-2 blocker, not a
  known-diff allowance.
- **Native packaging:** prebuilt-binary coverage for darwin-arm64 / linux-x64 /
  win32-x64; postinstall behavior in CI. Mitigated by optionalDependency +
  fail-loud hint.
- **Perf assumption:** es-git (libgit2) blame is slower than gix's — if the
  bench gate misses the target, the custom gix addon path reopens (recorded in
  w2dlu, decision #5).

## Out of Scope

- Non-git VCS implementations (hg, jj) — the top-level `VcsAdapter` exists
  precisely so one can be added without touching git-family consumers; none
  are built now.
- Open extension point for third-party adapter packages (decision #1).
- Migrating warm-path caches (blame-store, commit-discovery cache) — they sit
  above the seam and work unchanged with either adapter.
