# Auto-Update Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wrapper over superpowers:executing-plans) to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatic index freshness — an opt-in watcher that keeps a project's
index current on its target branch via ephemeral detached reindex processes.

**Architecture:** Registry becomes the source of truth for which git state the
index represents (`git` block written at pipeline finalize) and for the
auto-update policy (`autoUpdate` block, sticky, CLI-managed).
`IndexFreshnessCheck` (pure, `domains/maintenance/freshness/`) computes a
verdict from registry entry + repo git state; `AutoUpdateTrigger` (bootstrap
composition root) debounces and spawns the detached updater
(`tea-rags auto-update run`), which re-checks, reindexes incrementally, waits
for enrichments, and records the outcome back into the registry.

**Tech Stack:** TypeScript ESM, vitest, yargs CLI, node:child_process (detached
spawn), node:fs (`.git` file reads).

**Spec:** `docs/specs/2026-08-06-auto-update-watcher-design.md` (approved).

## Global Constraints

- `autoUpdate.enabled` defaults to `false`; enabling is an explicit CLI act.
- Auto-update fires ONLY when `HEAD == targetBranch` (spec §Decisions).
- Triggering query is never blocked: background + stale serve.
- No resident daemon; updater is ephemeral and detached (survives session).
- SessionStart latency unchanged: prime does spawn (~10 ms), never waits.
- Domain boundaries (`.claude/rules/domain-boundaries.md`): ingest ✗→
  maintenance; cli/mcp reach core ONLY via `core/api/public/`; shared git-state
  reader therefore lives in `core/infra/` (precedent: `commit-diff-memo.ts`);
  spawner/trigger live in `bootstrap/`.
- Typed errors (`.claude/rules/typed-errors.md`); no `throw new Error` outside
  programming invariants.
- Hub protection: `src/mcp/format.ts` (fanIn 10) — ADD functions only, never
  modify existing formatters. `pipeline/base.ts` registry write is the ONLY
  pipeline touch (hotspots `indexing.ts`/`reindexing.ts` untouched).
- Naming rule: domain-qualified exported names (`RegistryGitState`,
  `IndexFreshnessVerdict`, not `GitState`/`Verdict`).
- Proven-template note: extract-project-patterns returned locality NONE for
  `maintenance/freshness` (domain too young). Technique references:
  `src/cli/update-check/check-service.ts` (DI interfaces, discriminated union,
  TTL), `src/core/domains/maintenance/schema-drift-monitor.ts` (monitor),
  `src/mcp/middleware/error-handler.ts` (tool wrapping). Scrutinize generated
  code accordingly.
- Beads: 1:1 tasks under `tea-rags-mcp-hpg2`
  (`bd update <id> --status=in_progress` on start, `bd close <id>` on commit).

---

### Task 1: Registry schema — `RegistryGitState` + `RegistryAutoUpdateConfig`

**Files:**

- Modify: `src/core/contracts/types/registry.ts`
- Modify: `src/core/domains/maintenance/registry/collection-registry.ts`
- Test: `tests/core/domains/maintenance/registry/collection-registry.test.ts`
  (extend existing)

**Interfaces:**

- Consumes: existing `CollectionEntry`, `RecordEntryInput`,
  `CollectionRegistry`.
- Produces (later tasks rely on these exact shapes):

```ts
// contracts/types/registry.ts
export interface RegistryGitState {
  indexedBranch: string | null; // null = detached HEAD at index time
  indexedCommit: string;
  indexedDirty: boolean;
}

export interface AutoUpdateRunRecord {
  at: string; // ISO timestamp
  outcome: "ok" | "no-op" | "skipped" | "lock-held" | "failed";
  durationMs: number;
  filesChanged: number;
  error?: string;
}

export interface RegistryAutoUpdateConfig {
  enabled: boolean;
  targetBranch: string;
  lastRun?: AutoUpdateRunRecord;
}

// CollectionEntry gains (both optional — backward compat with existing files):
//   git?: RegistryGitState;
//   autoUpdate?: RegistryAutoUpdateConfig;
// RecordEntryInput becomes:
export type RecordEntryInput = Omit<CollectionEntry, "name" | "autoUpdate">;
// CollectionRegistry gains:
//   setAutoUpdate(collectionName: string, config: RegistryAutoUpdateConfig | null): void
//   recordAutoUpdateRun(collectionName: string, lastRun: AutoUpdateRunRecord): void
```

`autoUpdate` is sticky exactly like `name`: `record()` preserves it from the
existing entry (pipeline reruns must not wipe CLI-set policy). `git` flows
through `record()` normally (pipeline owns it). `setAutoUpdate(name, null)`
deletes the block (disable-and-forget). `recordAutoUpdateRun` merges `lastRun`
into an existing `autoUpdate` block and is a no-op when the entry or block is
missing (registry may have been unregistered while the updater ran).

- [ ] **Step 1: Write the failing tests** (extend the existing registry test
      file; follow its existing tmp-dataDir setup pattern)

