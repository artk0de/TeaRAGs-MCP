# Git Blame Off The Main Thread — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. **Per the dinopowers chaining rule,
> invoke `dinopowers:test-driven-development` for each RED phase and
> `dinopowers:executing-plans` to run the plan.**

**Goal:** Stop a cold full reindex from stalling — move the synchronous
in-process es-git blame of the FILE phase off the ingest main thread into a
provider-owned pool of `worker_threads`, so embedding (async I/O on the same
event loop) keeps flowing.

**Architecture:** The single inline-blame call site
(`GitEnrichmentProvider.populateBlameMap`, provider.ts:426) partitions its
cache-miss files by history depth. SHALLOW files (sync in-process es-git blame —
the event-loop stall) go to a new `BlameWorkerPool` (N `worker_threads`, each
with its own es-git `Repository` handle — proven thread-safe by the Step 0
spike, `scripts/spikes/esgit-thread-safety.js`). DEEP files stay on main (their
blame already goes to the async CLI, which does not block the loop, capped at
2). The OID-keyed blame cache and `git log --numstat` discovery stay entirely on
main. The chunk-churn WALK worker (already off-thread, iqpuu) is untouched — it
still receives precomputed `blameByPath`.

**Tech Stack:** TypeScript (ESM, NodeNext), `node:worker_threads`, es-git
(napi-rs/libgit2), Vitest, Zod config schemas.

## Global Constraints

- **Spec:**
  `docs/superpowers/specs/2026-07-05-git-blame-off-main-thread-design.md` (bd
  tea-rags-mcp-dog1v). The "Design refinement (post-seam-analysis)" section
  governs where it conflicts with the original "blame in the walk worker"
  framing.
- **Step 0 gate = GREEN → thread pool** (committed d19e5cd7). Use
  `worker_threads`, NOT `ProcessTransport`.
- **Worker-thread DI (`.claude/rules/domains-language.md`):** class INSTANCES
  never cross `postMessage`. Ship the adapter KIND (a `GitAdapterKind`
  literal) + serializable data; the worker rebuilds its own `VcsGitAdapter` via
  `VcsAdapterFactory`. Every job/response field must be structured-clone-safe
  (Map/Set/plain objects/scalars).
- **Domain boundaries (`.claude/rules/domain-boundaries.md`):**
  `domains/trajectory/` may NOT import from `domains/ingest/`. The blame-pool
  default helper therefore lives under `trajectory/git/infra/`, never in
  `ingest/pipeline/infra/pool-defaults.ts`.
- **Typed errors (`.claude/rules/typed-errors.md`):** reuse
  `ChunkChurnWalkThreadError` family or add a sibling `TrajectoryError`
  subclass; never `throw new Error(...)` in domain code.
- **Barrel files (`.claude/rules/barrel-files.md`):** new public exports
  crossing a domain boundary go through the domain barrel; deep imports OK
  within `git/infra/`.
- **Naming (`.claude/rules/naming.md`):** domain-qualified, unambiguous in
  isolation.
- **Tests:** `npx vitest run <file>`. Pre-commit runs tests + type-check.
  Business-logic tests are immutable — move/extend, never rewrite. Real-git
  fixtures are authored inline per test file (`gitIn`/`mkdtempSync` convention —
  there is NO shared `createTempGitRepo` helper).
- **Worker script path:** `worker_threads` load compiled JS. The host resolves
  `import.meta.url` with `.replace("/src/", "/build/")` and points at
  `worker.js` (existing `churn-walk/thread.ts:37` idiom). A run must therefore
  be `npm run build` before any MCP/live test.
- **NEVER push** (ephemeral branch). Commit only. Reindex is user-gated.

---

## File Structure

