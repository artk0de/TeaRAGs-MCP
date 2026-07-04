# VCS Adapter Seam + es-git In-Process Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. In this repo, invoke the
> `dinopowers:executing-plans` / `dinopowers:test-driven-development` wrappers
> instead of the raw superpowers skills.

**Goal:** Abstract all git history access behind a
`VcsAdapter → VcsGitAdapter → GitCliAdapter | EsGitAdapter` hierarchy selected
by `GIT_ADAPTER` (default `git`), so EDR-throttled machines can opt into
in-process libgit2 reads (es-git) — spec
`docs/superpowers/specs/2026-07-04-vcs-adapter-design.md`.

**Architecture:** Two independent full implementations under an abstract
git-family base class; factory with fail-loud `VcsAdapterUnavailableError`;
`GIT_ADAPTER` flows through the existing tuning-env registry snapshot
(`env > registry > code default`) and is force-persisted even at default.

**Tech Stack:** TypeScript ESM, vitest, es-git ^0.7 (optionalDependency),
yargs CLI, existing tuning-env registry mechanism.

**Beads:** epic parent `tea-rags-mcp-w2dlu`; tasks below map 1:1 to beads
tasks (plan-beads-sync).

## Global Constraints

- `GIT_ADAPTER` values: exactly `git` | `es-git`; default `git`; unknown value
  → `ConfigValueInvalidError` (same shape as EmbeddingProviderFactory).
- No runtime fallback: `es-git` selected + binding load failure →
  `VcsAdapterUnavailableError` with per-OS hint (template in spec, verbatim).
- es-git is `optionalDependencies` — `npm install` must succeed without it.
- Business-logic tests move, never rewritten (relocation rule).
- TDD for every new behavior; conventional commits ≤100 char header.
- Worktree build always `npm run build && npm link` paired, only when
  authorized. Bench/reindex tasks are USER-GATED — never auto-run.
- Phase-1 end state is byte-identical runtime behavior with `GIT_ADAPTER`
  unset.

---

## Phase 1 — Seam (pure refactor)

### Task 1: `vcs/types.ts` + `vcs/errors.ts` — contracts and fail-loud error

**Files:**

- Create: `src/core/adapters/vcs/types.ts`
- Create: `src/core/adapters/vcs/errors.ts`
- Test: `tests/core/adapters/vcs/errors.test.ts`

**Interfaces:**

- Produces: `VcsAdapter` interface, neutral types re-exported
  (`CommitInfo`, `BlameLine`, `FileChurnData`, `RawNumstatEntry` — moved
  verbatim from `adapters/git/types.ts`), `VcsAdapterUnavailableError`.
- Consumed by: every later task.

- [ ] **Step 1: Write failing test for per-OS install hints**

```ts
// tests/core/adapters/vcs/errors.test.ts
import { describe, expect, it } from "vitest";
import { VcsAdapterUnavailableError } from "../../../../src/core/adapters/vcs/errors.js";

describe("VcsAdapterUnavailableError", () => {
  it.each([
    ["darwin", "brew install rustup"],
    ["linux", "build-essential"],
    ["win32", "Visual Studio Build Tools"],
  ])("renders %s hint only", (platform, marker) => {
    const err = new VcsAdapterUnavailableError("es-git", "Cannot find module 'es-git'", platform);
    expect(err.message).toContain("GIT_ADAPTER=es-git");
    expect(err.message).toContain("npm install -g es-git");
    expect(err.message).toContain(marker);
    expect(err.message).toContain("GIT_ADAPTER=git");
    expect(err.message).toContain("Cannot find module 'es-git'");
  });

  it("hints only the running platform", () => {
    const err = new VcsAdapterUnavailableError("es-git", "load failed", "darwin");
    expect(err.message).not.toContain("Visual Studio");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run tests/core/adapters/vcs/errors.test.ts` → FAIL (module not found)

- [ ] **Step 3: Implement**

