# WorkingTreeOverlay — unbounded delta design

Follow-up to `2026-10-02-working-tree-overlay-design.md` (epic
tea-rags-mcp-xi2r9, closed). Supersedes its "Cap" paragraph under
`WorkingTreeDelta` and the clone-mode guidance built on it.

## Problem

`WORKING_TREE_DELTA_FILE_CAP = 200` turns any tree more than 200 files from the
index into a `degraded` answer with no floors. WTO-9 hit it on the first wave:
Claude Code's default `worktree.baseRef: "fresh"` branches agent worktrees from
`origin/main`, which in a no-push workflow sat 169 commits (674 files) behind
the index. All six subagents got `floors: []` and fell back to `git show`. The
cap is a product limit, not a correctness boundary, and the decision is that
there are no limits: any delta answers from the tree.

Lifting the cap in a probe build (`Number.MAX_SAFE_INTEGER`, never committed)
and timing a 674-file tree (`1d4e3759b`) showed the cost is not in scoring. It
is per-request O(delta) work, repeated on every call:

| Stage (674 files, one-shot `call`)                        | Cost                | Why it repeats                                                                                   |
| --------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| First chunking of the delta                               | 10.8 s              | once per content (chunk store hit afterwards)                                                    |
| Base-vector reuse: `retrieveDenseVectors(…, ["content"])` | ~1.2 s (JSON parse) | runs every request; reused vectors are never persisted                                           |
| Dense wait for the embedder                               | 2.0 s               | `persist` runs in `finally` after ALL rows; a one-shot process exits at the wait, saving nothing |
| Sparse vectors of every delta row                         | ~190 ms             | recomputed per request, never stored                                                             |
| Touched-base-points scroll                                | ~125 ms             | per request (memoized per view only)                                                             |
| Scoring / fusion                                          | negligible          | —                                                                                                |

## Decisions

1. **Delta admission = AST-chunked languages.** A changed file enters the delta
   (re-read, chunked, vectorized) only when its language's chunker is AST-tier
   `full` — source, tests, and Markdown (MarkdownChunker). Files chunked by
   CharacterChunker (json, jsonc, yaml, sql, toml, env, …) are not re-read;
   their index rows are served marked `treeState: "modified"`. Deletions apply
   to every file ingest admits (deleting costs no chunking).
2. **No count cap anywhere.** `WORKING_TREE_DELTA_FILE_CAP`, the over-cap
   `degraded`, the rename-diff skip in `measureDelta`, and ingest's
   `indexedDirtyPathsOverflowed` write path are removed.
3. **Progressive warm.** Chunks, sparse vectors, and dense vectors of the delta
   are produced by a background job and persisted per batch. A request waits at
   most its budget and answers with what is warm; a file not yet warm is served
   from the index with `treeState`, and the marker counts it.
4. **No per-request O(delta) repeats.** Everything a request reads about the
   delta comes from memory or the chunk store, keyed by content; only files not
   yet warm cost work, and that work is the warm job's.
5. **Watcher in the long-lived server.** A tree addressed with `path` and a
   non-empty delta is watched; edits are warmed before the next request asks.
   The one-shot CLI `call` never watches.

## Components

### Delta admission — `domains/explore/working-tree/delta.ts`

`measureDelta` keeps measuring every file `FileScanner#accepts` admits — the
marker's `changedFiles` / `deletedFiles` stay the true distance from
`indexedCommit`. The view splits `changed` into:

- **re-read** — the chunker that ingest would pick for the path is AST-tier
  `full`;
- **index-only** — everything else. Their base rows are NOT excluded from
  `has_id` and carry `treeState: "modified"`.

Admission reads the decision the chunker makes for the path (language detection
as ingest does it, then `LanguageFactory#capabilities()` tier), never an
extension list kept in the overlay. Prime on tea-rags reports `tsx`, `js`, `md`,
`sh` as separate `ast none` languages; the plan verifies what the chunker
actually does for those extensions before admission is wired, so a `.tsx` file
chunked by tree-sitter is admitted and one that falls back to CharacterChunker
is not.