| Path                                                                      | Responsibility                                                                     | Action                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/trajectory/git/infra/churn-walk/protocol.ts`            | serializable job/response types                                                    | **Modify** — add `BlameJobInput`, `BlameOutcome`, `"blame"`/`"blamed"`/`"blame-failed"` variants                                                           |
| `src/core/domains/trajectory/git/infra/churn-walk/worker.ts`              | worker entry (walk today)                                                          | **Modify** — add `runBlame`, discriminate `"walk"`/`"blame"`/`"close"`                                                                                     |
| `src/core/domains/trajectory/git/infra/churn-walk/blame-pool.ts`          | `BlameWorkerPool` — N workers, shard+dispatch blame, merge                         | **Create**                                                                                                                                                 |
| `src/core/domains/trajectory/git/infra/churn-walk/blame-pool-defaults.ts` | `defaultBlamePoolSize()` (boundary-safe home for both provider + bootstrap schema) | **Create**                                                                                                                                                 |
| `src/core/adapters/vcs/git/es-git/adapter.ts`                             | hybrid blame adapter                                                               | **Modify** — `export` the `BLAME_CLI_MIN_COMMITS` threshold so the provider partitions on the SAME value                                                   |
| `src/core/domains/trajectory/git/provider.ts`                             | `GitEnrichmentProvider` — the change hub                                           | **Modify** — `populateBlameMap` partitions + dispatches; new `blamePool` field + `ensureBlamePool`; `finalizeSignals` closes it; `blamePoolSize` in config |
| `src/core/contracts/types/config.ts`                                      | `TrajectoryGitConfig`                                                              | **Modify** — add `blamePoolSize: number`                                                                                                                   |
| `src/bootstrap/config/schemas.ts`                                         | `trajectoryGitSchema`                                                              | **Modify** — add `blamePoolSize: intWithDefault(defaultBlamePoolSize())`                                                                                   |
| `src/bootstrap/factory.ts`                                                | inline-git note (:255–266)                                                         | **Modify** — doc-note update                                                                                                                               |
| `tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts`   | pool equivalence (real-git)                                                        | **Create**                                                                                                                                                 |
| `tests/core/domains/trajectory/git/provider.test.ts`                      | provider partition + wiring                                                        | **Modify** — extend                                                                                                                                        |
| `tests/bootstrap/config-zod.test.ts`                                      | config default/override                                                            | **Modify** — extend                                                                                                                                        |

---

## Task 1: `BlameWorkerPool` + the blame job (protocol + worker + pool host)

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/churn-walk/protocol.ts`
- Modify: `src/core/domains/trajectory/git/infra/churn-walk/worker.ts`
- Create: `src/core/domains/trajectory/git/infra/churn-walk/blame-pool.ts`
- Test: `tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts`

**Interfaces:**

- Produces:
  `interface BlameJobInput { repoRoot: string; gitAdapter: GitAdapterKind; files: { relPath: string; historyDepthHint: number }[]; timeoutMs: number }`;
  `interface BlameOutcome { blameByPath: Map<string, BlameLine[]> }`;
  `class BlameWorkerPool { constructor(size: number); blame(repoRoot: string, gitAdapter: GitAdapterKind, files: { relPath: string; historyDepthHint: number }[], timeoutMs: number): Promise<Map<string, BlameLine[]>>; close(): Promise<void> }`.
- Consumes: existing `worker.ts` `adapterFor(kind, repoRoot)`,
  `EsGitAdapter.blameFile(relPath, timeoutMs, historyDepthHint)`.

- [ ] **Step 1: Write the failing pool-equivalence test**

Create `tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts`.
Mirror the inline real-git fixture convention from `churn-walk-thread.test.ts`
(`mkdtempSync` under `realpathSync(tmpdir())`, `gitIn` with pinned author env).
Assert the pool's blame equals a direct `EsGitAdapter.blameFile` oracle for
shallow files.

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync as _r, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VcsAdapterFactory } from "../../../../../../../src/core/adapters/vcs/factory.js";
import { BlameWorkerPool } from "../../../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js";

const TMP_BASE = realpathSync(tmpdir());
let repo: string;