```ts
// src/core/adapters/vcs/errors.ts
import { InfraError } from "../../infra/errors.js";

const HINTS: Record<string, string> = {
  darwin: `Install (darwin):
  npm install -g es-git          # arm64 + x64 prebuilt binaries
  # If no prebuild exists for your platform, install the Rust toolchain first:
  #   brew install rustup && rustup-init -y
  # then re-run the npm install.`,
  linux: `Install (linux):
  npm install -g es-git          # x64/arm64 gnu + musl prebuilt binaries
  # No prebuild: apt install build-essential (or dnf groupinstall
  # "Development Tools"), install rustup, then re-run the npm install.`,
  win32: `Install (win32):
  npm install -g es-git          # x64 prebuilt binary
  # No prebuild: install Visual Studio Build Tools + rustup,
  # then re-run the npm install.`,
};

export class VcsAdapterUnavailableError extends InfraError {
  constructor(adapter: string, cause: string, platform: string = process.platform) {
    const hint = HINTS[platform] ?? HINTS.linux;
    super(
      `${adapter} adapter selected (GIT_ADAPTER=${adapter}) but the binding failed to load.\n` +
        `Cause: ${cause}\n\n${hint}\n\n` +
        `Then retry the command. Alternatively set GIT_ADAPTER=git to use the CLI adapter for this project.`,
    );
    this.name = "VcsAdapterUnavailableError";
  }
}
```

(Adjust the `InfraError` import to the actual base-error path used by
`adapters/git/errors.ts` — same parent class.)

```ts
// src/core/adapters/vcs/types.ts — move the four interfaces VERBATIM from
// src/core/adapters/git/types.ts, then append:
export type GitAdapterKind = "git" | "es-git";

export interface VcsAdapter {
  readonly repoRoot: string;
  getHead(): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** Parsed numstat churn log (was buildViaCli + parseNumstatOutput on CLI). */
  readNumstatLog(sinceDate?: Date): Promise<Map<string, FileChurnData>>;
  getCommitsSince(sinceDate: Date, maxAgeMonths: number): Promise<CommitInfo[]>;
  getCommitsInRange(fromOid: string, toOid: string): Promise<CommitInfo[]>;
  readBlobAsString(revision: string, filepath: string): Promise<string>;
  blameFile(filePath: string, timeoutMs?: number): Promise<BlameLine[]>;
}
```

Signatures for `getCommitsSince`/`getCommitsInRange`/`readNumstatLog` MUST be
copied from the current `client.ts` functions (open the file, mirror parameter
lists exactly — including timeout params where present). The interface is the
existing surface renamed, not a redesign.

- [ ] **Step 4: Run test** → PASS. `npx tsc --noEmit` → 0 errors.
- [ ] **Step 5: Commit** — `feat(vcs): VcsAdapter contract + fail-loud VcsAdapterUnavailableError with per-OS hints`

### Task 2: `vcs/git/adapter.ts` — abstract `VcsGitAdapter`

**Files:**

- Create: `src/core/adapters/vcs/git/adapter.ts`
- Test: `tests/core/adapters/vcs/git/adapter.test.ts`

**Interfaces:**

- Consumes: `VcsAdapter`, `CatFileBatchReader`/`CatFileBatchCheckReader`
  interfaces (moved in Task 3 — declare them in `vcs/types.ts` in this task,
  renamed `BlobBatchReader` / `OidBatchResolver`, members verbatim).
- Produces: `abstract class VcsGitAdapter implements VcsAdapter` — the type
  every consumer and the factory use.

- [ ] **Step 1: Failing test** — assert a minimal concrete subclass carries
  `repoRoot`, and that `VcsGitAdapter` declares the git-strength ops
  (`getCommitsByPathspec`, `createBlobBatchReader`, `createOidBatchResolver`)
  as abstract members (compile-time check via `satisfies` + runtime smoke).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement**

```ts
// src/core/adapters/vcs/git/adapter.ts
import type { BlobBatchReader, CommitInfo, FileChurnData, OidBatchResolver, VcsAdapter } from "../types.js";

export abstract class VcsGitAdapter implements VcsAdapter {
  constructor(readonly repoRoot: string) {}

