# WorkingTreeOverlay P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (subagent-driven) to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** Every read tool answers for the working tree the caller stands in —
addressed by `path=<cwd>` alone — and says which tree it read and how far that
tree is from the index, without writing to the shared index.

**Architecture:** `resolveWorkingTree` maps the request to a `WorkingTree` (tree
root + the same-repository base index). A `WorkingTreeOverlay` service builds a
per-request `WorkingTreeView`: the `WorkingTreeDelta` of the tree against the
index's `indexedCommit`, a `WorkingTreeChunkLayer` that chunks delta files with
the production chunker, and the `WorkingTreeMarker` every answer carries.
Strategies substitute delta chunks for base chunks of delta files where they
have a floor (find_symbol: chunks, hybrid_search: sparse) and flag base rows
with `treeState` where they do not.

**Tech Stack:** TypeScript, vitest, Qdrant, tree-sitter chunker worker pool
(`ChunkerPool`), git CLI.

**Spec:** `docs/superpowers/specs/2026-10-02-working-tree-overlay-design.md`

## Global Constraints

- Names are `WorkingTree*`-qualified; never a bare `Overlay`, `Delta`, `Layer`,
  `View`, `Marker` (`RankingOverlay` already owns "overlay").
- The shared index is read-only to this feature. No code path writes points,
  payload, or registry fields.
- Every read answer carries `workingTree`. `changedFiles: 0` means measured;
  anything unmeasured carries `degraded { reason, remedy }`.
- One chunker, one id scheme: delta chunks come from `ChunkerPool#processFile`
  and `generateChunkId`; payload shaped by the same builder ingest uses.
- Real git in tests: repositories and `git worktree add` in a temp dir. No git
  mocks for delta logic.
- `resolveCollection` keeps its signature and behaviour.
- Existing business-logic tests are immutable. A changed expectation is an
  intended invariant change and the commit says which.
- TDD: red first, every task.
- Deep-silo files (`collection-resolver.ts`, `naming-lexicon-ops.ts`,
  `git-cli/client.ts`, `diff-scope-reader.ts`, `review-changes-ops.ts`): commit
  body carries a `Why:` line.
- Commits: `.claude/rules/commit-rules.md` types/scopes, header ≤ 100 chars,
  footer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Chunker-forking tests need `npm run build` once in the worktree (worker is
  forked from `build/`). Never `npm link` from a task; reindex is user-gated.
- Per-task gate: targeted `npx vitest run <files>`, `npx tsc --noEmit`,
  `npx eslint <touched files>`. `npm run test:coverage` runs once, on main, in
  Task 9.

## Shared types (introduced across tasks — names are binding)

```ts
// src/core/api/internal/collection-resolver.ts (Task 1)
export interface WorkingTree {
  /** realpath of the tree the caller stands in (git toplevel, not a subdir) */
  root: string;
  /** lower layer the tree is read against */
  baseIndex: { collectionName: string; root: string | undefined };
}
export function resolveWorkingTree(
  registry: CollectionRegistry,
  input: ResolveInput,
): WorkingTree;

// src/core/api/public/dto/working-tree.ts (Task 4)
export type WorkingTreeFloor = "chunks" | "sparse";
export interface WorkingTreeMarker {
  tree: string;
  indexedCommit: string | null;
  treeCommit: string | null;
  indexedDirty: boolean;
  changedFiles: number;
  deletedFiles: number;
  floors: WorkingTreeFloor[];
  degraded?: { reason: string; remedy: string };
}
export type WorkingTreeState = "modified" | "deleted";

// src/core/domains/explore/working-tree/delta.ts (Task 3)
export interface WorkingTreeDelta {
  changed: readonly string[]; // repo-relative, includes untracked and rename targets
  deleted: readonly string[]; // repo-relative, includes rename sources
  fingerprint: string;
}
export type WorkingTreeDeltaRead =
  | { kind: "measured"; delta: WorkingTreeDelta }
  | { kind: "degraded"; reason: string; remedy: string };

// src/core/domains/explore/working-tree/overlay.ts (Task 4, extended in 5)
export interface WorkingTreeView {
  marker: WorkingTreeMarker;
  /** changed ∪ deleted; empty when degraded (nothing substituted, nothing hidden) */
  touchedPaths: ReadonlySet<string>;
  deletedPaths: ReadonlySet<string>;
  /** delta chunks in ScrollChunk shape; undefined until Task 5 wires the layer */
  readDeltaChunks?: () => Promise<readonly ScrollChunk[]>;
}

// src/core/domains/explore/strategies/types.ts (Task 6)
// ExploreContext gains: workingTreeView?: WorkingTreeView
```

---

### Task 1: `resolveWorkingTree` — path=cwd addresses the tree and its same-repo index