function gitIn(cwd: string, args: string[]): void {
  if (!cwd.startsWith(TMP_BASE))
    throw new Error(`refusing git outside temp: ${cwd}`);
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(TMP_BASE, "blame-pool-"));
  const g = (args: string[]): void => gitIn(repo, args);
  g(["init", "-q"]);
  writeFileSync(join(repo, "a.ts"), "const a = 1;\nconst b = 2;\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "c1"]);
  writeFileSync(
    join(repo, "a.ts"),
    "const a = 1;\nconst b = 3;\nconst c = 4;\n",
  );
  writeFileSync(join(repo, "b.ts"), "export const x = 10;\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "c2"]);
}, 30000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("BlameWorkerPool", () => {
  it("computes blame off-thread equal to the inline es-git oracle", async () => {
    const oracle = await VcsAdapterFactory.create("es-git", repo);
    const expectedA = await oracle.blameFile("a.ts", 60000, 2);
    const expectedB = await oracle.blameFile("b.ts", 60000, 1);

    const pool = new BlameWorkerPool(2);
    try {
      const result = await pool.blame(
        repo,
        "es-git",
        [
          { relPath: "a.ts", historyDepthHint: 2 },
          { relPath: "b.ts", historyDepthHint: 1 },
        ],
        60000,
      );
      expect(result.get("a.ts")).toEqual(expectedA);
      expect(result.get("b.ts")).toEqual(expectedB);
    } finally {
      await pool.close();
    }
  }, 30000);

  it("returns an empty map for zero files without spawning a worker", async () => {
    const pool = new BlameWorkerPool(2);
    const result = await pool.blame(repo, "es-git", [], 60000);
    expect(result.size).toBe(0);
    await pool.close();
  });
});
```

> Delete the throwaway `const got = ...` probe line before committing — it is
> only here to show the signature; keep the real `result` assertion.

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts`
Expected: FAIL — `Cannot find module '.../churn-walk/blame-pool.js'`.

- [ ] **Step 3: Add the blame job types to `protocol.ts`**

Append to `src/core/domains/trajectory/git/infra/churn-walk/protocol.ts` (keep
the existing walk types):

```ts
/** One serializable BLAME job — shallow-history files the main side routed to
 *  the off-thread pool (deep files stay on main's async CLI). The worker
 *  rebuilds its own es-git adapter (worker-DI) and blames each file. */
export interface BlameJobInput {
  repoRoot: string;
  /** Adapter KIND literal — worker rebuilds VcsGitAdapter in-thread. */
  gitAdapter: GitAdapterKind;
  /** Files to blame + each file's commit count, so the worker's adapter can
   *  keep the depth-routing contract (shallow → in-process; a misclassified
   *  deep file still routes correctly to the worker's own capped CLI). */
  files: { relPath: string; historyDepthHint: number }[];
  timeoutMs: number;
}

/** Blame result crossing back to the main thread. */
export interface BlameOutcome {
  blameByPath: Map<string, BlameLine[]>;
}
```

Extend the two unions (replace them wholesale):

```ts
export type ChurnWalkThreadRequest =
  | { type: "walk"; id: number; job: ChunkChurnWalkJobInput }
  | { type: "blame"; id: number; job: BlameJobInput }
  | { type: "close" };

export type ChurnWalkThreadResponse =
  | {
      type: "walked";
      id: number;
      overlays: ChunkChurnWalkOutcome["overlays"];
      stats: ChunkChurnWalkStats;
    }
  | { type: "walk-failed"; id: number; error: string }
  | { type: "blamed"; id: number; blameByPath: Map<string, BlameLine[]> }
  | { type: "blame-failed"; id: number; error: string };
```

(`BlameLine` and `GitAdapterKind` are already imported at the top of the file.)

- [ ] **Step 4: Add `runBlame` + the `"blame"` branch to `worker.ts`**

In `src/core/domains/trajectory/git/infra/churn-walk/worker.ts`, add the
`BlameJobInput`/`BlameOutcome` type imports to the existing protocol import, add
a `BlameLine` type import, then add `runBlame` next to `runWalk`:

```ts
async function runBlame(job: BlameJobInput): Promise<BlameOutcome> {
  const adapter = await adapterFor(job.gitAdapter, job.repoRoot);
  const blameByPath = new Map<string, BlameLine[]>();
  // Serial per worker: in-process es-git blame is sync — concurrency on ONE
  // thread yields nothing (that is exactly why the inline path stalled). The
  // pool's parallelism comes from N workers, each blaming a disjoint shard.
  for (const { relPath, historyDepthHint } of job.files) {
    blameByPath.set(
      relPath,
      await adapter.blameFile(relPath, job.timeoutMs, historyDepthHint),
    );
  }
  return { blameByPath };
}
```

Replace the `parentPort.on("message", ...)` body to discriminate the three
request types:

```ts
if (parentPort) {
  parentPort.on("message", (request: ChurnWalkThreadRequest) => {
    void (async () => {
      if (request.type === "close") {
        await handleClose();
        return;
      }
      if (request.type === "blame") {
        try {
          const { blameByPath } = await runBlame(request.job);
          parentPort?.postMessage({
            type: "blamed",
            id: request.id,
            blameByPath,
          } satisfies ChurnWalkThreadResponse);
        } catch (error) {
          parentPort?.postMessage({
            type: "blame-failed",
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ChurnWalkThreadResponse);
        }
        return;
      }
      try {
        const { overlays, stats } = await runWalk(request.job);
        parentPort?.postMessage({
          type: "walked",
          id: request.id,
          overlays,
          stats,
        } satisfies ChurnWalkThreadResponse);
      } catch (error) {
        parentPort?.postMessage({
          type: "walk-failed",
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies ChurnWalkThreadResponse);
      }
    })();
  });
}
```

- [ ] **Step 5: Create `blame-pool.ts`**

Create `src/core/domains/trajectory/git/infra/churn-walk/blame-pool.ts`:

```ts
/**
 * BlameWorkerPool — main-side host of N churn-walk workers used to compute the
 * FILE-phase git blame OFF the ingest main thread (bd tea-rags-mcp-dog1v).
 *
 * The inline es-git in-process blame is a SYNC napi call that blocks the event
 * loop; on a cold reindex of a large monolith that starves embedding (34k+
 * sync blames on main). Step 0 (scripts/spikes/esgit-thread-safety.js) proved
 * es-git/libgit2 is thread-safe with a per-thread Repository handle, so each
 * worker opens its own adapter and blames a disjoint shard in parallel.
 *
 * Reuses the churn-walk worker.js (a "blame" job type); this host differs from
 * ChunkChurnWalkThread only in fan-out (N workers + file sharding vs one).
 * Provider-owned, lazily spawned on first blame, closed at finalizeSignals.
 */

import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type {
  BlameLine,
  GitAdapterKind,
} from "../../../../../adapters/vcs/types.js";
import { ChunkChurnWalkThreadError } from "../../errors.js";
import type {
  BlameJobInput,
  ChurnWalkThreadRequest,
  ChurnWalkThreadResponse,
} from "./protocol.js";

const WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)).replace("/src/", "/build/"),
  "worker.js",
);
const CLOSE_TIMEOUT_MS = 5000;

interface PendingBlame {
  resolve: (blameByPath: Map<string, BlameLine[]>) => void;
  reject: (error: Error) => void;
}

export class BlameWorkerPool {
  private readonly size: number;
  private readonly workers: (Worker | undefined)[];
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingBlame>();

  constructor(size: number) {
    this.size = Math.max(1, size);
    this.workers = new Array<Worker | undefined>(this.size).fill(undefined);
  }

  /** Shard the files across the pool and blame each shard on its own worker,
   *  merging the per-shard blame maps. Zero files → empty map, no spawn. */
  async blame(
    repoRoot: string,
    gitAdapter: GitAdapterKind,
    files: { relPath: string; historyDepthHint: number }[],
    timeoutMs: number,
  ): Promise<Map<string, BlameLine[]>> {
    if (files.length === 0 || this.closed) return new Map();
    const shards: { relPath: string; historyDepthHint: number }[][] =
      Array.from({ length: this.size }, () => []);
    files.forEach((file, i) => shards[i % this.size].push(file));

    const maps = await Promise.all(
      shards.map(async (shard, workerIdx) =>
        shard.length === 0
          ? new Map<string, BlameLine[]>()
          : this.dispatch(workerIdx, {
              repoRoot,
              gitAdapter,
              files: shard,
              timeoutMs,
            }),
      ),
    );

    const merged = new Map<string, BlameLine[]>();
    for (const map of maps)
      for (const [relPath, lines] of map) merged.set(relPath, lines);
    return merged;
  }

  /**
   * Idempotent teardown — posts "close" to every live worker, waits (bounded)
   * for graceful exits, hard-terminates the stragglers, then rejects any blame
   * still pending (its files fall back to unknown ownership, same as an inline
   * blame failure).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const live = this.workers.filter((w): w is Worker => w !== undefined);
    this.workers.fill(undefined);
    await Promise.all(
      live.map(async (worker) => {
        try {
          worker.postMessage({
            type: "close",
          } satisfies ChurnWalkThreadRequest);
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), CLOSE_TIMEOUT_MS);
          });
          const outcome = await Promise.race([
            once(worker, "exit").then(() => "exit" as const),
            timedOut,
          ]);
          if (timer) clearTimeout(timer);
          if (outcome === "timeout") await worker.terminate();
        } catch {
          await worker.terminate().catch(() => undefined);
        }
      }),
    );
    this.rejectAll(
      new ChunkChurnWalkThreadError(
        "blame pool closed with blames still pending",
      ),
    );
  }

  private dispatch(
    workerIdx: number,
    job: BlameJobInput,
  ): Promise<Map<string, BlameLine[]>> {
    const worker = this.ensureWorker(workerIdx);
    const id = this.nextId++;
    return new Promise<Map<string, BlameLine[]>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({
        type: "blame",
        id,
        job,
      } satisfies ChurnWalkThreadRequest);
    });
  }

  private ensureWorker(idx: number): Worker {
    const existing = this.workers[idx];
    if (existing) return existing;
    if (this.closed)
      throw new ChunkChurnWalkThreadError("blame() after close()");
    const worker = new Worker(WORKER_PATH);
    worker.on("message", (response: ChurnWalkThreadResponse) =>
      this.onResponse(response),
    );
    worker.on("error", (error: Error) =>
      this.rejectAll(
        new ChunkChurnWalkThreadError("blame worker error", error),
      ),
    );
    worker.on("exit", (code: number) => {
      if (!this.closed && code !== 0) {
        this.rejectAll(
          new ChunkChurnWalkThreadError(
            `blame worker exited unexpectedly (code ${code})`,
          ),
        );
      }
    });
    this.workers[idx] = worker;
    return worker;
  }

  private onResponse(response: ChurnWalkThreadResponse): void {
    if (response.type !== "blamed" && response.type !== "blame-failed") return;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (response.type === "blamed") entry.resolve(response.blameByPath);
    else entry.reject(new ChunkChurnWalkThreadError(response.error));
  }

  private rejectAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
```

- [ ] **Step 6: Build (workers need compiled JS) and run the test**

Run:
`npm run build && npx vitest run tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts`
Expected: PASS — both `a.ts`/`b.ts` blame maps equal the inline oracle;
empty-files case returns size 0.

> The `npm run build` is mandatory: `worker.js` is loaded from `build/`, so the
> new `runBlame` branch must be compiled before the pool test can exercise it.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/trajectory/git/infra/churn-walk/protocol.ts \
        src/core/domains/trajectory/git/infra/churn-walk/worker.ts \
        src/core/domains/trajectory/git/infra/churn-walk/blame-pool.ts \
        tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts
git commit -m "feat(trajectory): BlameWorkerPool — off-thread es-git blame via a churn-walk blame job"
```

---

## Task 2: Config knob (`blamePoolSize`) + exported blame-depth threshold

**Files:**

- Create:
  `src/core/domains/trajectory/git/infra/churn-walk/blame-pool-defaults.ts`
- Modify: `src/core/adapters/vcs/git/es-git/adapter.ts` (export
  `BLAME_CLI_MIN_COMMITS`)
- Modify: `src/core/contracts/types/config.ts` (`TrajectoryGitConfig`)
- Modify: `src/bootstrap/config/schemas.ts` (`trajectoryGitSchema`)
- Test: `tests/bootstrap/config-zod.test.ts`

**Interfaces:**

- Produces: `defaultBlamePoolSize(): number`;
  `TrajectoryGitConfig.blamePoolSize: number`; exported `BLAME_CLI_MIN_COMMITS`
  const from the es-git adapter.
- Consumes: `os.cpus()`, existing `intWithDefault`.

- [ ] **Step 1: Write the failing config test**

Extend `tests/bootstrap/config-zod.test.ts` — add to the trajectory-git describe
block:

```ts
it("defaults blamePoolSize to min(4, cpus-1) and honors TRAJECTORY_GIT_BLAME_POOL_SIZE", () => {
  const parsedDefault = trajectoryGitSchema.parse({});
  expect(parsedDefault.blamePoolSize).toBeGreaterThanOrEqual(1);
  expect(parsedDefault.blamePoolSize).toBeLessThanOrEqual(4);

  const parsedOverride = trajectoryGitSchema.parse({ blamePoolSize: "8" });
  expect(parsedOverride.blamePoolSize).toBe(8);
});
```

(If `trajectoryGitSchema` is not yet imported in that test file, add
`import { trajectoryGitSchema } from "../../src/bootstrap/config/schemas.js";` —
match the existing import path style in the file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/bootstrap/config-zod.test.ts` Expected: FAIL —
`parsedDefault.blamePoolSize` is `undefined`.

- [ ] **Step 3: Create the boundary-safe default helper**

Create
`src/core/domains/trajectory/git/infra/churn-walk/blame-pool-defaults.ts`:

```ts
import os from "node:os";

/**
 * Default size of the FILE-phase blame worker pool (bd tea-rags-mcp-dog1v).
 * CPU-parallelism axis: es-git in-process blame is CPU-bound sync work, so the
 * pool caps at 4 to bound worker memory (each worker holds its own libgit2
 * repo handle), floor 1. Lives here — NOT in ingest/pool-defaults.ts — because
 * `domains/trajectory` may not import `domains/ingest` (domain-boundaries).
 * Overridable via `TRAJECTORY_GIT_BLAME_POOL_SIZE` (wired by the config schema).
 */
export function defaultBlamePoolSize(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}
```

- [ ] **Step 4: Export the depth threshold from the es-git adapter**

In `src/core/adapters/vcs/git/es-git/adapter.ts`, change the
`BLAME_CLI_MIN_COMMITS` declaration (line 65) to be exported so the provider
partitions on the exact same value:

```ts
/** Commit-count at/above which a file's blame goes to native `git blame`... */
export const BLAME_CLI_MIN_COMMITS = envPositiveInt(
  "TRAJECTORY_GIT_BLAME_CLI_MIN_COMMITS",
  30,
);
```

(Only the `export` keyword is added; the value/behavior are unchanged.)

- [ ] **Step 5: Add `blamePoolSize` to the config type + schema**

In `src/core/contracts/types/config.ts`, add to the `TrajectoryGitConfig`
interface (next to `chunkConcurrency`):

```ts
/** FILE-phase blame worker-pool size (off-main-thread es-git blame). */
blamePoolSize: number;
```

In `src/bootstrap/config/schemas.ts`, import the helper and add the field to
`trajectoryGitSchema` (next to `chunkConcurrency`, line 120):

```ts
import { defaultBlamePoolSize } from "../../core/domains/trajectory/git/infra/churn-walk/blame-pool-defaults.js";
```

```ts
  blamePoolSize: intWithDefault(defaultBlamePoolSize()),
```

In `src/core/domains/trajectory/git/provider.ts`, thread the field through the
provider's own config so standalone/test construction (which does not go through
the bootstrap schema) has a value. Add `"blamePoolSize"` to the
`GitProviderConfig` `Pick<TrajectoryGitConfig, ...>` (line 63-69), import
`defaultBlamePoolSize`, and add to `DEFAULT_PROVIDER_CONFIG` (line 71-79):

