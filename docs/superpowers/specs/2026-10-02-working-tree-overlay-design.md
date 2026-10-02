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
`degraded` set. The marker is never omitted.

`indexLag` on `review_changes` and `get_naming_lexicon` stays as is; the marker
supersedes it in a later cleanup, not in this slice.

### `WorkingTreeDelta` (WTO-2) — `domains/explore/working-tree/delta.ts`

Input: tree root, `indexedCommit`, the ingest file filter. Output:
`{ changed: string[]; deleted: string[]; fingerprint: string }` with
repo-relative paths.

- changed = `git diff --name-status --no-renames <indexedCommit>` entries that
  are not deletions, plus `git ls-files --others --exclude-standard`;
- deleted = the `D` entries; a rename is a delete plus an add;
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

Retention (sweep at server start, then every 6 h on an unref'd timer):

| Entry state                                                      | Action    |
| ---------------------------------------------------------------- | --------- |
| tree root no longer exists (worktree removed)                    | evict now |
| content committed and `now − max(commitTime, lastReadAt) ≥ 96 h` | evict     |
| content uncommitted, tree alive                                  | keep      |
| store above its size cap (default 512 MB)                        | evict LRU |

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

Dense floor, delta signals, codegraph delta edges, replacing `indexLag`. Live
validation and the WTO-9 transcript audit are user-gated.