**Bead:** tea-rags-mcp-xi2r9.1 (part a)

**Files:**

- Modify: `src/core/api/internal/collection-resolver.ts` (additive:
  `WorkingTree`, `resolveWorkingTree`, `findWorkingTreeRoot`)
- Create: `tests/core/__helpers__/git-working-tree-fixture.ts` — reuse first:
  read `tests/core/api/internal/ops/diff-scope-reader.test.ts` and
  `tests/core/domains/maintenance/worktree-seed-source.test.ts`. If one already
  builds a repo + `git worktree add`, lift that code into the helper; do not
  edit those tests' assertions.
- Test: `tests/core/api/internal/collection-resolver-working-tree.test.ts`

**Interfaces:**

- Consumes: `resolveGitCommonDir`, `listRepoWorkTrees`
  (`src/core/adapters/vcs/git/common-dir.ts`); `CollectionRegistry#findByName`,
  `#findByPath`, `#list`, `#get`; `InvalidParameterError`,
  `CollectionNotProvidedError` (`src/core/api/errors.ts`).
- Produces: `WorkingTree`, `resolveWorkingTree`, `findWorkingTreeRoot`, and:

```ts
// tests/core/__helpers__/git-working-tree-fixture.ts
export interface GitWorkingTreeFixture {
  mainRoot: string; // realpath of the main checkout
  addWorktree: (name: string) => string; // git worktree add -b wt-<name>; returns realpath
  commit: (
    root: string,
    files: Record<string, string>,
    message?: string,
  ) => string; // sha
  git: (root: string, ...args: string[]) => string;
  cleanup: () => void;
}
export function createGitWorkingTreeFixture(): GitWorkingTreeFixture;
```

- [ ] **Step 1: Failing tests** — one `it` per rule, real git via the fixture,
      registry stub built like the existing `resolveCollection` tests (find:
      `rg -l "resolveCollection" tests`):
  1. `path` = linked worktree, registry holds only the main entry →
     `{ root: <wt>, baseIndex: { collectionName: <main>, root: <main> } }`.
  2. `path` = `<wt>/src` → `root` is the worktree toplevel.
  3. `path` = a registered worktree (clone entry) → that entry wins over main.
  4. two non-main entries of one repo, none at main, path unregistered →
     `InvalidParameterError` whose message lists both aliases.
  5. two entries, one at main → main.
  6. `path` in an unrelated, unregistered repo → `baseIndex.collectionName`
     equals `resolveCollection(registry, { path }).collectionName` (hash
     fallback kept).
  7. `project` + `path` of another repository → `InvalidParameterError` on
     `path`.
  8. `project` alone → `root === entry.path`.
  9. `collection` + `path` → `baseIndex.collectionName === collection`, `root` =
     path toplevel.
- [ ] **Step 2: Run**
      `npx vitest run tests/core/api/internal/collection-resolver-working-tree.test.ts`
      — FAIL (`resolveWorkingTree` not exported).
- [ ] **Step 3: Implement**

```ts
export interface WorkingTree {
  root: string;
  baseIndex: { collectionName: string; root: string | undefined };
}

/** Nearest ancestor (inclusive) holding `.git` — the tree's toplevel. Filesystem only. */
export function findWorkingTreeRoot(path: string): string | undefined {
  let dir = realpathSync(resolve(path));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveWorkingTree(
  registry: CollectionRegistry,
  input: ResolveInput,
): WorkingTree {
  if (input.collection !== undefined || input.project !== undefined) {
    const resolved = resolveCollection(registry, input);
    const indexRoot =
      input.project !== undefined
        ? resolved.path
        : registry.get?.(resolved.collectionName)?.path;
    const root =
      input.path === undefined
        ? indexRoot
        : requireSameRepositoryTree(input, indexRoot);
    return {
      root: root ?? "",
      baseIndex: { collectionName: resolved.collectionName, root: indexRoot },
    };
  }
  if (input.path === undefined) throw new CollectionNotProvidedError();
  const treeRoot =
    findWorkingTreeRoot(input.path) ?? validatePathSync(input.path);
  const entry =
    registry.findByPath?.(treeRoot) ??
    selectSameRepositoryEntry(registry, treeRoot);
  if (entry)
    return {
      root: treeRoot,
      baseIndex: { collectionName: entry.collectionName, root: entry.path },
    };
  const resolved = resolveCollection(registry, { path: input.path });
  return {
    root: treeRoot,
    baseIndex: { collectionName: resolved.collectionName, root: resolved.path },
  };
}
```