```ts
import { defaultBlamePoolSize } from "./infra/churn-walk/blame-pool-defaults.js";
```

```ts
  blamePoolSize: defaultBlamePoolSize(),
```

- [ ] **Step 6: Run the config test**

Run: `npx vitest run tests/bootstrap/config-zod.test.ts` Expected: PASS —
default in [1,4], override `"8"` → `8`.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/trajectory/git/infra/churn-walk/blame-pool-defaults.ts \
        src/core/adapters/vcs/git/es-git/adapter.ts \
        src/core/contracts/types/config.ts \
        src/bootstrap/config/schemas.ts \
        tests/bootstrap/config-zod.test.ts
git commit -m "feat(config): TRAJECTORY_GIT_BLAME_POOL_SIZE knob + export blame depth threshold"
```

---

## Task 3: Provider wiring — partition misses, dispatch shallow to the pool, close at finalize

**Files:**

- Modify: `src/core/domains/trajectory/git/provider.ts`
- Test: `tests/core/domains/trajectory/git/provider.test.ts`

**Interfaces:**

- Consumes: `BlameWorkerPool` (Task 1), `BLAME_CLI_MIN_COMMITS` (Task 2),
  `config.blamePoolSize` (Task 2), existing `resolveHeadOids` /
  `ensureBlameCache` / `blameByChurnData` / `blameByRelPath`.
- Produces: no new external interface — `buildFileSignals` / `streamFileBatch`
  behavior is unchanged (file signals identical), only the blame computation
  moves off-thread.

- [ ] **Step 1: Write the failing partition test**

Extend `tests/core/domains/trajectory/git/provider.test.ts`. The existing suite
mocks `git-cli/client.js` and `chunk-reader.js`; add a `vi.mock` for the blame
pool and assert (a) shallow misses go to the pool, (b) deep misses go to the
main adapter, (c) file signals still populate. Add near the other mocks:

```ts
const blameMock = vi.fn(async () => new Map<string, unknown>());
vi.mock(
  "../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js",
  () => ({
    BlameWorkerPool: vi.fn().mockImplementation(() => ({
      blame: blameMock,
      close: vi.fn().mockResolvedValue(undefined),
    })),
  }),
);
```

And a test that drives `buildFileSignals` with a shallow + a deep file (mock
`file-reader`'s `buildFileSignalMap` to return two `FileChurnData` entries with
`commits.length` 2 and 40), asserting `blameMock` is called with only the
shallow file and the main adapter blame with only the deep one:

```ts
it("routes shallow misses to the blame pool and deep misses to main", async () => {
  vi.mocked(nodeFs.existsSync).mockReturnValue(true);
  const churn = (n: number) =>
    ({
      commits: Array.from({ length: n }, (_, i) => ({
        sha: `s${i}`,
      })) /* ...minimal FileChurnData shape used by the suite... */,
    }) as never;
  vi.mocked(buildFileSignalMap).mockResolvedValue(
    new Map([
      ["shallow.ts", churn(2)],
      ["deep.ts", churn(40)],
    ]),
  );

  await provider.buildFileSignals("/repo");

  // shallow.ts → pool
  expect(blameMock).toHaveBeenCalledTimes(1);
  const [, , files] = blameMock.mock.calls[0];
  expect(files.map((f: { relPath: string }) => f.relPath)).toEqual([
    "shallow.ts",
  ]);
  // deep.ts → main adapter (mocked git-cli blameFile)
  expect(vi.mocked(blameFile)).toHaveBeenCalledWith(
    expect.anything(),
    "deep.ts",
    expect.anything(),
    expect.anything(),
  );
});
```

> Adapt the `churn()` factory + `blameFile` assertion shape to the suite's
> existing mock signatures (the exact `FileChurnData` fields and the
> `git-cli/client.js` `blameFile` arg order the suite already uses). The point
> of the RED test: shallow → pool, deep → main.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/domains/trajectory/git/provider.test.ts`
Expected: FAIL — `blameMock` never called (populateBlameMap still blames inline
on main).