```ts
describe("autoUpdate stickiness", () => {
  it("record() preserves existing autoUpdate block", () => {
    registry.record(entry({ collectionName: "code_x" }));
    registry.setAutoUpdate("code_x", { enabled: true, targetBranch: "master" });
    registry.record(entry({ collectionName: "code_x", chunksCount: 99 }));
    expect(registry.get("code_x")?.autoUpdate).toEqual({
      enabled: true,
      targetBranch: "master",
    });
  });

  it("setAutoUpdate(null) removes the block", () => {
    registry.record(entry({ collectionName: "code_x" }));
    registry.setAutoUpdate("code_x", { enabled: true, targetBranch: "master" });
    registry.setAutoUpdate("code_x", null);
    expect(registry.get("code_x")?.autoUpdate).toBeUndefined();
  });

  it("setAutoUpdate throws on unknown collection", () => {
    expect(() =>
      registry.setAutoUpdate("nope", { enabled: true, targetBranch: "m" }),
    ).toThrow("not in registry");
  });

  it("recordAutoUpdateRun merges lastRun and persists", () => {
    registry.record(entry({ collectionName: "code_x" }));
    registry.setAutoUpdate("code_x", { enabled: true, targetBranch: "master" });
    registry.recordAutoUpdateRun("code_x", {
      at: "2026-08-06T12:00:00Z",
      outcome: "ok",
      durationMs: 1200,
      filesChanged: 3,
    });
    const fresh = new CollectionRegistry(dataDir); // re-read from disk
    expect(fresh.get("code_x")?.autoUpdate?.lastRun?.outcome).toBe("ok");
  });

  it("recordAutoUpdateRun is a no-op when entry or block missing", () => {
    expect(() =>
      registry.recordAutoUpdateRun("nope", {
        at: "2026-08-06T12:00:00Z",
        outcome: "failed",
        durationMs: 1,
        filesChanged: 0,
      }),
    ).not.toThrow();
  });

  it("record() round-trips the git block", () => {
    registry.record(
      entry({
        collectionName: "code_x",
        git: {
          indexedBranch: "master",
          indexedCommit: "abc123",
          indexedDirty: false,
        },
      }),
    );
    expect(registry.get("code_x")?.git?.indexedCommit).toBe("abc123");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**
      `npx vitest run tests/core/domains/maintenance/registry/collection-registry.test.ts`
      — expect failures: `setAutoUpdate is not a function`, missing `git`.
- [ ] **Step 3: Implement.** Add the three interfaces + two optional
      `CollectionEntry` fields + `RecordEntryInput` omit in
      `contracts/types/registry.ts` (JSDoc each field, mirroring the file's
      existing doc style). In `collection-registry.ts`:

```ts
record(entry: RecordEntryInput): void {
  // ...existing validation...
  const existing = map.get(entry.collectionName);
  map.set(entry.collectionName, {
    ...entry,
    name: existing?.name ?? null,
    ...(existing?.autoUpdate !== undefined ? { autoUpdate: existing.autoUpdate } : {}),
  });
  // ...
}

setAutoUpdate(collectionName: string, config: RegistryAutoUpdateConfig | null): void {
  const map = this.ensureLoaded();
  const entry = map.get(collectionName);
  if (!entry) throw new Error(`Collection '${collectionName}' not in registry`);
  if (config === null) {
    const { autoUpdate: _dropped, ...rest } = entry;
    map.set(collectionName, rest as CollectionEntry);
  } else {
    map.set(collectionName, { ...entry, autoUpdate: config });
  }
  this.flush();
}