`requireSameRepositoryTree` throws
`InvalidParameterError("path", "'<path>' is not a checkout of <project|collection> (<indexRoot>)")`
when `resolveGitCommonDir` differs, else returns `findWorkingTreeRoot(path)`.
`selectSameRepositoryEntry` filters `registry.list()` by
`commonDirOf(entry.path) === resolveGitCommonDir(treeRoot)` (`commonDirOf`
memoised in a module `Map<string, string>`), prefers the entry whose realpath
equals `dirname(commonDir)` when `basename(commonDir) === ".git"`
(`listRepoWorkTrees` sorts alphabetically, so its `[0]` is not the main
checkout), then a single candidate, else throws
`InvalidParameterError("path", "'<treeRoot>' belongs to a repository indexed under several projects: <a>, <b> — pass project=<alias>")`.
Entries with an empty `path` (recoverFromQdrant stubs) are skipped. Confirm the
real `CollectionRegistry` method shapes in
`src/core/domains/maintenance/registry/collection-registry.ts` first.

- [ ] **Step 4: Run** the test — PASS; `npx tsc --noEmit`; eslint on touched
      files;
      `npx vitest related src/core/api/internal/collection-resolver.ts --run`
      green.
- [ ] **Step 5: Commit**
      `feat(api): resolveWorkingTree maps path=cwd to the tree and its same-repo index (xi2r9.1)`
      with body line
      `Why: one MCP server serves every subagent; only the agent knows its tree, so its working directory alone must address both tree and index.`

---

### Task 2: One addressing rule — `review_changes` and `get_naming_lexicon` move to `resolveWorkingTree`

**Bead:** tea-rags-mcp-xi2r9.1 (part b)

**Files:**

- Modify: `src/core/api/internal/ops/review-changes-ops.ts`,
  `src/core/api/internal/ops/naming-lexicon-ops.ts`,
  `src/core/api/internal/ops/diff-scope-reader.ts` (delete `resolveWorkTree`)
- Test: `tests/core/api/internal/ops/diff-scope-reader.test.ts`,
  `tests/core/api/internal/ops/naming-lexicon-diff.test.ts`, review-changes ops
  tests (find: `rg -l "ReviewChangesOps" tests`)

**Interfaces:** Consumes `resolveWorkingTree` (Task 1). Produces nothing new;
`resolveWorkTree` is gone.

- [ ] **Step 1: Failing test** — review-changes ops: `path` alone pointing at a
      linked worktree of a registered project (no `project`) reviews that
      worktree (`workTree` in the answer equals the worktree realpath). Today it
      hashes to an unregistered collection.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — both ops call `resolveWorkingTree` once; index
      reads use `.baseIndex.collectionName`, git reads use `.root`. Existing
      `resolveWorkTree` tests are ported verbatim (same inputs, same expected
      tree) to call `resolveWorkingTree(...).root` — no expectation changes.
- [ ] **Step 4: Run** the three test files + `npx vitest related` on the three
      sources — PASS; tsc; eslint.
- [ ] **Step 5: Commit**
      `refactor(api): review_changes and naming lexicon resolve the tree via resolveWorkingTree (xi2r9.1)`
      — `Why:` line; note the intended invariant change "path alone now reaches
      a linked worktree of a registered project".

---

### Task 3: `WorkingTreeDelta` — changed and deleted files against the indexed commit

**Bead:** tea-rags-mcp-xi2r9.2

**Files:**

- Modify: `src/core/domains/ingest/pipeline/scanner.ts` — public
  `FileScanner#accepts(relativePath)`; `walkDirectory` calls it (one rule).
- Modify: `src/core/adapters/vcs/git/git-cli/client.ts` — additive
  `readWorkingTreeChanges`, `readStatusPorcelain`; `listChangedFiles` untouched.
- Create: `src/core/domains/explore/working-tree/delta.ts`,
  `src/core/domains/explore/working-tree/index.ts`
- Test: `tests/core/domains/ingest/pipeline/scanner-accepts.test.ts`,
  `tests/core/domains/explore/working-tree/delta.test.ts`

**Interfaces:**

```ts
// git-cli/client.ts
export interface WorkingTreeNameStatus {
  changed: string[];
  deleted: string[];
}
/** `git diff --name-status --no-renames <commit>` + `git ls-files --others --exclude-standard`. Throws on an unknown commit. */
export async function readWorkingTreeChanges(
  root: string,
  commit: string,
  timeoutMs?: number,
): Promise<WorkingTreeNameStatus>;
export async function readStatusPorcelain(
  root: string,
  timeoutMs?: number,
): Promise<string>;

// working-tree/delta.ts
export const WORKING_TREE_DELTA_FILE_CAP = 200;
export interface WorkingTreeDeltaReader {
  read(
    root: string,
    indexedCommit: string | null,
    accepts: (relativePath: string) => boolean,
  ): Promise<WorkingTreeDeltaRead>;
}
export function createWorkingTreeDeltaReader(): WorkingTreeDeltaReader;
```