- [ ] **Step 3: Add imports + the pool field + `ensureBlamePool`**

In `src/core/domains/trajectory/git/provider.ts` add imports:

```ts
import { BLAME_CLI_MIN_COMMITS } from "../../../adapters/vcs/git/es-git/adapter.js";
import { BlameWorkerPool } from "./infra/churn-walk/blame-pool.js";
```

Add the field next to the other run-scoped blame state (near line 127):

```ts
  /** FILE-phase off-main-thread blame pool (bd tea-rags-mcp-dog1v). Lazily
   *  spawned on the first shallow miss, closed at the finalize seam. */
  private blamePool?: BlameWorkerPool;
```

Add the lazy accessor (near `ensureBlameCache`):

```ts
  private ensureBlamePool(): BlameWorkerPool {
    this.blamePool ??= new BlameWorkerPool(this.config.blamePoolSize);
    return this.blamePool;
  }
```

- [ ] **Step 4: Rewrite the miss loop in `populateBlameMap`**

Replace lines 418–438 (the `concurrency`/`cursor`/`worker` block and its
`await Promise.all(...)`) with the depth-partitioned dispatch. Everything before
(oid resolve, cache-hit loop) and after (the `onBlameStats` call) stays:

```ts
// Partition cache misses by history depth. Shallow files go to the
// off-main-thread blame pool (sync in-process es-git blame is the event-loop
// stall — real parallelism needs threads, not async fan-out on one thread).
// Deep files stay on main: their blame already routes to the async CLI
// (non-blocking, capped in the adapter), so it never stalled embedding.
const shallowMisses: [string, FileChurnData][] = [];
const deepMisses: [string, FileChurnData][] = [];
for (const entry of missEntries) {
  (entry[1].commits.length >= BLAME_CLI_MIN_COMMITS
    ? deepMisses
    : shallowMisses
  ).push(entry);
}

const recordBlame = (
  relPath: string,
  churnData: FileChurnData,
  lines: BlameLine[],
): void => {
  this.blameByChurnData.set(churnData, lines);
  this.blameByRelPath.set(relPath, lines);
  const oid = oidByPath.get(relPath);
  // Cache only non-empty results: [] can be a transient blame failure.
  if (oid && lines.length > 0) {
    cache.set(relPath, { oid, lines });
    this.blameCacheDirty = true;
  }
};

if (shallowMisses.length > 0) {
  const blameByPath = await this.ensureBlamePool().blame(
    root,
    this.config.vcsAdapter,
    shallowMisses.map(([relPath, churnData]) => ({
      relPath,
      historyDepthHint: churnData.commits.length,
    })),
    this.config.logTimeoutMs,
  );
  for (const [relPath, churnData] of shallowMisses) {
    recordBlame(relPath, churnData, blameByPath.get(relPath) ?? []);
  }
}

if (deepMisses.length > 0) {
  // Deep blame stays on main but is async (CLI child process, capped in the
  // adapter) — keep the same bounded fan-out the inline path used.
  const concurrency = Math.max(this.config.chunkConcurrency, 1);
  let cursor = 0;
  const deepWorker = async (): Promise<void> => {
    while (cursor < deepMisses.length) {
      const [relPath, churnData] = deepMisses[cursor++];
      const lines = await adapter.blameFile(
        relPath,
        this.config.logTimeoutMs,
        churnData.commits.length,
      );
      recordBlame(relPath, churnData, lines);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, deepMisses.length) },
      deepWorker,
    ),
  );
}
```