recordAutoUpdateRun(collectionName: string, lastRun: AutoUpdateRunRecord): void {
  const map = this.ensureLoaded();
  const entry = map.get(collectionName);
  if (!entry?.autoUpdate) return;
  map.set(collectionName, { ...entry, autoUpdate: { ...entry.autoUpdate, lastRun } });
  this.flush();
}
```

(Plain `Error` here matches the file's existing invariant style — `setName` does
the same.)

- [ ] **Step 4: Run tests, verify pass; run type-check** `npm run typecheck` (or
      the project's `tsc --noEmit` script) — `RecordEntryInput` narrowing may
      surface call sites constructing entries with `autoUpdate`; there are none
      today, expect clean.
- [ ] **Step 5: Commit**
      `git commit -m "feat(contracts): registry schema for git state + autoUpdate policy (hpg2 Task 1)"`

---

### Task 2: `RepoGitState` reader in `core/infra/`

**Files:**

- Create: `src/core/infra/repo-git-state.ts`
- Test: `tests/core/infra/repo-git-state.test.ts`

**Interfaces:**

- Consumes: nothing project-internal (node:fs, node:path, node:child_process).
- Produces:

```ts
export interface RepoGitState {
  branch: string | null; // null = detached HEAD
  commit: string; // resolved sha ("" when unborn/unresolvable)
  transient: boolean; // rebase/merge/bisect in progress
}
/** Fast, file-based — no git spawn. ~1ms. Returns null when repoPath is not a git repo. */
export function readRepoGitState(repoPath: string): RepoGitState | null;
/** Spawns `git status --porcelain -uno`; ONLY for pipeline-finalize use. */
export function readWorkingTreeDirty(
  repoPath: string,
  execFileImpl?: typeof execFileSync,
): boolean;
/** origin/HEAD symref → fallback existing local main/master → "main". */
export function detectDefaultBranch(
  repoPath: string,
  execFileImpl?: typeof execFileSync,
): string;
```

Why `infra/`: needed by BOTH `domains/ingest` (finalize write, Task 3) and
`domains/maintenance` (freshness check, Task 4) — domains may not import each
other; foundation is the only legal home (documented precedent:
`infra/commit-diff-memo.ts`). Docblock must state this per the infra rule.

Implementation notes (the tricky parts, spell out in code):

- `.git` may be a FILE in worktrees: content `gitdir: /abs/path`. Resolve to the
  real gitdir first; for worktrees `HEAD`/`MERGE_HEAD`/`rebase-merge` live in
  the per-worktree gitdir, `packed-refs` in the COMMON dir (`commondir` file
  inside the worktree gitdir points there).
- `HEAD` content: `ref: refs/heads/<branch>` → branch name; bare sha → detached
  (`branch: null`). Resolve the ref via `<gitdir>/refs/heads/<branch>` file,
  falling back to scanning `<commondir>/packed-refs` lines
  (`<sha> refs/heads/<branch>`).
- `transient` = any of `MERGE_HEAD`, `BISECT_LOG`, `rebase-merge/`,
  `rebase-apply/` exists in the (worktree) gitdir.
- `readWorkingTreeDirty`:
  `execFileSync("git", ["-C", repoPath, "status", "--porcelain", "-uno"], { timeout: 15_000 })`
  → non-empty output = dirty. Injected exec for tests; on spawn failure return
  `false` (conservative — never blocks finalize).
- `detectDefaultBranch`:
  `git -C <p> symbolic-ref --short refs/remotes/origin/HEAD` → strip `origin/`;
  on failure check `readRepoGitState` resolvability of `main` then `master` ref
  files; final fallback `"main"`.

- [ ] **Step 1: Write failing tests** — build real tmp git fixtures with
      `fs.mkdtempSync` + raw file writes (no git spawn needed for the file-based
      paths):

```ts
function writeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-git-state-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

it("reads branch + commit from ref file", () => {
  const dir = writeRepo({
    ".git/HEAD": "ref: refs/heads/master\n",
    ".git/refs/heads/master": "abc123def\n",
  });
  expect(readRepoGitState(dir)).toEqual({
    branch: "master",
    commit: "abc123def",
    transient: false,
  });
});

it("resolves ref through packed-refs", () => {
  const dir = writeRepo({
    ".git/HEAD": "ref: refs/heads/feature-x\n",
    ".git/packed-refs": "# pack-refs\nabc999 refs/heads/feature-x\n",
  });
  expect(readRepoGitState(dir)?.commit).toBe("abc999");
});

it("detached HEAD → branch null", () => {
  const dir = writeRepo({ ".git/HEAD": "abc123def\n" });
  expect(readRepoGitState(dir)).toEqual({
    branch: null,
    commit: "abc123def",
    transient: false,
  });
});

it("MERGE_HEAD marks transient", () => {
  const dir = writeRepo({
    ".git/HEAD": "ref: refs/heads/master\n",
    ".git/refs/heads/master": "abc\n",
    ".git/MERGE_HEAD": "def\n",
  });
  expect(readRepoGitState(dir)?.transient).toBe(true);
});