Degraded reasons (tests assert the exact strings); remedies carry `{alias}` /
`{tree}` tokens the overlay fills in Task 4:

| Reason                                            | Remedy template                                                |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `index has no indexedCommit stamp`                | `tea-rags index-codebase --project {alias}`                    |
| `indexed commit <sha7> is not in this repository` | `tea-rags index-codebase --project {alias}`                    |
| `delta of <n> files over the 200-file cap`        | `tea-rags worktree create <name> --from {alias} --path {tree}` |

- [ ] **Step 1: Failing tests** — scanner: `.ts` accepted; `.png` rejected;
      `node_modules/x.ts` rejected; a file under a `.contextignore`d `dir/`
      rejected; a `.gitignore`d file rejected. Delta (fixture; index = commit A
      on main; tree = linked worktree): clean at A → measured, empty; modified
      and committed on the branch; staged-only; unstaged-only; untracked;
      deleted; renamed via `git mv` (source in `deleted`, target in `changed`);
      ignored file absent; tree at commit B the index never saw; unknown commit
      → degraded; null commit → degraded; 201 untracked files → degraded cap; a
      second `read` with nothing changed does not call `readWorkingTreeChanges`
      (`vi.spyOn` on the module — spy, never stub results); re-editing an
      already-modified file invalidates the cache.
- [ ] **Step 2: Run** both — FAIL.
- [ ] **Step 3: Implement** — fingerprint = sha1 of `HEAD sha` + status
      porcelain + sorted `path:mtimeMs:size` of changed paths; cache
      `Map<root, {fingerprint, read}>`; clean status with HEAD === indexedCommit
      returns measured-empty without the diff spawn.
- [ ] **Step 4: Run** — PASS. Measure: 20 cached and 20 cold `read` calls on
      this worktree, median ms each, recorded for the commit. tsc; eslint.
- [ ] **Step 5: Commit**
      `feat(explore): WorkingTreeDelta reads a tree's changes against the indexed commit (xi2r9.2)`
      — `Why:` line (git-cli client is deep-silo) +
      `clean tree: <x> ms cached / <y> ms cold on tea-rags`.

---

### Task 4: `WorkingTreeMarker` on every read answer

**Bead:** tea-rags-mcp-xi2r9.1 (part c)

**Files:**

- Create: `src/core/api/public/dto/working-tree.ts` (exported from
  `dto/index.ts`), `src/core/domains/explore/working-tree/overlay.ts`
- Modify: `src/core/api/internal/ops/explore-ops.ts` (`resolveAndGuard`,
  `executeExplore`, inline resolutions in `searchCode` / `getIndexMetrics`),
  `src/core/api/internal/facades/explore-facade.ts` (deps),
  `src/core/api/internal/facades/graph-facade.ts` (`withReadHandle`),
  `src/core/api/internal/ops/trace-path-ops.ts`,
  `src/core/api/public/dto/explore.ts`, `src/core/api/public/dto/graph.ts`
  (optional `workingTree`), `src/bootstrap/factory.ts` (construct the overlay),
  `src/mcp/tools/explore.ts`, `src/mcp/tools/codegraph.ts`,
  `src/mcp/tools/code/register-search-tools.ts` (render the marker; `path`
  describe text — follow `.claude/skills/mcp-schema-authoring/SKILL.md`)
- Test: `tests/core/domains/explore/working-tree/overlay.test.ts`; additions to
  the existing explore-ops, graph-facade, trace-path tests; the tools/list size
  test (find: `rg -l "tools/list" tests`).

**Interfaces:**

```ts
export class WorkingTreeOverlay {
  constructor(deps: {
    registry: CollectionRegistry;
    deltaReader: WorkingTreeDeltaReader;
    createFileFilter: (
      root: string,
    ) => Promise<(relativePath: string) => boolean>;
  });
  /** Never throws for git trouble: a failure becomes marker.degraded. */
  view(tree: WorkingTree, alias: string | undefined): Promise<WorkingTreeView>;
}
```

`floors` is `[]` here; Tasks 6–7 pass floors through a new
`ExploreFinalizeOptions.workingTreeFloors`. Graph tools always `[]`.
`indexedCommit` / `indexedDirty` come from `registry.get(collectionName)?.git`,
`treeCommit` from `readRepoGitState(tree.root)?.commit`.

Text render (one line, next to where `driftWarning` is rendered):
`workingTree: <tree> · index @<sha7> · tree @<sha7> · changed <n> · deleted <m> · floors <list|none>`
plus ` · degraded: <reason> → <remedy>` when set.