(`missEntries`, `oidByPath`, `cache`, `adapter`, `hits` remain as they are; the
`options?.onBlameStats?.({ files, hits, misses, durationMs })` call still
follows, with `misses: missEntries.length`.)

- [ ] **Step 5: Close the pool in `finalizeSignals`**

In `finalizeSignals` (lines 265–278), add pool teardown before
`this.vcsAdapters.clear()` (workers hold their own repo handles — close them
with the run):

```ts
await this.blamePool?.close().catch(() => undefined);
this.blamePool = undefined;
```

- [ ] **Step 6: Run the provider test**

Run: `npx vitest run tests/core/domains/trajectory/git/provider.test.ts`
Expected: PASS — shallow → pool (1 call, `["shallow.ts"]`), deep → main adapter
blame.

- [ ] **Step 7: Add the real-git equivalence test (file signals unchanged)**

Add to `tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts`
(it already has a real-git fixture) OR a new real-git provider test: construct
two `new GitEnrichmentProvider()`, force one down the pool path (default) and
compare `streamFileBatch` file-signal blame ownership to a direct inline
`EsGitAdapter.blameFile` oracle for the same files. Assert `blameDominantAuthor`
/ line ownership match. (Mirror the `canonical()` deep-compare from
`churn-walk-thread.test.ts`.)

