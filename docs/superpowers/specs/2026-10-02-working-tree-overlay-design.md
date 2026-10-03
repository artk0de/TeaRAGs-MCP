# WorkingTreeOverlay — P0 slice design

Epic: `tea-rags-mcp-xi2r9`. Slice: WTO-1 (addressing + marker), WTO-2
(`WorkingTreeDelta`), WTO-3 (chunk floor), WTO-4 (sparse floor), WTO-8 (plugin
injection). WTO-9 (transcript audit) is the user-gated live measurement that
closes the epic. P1 floors (dense WTO-5, signals WTO-6, codegraph WTO-7) are out
of scope.

## Problem

One MCP server serves the whole Claude Code session. Its cwd is the main
checkout, and the `PreToolUse:Agent` hook runs before an `isolation: "worktree"`
subagent's worktree exists, so neither can know which tree a subagent stands in.
Today `project=<alias>` reads the main checkout's index and `path=<worktree>`
hashes to an empty, unindexed collection. Either way the subagent gets answers
about a tree it is not working in, and nothing in the answer says so.

The only party that knows the tree is the agent itself: its working directory is
in its own system prompt. The design makes that one value sufficient.

## Decisions

| Decision                                 | Choice                                                                                                                                                  | Rejected                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Addressing                               | `path=<cwd>` alone is enough; it resolves to the index registered for the same git common dir                                                           | `project`+`path` only — an agent that forgets the alias silently reads an empty collection                                                                          |
| Index selection for an unregistered tree | exact registered path (a worktree clone) → the entry at the main checkout → the single same-repo entry → `InvalidParameterError` listing the candidates | picking by commit proximity — unpredictable for the agent                                                                                                           |
| Delta chunking                           | lazy `ChunkerPool` (size 1, idle shutdown 60 s) built by a bootstrap factory; chunks cached by `(relativePath, sha256(content))`                        | in-process chunking (blocks the event loop, loads every grammar into the server); warm pool from start (constant memory for sessions that never touch a dirty tree) |
| Tools without a floor                    | base chunks of delta files stay visible and carry `treeState: "modified" \| "deleted"`                                                                  | hiding them — a modified file would vanish from `semantic_search` until the dense floor ships                                                                       |
| Naming                                   | `resolveWorkingTree` returns a `WorkingTree` whose base index is an attribute; existing `resolveWorkTree` is deleted                                    | `resolveIndexAndTree` — two responsibilities in one name                                                                                                            |

## Components

### `resolveWorkingTree` (WTO-1) — `api/internal/collection-resolver.ts`

```ts
interface WorkingTree {
  root: string; // realpath of the tree the caller stands in
  baseIndex: { collectionName: string; root: string | undefined };
}
function resolveWorkingTree(
  registry: CollectionRegistry,
  input: ResolveInput,
): WorkingTree;
```

Rules:

1. `collection` or `project` given → `baseIndex` from it exactly as
   `resolveCollection` does today. `path` given → it must be inside a checkout
   with the same `resolveGitCommonDir` as the index root, else
   `InvalidParameterError("path", …)`. No `path` → tree = index root.
2. `path` only → normalise to the tree root (walk up to the nearest `.git`,
   filesystem only, no git spawn). Then:
   1. `findByPath(treeRoot)` hit → that entry (a worktree clone wins);
   2. registry entries whose path shares the common dir → the one at the main
      checkout (`listRepoWorkTrees(treeRoot)[0]`), else the only one, else
      `InvalidParameterError` naming every candidate alias;
   3. no same-repo entry → today's behaviour (hash of the path).
3. `resolveCollection` keeps its signature and behaviour; its ten dependents do
   not move. Read tools switch to `resolveWorkingTree`.

Callers: `ExploreOps#resolveAndGuard`, `ExploreOps#searchCode`,
`ExploreOps#getIndexMetrics`, `GraphFacade#withReadHandle`,
`TracePathOps#tracePath`, `ReviewChangesOps`, `NamingLexiconOps`. The last two
drop `resolveWorkTree` from `diff-scope-reader.ts`; that function is deleted.

Registry lookups are an O(entries) scan with one filesystem read per entry for
its common dir, memoised per entry path for the process lifetime.

### `WorkingTreeMarker` (WTO-1) — `api/public/dto/working-tree.ts`