`path` describe text on every read tool (must fit the tools/list budget):
`"Your working directory (any dir inside the checkout). Addresses the TREE; the index resolves from the same repository. Prefer over project in worktrees."`

- [ ] **Step 1: Failing tests** — overlay: clean → `changedFiles 0`,
      `floors []`, no `degraded`; modified → counts; no stamp → `degraded` with
      alias filled; delta reader throwing → `degraded`, no throw. explore-ops:
      `find_symbol`, `semantic_search`, `rank_chunks`, `hybrid_search`,
      `find_similar` answers carry `workingTree`, including empty results,
      `metaOnly`, `fields` projection. Graph: `get_callers`, `get_callees`,
      `find_cycles`, `trace_path` carry `workingTree` with `floors: []`,
      including the `fallback` branch of `withReadHandle`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `resolveAndGuard` keeps its guard and returns
      `{ collectionName, path, workingTree }`; the drift check keeps the INDEX
      root path. `executeExplore` receives the view and writes
      `workingTree: view.marker` beside `driftWarning`.
- [ ] **Step 4: Run** targeted files + `npx vitest related` on every modified
      source — PASS; tools/list size test (re-pin only if the test documents
      that intended schema changes re-pin it; record old → new bytes); tsc;
      eslint.
- [ ] **Step 5: Commit**
      `feat(mcp): every read answer carries the workingTree marker (xi2r9.1)` —
      body `tools/list: codegraph ON a -> b bytes, OFF c -> d`.

---

### Task 5: `WorkingTreeChunkLayer` — delta files through the production chunker

**Bead:** tea-rags-mcp-xi2r9.3 (part a)

**Files:**

- Modify: `src/core/domains/ingest/pipeline/file-ingestor.ts` and
  `src/core/domains/ingest/pipeline/chunk-pipeline.ts` — extract the inline
  CodeChunk → point-payload shaping (the `baseChunk` literal in `FileIngestor`
  and the payload assembly `chunk-pipeline` does before upsert) into one
  exported function, behaviour unchanged. Name it for what it returns:
  `buildChunkPointPayload(chunk, ctx)` in
  `src/core/domains/ingest/pipeline/chunk-point-payload.ts`. Ingest calls it;
  the overlay calls it. Read `src/core/domains/ingest/pipeline/CLAUDE.md` and
  `domains/ingest/pipeline/enrichment/CLAUDE.md` first (payload-key ownership).
- Create: `src/core/domains/explore/working-tree/chunk-layer.ts`
- Modify: `src/bootstrap/factory.ts` — lazy `ChunkerPool` factory for the layer
  (size 1, idle shutdown 60 s, `languageModulePath` injected exactly as ingest's
  `BaseIndexPipeline#createChunkerPool` does), shut down on server dispose.
- Test: `tests/core/domains/ingest/pipeline/chunk-point-payload.test.ts`,
  `tests/core/domains/explore/working-tree/chunk-layer.test.ts`

**Interfaces:**

```ts
export interface WorkingTreeChunkLayer {
  /** ScrollChunk rows for the given tree files, exactly as ingest would store them (minus git/codegraph payload). */
  chunk(
    tree: string,
    relativePaths: readonly string[],
    config: ChunkerConfig,
  ): Promise<readonly ScrollChunk[]>;
  dispose(): Promise<void>;
}
export function createWorkingTreeChunkLayer(deps: {
  createPool: (config: ChunkerConfig) => ChunkerPool;
  idleShutdownMs?: number; // default 60_000
}): WorkingTreeChunkLayer;
```

Chunker config for a collection: the registry entry's env snapshot
(`INGEST_CHUNK_SIZE`, `INGEST_CHUNK_OVERLAP`, … — find how
`domains/maintenance/registry` replays env, see its `CLAUDE.md` "env replay")
when present, else the server's ingest config. `WorkingTreeOverlay#view` sets
`readDeltaChunks` to call the layer for `delta.changed` (deleted files have no
chunks).

- [ ] **Step 1: Failing tests** — payload: for one TS fixture file,
      `buildChunkPointPayload` output equals what the ingest path produced
      before the extraction (capture the old literal's output in the test from a
      `FileIngestor` run against an in-memory chunk pipeline — follow the
      existing file-ingestor tests). Layer: (a) parity — chunk ids from the
      layer equal `generateChunkId` over `ChunkerPool#processFile` output for
      the same content, and payload equals `buildChunkPointPayload`; (b) cache —
      second call for unchanged content does not call `processFile` (spy);
      edited content does; (c) the pool is not created until the first non-empty
      call; (d) idle shutdown after `idleShutdownMs` (fake timers) and recreated
      on next call; (e) a file that fails to parse yields no rows and does not
      throw; the overlay lists it in a new optional `marker.unparsed: string[]`
      (added to `WorkingTreeMarker` in this task) — the whole answer is not
      degraded by one bad file.