it("worktree .git FILE indirection resolves via gitdir + commondir", () => {
  const main = writeRepo({ ".git/packed-refs": "abc123 refs/heads/master\n" });
  const wtGitdir = join(main, ".git", "worktrees", "wt1");
  mkdirSync(wtGitdir, { recursive: true });
  writeFileSync(join(wtGitdir, "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(join(wtGitdir, "commondir"), "../..\n");
  const wt = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(join(wt, ".git"), `gitdir: ${wtGitdir}\n`);
  expect(readRepoGitState(wt)?.commit).toBe("abc123");
});

it("non-repo → null", () => {
  expect(readRepoGitState(mkdtempSync(join(tmpdir(), "norepo-")))).toBeNull();
});

it("readWorkingTreeDirty true on porcelain output, false on spawn failure", () => {
  expect(readWorkingTreeDirty("/x", (() => " M a.ts\n") as never)).toBe(true);
  expect(readWorkingTreeDirty("/x", (() => "") as never)).toBe(false);
  expect(
    readWorkingTreeDirty("/x", (() => {
      throw new Error("no git");
    }) as never),
  ).toBe(false);
});

it("detectDefaultBranch strips origin/ prefix, falls back to main", () => {
  expect(detectDefaultBranch("/x", (() => "origin/trunk\n") as never)).toBe(
    "trunk",
  );
  expect(
    detectDefaultBranch(mkdtempSync(join(tmpdir(), "norepo-")), (() => {
      throw new Error("no origin");
    }) as never),
  ).toBe("main");
});
```

- [ ] **Step 2: Run tests, verify fail** (`module not found`).
- [ ] **Step 3: Implement** `repo-git-state.ts` per notes above. Pure node:fs
      reads; every fs call inside try/catch returning null/false — this reader
      must NEVER throw on weird repo states (it runs on every trigger check).
- [ ] **Step 4: Run tests → pass.**
- [ ] **Step 5: Commit**
      `git commit -m "feat(config): file-based repo git state reader in infra (hpg2 Task 2)"`

---

### Task 3: Pipeline finalize writes the `git` block

**Files:**

- Modify: `src/core/domains/ingest/pipeline/base.ts` (~line 258 — the single
  `registry.record({...})` call site; do NOT touch `operations/indexing.ts` /
  `operations/reindexing.ts`)
- Test: extend the existing test covering the registry record in
  `tests/core/domains/ingest/pipeline/` (locate the spec asserting
  `registry.record` was called; add a sibling case)

**Interfaces:**

- Consumes: `readRepoGitState`, `readWorkingTreeDirty` (Task 2);
  `RegistryGitState` (Task 1).
- Produces: every fresh `CollectionEntry` written by an index/reindex run
  carries `git: RegistryGitState` (undefined only when the project path is not a
  git repo).

- [ ] **Step 1: Failing test** — in the existing pipeline test that stubs
      `registry` (a `CollectionRegistryPort` mock), point the pipeline at a tmp
      dir fixture with `.git/HEAD` + ref file (reuse `writeRepo` helper shape
      from Task 2 test), run the pipeline's finalize path, assert:

```ts
expect(recordedEntry.git).toEqual({
  indexedBranch: "master",
  indexedCommit: "abc123def",
  indexedDirty: false,
});
```

and a second case: non-git tmp dir → `recordedEntry.git` undefined.

- [ ] **Step 2: Run → fail** (`git` undefined in recorded entry).
- [ ] **Step 3: Implement** in `base.ts` next to the record call:

```ts
import { readRepoGitState, readWorkingTreeDirty } from "../../../infra/repo-git-state.js";

private buildRegistryGitState(): RegistryGitState | undefined {
  const state = readRepoGitState(this.codebasePath);
  if (state === null) return undefined;
  return {
    indexedBranch: state.branch,
    indexedCommit: state.commit,
    indexedDirty: readWorkingTreeDirty(this.codebasePath),
  };
}
```

spread into the existing record call:
`...(gitState !== undefined ? { git: gitState } : {})`. Use the actual path
field name from `base.ts` (verify — likely `this.codebasePath` or equivalent
constructor param).

- [ ] **Step 4: Run the pipeline test file + full
      `npx vitest run     tests/core/domains/ingest/pipeline` → pass.**
- [ ] **Step 5: Commit**
      `git commit -m "feat(ingest): record repo git state in registry at finalize (hpg2 Task 3)"`

---

### Task 4: `IndexFreshnessCheck` in `domains/maintenance/freshness/`

**Files:**

- Create: `src/core/domains/maintenance/freshness/freshness-check.ts`
- Create: `src/core/domains/maintenance/freshness/index.ts` (barrel)
- Modify: `src/core/api/public/index.ts` (re-export — cli/mcp legal access)
- Test: `tests/core/domains/maintenance/freshness/freshness-check.test.ts`

**Interfaces:**

- Consumes: `CollectionEntry` (Task 1), `RepoGitState`/`readRepoGitState` (Task
  2).
- Produces:

```ts
export type IndexFreshnessVerdict =
  | { kind: "eligible"; entry: CollectionEntry }
  | { kind: "branch-mismatch"; head: string | null; targetBranch: string }
  | { kind: "transient" }
  | { kind: "disabled" }
  | { kind: "debounced"; reason: "recent-run" | "failure-backoff" }
  | { kind: "not-a-repo" };

export const AUTO_UPDATE_RUN_TTL_MS = 120_000;
export const AUTO_UPDATE_FAILURE_BACKOFF_MS = 300_000;

export interface IndexFreshnessCheckDeps {
  readGitState: typeof readRepoGitState; // injectable for tests
  clock: () => number; // Date.now injectable
}

export class IndexFreshnessCheck {
  constructor(deps?: Partial<IndexFreshnessCheckDeps>);
  /** Pure decision. Never throws. Marker/lock is NOT consulted here —
   *  the updater enforces it authoritatively (spec §4 step 2). */
  check(entry: CollectionEntry): IndexFreshnessVerdict;
}
```

Decision order (first match wins): no `autoUpdate` or `enabled === false` →
`disabled`; git state null → `not-a-repo`; `transient` → `transient`;
`state.branch !== targetBranch` → `branch-mismatch`; `lastRun` within TTL
(failed → `AUTO_UPDATE_FAILURE_BACKOFF_MS`, else `AUTO_UPDATE_RUN_TTL_MS`) →
`debounced`; else `eligible`. Mirror `update-check/check-service.ts` shape: tiny
class, deps as plain object literals in tests, discriminated-union result
(technique reference — locality NONE, review closely).

- [ ] **Step 1: Failing tests** — one `it` per verdict, plain literals:

```ts
const entry = (over: Partial<CollectionEntry>): CollectionEntry => ({
  ...baseEntry, // minimal valid CollectionEntry fixture
  autoUpdate: { enabled: true, targetBranch: "master" },
  ...over,
});
const check = (
  e: CollectionEntry,
  state: RepoGitState | null,
  now = 1_000_000,
) =>
  new IndexFreshnessCheck({
    readGitState: () => state,
    clock: () => now,
  }).check(e);

it("disabled when block missing", () =>
  expect(check(entry({ autoUpdate: undefined }), onMaster).kind).toBe(
    "disabled",
  ));
it("disabled when enabled=false", () =>
  expect(
    check(
      entry({ autoUpdate: { enabled: false, targetBranch: "master" } }),
      onMaster,
    ).kind,
  ).toBe("disabled"));
it("not-a-repo on null git state", () =>
  expect(check(entry({}), null).kind).toBe("not-a-repo"));
it("transient during rebase", () =>
  expect(check(entry({}), { ...onMaster, transient: true }).kind).toBe(
    "transient",
  ));
it("branch-mismatch carries head and target", () =>
  expect(check(entry({}), { ...onMaster, branch: "feature-x" })).toEqual({
    kind: "branch-mismatch",
    head: "feature-x",
    targetBranch: "master",
  }));
it("debounced within run TTL", () =>
  expect(
    check(
      entry({
        autoUpdate: {
          enabled: true,
          targetBranch: "master",
          lastRun: okRunAt(999_000),
        },
      }),
      onMaster,
    ).kind,
  ).toBe("debounced"));
it("failure backoff extends debounce to 5min", () => {
  const e = entry({
    autoUpdate: {
      enabled: true,
      targetBranch: "master",
      lastRun: failedRunAt(800_000),
    },
  });
  expect(check(e, onMaster, 1_000_000).kind).toBe("debounced");
  expect(check(e, onMaster, 1_200_000).kind).toBe("eligible");
});
it("eligible on target branch, no debounce", () =>
  expect(check(entry({}), onMaster).kind).toBe("eligible"));
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `freshness-check.ts` (≤80 lines), `index.ts` barrel
      exporting class + verdict type + constants; add re-export line to
      `src/core/api/public/index.ts` alongside the existing registry utilities
      re-exports.
- [ ] **Step 4: Run tests + `npm run typecheck` → pass.**
- [ ] **Step 5: Commit**
      `git commit -m "feat(api): IndexFreshnessCheck verdict module (hpg2 Task 4)"`

---

### Task 5: Detached updater — `tea-rags auto-update run` core

**Files:**

- Create: `src/cli/auto-update/run-updater.ts`
- Create: `src/cli/auto-update/updater-log.ts`
- Test: `tests/cli/auto-update/run-updater.test.ts`

**Interfaces:**

- Consumes: `IndexFreshnessCheck` (Task 4), `CollectionRegistry`
  (`setAutoUpdate`/`recordAutoUpdateRun`, Task 1), `App.indexCodebase`
  (existing: `src/core/api/public/app.ts:75`), bootstrap factory (existing —
  same wiring `src/cli/index-progress/worker.ts` uses; that file is a deep-silo
  reference: MIRROR its App construction, do not modify it).
- Produces:

```ts
export const AUTO_UPDATE_EXIT = {
  ok: 0,
  failed: 1,
  skipped: 2,
  lockHeld: 3,
} as const;

export interface RunUpdaterDeps {
  app: Pick<App, "indexCodebase">;
  registry: Pick<CollectionRegistry, "get" | "recordAutoUpdateRun">;
  freshness: Pick<IndexFreshnessCheck, "check">;
  clock: () => number;
  log: (line: string) => void;
}
/** Full updater lifecycle (spec §4). Returns exit code — caller process.exit()s. */
export async function runUpdater(
  collectionName: string,
  deps: RunUpdaterDeps,
): Promise<number>;

// updater-log.ts
export function openAutoUpdateLog(
  dataDir: string,
  projectLabel: string,
): { fd: number; path: string };
```

Lifecycle inside `runUpdater` (spec §4 numbered steps):

1. `registry.get(collectionName)` → missing → log + `skipped`.
2. `freshness.check(entry)` (TOCTOU re-check) → non-`eligible` → log verdict →
   `skipped`.
3. `await app.indexCodebase(entry.path, { /* incremental — same options worker.ts passes for non-force runs */ })`;
   the pipelines' existing indexing-marker/heartbeat guard throws when another
   run holds the lock — catch, match the ingest error by `name` (check the
   exported error classes in `core/api/public` — the in-progress guard error
   from `infra/heartbeat-guard.ts` path), map → `lock-held`.
4. Enrichment wait: pass the `enrichmentProgress` callback and await the
   terminal notification the same way `worker.ts` does (reference only).
5. `registry.recordAutoUpdateRun(collectionName, { at: new Date(deps.clock()).toISOString(), outcome, durationMs, filesChanged })`
   — written on EVERY path including catch (outcome `failed`, `error` message
   trimmed to 500 chars).
6. Return exit code.

`filesChanged`: from `indexCodebase` result stats (the `IndexStats` DTO — use
its changed/indexed count field; `no-op` outcome when 0).

- [ ] **Step 1: Failing tests** — all deps are object literals; no real App:

```ts
it("skipped when registry entry vanished", async () => {
  expect(
    await runUpdater(
      "gone",
      deps({ registry: { get: () => null, recordAutoUpdateRun: vi.fn() } }),
    ),
  ).toBe(2);
});
it("skipped on TOCTOU branch mismatch, lastRun recorded", async () => {
  /* freshness → branch-mismatch; expect recordAutoUpdateRun outcome "skipped" */
});
it("lock-held when pipeline throws in-progress guard error", async () => {
  /* app.indexCodebase rejects with err.name = <guard error>; expect 3 + "lock-held" */
});
it("ok path records durationMs + filesChanged", async () => {
  /* resolve stats with 3 changed; expect 0 + outcome "ok", filesChanged 3 */
});
it("no-op when 0 files changed", async () => {
  /* outcome "no-op", exit 0 */
});
it("failed records trimmed error", async () => {
  /* reject generic; expect 1, outcome "failed", error present */
});
```

(Write these six fully in the test file — the sketch comments above are the
behaviors; the implementer expands each with the literal deps.)

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `run-updater.ts` (~100 lines) + `updater-log.ts`
      (mkdir `join(dataDir, "logs")`, open append fd, filename
      `auto-update-<projectLabel>.log`, truncate when >5 MB).
- [ ] **Step 4: Run tests → pass.**
- [ ] **Step 5: Commit**
      `git commit -m "feat(config): detached auto-update updater lifecycle (hpg2 Task 5)"`

---

### Task 6: `AutoUpdateTrigger` + spawner in `bootstrap/`

**Files:**

- Create: `src/bootstrap/auto-update/spawner.ts`
- Create: `src/bootstrap/auto-update/trigger.ts`
- Test: `tests/bootstrap/auto-update/trigger.test.ts`,
  `tests/bootstrap/auto-update/spawner.test.ts`

**Interfaces:**

- Consumes: `IndexFreshnessCheck` (Task 4), `CollectionRegistry` (Task 1),
  `AUTO_UPDATE_EXIT` semantics (Task 5, indirectly — spawns the subcommand).
- Produces (Tasks 7–8 wire these into prime and MCP):

```ts
// spawner.ts
export interface SpawnDetachedUpdaterOptions {
  project: string; // alias or collectionName — passed through to the subcommand
  logFd: number;
  spawnImpl?: typeof nodeSpawn;
  cliEntryPath?: string; // default: resolved from import.meta.url → ../../cli/index.js
}
export function spawnDetachedUpdater(opts: SpawnDetachedUpdaterOptions): void;
// spawn(process.execPath, [cliEntry, "auto-update", "run", "--project", project],
//       { detached: true, stdio: ["ignore", logFd, logFd] }).unref()

// trigger.ts
export interface AutoUpdateTriggerDeps {
  registry: Pick<CollectionRegistry, "get" | "findByPath" | "findByName">;
  freshness: Pick<IndexFreshnessCheck, "check">;
  spawn: (project: string) => void; // spawner partial-applied with log fd
  clock: () => number;
}
export class AutoUpdateTrigger {
  constructor(deps: AutoUpdateTriggerDeps);
  /** Fire-and-forget: cheap in-memory TTL (120s per collection), then
   *  freshness verdict, then spawn on eligible. Never throws. Returns the
   *  verdict kind (for prime/MCP hint rendering) or "in-memory-debounced". */
  maybeSpawn(
    collectionName: string,
  ): IndexFreshnessVerdict["kind"] | "in-memory-debounced";
}
```

In-memory TTL is a `Map<string, number>` keyed by collectionName inside the
trigger instance (one instance per MCP server process / per prime run).
Cross-process debounce already lives in the verdict (`debounced` via `lastRun`).
`maybeSpawn` looks up the entry by collectionName only — callers resolve
alias/path→collection first (MCP tools already carry the resolved collection;
prime has the entry in hand).

- [ ] **Step 1: Failing tests:**

```ts
it("spawns on eligible and remembers TTL", () => {
  const spawn = vi.fn();
  const t = trigger({ spawn, verdict: { kind: "eligible", entry } });
  expect(t.maybeSpawn("code_x")).toBe("eligible");
  expect(spawn).toHaveBeenCalledWith("code_x");
  expect(t.maybeSpawn("code_x")).toBe("in-memory-debounced");
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("does not spawn on branch-mismatch but reports kind", () => {
  /* spawn not called, returns "branch-mismatch" */
});
it("TTL expires after 120s", () => {
  /* clock advance → second spawn */
});
it("unknown collection → disabled kind, no spawn, no throw", () => {});
// spawner.test.ts
it("spawns detached node process with auto-update run argv and unrefs", () => {
  const child = { unref: vi.fn() };
  const spawnImpl = vi.fn(() => child);
  spawnDetachedUpdater({
    project: "tea-rags",
    logFd: 7,
    spawnImpl: spawnImpl as never,
  });
  const [cmd, argv, opts] = spawnImpl.mock.calls[0];
  expect(cmd).toBe(process.execPath);
  expect(argv.slice(-4)).toEqual([
    "auto-update",
    "run",
    "--project",
    "tea-rags",
  ]);
  expect(opts).toMatchObject({ detached: true, stdio: ["ignore", 7, 7] });
  expect(child.unref).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** both modules (~40 lines each).
- [ ] **Step 4: Run tests → pass.**
- [ ] **Step 5: Commit**
      `git commit -m "feat(bootstrap): AutoUpdateTrigger + detached spawner (hpg2 Task 6)"`

---

### Task 7: CLI command `tea-rags auto-update` (enable/disable/status/run)

**Files:**

- Create: `src/cli/commands/auto-update.ts`
- Modify: `src/cli/create-cli.ts` (add one `.command(...)` registration — file
  is 90% Arthur-owned with taskIds #6–#8; additive only)
- Test: `tests/cli/commands/auto-update.test.ts`

**Interfaces:**

- Consumes: `runUpdater` + `AUTO_UPDATE_EXIT` + `openAutoUpdateLog` (Task 5),
  `CollectionRegistry.setAutoUpdate` (Task 1), `detectDefaultBranch` (Task 2),
  alias resolution — mirror how existing commands resolve `--project` (see
  `src/cli/registry-resolver.ts`), DI-deps command pattern — mirror
  `src/cli/commands/update.ts` (`RunUpdateDeps` + `defaultDeps()` + pure
  handler + `CommandModule`).
- Produces: yargs command `auto-update <action>` with actions
  `enable|disable|status|run`, flags `--project <alias>` (required),
  `--branch <name>` (enable only, optional).

Behaviors:

- `enable`: resolve entry (alias → collectionName); branch = `--branch` ??
  `detectDefaultBranch(entry.path)`;
  `registry.setAutoUpdate(collectionName, { enabled: true, targetBranch })`;
  print `auto-update enabled for <alias> (branch: <targetBranch>)`.
- `disable`: `setAutoUpdate(collectionName, { ...existing, enabled: false })`
  when block exists, else no-op message. Keep targetBranch (re-enable remembers
  it).
- `status`: print verdict from `IndexFreshnessCheck` + `lastRun` line + log
  path.
- `run`: `runUpdater` inline (foreground; stdout log sink when TTY), exit with
  its code — this is the same entry the detached spawn hits.

- [ ] **Step 1: Failing tests** — pure-handler tests with literal deps (mirror
      `update.ts` test file structure): enable writes config with autodetected
      branch; enable honors `--branch`; disable preserves targetBranch; status
      prints verdict + lastRun; run exits with updater code; unknown `--project`
      → exit 1 with message listing `tea-rags projects` hint.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** command module + register in `create-cli.ts` (one
      line, matching neighbors).
- [ ] **Step 4: Run tests + `npm run typecheck` → pass. Manual smoke:**
      `node build/cli/index.js auto-update status --project tea-rags` after
      `npm run build` (single-worktree build rule: pair with `npm link`).
- [ ] **Step 5: Commit**
      `git commit -m "feat(config): auto-update CLI command — enable/disable/status/run (hpg2 Task 7)"`

---

### Task 8: Prime integration — spawn at SessionStart + digest lines

**Files:**

- Modify: `src/cli/prime/run-prime.ts` (wire trigger after digest render — file
  already wires `update-check/*` the same way)
- Modify: `src/cli/prime/format.ts` (staleness line at :65-69 becomes
  branch-aware; new `auto-update:` status line near the `last indexed` line at
  :269)
- Test: extend `tests/cli/prime/format.test.ts` (or the existing prime format
  spec file) + `tests/cli/prime/run-prime.test.ts`

**Interfaces:**

- Consumes: `AutoUpdateTrigger` (Task 6), `RegistryAutoUpdateConfig` +
  `RegistryGitState` (Task 1) — surfaced through the prime data object
  (`PrimeData` in `src/cli/prime/types.ts` gains optional
  `autoUpdate?: { verdictKind: string; config?: RegistryAutoUpdateConfig; git?: RegistryGitState }`).
- Produces: digest lines (exact copy, tests pin them):
  - enabled + eligible/spawned:
    `auto-update: on (master) · catching up in background`
  - enabled + fresh (debounced/no changes):
    `auto-update: on (master) · last run ok 3m ago`
  - enabled + mismatch:
    `auto-update: paused — HEAD feature-x ≠ target master; run index_codebase to switch the index`
  - disabled + registry has git block: existing staleness line PLUS
    `index = feature-x@ab12f3 — enable auto-update: tea-rags auto-update enable --project <alias>`
    (only when stale; keeps current behavior otherwise)
  - failed lastRun: `auto-update: failed 2h ago — see <logPath>`

Latency guard: trigger call is fire-and-forget AFTER the digest string is fully
written to stdout; prime never awaits the spawn (test asserts output ordering by
injected spawn spy that records call order).

- [ ] **Step 1: Failing tests** — format cases (one per line above, feeding
      literal `PrimeData`), run-prime case asserting `trigger.maybeSpawn` called
      once with the resolved collectionName and AFTER stdout write (spy
      ordering).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** `format.ts`: new pure
      `formatAutoUpdateLine(data): string | null` + branch-aware tweak of the
      staleness block; `run-prime.ts`: build trigger from bootstrap deps
      (registry + freshness + spawner with log fd), call after render.
- [ ] **Step 4: Run prime tests → pass. Smoke:
      `node build/cli/index.js prime .`**
- [ ] **Step 5: Commit**
      `git commit -m "improve(config): branch-aware prime digest + auto-update spawn at session start (hpg2 Task 8)"`

---

### Task 9: MCP post-response trigger + response hint

**Files:**

- Modify: `src/mcp/tools/explore.ts` (`registerSearchTools` at :136-157 — wrap
  handlers)
- Modify: `src/mcp/format.ts` (HUB — fanIn 10: ADD `appendAutoUpdateHint`
  function only; zero edits to existing exports)
- Modify: the bootstrap→mcp registration seam (where `registerSearchTools`
  receives `App` — thread optional `autoUpdateTrigger?: AutoUpdateTrigger`
  through the registration deps; absent → behavior identical to today)
- Test: `tests/mcp/tools/explore-auto-update.test.ts` (new file — existing
  explore tests untouched per test-invariants rule)

**Interfaces:**

- Consumes: `AutoUpdateTrigger.maybeSpawn(collectionName)` (Task 6); the
  resolved collection name available inside search handlers (the request
  resolution path the tools already use).
- Produces:

```ts
// mcp/format.ts — ADDITIVE
export function appendAutoUpdateHint(
  result: McpToolResult,
  hint: string | null,
): McpToolResult;
// hint lines rendered by the caller:
//   "index updating in background"            (verdict "eligible" → spawned)
//   "index = <branch>@<sha7>, HEAD = <head> — auto-update paused (branch mismatch)"
//   null for every other verdict (silent)
```

Wiring shape in `registerSearchTools`: after the tool handler produces its
result and BEFORE returning, call
`const kind = trigger?.maybeSpawn(collectionName)` (fire-and-forget spawn
inside), map kind → hint string, append. The trigger call itself is synchronous
and ~1ms (registry cache + HEAD read); the spawn inside is detached. No
try/catch in handlers (typed-errors rule) — `maybeSpawn` never throws by
contract (Task 6).

- [ ] **Step 1: Failing tests** — register tools with a stub trigger: eligible →
      response text ends with the hint; branch-mismatch → paused hint; disabled
      → no hint; no trigger passed → no hint and no crash.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** (hint map lives in `explore.ts`; `format.ts` gets
      only the append function).
- [ ] **Step 4: Run mcp tests + full `npx vitest run` → green.**
- [ ] **Step 5: Commit**
      `git commit -m "feat(mcp): auto-update trigger on search tools + response hint (hpg2 Task 9)"`

---

### Task 10: Docs — website/docs page + README section

**Files:**

- Create:
  `website/docs/<fit the existing sidebar category — check website/sidebars.* for the config/guides section>/auto-update.md`
- Modify: `README.md` (new "Auto-update" section after the indexing section)

**Interfaces:** consumes the CLI surface (Task 7) and behavior table (spec
§2-§4) — document exactly what shipped, no forward promises.

Content (both files, English): what it does (one paragraph), opt-in model
(`enabled: false` default + why), the three commands with copy-paste examples,
branch policy semantics table (eligible/branch-mismatch/transient/disabled/
debounced), where logs live, failure/backoff behavior, "no daemon" note
(ephemeral process, in-session triggers only).

- [ ] **Step 1: Write both docs.** Run `markdownlint` MCP on both; fix.
- [ ] **Step 2: Build website locally if the repo has a docs build script
      (`npm run --prefix website build` — check package.json) — must pass.**
- [ ] **Step 3: Commit**
      `git commit -m "docs: auto-update watcher guide + README section (hpg2 Task 10)"`

---

## Final verification (after Task 10)

- [ ] `npx vitest run` — full suite green.
- [ ] `npm run typecheck` + lint clean.
- [ ] `npm run build && npm link` (single-worktree rule) → reconnect MCP → live
      smoke: `tea-rags auto-update enable --project tea-rags`, edit a file on
      the target branch, run a search tool, observe hint + log file + `lastRun`
      in registry; `tea-rags auto-update status --project tea-rags`.
- [ ] dinopowers:verification-before-completion pass over the branch diff.
- [ ] Beads: close Tasks 1–10 beads with commit evidence; `bd close hpg2` only
      after live smoke passes.