```ts
it("file-phase blame via the pool equals the inline es-git oracle", async () => {
  const provider = new GitEnrichmentProvider(); // default config → blamePool path
  try {
    const signals = await provider.streamFileBatch(repo, ["a.ts", "b.ts"]);
    const oracle = await VcsAdapterFactory.create("es-git", repo);
    // assemble expected ownership from oracle.blameFile and compare the
    // dominant-author field the provider derived — deep-equal via canonical().
    expect(signals.size).toBe(2);
    // ...compare per-file ownership fields to the oracle blame...
  } finally {
    await provider.finalizeSignals();
  }
}, 30000);
```

Run:
`npm run build && npx vitest run tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts`
Expected: PASS.

- [ ] **Step 8: Full-suite guard + commit**

Run: `npx vitest run tests/core/domains/trajectory/git/` and `npx tsc --noEmit`
Expected: green.

```bash
git add src/core/domains/trajectory/git/provider.ts \
        tests/core/domains/trajectory/git/provider.test.ts \
        tests/core/domains/trajectory/git/infra/churn-walk/blame-pool.test.ts
git commit -m "feat(trajectory): file-phase blame off the main thread via BlameWorkerPool"
```

---

## Task 4: Update the inline-git rationale note in the factory

**Files:**

- Modify: `src/bootstrap/factory.ts:255-266`