Marker: `indexOnlyFiles?: number` — changed files served from the index by
admission. Absent when zero.

`measureDelta` always runs the rename diff when the delta deleted something (the
cap-based skip goes).

### Progressive warm — `WorkingTreeWarmer` (new, `domains/explore/working-tree/warmer.ts`)

**Does:** turns a tree's re-read files into stored rows, sparse vectors, and
dense vectors, batch by batch. **Owner:** explore / working-tree, one instance
per process, built in `createAppContext`. **Interface:**

```ts
interface WorkingTreeWarmer {
  /** Enqueue the tree's re-read files; resolves when the given paths are warm or the budget elapses. */
  warm(
    request: WorkingTreeWarmRequest,
    wait: { paths?: readonly string[]; budgetMs: number },
  ): Promise<WorkingTreeWarmState>;
}
interface WorkingTreeWarmState {
  /** Re-read files whose rows, sparse and dense vectors are all available. */
  warm: ReadonlySet<string>;
  /** Re-read files still queued or in flight. */
  pending: number;
  /** Failures (unparsed files, provider failure) as today's marker fields carry them. */
  unparsed: readonly string[];
  denseFailure?: string;
}
```

Per batch (default 32 files): chunk through the existing `ChunkerPool` → compute
sparse vectors → resolve dense vectors (memory → store → identical base vector →
embed) → `store.put` rows + `store.putVectors` sparse and dense. A batch is the
unit of persistence, so a process killed mid-warm keeps every finished batch,
and the next process resumes from the store. The current `finally`-time persist
in `WorkingTreeDenseVectorSource` goes.

Queue: one per process, shared by every tree. Priority, highest first:

1. paths a live request waits on (`wait.paths` — e.g. `find_symbol` with
   `relativePath`, or a symbol whose base row lies in a changed file);
2. the remaining re-read files of trees with a live request;
3. watcher-driven background work.

Chunking concurrency is the chunker pool's size. Background embedding keeps one
batch in flight, so query embeddings are never queued behind it.

`WorkingTreeOverlay#view` calls
`warm(…, { budgetMs: WORKING_TREE_WARM_WAIT_MS })` (2000 ms, replacing
`WORKING_TREE_DENSE_WAIT_MS`) and builds floors from the warm set:

- a warm file: its base rows are excluded (`has_id`), its tree rows serve every
  floor;
- a pending file: its base rows are served with `treeState: "modified"`; a new
  file not yet warm is absent.

Marker: `pendingFiles?: number` — re-read files not warm at answer time. Absent
when zero. `floors` lists a floor when it served at least one warm file;
`pendingFiles` qualifies it. `denseUnavailable` keeps its meaning for a provider
failure; the "N rows pending" reason folds into `pendingFiles`.

### Removing per-request repeats

| Repeat                  | Change                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sparse vectors          | Stored beside dense in the chunk store (`putVectors` / `getVectors` carry both, keyed by content); the sparse floor scores stored vectors.                                                                                                            |
| Base-vector reuse       | Reused vectors are written to the store in the batch that found them, so `retrieveDenseVectors(…, ["content"])` runs once per content ever, only for rows the store lacks. The content comparison stays (the touched-base read selects no `content`). |
| Touched base points     | Already cached per process by (collection, index revision, touched set). Unchanged; in the one-shot CLI it stays one scroll per process (~125 ms at 674 files), which the live budget below accounts for.                                             |
| In-memory content cache | `CONTENT_CACHE_MAX_FILES = 2_000` was sized off the cap; bound it by bytes instead (default 64 MB), oldest evicted first.                                                                                                                             |

The chunk store keeps its retention and sweep unchanged; a sparse vector is a
few hundred bytes per row beside a ~3 KB dense one.

### Watcher — `WorkingTreeWatcher` (new, `domains/explore/working-tree/watcher.ts`)

**Does:** keeps a tree's delta warm between requests. **Owner:** explore /
working-tree; enabled only by the MCP server's composition root (an option of
`createAppContext`), off for the CLI `call`. **Interface:**
`watch(tree: WorkingTree): void` (idempotent per tree root) and `close()`.

