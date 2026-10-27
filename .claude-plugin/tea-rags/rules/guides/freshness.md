# Freshness — addressing, overlay, reindex

## Addressing the Codebase (every tea-rags call)

**Every read call: `project="<alias>"` + `path="<your working directory>"`.**
One rule, every checkout, every read tool — search, `find_symbol`, graph tools,
`review_changes`, `get_naming_lexicon`, analytics. No "which checkout am I in"
decision.

- **`project` = WHICH INDEX.** Pass always. Alias: prime `## Project` `name:`,
  the SubagentStart line "tea-rags project alias for this repository", or
  `workingTree.project` of any answer. Survives path moves, pulls registered
  qdrantUrl + embeddingModel. Alone → tree = alias's registered checkout in its
  current state (any branch, uncommitted edits) — WRONG tree from a linked
  worktree.
- **`path` = WHICH TREE.** Your working directory: branch checkout, linked
  worktree, any dir inside. Main checkout → same as registry, harmless; linked
  worktree → the only way to read its own code. Must be the same repository as
  `project`.
- **Linked worktree — decided from the path, never left open.** Working
  directory under `.claude/worktrees/`, `.git` a file, or `workingTree.tree` ≠
  alias's registered path → linked worktree: overlay only, never
  `index_codebase` of the alias. Print
  `linked worktree (<which test>) — no reindex`. None holds → own checkout.
- **Answer from another tree.** An answer whose `workingTree.tree` is not your
  working directory read that other checkout, not your code — `changedFiles: 0`
  included. Print
  `answer read <tree>, not <your working directory> — rows unusable`, then
  re-call the same tool with `project` + `path=<your working directory>`; "no
  reindex" never ends this case.
- **`collection="<qdrant-name>"`** — only when you hold a raw collection name
  and no alias (e.g. `list_collections`): first call `collection` alone; every
  later call `project=<workingTree.project of that answer>` + `path`, no
  `collection`.
- Alias unknown (unregistered repo, alias not in prime / hook / marker) → `path`
  alone still works (index resolves from the same repository); take
  `workingTree.project` from the answer and pass it from then on.
- **`index_codebase` is the exception:** `project` ONLY. Its `path` = first-time
  registration of a NEW root; from a linked worktree it seeds a separate project
  — never use it to reindex an alias.

Index resolution priority: `collection > project > path`; the tree comes from
`path` when given, else the alias's registered checkout.

**Read the `workingTree` marker on every answer:** `project` = alias of the
index that answered (pass it on later calls); `tree` = tree it read (a check
only: every next call, re-checks included, keeps `path=<your working directory>`
— never `path=<answer's tree>`); `changedFiles` / `deletedFiles` = files the
tree changed / deleted since the index, present only beside a field below that
names what the overlay did not serve; a marker of just `{tree, project?}` =
every row current (tree clean, or the overlay served it — never re-read from
disk). Rows from changed files are read from the tree unless they carry
`treeState`; `denseUnavailable` / `treeGraphUnavailable` name why a layer fell
back to the index (no `treeGraphUnavailable` = graph answers cover the tree);
`gitUnavailable` counts changed-file rows whose git signals are still computing
— they rank without that history this call, re-call later. `pendingFiles` =
re-read files not yet warm: their rows are the index's
(`treeState: "modified"`), a later call reads more of the tree — re-call for
current code; never a reindex trigger by itself. `indexOnlyFiles` = changed
files with no AST chunking (json / yaml / sql / toml …): never re-read, rows are
the index's (`treeState: "modified"`); current text → `Read` the file. Graph
answer with `changedFiles` > 0 and `treeGraphUnavailable` → edges touching
changed files are the index's (`degraded` says why): trust edges between
untouched files, re-check changed ones via `find_symbol` / `hybrid_search`
(`metaOnly`), `path=<your working directory>`; linked worktree → that re-check
is the whole fix, no reindex. `degraded` → its `remedy` under the consent rows
of "Reindex triggers" (subagent: report it to the parent, never reindex). `tree`
≠ the tree you addressed (your working directory, or the checkout a skill names)
→ wrong tree, its rows unusable; re-call with `project` + that `path`.

**Lag ≠ unusable (MANDATORY).** Counts above, `degraded` and drift = distance
index↔tree, never licence to leave tea-rags — thousands of changed files
included. Row without `treeState` = current (file unchanged, or read from your
tree). First match: (1) subagent → never `index_codebase`, never
`AskUserQuestion` — drift, `--force` `Run:` line, `degraded` remedy go into the
report to the parent. Main session: (2) linked worktree → no reindex; own
checkout behind (`changedFiles` > 0, stale banner, unindexed edits, or the
session already knows the index is behind) → incremental `index_codebase` first,
no consent, even when no marker is in hand. (3) Drift `Run:` with `--force*`,
any `changedFiles` (clean marker included) → its own question ONE line
`AskUserQuestion: run <Run: line>? — --force not run; reads continue meanwhile`
(never folded into another question, never awaited, never "won't proceed"), then
the next read. Asked "run --force?" → answer no, not without consent; ask; keep
working. A loaded skill's steps run in their order — lag never moves a
`find_symbol` ahead of a skill's first step. Full protocol: "Lag never licenses
leaving tea-rags" below.