```ts
interface WorkingTreeMarker {
  tree: string;
  indexedCommit: string | null;
  treeCommit: string | null;
  indexedDirty: boolean;
  changedFiles: number;
  deletedFiles: number;
  floors: ("chunks" | "sparse")[];
  degraded?: { reason: string; remedy: string };
}
```

Attached as `workingTree` on every read answer: in `ExploreOps#executeExplore`
beside `driftWarning`, and on the graph tools' DTOs (`floors: []` until WTO-7).
`changedFiles: 0` means the delta was measured and is empty. Every path that
cannot measure — no `indexedCommit` stamp, the commit object missing from the
tree's repository, the delta over the cap — still returns the marker with
`degraded` set. The marker is never omitted. A delta refused for the cap WAS
measured: it reports its counts beside `degraded` (live D11a), so `0` means
measured-and-empty only.

`floors` lists exactly the layers that supplied tree data to THIS answer (live
D8). A floor is claimed by the code that put delta rows into the answer's
candidates (`claimWorkingTreeFloors`) or read the tree graph for it — never by
an operation up front, never by reading delta rows (find_similar reads them only
for a tree positive's content), and never by a clean tree. A clean tree reports
`floors: []` on every tool. The claim counts the delta rows admitted: a strategy
whose request filter, pathPattern or scroll predicate refused every delta row
answered from the index alone and claims nothing (live round-3 D1).

A read of a path whose resolved index does not exist is refused with
`EXPLORE_COLLECTION_NOT_FOUND` by every read tool, before the overlay measures
anything (`resolveIndexedWorkingTree`, live round-3 D3): no marker is made for
an index nobody created.

`indexLag` on `review_changes` and `get_naming_lexicon` stays as is; the marker
supersedes it in a later cleanup, not in this slice.

### `WorkingTreeDelta` (WTO-2) — `domains/explore/working-tree/delta.ts`

Input: tree root, `indexedCommit`, the ingest file filter. Output:
`{ changed: string[]; deleted: string[]; fingerprint: string }` with
repo-relative paths.

- changed = `git diff --name-status --no-renames <indexedCommit>` entries that
  are not deletions, plus `git ls-files --others --exclude-standard`;
- deleted = the `D` entries; a rename is a delete plus an add;
- renamedFrom = the moves git pairs (`git diff -M --name-status <indexedCommit>`
  over a throwaway copy of the index where the delta's untracked files are
  marked intent-to-add, so an unstaged move pairs too), read only when something
  was deleted. The touched sets stay exact; the pairs only say whose history a
  moved file carries (D12);
- both filtered by the ingest rules. `FileScanner` gains a public
  `accepts(relativePath)` that applies the supported-extension test and the
  ignore filter, including the trailing-slash probe of ancestor directories,
  lifted out of the private `walkDirectory` so ingest and the overlay share one
  rule.

Cache: per tree, keyed by a fingerprint of HEAD commit + the
`git status --porcelain` output + `mtime:size` of each changed path. Status text
alone does not change when an already-modified file is edited again; the
`mtime:size` term catches that. A clean tree at the indexed commit costs one
status spawn. Target under 20 ms added on tea-rags; the measured number goes in
the commit message.

Cap: more than 200 changed files →
`degraded { reason: "delta of N files over the 200-file cap", remedy: "tea-rags worktree create <name> --from <alias> --path <tree>" }`,
no delta applied.

### `WorkingTreeChunkLayer` (WTO-3) — `domains/explore/working-tree/chunk-layer.ts`

- Reads each changed file from the tree, detects its language like ingest,
  chunks it through a lazily built `ChunkerPool` with the collection's chunker
  config, assigns ids with `generateChunkId`, and shapes each chunk as the
  `ScrollChunk` payload ingest would store (relativePath, symbolId,
  parentSymbolId, content, lines, language, chunkType, isTest, isDocumentation,
  navigation).
- Cache by `(relativePath, sha256(content))`; an unchanged file is never
  re-chunked.
- `SymbolSearchStrategy#executeExplore` and `FileOutlineStrategy#executeExplore`
  substitute before grouping: drop scrolled rows whose `relativePath` is in
  `changed ∪ deleted`, add delta rows that pass the same predicate the Qdrant
  scroll applied (symbolId / parentSymbolId match, language, pathPattern, exact
  relativePath).
- Strategies without a floor (`semantic_search`, `rank_chunks`, `find_similar`)
  leave rows in place and set `treeState` on rows from delta files.
- Git and codegraph payload of delta chunks is absent, not copied from the base
  version (WTO-6 decides what is computed).

Parity: a test chunks a file through the layer and through the ingest file path
and asserts identical chunk ids.

### `WorkingTreeChunkStore` — persistent delta-chunk cache with retention

The chunk cache outlives the MCP process, so a restarted server does not
re-chunk a worktree it has seen. It lives under
`~/.tea-rags/working-tree/<collection>/` (resolved through the same data-dir
helper the other `~/.tea-rags/*` stores use), one JSON entry per
`(relativePath, sha256(content))`. The `ScrollChunk` rows, the tree root that
produced the entry, the content's git blob id, and `lastReadAt` are stored.
WTO-5 dense vectors will join the same entry.

Retention (first sweep 2 min after process start, then every 6 h, on unref'd
timers; throttled across processes by `<root>/.sweep-stamp.json` to one sweep
per 6 h per store, so a one-shot CLI call never pays it; aborted on exit). The
request path never asks git: an entry read within 96 h is kept unread, a
resolved commit time is persisted in the entry's meta and never re-asked, and at
most 32 lookups (4 concurrent) run per sweep, never-asked entries first:

| Entry state                                                                                                      | Action    |
| ---------------------------------------------------------------------------------------------------------------- | --------- |
| tree root no longer exists (worktree removed)                                                                    | evict now |
| content is not the tree's current content of that path (path gone or bytes differ) and `now − lastReadAt ≥ 96 h` | evict     |
| same content stored by another chunker build/config and read since, this entry `now − lastReadAt ≥ 96 h`         | evict     |
| content committed and `now − max(commitTime, lastReadAt) ≥ 96 h`                                                 | evict     |
| content uncommitted and current, tree alive                                                                      | keep      |
| store above its size cap (default 512 MB)                                                                        | evict LRU |

"Committed" means the blob id appears in the tree's history for that path:
`git log -1 --format=%ct --find-object=<blobId> HEAD -- <relativePath>`; its
`%ct` is the commit time. Once the next index run absorbs the commit, the
overlay stops asking for that content, so the entry ages out on its own.

The store writes only under its own directory. It never touches the shared
index, registry, or snapshots.

### Sparse floor (WTO-4)

Delta chunks get BM25 vectors from the ingest sparse vectorizer. `hybrid_search`
runs its Qdrant query with base rows of delta files filtered out, scores delta
chunks locally (dense similarity skipped until WTO-5; the sparse rank list
alone), and fuses with RRF using the same `k` the server-side fusion uses.
Tests: an identifier that exists only in the tree is found; one that exists only
in the base is not.

### Plugin (WTO-8)

- `enforce-tearags-search.sh` stops injecting `path=$CLAUDE_PROJECT_DIR`. The
  block tells the subagent to pass its own working directory as `path` (no
  `project` needed) and to read `workingTree.tree` in the answer.
- It names the Bash channel: grep/rg on an identifier → `find_symbol` or
  `hybrid_search` with `metaOnly`/`fields`; `sed -n`/`cat` to understand code →
  `find_symbol`. grep stays correct for regex, literal phrases, comments, and
  filtering command output. No deny hook.
- `search-cascade.md` and `references/subagent-injection.md` updated; plugin
  minor version bump.

### Dense floor (WTO-5) — delta rows ranked by their own vectors

Without it, every ranked query on a dirty tree loses the touched files: their
base rows are excluded and the delta rows enter with a sparse rank only, so a
non-lexical `hybrid_search` drops all of them (live: 9 touched files of 9 gone)
and `semantic_search` can only offer the stale base copy. Measured on a linked
worktree, round-2 probe D3.

- **Vectors.** A delta row's dense vector comes from, in order: the base point
  of the same `relativePath` whose stored `content` is byte-identical (an
  unchanged chunk of a modified file — its stored vector is exact, no
  embedding), then the working-tree chunk store (persisted beside the rows,
  keyed by content sha256 and the base index's embedding model id), then the
  base index's embedding provider. Only changed chunk content is ever embedded.
- **Warm-up.** `view()` starts embedding the delta rows that lack a vector (fire
  and forget, single-flight per content); a ranked query waits for them at most
  2 s. A row still without a vector stays out of the dense leg only, and the
  marker says so (`denseUnavailable: { reason: "<n> rows pending" }` or the
  provider's failure).
- **Ranking.** `semantic_search`, `find_similar` and the dense leg of
  `hybrid_search` exclude the base rows of touched files (`has_id`, the shared
  touched-base-points read) and score the delta rows locally — exact cosine
  against the query vector — merged with the Qdrant results by score (cosine on
  both sides); hybrid fuses the dense and sparse delta ranks with RRF k=2 like
  the server-side fusion. `rank_chunks` substitutes delta rows for the base rows
  of touched files (`chunks` floor) so signal-only rankings read the tree too.
  Floors: `"dense"` whenever a delta row was scored by its own vector.

### Tree graph (WTO-7) — codegraph for the working tree

The graph tools and every codegraph signal answer for the tree, not for the
indexed commit. No resolution code is written for this: the tree graph is the
PRODUCTION incremental codegraph run, pointed at a private copy of the base
graph.

1. **Base snapshot.** `GraphDbClient#exportSnapshot(targetPath)` copies the live
   graph with `COPY FROM DATABASE` inside the session that owns it (the daemon
   in production), in one write-queue slot — the same verified copy storage
   compaction uses (`writeCompactedCopy`), without the swap. One snapshot per
   physical collection and base version; the version is the `(size, mtime)` of
   the base `.duckdb` and `.wal`, which reads never move.
2. **Tree build, in a child process.** A forked entry
   (`domains/trajectory/codegraph/working-tree/`) clones the snapshot
   (`COPYFILE_FICLONE` — copy-on-write on APFS), builds a direct-mode provider
   with `createCodegraphEnrichmentProvider({ rootDir: <staging> })`, runs
   `handleDeletedPaths(deleted)` and then
   `buildFileSignals(treeRoot, { paths: changed })`. That is the walker, the
   full resolver chain (ts.Program strategies included), hierarchy-dependent
   re-resolution, PageRank and cycles — the same code an incremental reindex
   runs. The child has its own heap ceiling and a time budget; it is killed on
   either, and the answer degrades to the base graph with `degraded` naming why.
   Measured on this repository: 5 changed TypeScript files, 2.0 s.
3. **Cache.** `<appData>/working-tree/<collection>/graph/<key>/` with
   `key = sha256(treeRoot, delta fingerprint, base version)`, published by
   rename from a staging dir so concurrent servers never read a half-built
   graph. Single-flight per key in-process. Retention joins the chunk store's
   sweep: a dead tree's graphs go at once; per tree only the newest graph is
   kept once a newer one is published; snapshots of a superseded base version go
   at the next sweep.
4. **Warm-up.** `WorkingTreeOverlay#view` starts the build for a non-empty delta
   (fire and forget), so a graph call usually finds it ready.

Consumers:

| Read path                                                                            | Behaviour with a non-empty delta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_callers`, `get_callees`, `find_cycles`, `trace_path`, `get_architecture_report` | wait for the tree graph (budget 120 s), read it, marker `floors: ["codegraph"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| find_symbol visibility, symbol-chunk lookup                                          | same graph, same wait                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| delta rows of every search tool                                                      | `codegraph.symbols.{file,chunk}` from the tree graph when ready within 3 s; otherwise inherited from the base point of the same `(relativePath, symbolId)` and no `codegraph` floor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| delta rows, git                                                                      | `git.file` inherited from the base points of the file's history path — its own, or for a moved file (`renamedFrom`) the old path (uncommitted edits have no history); `git.chunk` from the base chunk of the same symbolId on that path. What no base point answers the git trajectory computes on demand with ingest's own computation: `git.file` of a history path the base never chunked (below the chunk floor, committed after the index), cached per (repository, path history, path, line extent); `git.chunk` of a row whose symbol the base never held, by the chunk walk over the row's TREE lines carried onto HEAD through the HEAD → working hunks (lines the working file added hold no history), cached per (repository, path history, path, tree-file content sha, range). An untracked never-committed file has no `git.file` and each row the chunk walk's zero block, as ingest writes it in the alias's own checkout (live round-3 D4) |

`floors` gains `"codegraph"` whenever the answer's graph data came from the tree
graph. The reranker is not changed: an absent chunk signal already blends to the
file value, and a file with no history scoring zero on churn is correct.

D12, revised (live G4): a delta row carries exactly the payload a reindex of
that tree would write. A brand-new symbol in a tracked file gets the chunk
walk's zero `git.chunk` block — ingest walks every chunk of the file, and one no
commit reached is assembled from an empty accumulator against the file's churn,
with unknown ownership since no blame line attributes an uncommitted line. (The
first P0 cut gave it no block and let the L3 blend fall back to the file
signals; that diverged from what ingest writes.) A symbol the base never held
whose lines ARE committed (a renamed method, a re-split chunk) gets its chunk
history on demand.

History that moved since the index (live G1): a file a commit in
`indexedCommit..HEAD` touched — one `git log --name-only --no-renames` per view,
both sides of a committed move — inherits nothing from its base points. Its
`git.file` and every row's `git.chunk` are computed on demand from the tree's
history, at the new path for a committed move (the file walk follows the
rename). A file changed only by uncommitted edits keeps inheriting.

Persistence (live G2): computed blocks are kept under
`<appData>/working-tree/.git-signals/`, one record per (repository toplevel,
path history (C2 below), history path, signal fingerprint = build version +
squash and chunk-walk config, UTC day), holding `git.file` by line extent and
`git.chunk` by (tree content sha, row range). The day term bounds the drift of
the time-relative values (`ageDays`, `recencyWeightedFreq`). A read bumps the
record's mtime; a record unread 96 h is evicted, then least-recently-read past a
64 MB cap, by a sweep that runs only in a long-lived server. Misses are computed
one batch at a time per process.

Lazy signals (live C1): the view's `readDeltaChunks` yields structure only, and
`signalDeltaRows` enriches the rows handed to it, each FILE at most once per
view. A strategy hands it the rows that reach its candidates:
`BaseExploreStrategy#execute` signals the candidates `executeExplore` returns,
before rerank; the chunk floor signals the rows it admits (rank_chunks ranks its
pool inside, an outline folds rows); a request filter that names a `git.*` /
`codegraph.*` key signals every row before admission. An answer pays git for the
files it returns, not for the delta: the first cold `find_symbol` after a commit
on a 159-file delta blamed all 159 files for an answer from one. A view's
tree-graph wait is made once for all its batches, and the graph-wide reads
(fan-in p95, chunk signals) are kept per graph file, so a row's blocks do not
depend on its batch.

History keys (live C2): with the index stamp, a record's key carries the path's
HISTORY instead of HEAD — the stamp plus a digest of the commits on either side
of `indexedCommit...HEAD` that touched the path (one `git log --left-right` per
(repository, stamp, HEAD), shared with G1). A commit pins every commit behind
it, so a committed move is pinned by the move's commit on the new path. A commit
touching one file leaves every other file's record a hit; without a stamp, or
when git cannot list the range, the key is HEAD.

Tests: rename, delete and move each assert which edges disappear and which
appear (a fixture repository, the real provider, a direct pool); a caller in an
unchanged file of a deleted method loses the edge; a symbol only the tree
declares gains its callers; the child killed on its budget leaves the base
answer with `degraded`; two builds of one key publish one graph.

## Testing

Real git, no git mocks. A fixture helper creates a repository, commits, and
`git worktree add`s in a temp dir. Cases: modified, staged-only, unstaged-only,
untracked, deleted, renamed, ignored by `.gitignore` / `.contextignore`, a tree
at a commit the index never saw, a clean tree, a `path` that is a subdirectory
of the tree, a `path` from another repository, two registry entries for one
repository.

Every early return of the explore and graph paths is covered by a test asserting
the marker is present.

## Closing the slice

1. Plugin and skill changes (WTO-8) ship with eval cases in
   `.claude-plugin/.benchmarks/working-tree-injection/evals.json`: a subagent
   prompt in a linked worktree must pass its own working directory as `path`,
   read `workingTree.tree`, route an identifier grep to `find_symbol` /
   `hybrid_search`, and keep grep for a regex or literal-phrase search. Run
   through the `optimize-skill` eval cycle to 100% before the plugin commit.
2. Live validation on the worktree build (`npm run build && npm link`, MCP
   reconnect — user-gated): from this worktree, with an uncommitted edit and an
   untracked file, `find_symbol` / `hybrid_search` with `path=<worktree>` return
   the tree's version, the marker names the worktree and the change counts, and
   a clean tree reports `changedFiles: 0` with the latency measured.
3. Merge to main; `npm run test:coverage` once on main.

## Out of scope

Replacing `indexLag`. The WTO-9 transcript audit is user-gated.