- [ ] **Step 2: Run** (`npm run build` first if `build/` is stale — the pool
      forks the compiled worker) — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `npx vitest related` on file-ingestor / chunk-pipeline
      (ingest behaviour unchanged) — PASS; tsc; eslint.
- [ ] **Step 5: Commit** two commits:
      `refactor(pipeline): extract buildChunkPointPayload from the ingest path (xi2r9.3)`
      then
      `feat(explore): WorkingTreeChunkLayer chunks delta files with the production chunker (xi2r9.3)`.

---

### Task 5b: `WorkingTreeChunkStore` — persistent delta-chunk cache with 96 h retention

**Bead:** tea-rags-mcp-xi2r9.3 (part c)

**Files:**

- Create: `src/core/domains/explore/working-tree/chunk-store.ts`
- Modify: `src/core/domains/explore/working-tree/chunk-layer.ts` (memory cache
  in front of the store), `src/core/adapters/vcs/git/git-cli/client.ts`
  (additive `readBlobCommitTime`), `src/bootstrap/factory.ts` (store under the
  data dir; sweep at start + every 6 h, `timer.unref()`; stop on dispose)
- Test: `tests/core/domains/explore/working-tree/chunk-store.test.ts`

**Interfaces:**

```ts
// git-cli/client.ts — `git log -1 --format=%ct --find-object=<blobId> HEAD -- <relativePath>`
export async function readBlobCommitTime(
  root: string,
  relativePath: string,
  blobId: string,
): Promise<number | null>; // epoch ms, null = uncommitted

export interface WorkingTreeChunkStoreEntry {
  relativePath: string;
  contentSha256: string;
  blobId: string; // git hash-object id of the content
  treeRoot: string;
  rows: readonly ScrollChunk[];
  lastReadAt: number;
}
export interface WorkingTreeChunkStore {
  get(
    collectionName: string,
    relativePath: string,
    contentSha256: string,
  ): Promise<WorkingTreeChunkStoreEntry | undefined>; // bumps lastReadAt
  put(
    collectionName: string,
    entry: Omit<WorkingTreeChunkStoreEntry, "lastReadAt">,
  ): Promise<void>;
  sweep(
    now?: number,
  ): Promise<{ evicted: number; kept: number; bytes: number }>;
}
export const WORKING_TREE_CHUNK_RETENTION_MS = 96 * 3600_000;
export const WORKING_TREE_CHUNK_STORE_CAP_BYTES = 512 * 1024 * 1024;
export function createWorkingTreeChunkStore(deps: {
  rootDir: string; // <dataDir>/working-tree
  readBlobCommitTime?: typeof readBlobCommitTime;
  now?: () => number;
}): WorkingTreeChunkStore;
```

Find the data-dir helper the other `~/.tea-rags/*` stores use (e.g. how
`snapshots/` or `git-blame/` resolve their root) and use it — no hard-coded home
path. Writes are atomic (temp file + rename), as the registry does.

- [ ] **Step 1: Failing tests** (real git fixture for commit detection, `now`
      injected): put/get round-trip; `get` bumps `lastReadAt`; sweep evicts an
      entry whose `treeRoot` was removed (`git worktree remove`) regardless of
      age; committed content idle 95 h → kept, 97 h → evicted, measured from
      `max(commitTime, lastReadAt)` (a read at 90 h after commit keeps it until
      186 h); uncommitted content of a live tree idle 1000 h → kept; store over
      cap → least-recently-read evicted until under cap; sweep never touches
      files outside `rootDir` (assert directory listing of a sibling dir
      unchanged); layer: a second layer instance (fresh process memory) over the
      same store does not call `processFile` for unchanged content.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `npx vitest related` on chunk-layer and factory — PASS;
      tsc; eslint.
- [ ] **Step 5: Commit**
      `feat(explore): persistent working-tree chunk cache with 96h post-commit retention (xi2r9.3)`
      — `Why:` line (git-cli client is deep-silo).

---

### Task 6: Chunk floor — `find_symbol` sees the tree; other tools flag stale rows

**Bead:** tea-rags-mcp-xi2r9.3 (part b)

**Files:**

- Modify: `src/core/domains/explore/strategies/types.ts`
  (`ExploreContext.workingTreeView?: WorkingTreeView`),
  `src/core/domains/explore/strategies/symbol.ts`,
  `src/core/domains/explore/strategies/file-outline.ts`,
  `src/core/domains/explore/strategies/base.ts` (shared `treeState` stamping for
  strategies without a floor — no duplication across vector / scroll-rank /
  similar), `src/core/api/internal/ops/explore-ops.ts` (put the view on ctx;
  pass `workingTreeFloors: ["chunks"]` for find_symbol)