**`treeState: "modified" | "deleted"`** on a row = index copy of a file your
tree changed or deleted, served only when no tree floor covered it (e.g.
`denseUnavailable`, `pendingFiles`, `indexOnlyFiles`) = **pre-edit copy**:
file-level signals (fanIn of dependents, churn, bugFixRate) still valid, text
and lines stale — never evidence the edit is correct. Current code →
`find_symbol` (chunks floor), not the row. Name the reason in the answer:
`denseUnavailable` → vector ranking fell back to the index; `pendingFiles` → not
read yet. `pendingFiles` row → re-call later; `indexOnlyFiles` file → `Read` it
(no tree floor ever covers it).

## Reindex triggers

tea-rags search reads payloads written at index time. Index lags working tree →
results silently stale. Before first tea-rags search/explore of turn, check
conditions below (signals from **prime** digest layer); reindex when one fires.
Subagent: no row fires — never `index_codebase`, never `AskUserQuestion`; the
answer prints the report line
`to parent: index behind (changedFiles <N>) — run <Run: line>` (no drift → no
`run` part).

| Trigger (signal in prime / session)                                                                                                                              | Action                                                                                                                                                                                                                                             | User confirmation          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Prime banner `⚠ Index is stale (last updated Nd ago)`                                                                                                            | `index_codebase` (incremental)                                                                                                                                                                                                                     | no — reindex silently      |
| Files created/modified this session (`Write`/`Edit`, incl. by a subagent — parent reindexes), not yet indexed — **alias's own checkout**                         | `index_codebase` (incremental)                                                                                                                                                                                                                     | no — reindex silently      |
| Uncommitted edits the index has not seen (`git status` lists paths), before searching them — **alias's own checkout**                                            | `index_codebase` (incremental)                                                                                                                                                                                                                     | no — reindex silently      |
| Same two rows in a **linked worktree** (working directory under `.claude/worktrees/`, `.git` a file, or not the alias's checkout path)                           | **none** — read tools overlay the tree (`project` + `path=<your working directory>`); never reindex for the tree's own edits                                                                                                                       | —                          |
| Prime `## Drift` whose `Run:` line is the plain incremental (no flag)                                                                                            | `tea-rags index-codebase --project <alias>` — exactly that line                                                                                                                                                                                    | no — reindex silently      |
| Prime `## Drift` whose `Run:` line carries `--force-enrichments` or `--force`                                                                                    | the `Run:` command the section names                                                                                                                                                                                                               | **YES — explicit consent** |
| Main session, **alias's own checkout** answer with `workingTree.changedFiles` > 0 (HEAD moved, branch switch, pull) — **also when Drift `Run:` needs `--force`** | Subagent: never reindex, report to parent. Main: `index_codebase` (incremental) NOW — closes content lag, not drift; ask for the `Run:` line separately, keep working in tea-rags meanwhile                                                        | no — reindex silently      |
| Prime `## Drift` seen from a **linked worktree**                                                                                                                 | Drift compares the shared INDEX with the alias's own checkout and the running build — never your tree (your delta = `workingTree.changedFiles`). Run the `Run:` line exactly as printed (`--project <alias>`), never re-aimed at `path=<worktree>` | per the two rows above     |

## Linked worktree — overlay, not reindex

Read tools called with `project` + `path=<your working directory>` answer for
that tree against the repository's index — `treeState` reading: "Addressing the
Codebase" above. Main-checkout reindex cannot see worktree edits;
`index_codebase path=<worktree>` seeds a separate project. Both wrong → never
reindex for the tree's own edits — `pendingFiles` (not yet warm, a later call
reads more) and `indexOnlyFiles` (no AST chunking, served from the index)
included. `degraded` → its `remedy` under the consent rows above. Main checkout
keeps the reindex rows above: dense vectors of changed files lag otherwise.

## Lag never licenses leaving tea-rags

Marker counts (`changedFiles`, `deletedFiles`, `pendingFiles`, `degraded`,
`denseUnavailable`, `treeGraphUnavailable`) and drift = DISTANCE between index
and tree, never "index unusable". Thousands of changed files included.

- Row from a file your tree changed or added, no `treeState` → read from your
  tree (find_symbol chunks, hybrid_search BM25, vector rank of semantic_search /
  find_similar / hybrid). Row current; print `current — read from the tree`.