- [ ] **Step 1: Rewrite the note**

The comment at factory.ts:255–266 currently justifies keeping the whole git
provider inline ("collection-affinity pinned git to 1 worker... per-batch cost
dominated by walkCommits, not blame"). Update it to record that the FILE-phase
blame now pools off-thread while the provider dispatch stays inline:

```ts
// Git enrichment dispatch stays INLINE (not in the collection-affinity
// ThreadTransport pool — that pinned git to 1 worker, ~4x slower). The one
// main-thread hazard, the SYNC es-git blame of the FILE phase, now runs in
// GitEnrichmentProvider's own BlameWorkerPool (bd tea-rags-mcp-dog1v):
// shallow in-process blames fan out across worker_threads, deep blames stay
// on main's async CLI. The chunk-churn walk is already off-thread (iqpuu).
```

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc --noEmit` Expected: clean (comment-only change).

```bash
git add src/bootstrap/factory.ts
git commit -m "docs(factory): note FILE-phase blame now pools off-thread"
```

---

## Task 5: Live validation (user-gated)

> This task requires a **user-authorized** cold reindex. Do NOT run
> `npm run build && npm link` or `force_reindex` autonomously — build/link is a
> single-worktree-only auto action and reindex is always user-gated (project
> rules). Present the result; wait for "build"/"reindex".

- [ ] **Step 1: Build + link the worktree** (on explicit "build")

```bash
cd .claude/worktrees/vcs-adapter && npm run build && npm link
```

Then ask the user to `/mcp reconnect` and wait.

- [ ] **Step 2: Cold reindex taxdome, timed** (on explicit "reindex")

```bash
tea-rags index-codebase --project taxdome --wait-enrichments --force --json
```

- [ ] **Step 3: Assert the acceptance criteria**
  - Embedding does NOT stall (no multi-minute pause between chunk batches;
    points advance steadily past ~12%).
  - Git enrichment `git.file` + `git.chunk` reach `status: "healthy"`.
  - Wall-clock in the ~15-minute target on a cold run.
  - Peak memory stays bounded (no N×1GB `git blame` storm — deep CLI blame
    capped at 2 on main; workers do in-process only).
  - `get_index_status project=taxdome` → `git` enrichment healthy, ownership
    signals populated (spot-check a few files' `blameDominantAuthor`).

- [ ] **Step 4: On success, close the bead**

```bash
bd close tea-rags-mcp-dog1v --reason "file-phase blame moved off the main thread via BlameWorkerPool; cold taxdome reindex no longer stalls embedding"
```

---

## Self-Review

**Spec coverage** (against the refined spec):

- Off-main-thread blame → Task 1 (`BlameWorkerPool`) + Task 3 (provider
  dispatch). ✓
- Thread pool (Step 0 GREEN) → `worker_threads` in Task 1. ✓
- Hybrid depth routing preserved → main partitions shallow→pool / deep→main-CLI
  (Task 3 Step 4); the worker's own adapter still routes a misclassified file
  (Task 1 `runBlame`). ✓
- Cache stays on main, single-writer → `recordBlame` writes cache on main from
  `oidByPath` (Task 3); no worker cache writes. ✓
- Pool sizing knob → Task 2 (`blamePoolSize`, `TRAJECTORY_GIT_BLAME_POOL_SIZE`).
  ✓
- Walk untouched → confirmed; no `thread.ts` / `walkChunkChurnOffThread` change
  in any task. ✓
- Finalize teardown → Task 3 Step 5. ✓
- Risk #2 (CLI OOM) closed → workers do in-process only; deep CLI capped 2 on
  main. ✓
- Equivalence tests → Task 1 (pool vs oracle), Task 3 (file signals vs oracle).
  ✓
- Factory note → Task 4. ✓

**Placeholder scan:** the two test steps (Task 1 Step 1 throwaway probe line;
Task 3 Step 1/Step 7 "adapt to suite mock shape") are explicitly flagged as
convention-matching, not blanks — the RED intent + assertions are concrete.
Acceptable.

**Type consistency:** `BlameJobInput.files: { relPath, historyDepthHint }[]` is
identical in protocol.ts (Task 1 Step 3), `runBlame` (Step 4),
`BlameWorkerPool.blame` (Step 5), and the provider dispatch (Task 3 Step 4).
`BlameOutcome.blameByPath: Map<string, BlameLine[]>` consistent across worker
response, pool merge, provider consume. `defaultBlamePoolSize()` single source
(Task 2), used by the schema AND `GitProviderConfig`/`DEFAULT_PROVIDER_CONFIG`
(Task 2 Step 5). `BLAME_CLI_MIN_COMMITS` exported once (Task 2 Step 4), imported
once (Task 3 Step 3). `config.blamePoolSize` reaches the provider via
`GitProviderConfig` (Task 2 Step 5) and is read in `ensureBlamePool` (Task 3
Step 3).