  abstract getHead(): Promise<string>;
  abstract isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  abstract readNumstatLog(sinceDate?: Date): Promise<Map<string, FileChurnData>>;
  abstract getCommitsSince(sinceDate: Date, maxAgeMonths: number): Promise<CommitInfo[]>;
  abstract getCommitsInRange(fromOid: string, toOid: string): Promise<CommitInfo[]>;
  abstract readBlobAsString(revision: string, filepath: string): Promise<string>;
  abstract blameFile(filePath: string, timeoutMs?: number): Promise<BlameLine[]>;
  // git-strength contract
  abstract getCommitsByPathspec(
    pathspecs: string[],
    sinceDate: Date,
  ): Promise<{ commit: CommitInfo; changedFiles: string[] }[]>;
  abstract createBlobBatchReader(): BlobBatchReader;
  abstract createOidBatchResolver(): OidBatchResolver;
}
```

(Mirror `getCommitsByPathspec` params from the current `client.ts` export —
verify before writing.) Shared substrate methods (arg validation, error
normalization) are added here ONLY when both implementations need them —
YAGNI until Task 9 shows real duplication.

- [ ] **Step 4: Test PASS, tsc 0.**
- [ ] **Step 5: Commit** — `feat(vcs): abstract VcsGitAdapter git-family base`

### Task 3: `GitCliAdapter` — relocate CLI implementation

**Files:**

- Move: `src/core/adapters/git/client.ts` → `src/core/adapters/vcs/git/cli/client.ts`
- Move: `src/core/adapters/git/parsers.ts` → `src/core/adapters/vcs/git/cli/parsers.ts`
- Move: `src/core/adapters/git/errors.ts` → `src/core/adapters/vcs/git/cli/errors.ts`
- Create: `src/core/adapters/vcs/git/cli/adapter.ts` (`GitCliAdapter`)
- Move: `src/core/adapters/vcs/` gets `resolveRepoRoot` re-export (module
  helper, stays a free function)
- Move tests: `tests/core/adapters/git/*.test.ts` →
  `tests/core/adapters/vcs/git/cli/` (git mv, update import paths ONLY)
- Delete: `src/core/adapters/git/types.ts` (content lives in `vcs/types.ts`
  since Task 1; `git mv` history preserved via Task 1 doing the move — this
  task removes the leftover re-export if any)

**Interfaces:**

- Produces: `class GitCliAdapter extends VcsGitAdapter` — reference
  implementation. Methods delegate to the moved free functions;
  `readNumstatLog` composes `buildViaCli` + `parseNumstatOutput`.

- [ ] **Step 1: `git mv` the three files + tests; fix relative imports inside them (types now from `../types.js` → `../../types.js`).**
- [ ] **Step 2: Write failing test for the class surface**

```ts
// tests/core/adapters/vcs/git/cli/adapter.test.ts
import { describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/cli/adapter.js";
import { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";

describe("GitCliAdapter", () => {
  it("is a VcsGitAdapter bound to a repo root", () => {
    const adapter = new GitCliAdapter(process.cwd());
    expect(adapter).toBeInstanceOf(VcsGitAdapter);
    expect(adapter.repoRoot).toBe(process.cwd());
  });

  it("getHead delegates to the CLI (real git repo)", async () => {
    const adapter = new GitCliAdapter(process.cwd());
    await expect(adapter.getHead()).resolves.toMatch(/^[0-9a-f]{40}/);
  });
});
```

- [ ] **Step 3: Implement `GitCliAdapter`** — every method a one-line
  delegation to the corresponding moved function, passing `this.repoRoot`;
  `readNumstatLog(since)` = `parseNumstatOutput(await buildViaCli(this.repoRoot, since))`
  (mirror actual current call chain from
  `trajectory/git/infra/file-reader.ts` — same arguments, same defaults).
  `createBlobBatchReader()` → `createCatFileBatch(this.repoRoot)`,
  `createOidBatchResolver()` → `createCatFileBatchCheck(this.repoRoot)`.
- [ ] **Step 4: Full suite green** — `npx vitest run tests/core/adapters` →
  moved tests pass unchanged; `npx tsc --noEmit` → 0.
- [ ] **Step 5: Commit** — `refactor(vcs): relocate git CLI client under vcs/git/cli as GitCliAdapter`

### Task 4: `VcsAdapterFactory`

**Files:**

- Create: `src/core/adapters/vcs/factory.ts`
- Test: `tests/core/adapters/vcs/factory.test.ts`

**Interfaces:**

- Consumes: `GitCliAdapter`, `VcsAdapterUnavailableError`, `GitAdapterKind`.
- Produces: `VcsAdapterFactory.create(adapter: GitAdapterKind, repoRoot: string): Promise<VcsGitAdapter>`
  (async — es-git branch dynamic-imports the binding).

- [ ] **Step 1: Failing tests**

```ts
// tests/core/adapters/vcs/factory.test.ts
import { describe, expect, it } from "vitest";
import { VcsAdapterFactory } from "../../../../src/core/adapters/vcs/factory.js";
import { GitCliAdapter } from "../../../../src/core/adapters/vcs/git/cli/adapter.js";
import { VcsAdapterUnavailableError } from "../../../../src/core/adapters/vcs/errors.js";

describe("VcsAdapterFactory", () => {
  it("git → GitCliAdapter", async () => {
    await expect(VcsAdapterFactory.create("git", process.cwd())).resolves.toBeInstanceOf(GitCliAdapter);
  });

  it("es-git without binding → VcsAdapterUnavailableError with hint", async () => {
    // binding not installed in unit-test env
    await expect(VcsAdapterFactory.create("es-git", process.cwd())).rejects.toThrow(VcsAdapterUnavailableError);
  });

  it("unknown value → ConfigValueInvalidError", async () => {
    await expect(VcsAdapterFactory.create("svn" as never, process.cwd())).rejects.toThrow(/GIT_ADAPTER/);
  });
});
```

- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — switch mirroring `EmbeddingProviderFactory`:

```ts
// src/core/adapters/vcs/factory.ts
import { ConfigValueInvalidError } from "../../infra/errors.js";
import { VcsAdapterUnavailableError } from "./errors.js";
import type { GitAdapterKind } from "./types.js";
import { VcsGitAdapter } from "./git/adapter.js";
import { GitCliAdapter } from "./git/cli/adapter.js";

export class VcsAdapterFactory {
  static async create(adapter: GitAdapterKind, repoRoot: string): Promise<VcsGitAdapter> {
    switch (adapter) {
      case "git":
        return new GitCliAdapter(repoRoot);
      case "es-git": {
        try {
          const { EsGitAdapter } = await import("./git/es-git/adapter.js");
          return await EsGitAdapter.open(repoRoot);
        } catch (err) {
          throw new VcsAdapterUnavailableError("es-git", err instanceof Error ? err.message : String(err));
        }
      }
      default:
        throw new ConfigValueInvalidError("vcs.adapter", "GIT_ADAPTER", `unknown adapter "${String(adapter)}"`);
    }
  }
}
```

(Until Task 9 lands, `./git/es-git/adapter.js` does not exist — the dynamic
import rejects, which IS the correct fail-loud behavior; the es-git test above
stays green before and after Task 9 on machines without the binding. Match
`ConfigValueInvalidError` constructor arity to `infra/errors.ts`.)

- [ ] **Step 4: PASS, tsc 0.** **Step 5: Commit** — `feat(vcs): VcsAdapterFactory with fail-loud es-git branch`

### Task 5: Config plumbing — `VcsConfig`, parse.ts, tuning-env force-persist

**Files:**

- Modify: `src/core/contracts/types/config.ts` (add `VcsConfig`, wire into root config type)
- Modify: `src/bootstrap/config/parse.ts` (new `vcs` section next to `trajectoryGit` at ~line 129)
- Modify: `src/core/infra/registry/tuning-env.ts` (allow-list entry)
- Modify: the tuning snapshot writer — locate with `rg "TUNING_ENV_ALLOWLIST" src/ -l` (single write site expected alongside readers `cli/index-progress/registry-env.ts:108`, `cli/prime/run-prime.ts:108`)
- Test: colocated config parse tests (find existing parse.ts test file, extend)

**Interfaces:**

- Produces: `config.vcs.adapter: GitAdapterKind` available wherever config
  flows; `GIT_ADAPTER` captured into `CollectionEntry.tuning` ALWAYS (explicit
  resolved value, even when env unset — spec decision #4; deviates from the
  "only vars actually set" rule for this one key, comment why at the write
  site).

- [ ] **Step 1: Failing tests** — parse defaults to `"git"`; `GIT_ADAPTER=es-git` parses; `GIT_ADAPTER=bogus` throws; snapshot builder emits `GIT_ADAPTER: "git"` when env unset.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — schema (zod enum `["git","es-git"]` default `"git"`), `vcs = { adapter: env("GIT_ADAPTER") }` section, allow-list entry under a new `// vcs (parse.ts vcs section)` group, force-include in snapshot writer.
- [ ] **Step 4: PASS; `npx vitest run tests/` targeted dirs; tsc 0.** **Step 5: Commit** — `feat(config): GIT_ADAPTER → VcsConfig, always persisted to registry tuning snapshot`

### Task 6: Consumer switch A — trajectory/git domain

**Files (modify):**

- `src/core/domains/trajectory/git/provider.ts` (imports at :19-20; construct adapter once via factory using `config.vcs.adapter` + resolved repoRoot; pass instance down)
- `src/core/domains/trajectory/git/infra/commit-discovery.ts` (:17-18 — take `VcsGitAdapter` in constructor instead of free functions)
- `src/core/domains/trajectory/git/infra/walk-commits.ts` (:11-12)
- `src/core/domains/trajectory/git/infra/file-reader.ts` (:9-11 — drop `parseNumstatOutput`, call `adapter.readNumstatLog`)
- `src/core/domains/trajectory/git/infra/cache.ts` (:6-7)
- `src/core/domains/trajectory/git/infra/git-log-reader.ts` (:8-9)
- `src/core/domains/trajectory/git/infra/chunk-reader.ts`, `blame-store.ts`, `metrics.ts`, `merge-branch-resolver.ts`, `assemble-overlays.ts`, `blame-ownership.ts`, `infra/metrics/{sessions,extractors,file-assembler}.ts`, `infra/churn-walk/protocol.ts` (type imports → `adapters/vcs/types.js`)
- `src/core/domains/trajectory/git/infra/churn-walk/worker.ts` (:23) + `thread.ts` — worker payload gains `gitAdapter: GitAdapterKind`; worker calls `VcsAdapterFactory.create` in-thread (worker-DI pattern)
- Tests: update mocks/module paths in affected test files — path updates and DI-argument updates only, assertions untouched

- [ ] **Step 1:** For each file: replace free-function imports with the
  adapter parameter; types from `adapters/vcs/types.js`. Provider constructs:
  `this.vcsAdapter = await VcsAdapterFactory.create(config.vcs.adapter, repoRoot)`
  at its existing init point (where repoRoot resolved today) and threads it to
  `GitCommitDiscovery`, `GitLogReader`, walk/file/cache readers.
- [ ] **Step 2:** Worker: extend churn-walk protocol payload with
  `gitAdapter`; in worker init `const adapter = await VcsAdapterFactory.create(payload.gitAdapter, payload.repoRoot)`;
  replace direct `createCatFileBatch` with `adapter.createBlobBatchReader()`.
- [ ] **Step 3:** `npx vitest run tests/core/domains/trajectory/git` → green; tsc 0.
- [ ] **Step 4: Commit** — `refactor(trajectory-git): consume VcsGitAdapter instead of git CLI free functions`

### Task 7: Consumer switch B — ingest + facade, delete `adapters/git/`

**Files (modify):**

- `src/core/api/internal/facades/ingest-facade.ts` (:15, `IngestFacadeDeps` at :49-107, `buildIngestPipeline` at :177-277 — replace `createCatFileBatch` dep with `vcsAdapter: VcsGitAdapter` built at wiring site via factory)
- `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts` (:19, `BlobReaderFactory` at :98 — type becomes `() => BlobBatchReader`, fed from `vcsAdapter.createBlobBatchReader`)
- Bootstrap wiring: wherever `IngestFacadeDeps` is assembled (follow current `createCatFileBatch` injection), call `await VcsAdapterFactory.create(config.vcs.adapter, repoRoot)`
- Delete: `src/core/adapters/git/` (now empty of consumers)
- Tests: affected facade/chunk-phase tests — DI updates only

- [ ] **Step 1:** Swap deps + wiring as above. **Step 2:** `rg "adapters/git/" src/ tests/` → zero hits; delete folder. **Step 3:** FULL suite `npx vitest run` green, `npm run build` clean (single-worktree check first: `git worktree list`), eslint 0. **Step 4: Commit** — `refactor(ingest): VcsGitAdapter DI; remove legacy adapters/git`

### Task 8: tune + CLI registry pickup

**Files:**

- Modify: `src/cli/commands/tune.ts` (handler: after `applyProjectDefaults`, replay registry tuning env — reuse the exact loop from `src/cli/index-progress/registry-env.ts:108` via a shared helper; extract that loop into `src/cli/registry-env-replay.ts` if not already shared)
- Modify: tune report/labeling — `tune.mjs` invocation env now carries `GIT_ADAPTER`; the report header prints `git adapter: <value>`
- Test: `tests/cli/commands/tune.test.ts` (or existing tune test file) — registry entry with `tuning.GIT_ADAPTER=es-git` → spawned script env contains it; process env wins over registry

- [ ] **Step 1: Failing test (env replay order: env > registry > default).**
- [ ] **Step 2-4: Implement, PASS, tsc 0.**
- [ ] **Step 5: Commit** — `feat(cli): tune replays GIT_ADAPTER from project registry, labels report`

**Phase-1 exit check (byte-identical):** with `GIT_ADAPTER` unset, full test
suite green, `npm run build && npm link` (if authorized), no behavior change —
this is the merge-ready seam.

---

## Phase 2 — EsGitAdapter

### Task 9: es-git dependency + adapter core ops (head/blob/blame/OID)

**Files:**

- Modify: `package.json` (`optionalDependencies: { "es-git": "^0.7.0" }`)
- Create: `src/core/adapters/vcs/git/es-git/adapter.ts`
- Test: `tests/core/adapters/vcs/git/es-git/equivalence-core.test.ts`

**Interfaces:**

- Produces: `class EsGitAdapter extends VcsGitAdapter` with
  `static async open(repoRoot): Promise<EsGitAdapter>`.

- [ ] **Step 1: `npm install` (worktree), then pin the API mapping**: read
  `node_modules/es-git/index.d.ts`; record exact method names for: open
  repository, head resolve, `blameFile`/`Blame.iterByLine` hunk fields,
  blob read by `<rev>:<path>`, merge-base/descendant check, revwalk. Write the
  mapping table as a comment header in `adapter.ts`.
- [ ] **Step 2: Failing equivalence tests** — fixture repo built in
  `beforeAll` via real `git` commands in a temp dir (init, 3 commits, 2
  authors, one rename, one merge). For each core op:
  `expect(await esGit.blameFile(f)).toEqual(await cli.blameFile(f))`, same for
  `getHead`, `isAncestor`, `readBlobAsString`, OID batch resolver outputs,
  blob batch reader outputs. Guard: `describe.skipIf(!esGitAvailable)` so CI
  without the binding skips, never fails.
- [ ] **Step 3: Implement the core ops.** Timestamps/author fields normalized
  to EXACTLY the CLI parser's shapes (`BlameLine` fields byte-equal).
- [ ] **Step 4: Equivalence green locally.**
- [ ] **Step 5: Commit** — `feat(vcs): EsGitAdapter core ops (head/blame/blob/oid) + equivalence suite`

### Task 10: EsGitAdapter history ops + walk-level pins

**Files:**

- Modify: `src/core/adapters/vcs/git/es-git/adapter.ts`
  (`readNumstatLog`, `getCommitsSince`, `getCommitsInRange`,
  `getCommitsByPathspec` via revwalk + diff with rename detection)
- Test: `tests/core/adapters/vcs/git/es-git/equivalence-history.test.ts`

- [ ] **Step 1: Failing tests** — fixture repo extended with: merge commit
  with divergent branches (merge-branch semantics), file rename (numstat
  rename detection), pathspec batching >1 file. Deep-equal against
  `GitCliAdapter` for each op AND a walkCommits-level pin: run the real
  `walkCommits` (trajectory infra) against both adapters, deep-equal the
  resulting accumulators.
- [ ] **Step 2-4: Implement, equivalence green. Any deviation is a blocker —
  no known-diff allowances (spec Risks).**
- [ ] **Step 5: Commit** — `feat(vcs): EsGitAdapter history ops, walkCommits-level equivalence pins`

---

## Phase 3 — Setup UX + website docs

### Task 11: setup plugin — engine choice + install + persist

**Files:**

- Modify: `.claude-plugin/tea-rags-setup/skills/install/steps/step-7-git.md`
  (new AskUserQuestion after git-analytics yes: "Git history engine?" — `git`
  vs `es-git`, Recommended computed from `analyze-project.sh` output:
  `files > 10000 || loc > 1000000 || commits > 20000` → es-git, else git;
  on es-git: run the install commands from the spec hint, verify
  `node -e "require('es-git')"`, save choice to progress)
- Modify: `.claude-plugin/tea-rags-setup/skills/install/steps/step-9-register.md`
  (persist explicit `GIT_ADAPTER` into the MCP env block + registry for BOTH
  choices)
- Bump plugin version (minor — new feature) in the plugin manifest.

- [ ] Steps: edit both step files with exact question blocks (copy option
  labels/descriptions from the spec Setup section), version bump, commit —
  `feat(setup): git history engine choice with dynamic recommendation`.

### Task 12: website docs

**Files:**

- Modify: `website/docs/architecture/git-enrichment-pipeline.md` (rewrite
  git-access description around the hierarchy + factory selection)
- Modify: `website/docs/usage/advanced/git-enrichments.md` (new "Git history
  engine" subsection: values, when es-git, install commands, fail-loud +
  escape hatch)
- Modify: `website/docs/config/environment-variables.md` (`GIT_ADAPTER` entry:
  enum, default, registry persistence, tune interaction)
- Lint every page with markdownlint; commit —
  `docs(website): GIT_ADAPTER + VCS adapter hierarchy`.

---

## Phase 4 — Bench gate (USER-GATED)

### Task 13: bench + unblock hi37c

- [ ] **USER GATE:** ask before any reindex. `npm run build && npm link` (ask
  if >1 worktree active), MCP reconnect, then
  `tea-rags index-codebase --project tea-rags --wait-enrichments --force --json`
  under `GIT_ADAPTER=git` then `GIT_ADAPTER=es-git`; capture per-provider
  durations; expectation: cold blame ~350ms/file → sub-ms.
- [ ] Repeat on mastodon bench corpus (user-gated).
- [ ] Record before/after in beads w2dlu; close w2dlu; `hi37c` unblocks
  automatically (dep).

---

## Self-Review Notes

- Spec coverage: decisions 1-6 → Tasks 4/9 (enum+binding), 2/3/9/10 (two full
  implementations, hierarchy), 1/4 (fail-loud), 5/8 (persistence+tune), 11/12
  (setup+docs), 13 (bench). Registry force-persist deviation documented in
  Task 5.
- Types used across tasks: `VcsGitAdapter`, `GitAdapterKind`,
  `BlobBatchReader`, `OidBatchResolver`, `VcsAdapterFactory.create` — defined
  Task 1/2/4, consumed 6/7/8/9.
- Exact current signatures (`buildViaCli`, `getCommitsByPathspec`,
  batch-reader members) are mirrored at execution time from the moved sources
  — the plan mandates copying them verbatim, never redesigning.