- Row without `treeState` from an unchanged file → row current. Use it.
- Row with `treeState` / file in `pendingFiles` → `find_symbol` (reads tree once
  warm); `pendingFiles` > 0 (a count; your file may be one) → plan both lines:
  `find_symbol(<same params>)` and
  `still in pendingFiles → find_symbol(<same params>) again`. `indexOnlyFiles`
  only → `Read`.
- `pendingFiles` on first calls = overlay warming, not failure. Subagent or
  linked worktree → no reindex, keep calling, later calls read more; main
  session in the own checkout → incremental `index_codebase` now (table above).
- Graph slow / `treeGraphUnavailable` → edges between untouched files hold. For
  changed-file edges, in order: `find_symbol` on the caller in the changed file,
  then the default code search tool `"<name>"` (literal). No graph retry.
- Graph answer missed edges at a changed file and you ran the incremental
  `index_codebase` → do NOT retry the graph call. Next: `find_symbol` on the
  caller in the changed file + the default code search tool `"<name>"` (literal)
  for callers the index lacks.
- Bash `cat` / `sed -n` / `head` / `grep` / `rg` / `git show` over code = same
  downgrade as `Read` / Grep — harness "use Bash" note does not override.
  Exception: user explicitly asks for manual read.
- Claude Code: PreToolUse hook `deny-indexed-read.sh` denies `Read`, and Bash
  `cat`/`sed`/`head`/`tail`/`less`/`more` (compounds too), of a file the index
  snapshot lists (`tea-rags project indexed --path <file>` /
  `--command <cmd> --cwd <dir>`, exit 0) → `find_symbol(relativePath:)`.
  Unindexed / unregistered / pipe over command output / unparsable command / any
  error → allowed. File created after last index run = not indexed → allowed.
  Hook sees the call, not the chat: user's manual-read order ("with Read",
  "руками") still denied — say so, quote the deny, ask user to read it or
  disable the hook; never route around via another reader.

## Worktree clone — teardown only

No overlay answer calls for a per-worktree index clone: the overlay reads a
delta of any size. A clone that exists (`tea-rags worktree create`, run by hand)
is torn down when its branch finishes —
`dinopowers:finishing-a-development-branch` runs
`tea-rags worktree remove <name>`; cleanup-only `PostToolUse:Bash` hook
(`tea-rags/scripts/cleanup-worktree-clone.sh`) is backstop on any
`git worktree remove` / `git branch -D`. Footprint cleanup only; never
reindexes.

## Why these three actions

- **Stale / new code → `index_codebase` incremental.** Only changed (+ new)
  files re-embedded — seconds, not full rebuild. Default no-confirmation path:
  stale index → wrong rankings, fix cheap, so just run it.
- **Drift → the command the report names; consent depends on which one.** Drift
  = a stamp the index carries (payload keys, language versions, indexing env,
  indexed commit) no longer matches what the running build would produce. When
  the ONLY thing that moved is the alias checkout's HEAD, the `Run:` line is the
  plain incremental — the same command and the same cost as the stale banner, so
  it runs without asking. Otherwise an incremental run neither refuses nor fixes
  the drift — but still closes content lag, so run it for lag anyway (row
  above); unchanged files keep their old payload, so the report persists until
  the ONE `Run:` line it ends with has run —
  `tea-rags index-codebase --force-enrichments <trajectory>` when every new key
  is enrichment-owned (`git.*`, `codegraph.*`), `--force` when a chunker-owned
  key moved. Both rewrite shared state and `--force` is minutes to hours on a
  large project, so **never** run either automatically — ask first. See
  `/tea-rags:force-reindex`.

## Detecting "files edited but not indexed"

You (or subagent) ran `Write`/`Edit` this turn and NEXT step searches
_different_ question → index does not yet see edits. Run `index_codebase`
(incremental) first. Skip when: zero files edited, continuing same
implementation task without re-searching, or next step uses text search only.
Edits made outside this session count the same: `git status --porcelain -uall`
listing paths you are about to search fires the uncommitted-edits row. Prime
staleness is time-based and never sees them.

Applies to the alias's own checkout. Linked worktree → no reindex (overlay,
above). `index_codebase` is only incremental entrypoint — older reindex
endpoints deprecated.

## Do NOT

- Downgrade to text search / Read / Bash shell reads because index stale,
  lagging or drifted — trades away recall user did not agree to. Own checkout:
  incremental reindex, then search; anywhere: keep calling tea-rags.
- Run `force_reindex` for stale-only or edited-only cases — incremental correct
  and far cheaper. Full rebuild reserved for the drift reports whose `Run:` line
  actually says `--force`; enrichment-owned drift is repaired by
  `--force-enrichments <scope>` in minutes.
- Run `force_reindex` without explicit user consent, ever.