- Test: `tests/core/domains/explore/strategies/symbol-working-tree.test.ts`,
  `tests/core/domains/explore/strategies/file-outline-working-tree.test.ts`,
  `tests/core/domains/explore/strategies/tree-state.test.ts`

Read `src/core/domains/explore/CLAUDE.md` and `strategies/CLAUDE.md` first and
keep their per-strategy contracts.

**Interfaces:** Consumes `WorkingTreeView` (Tasks 4–5). Produces the
substitution rule, implemented once in
`src/core/domains/explore/working-tree/substitute.ts`:

```ts
/** Drop rows of touched files, add delta rows passing `keep`. Pure. */
export function substituteWorkingTreeRows(
  scrolled: readonly ScrollChunk[],
  view: WorkingTreeView,
  deltaRows: readonly ScrollChunk[],
  keep: (row: ScrollChunk) => boolean,
): ScrollChunk[];
```

`SymbolSearchStrategy#executeExplore` applies it to `scrolled` before the
pathPattern / exact-symbol filters with `keep` = the same symbolId /
parentSymbolId / language predicate the two Qdrant scrolls apply (implement the
predicate next to the scroll filter builder so the two cannot drift).
`FileOutlineStrategy#executeExplore` applies it to `scrolled` with `keep` =
exact `relativePath` (+ language). A deleted file's outline is empty and the
answer carries the marker. Rows from `view.touchedPaths` in vector / hybrid
(until Task 7) / scroll-rank / similar results get `treeState` (`"deleted"` when
in `deletedPaths`, else `"modified"`) on the result, not inside payload.

- [ ] **Step 1: Failing tests** — with a fake `WorkingTreeView` (pure strategy
      tests; real git is covered by Task 3 and the Task 9 live run): method
      renamed in the tree → old symbol not found, new symbol found with the
      tree's body; method added in an untracked file → found; file deleted → its
      symbols not found, outline empty; `#partN` delta rows reassemble through
      `resolveSymbols` like base rows; relativePath outline of a modified file
      lists the tree's members; semantic / rank_chunks rows of a modified file
      carry `treeState: "modified"`, of a deleted file `"deleted"`; view with
      `touchedPaths` empty changes nothing (byte-equal results).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `npx vitest related` on each modified strategy — PASS;
      tsc; eslint.
- [ ] **Step 5: Commit**
      `feat(explore): find_symbol answers for the working tree; stale rows carry treeState (xi2r9.3)`.

---

### Task 7: Sparse floor — `hybrid_search` finds what only the tree contains

**Bead:** tea-rags-mcp-xi2r9.4

**Files:**

- Modify: `src/core/domains/explore/strategies/hybrid.ts`,
  `src/core/api/internal/ops/explore-ops.ts`
  (`workingTreeFloors: ["chunks", "sparse"]` for hybrid)
- Test: `tests/core/domains/explore/strategies/hybrid-working-tree.test.ts`

**Interfaces:** Consumes `WorkingTreeView.readDeltaChunks`,
`generateSparseVector` / `BM25SparseVectorGenerator`
(`src/core/adapters/qdrant/sparse.ts` — use the generator ingest uses for chunk
documents; confirm in `chunk-pipeline.ts`), `buildSymbolIdentityFilter` /
`isSymbolIdentifierQuery` (`strategies/symbol-identity-leg.ts`).

Rule:

1. The Qdrant request gets a `must_not` on `relativePath` ∈ `touchedPaths`
   (merged into `ctx.filter`, same shape `fetchPathPatternMatches` expects).
2. Delta chunks are scored locally: sparse dot product of the query sparse
   vector with each chunk's BM25 vector → local rank; identity leg: a delta
   chunk whose `symbolId` matches the identity filter predicate is identity rank
   1..n. Each delta chunk's fused score = Σ over its legs of `1 / (k + rank)`
   with the SAME `k` Qdrant's server-side RRF uses (find it: the `fusion` /
   `rrf` params in `src/core/adapters/qdrant/client.ts#hybridSearch`; Qdrant's
   default if unset — cite the source in a comment).
3. Merge base results and scored delta chunks by score, cut to `limit`, then
   `FileLevelGrouper.group` for `level: "file"` as today.

- [ ] **Step 1: Failing tests** — fake qdrant returning fixed base results +
      fake view: an identifier present only in a delta chunk is in the top
      `limit`; an identifier present only in a base row of a touched file is not
      returned; base rows of untouched files keep their order; level `file`
      groups delta rows with base rows; empty `touchedPaths` → request and
      result identical to today (assert the exact `hybridSearch` call args).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** +
      `npx vitest related src/core/domains/explore/strategies/hybrid.ts --run` —
      PASS; tsc; eslint.