- **Start:** the first `view` of a tree, addressed by `path`, whose measured
  delta is non-empty. The alias's own checkout is never watched — it keeps the
  reindex rule.
- **Events:** recursive `fs.watch` on the tree root. Paths under `.git` and
  paths `FileScanner#accepts` rejects are dropped before debounce.
- **Debounce:** 2 s after the last event → re-measure the delta (same reader,
  same fingerprint) → enqueue re-read files the store does not hold at their
  current content, at background priority → rebuild the tree graph for the new
  fingerprint.
- **Stop:** the tree root disappears, 30 minutes without a `view` of the tree,
  or process exit. No limit on the number of watched trees; idle stop bounds
  them.
- **Writes:** only the chunk store and the tree-graph cache. Never Qdrant.

A commit or checkout in the tree shows up as file events (checkout) or as no
content change at all (commit — the delta against `indexedCommit` is the same
content, so every row is a store hit).

### Ingest — `domains/ingest/pipeline/base.ts`

`BaseIndexingPipeline#buildRegistryGitState` stores `indexedDirtyPaths` in full.
`RegistryGitState.indexedDirtyPathsOverflowed` stays in the type as a legacy
read: `dirtyAtIndexTime` still answers `unknown` (reindex remedy) for a registry
entry written before this change, since that run stored no list. Nothing writes
it any more.

### Plugin — `.claude-plugin/tea-rags/`

- `rules/index-freshness.md`: "Worktree clone — only when the overlay degrades"
  loses its only trigger (over-cap `degraded`) and is removed; the remaining
  `degraded` reasons carry the reindex remedy.
- `rules/search-cascade.md`: drop "Clone mode"; document `pendingFiles` (rows of
  files not yet warm come from the index with `treeState`; a later call reads
  more of the tree) and `indexOnlyFiles` (non-code files changed in the tree;
  their rows are the index's).
- Subagent injection block: same two marker fields, one line each.
- `WORKING_TREE_WORKTREE_INDEX_REMEDY` loses its last user and is deleted. The
  `tea-rags worktree create` CLI stays.
- Plugin version bump (minor) and an eval run on the changed guidance.

## Error handling

- A file that fails to chunk is `unparsed`, as today; it is warm-with-no-rows,
  so it never stays pending.
- Embedding provider down: batches persist rows and sparse vectors; dense stays
  missing, `denseUnavailable` names the failure, those files stay pending for
  the dense floor only, and the next batch retries.
- Watcher errors (`EMFILE`, root removed) stop that tree's watcher; requests
  still warm on demand.

## Testing

TDD, red first, per component:

- admission: AST-full vs CharacterChunker split, deletions of any admitted file,
  `indexOnlyFiles` count, index-only rows keep `treeState`;
- warmer: batch persistence (kill after batch N → next process starts at N + 1),
  priority order, budget expiry returns partial state, `pendingFiles`;
- repeats: second request on the same fingerprint does zero chunking, zero
  sparse computation, zero `retrieveDenseVectors`;
- watcher: debounce coalesces bursts, ignored paths, idle and root-removed stop,
  no Qdrant writes (fake client asserts);
- ingest: list stored past 200 paths; a legacy overflowed entry still degrades.

Tests that pin the cap (`overlay.test.ts`, `delta.test.ts`) change because the
invariant changes; the commit that changes them says so.

Live validation (worktree build, `node build/cli/index.js call`, no link):

- far tree `t674`, cold: each call returns within budget + boot, with
  `pendingFiles` falling call over call until 0;
- far tree, warm: per-call overhead over a clean tree ≤ 300 ms in the one-shot
  CLI (touched-base scroll is per process there);
- near tree (≤ 20 files): no regression against today's timings;
- server mode: watcher warms an edit within debounce + one batch; the next
  `find_symbol` on it reports no pending files.

## Out of scope

- Watching the alias's own checkout (reindex remains its freshness path).
- Writing the tree's rows into Qdrant or creating per-tree collections.
- Changing chunk store retention or sweep policy.