- [ ] **Step 5: Commit**
      `feat(hybrid): BM25 over working-tree delta chunks fused into hybrid_search (xi2r9.4)`.

---

### Task 8: Plugin — the subagent passes its own working directory; eval cases

**Bead:** tea-rags-mcp-xi2r9.8

**Files:**

- Modify: `.claude-plugin/tea-rags/scripts/enforce-tearags-search.sh`,
  `.claude-plugin/tea-rags/rules/search-cascade.md`,
  `.claude-plugin/tea-rags/rules/references/subagent-injection.md` (confirm
  path), `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (minor bump)
- Create: `.claude-plugin/.benchmarks/working-tree-injection/evals.json`,
  `.claude-plugin/.benchmarks/working-tree-injection/benchmark.md` (model both
  on `.claude-plugin/.benchmarks/dinopowers-chaining-rule/`)
- Test: any test pinning plugin text (find:
  `rg -l "enforce-tearags-search|search-cascade" tests scripts`)

Read `.claude/rules/plugin-guidance-layers.md` (which layer owns what) and
`.claude/skills/optimize-skill/SKILL.md` (eval cycle) first.

Injection block changes:

- Drop `PROJECT_PATH="${CLAUDE_PROJECT_DIR:-$(pwd)}"` and every
  `path=$PROJECT_PATH` in the block.
- Add, at the top of the block:
  `**Address tea-rags with YOUR working directory:** pass path=<your working directory> on every tea-rags call (no project needed — the index resolves from the same repository). Each answer's workingTree.tree names the tree it read; changed/deleted counts say how far it is from the index.`
- Bash channel, explicit:
  `grep/rg for an identifier → find_symbol (definition) or hybrid_search with metaOnly:true or fields (usages)`;
  `sed -n / cat / head to understand code → find_symbol (symbol or relativePath)`;
  `grep stays right for: regex patterns, literal phrases, comments/TODO, filtering command output`.

Eval cases (≥ 6; each with prompt, cwd context, expected first tool call
assertions): worktree subagent asked "where is X defined" → `find_symbol` with
`path` = its worktree; "all usages of Y" → `hybrid_search` with `path` and
`metaOnly`/`fields`; "find TODOs" → ripgrep/grep allowed; "regex over error
messages" → grep allowed; "understand file Z" → `find_symbol(relativePath)`, not
`cat`; main-checkout session → `path` = project dir (still valid). Run the
optimize-skill eval cycle to 100% pass; record the pass table in `benchmark.md`.

- [ ] **Step 1:** write `evals.json`, run the eval cycle against the CURRENT
      block — record the baseline (expected failures on the `path` assertions).
- [ ] **Step 2:** edit the block, rules and reference doc.
- [ ] **Step 3:** rerun the eval cycle until 100%; plugin-text tests green.
- [ ] **Step 4: Commit**
      `feat(mcp): subagent injection addresses tea-rags by its own working directory (xi2r9.8)`
      — body carries the eval baseline → final pass rates and the plugin
      version.

---

### Task 9: Integration gate, live validation, merge

**Beads:** close xi2r9.1–.4, .8 on evidence; xi2r9.9 stays open (transcript
audit after a real subagent wave).

- [ ] **Step 1:** `npm run build`; `npx tsc --noEmit`; `npx eslint src`;
      targeted suites of Tasks 1–8 together.
- [ ] **Step 2 (USER-GATED — ask, state exactly what runs):**
      `npm run build && npm link`, user reconnects MCP. In this worktree make
      one uncommitted edit to an indexed TS method and add one untracked TS
      file, then: `find_symbol(path=<worktree>, symbol=<edited method>)` returns
      the tree body; `find_symbol(path=<worktree>, symbol=<new fn>)` found;
      `hybrid_search(path=<worktree>, query=<identifier only in the new file>)`
      finds it; `semantic_search(path=<worktree>)` rows of the edited file carry
      `treeState`; every answer's `workingTree` names the worktree with
      `changed 2`; `find_symbol(project=tea-rags)` (main) is unaffected; a
      second worktree (`git worktree list`) addressed by its path reports its
      own tree. Revert the edit → `changedFiles 0`; record cold and warm latency
      of a clean `find_symbol`.
- [ ] **Step 3:** merge per project convention — leave the worktree
      (`ExitWorktree keep`), fast-forward / `--no-ff` merge into local `main`
      from the main checkout, `npm install` there, `npm run test:coverage` once
      on main; failures land as separate fix commits. Do not relink main. Do not
      push.
- [ ] **Step 4:** settle beads per `.claude/rules/worktree-beads-lifecycle.md`
      with the live numbers in each close reason; then remove the worktree.
