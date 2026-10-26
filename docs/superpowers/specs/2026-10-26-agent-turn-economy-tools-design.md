# Agent Turn Economy — Tool Changes (N1, N2, N4, N5, N6)

Date: 2026-10-26 · Status: approved item by item in session "agent stepping
optimization" · Phase 1 of 2 (tools). Phase 2 — rules, skills, plugin (R2–R5) —
lands after `worktree-harness-context-economy` (R1) merges, because both edit
`.claude-plugin/tea-rags/rules/*.md`.

## Problem

The A/C pilot (agent without / with tea-rags) shows the tea-rags cell losing on
turns and tool-result tokens for localization tasks. Transcript evidence, per
gap:

| Gap                                 | Evidence                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| N bodies cost N turns               | TD-91114 C: outline (3k) → "Need the bodies of call, eligible?, preload, build, arithmetic_valid?, reconcile" → `Read` 7.5k                    |
| Directory path answers `[]`         | TD-72544 D: `find_symbol(relativePath: "app/policies/bookkeeper_hub")` → `[]` → `ls` + `cat` ×4, Bash for the rest of the run                  |
| Search rows are ~1–1.5k chars       | `metaOnly`, `limit: 15` → ~15k chars; search = 18.4k of 31.2k tool-result tokens in C                                                          |
| Agent stops at the first anchor     | TD-93238 C: 1 search → anchor → answer; 5 of 10 gold files are co-change / import neighbours; neither tool called                              |
| Empty answers are indistinguishable | `get_callers("GraphFacade.findCoChanged")` (wrong separator, real fanIn 1) and `get_callers("NoSuchThing#nope")` return the same `callers: []` |

Measured in this session on the self-index (`code_8b243ffe`):

- `hybrid_search` without `rerank` already returns `rankingOverlay: null`. The
  row weight is the **default payload**: `imports` (29 paths, ~1.2k chars on one
  row), `git.*.taskIds`, `blame*`, three `enrichedAt`, `codegraph.*` metrics.
- `find_symbol` (no `metaOnly`) carries the full `git.file` block per body
  (email, `lastCommitHash`, `recentAuthors`); a 5-symbol file outline carries
  ~1k chars of `git.file`.
- `fields` projects `payload` only (`projectSearchResultPayloads`).
- File outline defects: unnamed block chunks render as blank lines; `#partN`
  windows of one method render as separate members
  (`SchemaManager#initializeSchema#part1..3`).
- `find_symbol` already tolerates a wrong `#`/`.` separator; the search-cascade
  rule claims the opposite (rule drift, fixed in phase 2).

Each item below states its **reason to apply** and **why the default tool does
not cope** — the default tool being whatever the harness or user gives the agent
(`Read`, `ls`, `cat`, Grep, ripgrep).

## Dropped: N3 `find_usages`

No full-text index exists on `content` (`TEXT_INDEXED_KEYS` = `relativePath`,
`symbolId`, `parentSymbolId`); the sparse layer stores hashed sub-word tokens
(`codeTokenize` splits `sync_qbo_transactions` into
`sync`/`qbo`/`transactions`), so it can rank but cannot enumerate. Exhaustive
multi-spelling enumeration is what the text-search tool already does in one
call, complete and against the live tree. The pilot loss came from
`hybrid_search` attempts made before grep because the rules forbid text search
for identifiers. Fix moves to R5: the rule names the role "text-search tool the
agent has" (harness Grep, Bash `grep`/`rg`, or a user ripgrep MCP) and allows it
for exhaustive enumeration; calls / imports / subclasses stay on `get_callers`.
Revisit (index scan with symbol mapping) only if the wave-4 rerun still shows
the grep route costing turns.

## N1 — batch drill: `find_symbol(symbols: [...])`

**Reason to apply.** After an outline the agent needs 3–6 bodies from one or
more files.

**Why the default tool does not cope.** N single `find_symbol` calls = N turns,
each paying the full context prefix again. `Read` is one turn but returns the
whole file (7.5k vs ~2k needed) without merging `#partN`. The agent counts turns
and picks `Read` — rationally.

**Contract.**

```text
find_symbol(project, path, symbols: string[1..20], pathPattern?, language?, fields?, metaOnly?, rerank?)
→ results: table { request, symbolId, relativePath, startLine, endLine, content }
  missing: [{ request, message, treeState? }]
```

- `symbols` excludes `symbol` and `relativePath` (InputError otherwise); 21+
  entries → InputError. `pathPattern` scopes, as in symbol mode.
- Each address resolves through the existing `SymbolSearchStrategy` path —
  text-match scroll → postProcess → `#partN` merge → codegraph fallback — run
  with bounded `Promise.all`. No second resolver.
- Per-address semantics equal single `symbol:` (method → body, class/module →
  outline, `doc:<hash>` → section).
- **Lean default payload** in batch mode:
  `symbolId, relativePath, startLine, endLine, content`. Explicit `fields` or
  `rerank` restores the rest. Single `symbol:` mode is governed by N4.
- **Separator swap**: an address that resolves only under the other `#`/`.`
  separator returns the symbol with `resolvedAs`.
- **Ambiguity cap**: ≤5 matches per address; more → a `missing` entry
  `{ request, message: "ambiguous: N matches — qualify with Class# or pathPattern" }`.
- **Working-tree overlay mandatory**: every address goes through the
  working-tree substitution; modified symbol → tree body; deleted → `missing`
  with `treeState: "deleted"`; `pendingFiles` → `treeState` on the row. The
  parallel fan-out must not bypass substitution.

**Owner.** `FindSymbolSchema` (`api/tools/schemas.ts`); new branch in
`ExploreOps#buildFindSymbolStrategy`.

**Tests.** Method + class + doc mix; `#partN` address; wrong separator →
`resolvedAs`; ambiguous bare name; missing address; 21 entries; exclusivity with
`symbol` / `relativePath`; lean projection and its `fields` override; linked
worktree with modified / added / deleted symbol.

**Estimate.** P25 1 / P50 1.5 / P75 2 burst days.

## N2 — directory outline: `find_symbol(relativePath: "<dir>")`

**Reason to apply.** The agent knows the area ("bookkeeper_hub policies") but
not which file inside it; today the empty answer to a directory path sends it to
the shell for the rest of the task, followed by whole-file `cat`.

**Why the default tool does not cope.** `ls` returns names without content, so
the next step is reading files — tokens (`cat`) or turns (outline per file).
`ls` sees the filesystem, not the index: it lists ignored / unindexed files on
which the next `find_symbol` answers empty. `find_symbol` itself answers a
silent `[]`. The listing alone is a weak lever (≤1 turn over `ls` + outline);
the value is the per-file symbol column and the self-explaining empty answer.

**Contract.**

```text
find_symbol(relativePath: "app/policies/bookkeeper_hub")
→ { kind: "directory", dir,
    files:   table { relativePath, language, symbols: [top-level ≤8, "+N more"] },
    subdirs: [{ dir, fileCount }],
    total, truncated }
unknown path → { results: [], empty: { reason: "unknownPath", message, suggestions: nearest ≤5 } }
```

- Fallback inside `FileOutlineStrategy#executeExplore` after the exact-path
  match is empty and at least one indexed file has prefix `<dir>/`. Trailing `/`
  accepted.
- One level (like `ls`): deeper levels collapse into `subdirs` with counts.
  Top-level symbols only. Cap 50 files → `truncated`, `total`. No `depth` param.
- Source = the index: one scroll with a minimal payload selector
  (`relativePath`, `symbolId`, `parentSymbolId`, `chunkType`, `language`; no
  content), prefix post-filter. No `git.*` in the answer.
- **Working-tree overlay mandatory**: added files listed with symbols from the
  tree chunks floor; deleted excluded; modified show tree symbols;
  `pendingFiles` → row with `treeState` and index symbols. `workingTree.floors`
  names the layer.
- `nearest`: same-basename files first, then files under the nearest existing
  ancestor.
- Grouper fixes in the same code: unnamed block chunks render no blank line;
  `#partN` windows collapse to one member line.

**Tests.** Exact file → unchanged outline (regression); directory → files +
subdirs; trailing slash; 51 files → truncation; unknown path → `nearest` by
basename and by ancestor; linked worktree with added / deleted / modified file;
`pendingFiles` row; no blank line for unnamed block; `#part1..3` → one member.

**Estimate.** P25 5 / P50 7 / P75 9 h.

## N4 — default payload projection by call mode

**Reason to apply.** Localization runs 2–4 searches of 8–15 rows; every answer
stays in context and is paid again on every later turn.

**Why the default tool does not cope.** The competitor is `grep -rln`: ~50 chars
per row, path only. tea-rags wins on ranking and on `symbolId` for drill, loses
20–30× on row weight, and the agent answers that with grep. `fields` fixes it
only when passed; in the pilot it never was. The default must be right without
agent discipline.

**Contract** (applies when `fields` is absent; `fields` stays an exact
allow-list):

| Mode                                    | Default projection                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `metaOnly`, no `rerank`                 | locator: `relativePath, symbolId, startLine, endLine, chunkType, language, signature`               |
| `metaOnly` + `rerank`                   | locator + `rankingOverlay` per the preset's `OverlayMask`; raw `git.*` / `codegraph.*` dropped      |
| with content (search and `find_symbol`) | locator + `content` + `navigation`; no `imports` / `taskIds` / `git` / `enrichedAt` unless `rerank` |
| `fields` given                          | exact allow-list, unchanged                                                                         |

- `signature` = first non-empty code line of the chunk, ≤160 chars, taken before
  `applyMetaOnly` strips content.
- `fields: ["git"]` must project the whole subtree (verify; add if missing) so
  the old answer stays reachable.
- `treeState` survives in the locator.
- Expected effect: ~1–1.5k → ~150–250 chars per `metaOnly` row.

**BREAKING CHANGE** for consumers of raw `metaOnly` payload — footer per
`commit-rules.md`. The contract line "metaOnly payload is raw; its labels live
only on rankingOverlay" in `src/core/domains/explore/CLAUDE.md` changes. The
consumer audit (skills / rules reading `payload.git.*` / `codegraph.*` under
`metaOnly`, e.g. `dinopowers:brainstorming` Step 3, the analytics recipes) is
listed in the plan; the rewrites themselves land in phase 2.

**Owner.** `projectSearchResultPayloads`
(`api/public/dto/payload-projection.ts`).

**Tests.** Four modes; `signature` for a multi-line header and a doc chunk;
`fields` still exact; `fields: ["git"]` subtree; overlay kept under `rerank`;
`treeState` kept.

**Estimate.** P25 6 / P50 8 / P75 10 h.

## N5 — `next` expansion hint on search answers

**Reason to apply.** In localization the agent finds an anchor and stops; in
TD-93238 5 of 10 gold files are the anchor's co-change / import neighbours.

**Why the default tool does not cope.** grep / `Read` have no notion of change
neighbours; reconstructing co-change from the shell means mining `git log` —
several heavy calls plus manual aggregation, which agents do not do. A rule in
the system prompt (R2) is far from the decision point; the agent decides to stop
while looking at the search answer.

**Contract** (`hybrid_search`, `semantic_search`):

```text
next: [
  { tool: "find_co_changed", args: { project, path, files: [top1, top2] },
    why: "files usually edited together with the top results" },
  { tool: "get_callers", args: { project, path, relativePath: top1 },
    why: "files importing the top result" } ]
```

- Anchors = top-2 distinct files by score; chunks of one file collapse; doc
  chunks excluded.
- `args` carry the caller's `project` + `path` (linked worktree → same tree).
- Gate: codegraph enabled for the collection (default on) — the search path
  already knows it (`codegraphWarning`). Off, empty results, or docs only → no
  `next`.
- No graph-DB read at search time; `built: false` from `find_co_changed` stays
  the explicit answer in the rare unbuilt case.
- Size ~250–300 chars.
- Deferred: inline `neighbors` in the answer. Upgrade if the wave-2 rerun shows
  the agent ignoring `next` in ≥50% of localization tasks.

**Owner.** `ExploreResponse` (`api/public/dto/explore.ts`) new field; assembled
in `ExploreOps` after ranking; passed through by `formatStructuredResult`.

**Tests.** Codegraph on → two hints with correct `project` / `path`; one file's
chunks → one anchor; docs only → none; codegraph off → none; empty → none; one
file → `files: [top1]`; linked worktree → tree `path` in `args`.

**Estimate.** P25 3 / P50 4 / P75 5 h.

## N6 — empty answers explain themselves

**Reason to apply.** After an empty answer the agent decides whether tea-rags is
trustworthy. An empty directory outline sent the pilot agent to the shell for
good; an empty `get_callers` caused by a separator is also a false "no callers".

**Why the default tool does not cope.** A grep empty is honest by construction.
A tea-rags empty conflates four states — absent, addressed wrongly, graph
incomplete, filtered out — so a rational agent re-checks every empty with grep.

**Contract.** One field on every empty answer:

```text
empty: { reason, message, suggestions?: [≤5] }
```

| Tool                                   | `reason`                      | Detection                                                                            | `suggestions`                       |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| `get_callers` / `get_callees` symbolId | `unknownSymbol`               | node absent from graph                                                               | `#`↔`.` swap, short-name matches    |
|                                        | `noEdges`                     | node present, 0 edges; message adds language resolve rate when < 0.9 ("lower bound") | —                                   |
| `get_callers` / `get_callees` path     | `unknownFile`                 | existing `message`, normalised                                                       | `nearest` (N2)                      |
| `hybrid` / `semantic`                  | `pathPatternMatchesNothing`   | on empty only: count with `pathPattern` alone = 0                                    | nearest existing literal prefix     |
|                                        | `filteredOut`                 | count without filters / preset > 0                                                   | which filter to drop / `filter: {}` |
|                                        | `noMatch`                     | otherwise                                                                            | —                                   |
| `find_symbol` symbol / batch           | `unknownSymbol` / `ambiguous` | N1                                                                                   | —                                   |
| `find_symbol` relativePath             | `unknownPath`                 | N2                                                                                   | `nearest`                           |
| `find_co_changed`                      | `notBuilt` / `noHistory`      | `built: false`; file without commits                                                 | —                                   |

- **Separator swap in the graph**: `get_callers` / `get_callees` with the wrong
  separator resolve the swapped id and name it in the existing
  `resolvedSymbolId` — the trap disappears instead of being explained.
- Owner: each tool's op (the reason is domain knowledge); shared
  `EmptyAnswerExplanation` type in `contracts/`, rendering in the formatter. No
  generic "MCP layer" — it cannot know why an answer is empty.
- Zero cost on non-empty answers: diagnostic counts run only after an empty
  result.

**Tests.** Every table row; swap resolution with `resolvedSymbolId`; `noEdges`
with low / high resolve rate; non-empty answer → no `empty` field and no extra
queries (spy on call count).

**Estimate.** P25 5 / P50 7 / P75 9 h.

## Cross-cutting — emitted calls address the tree that answered

Every ready-made call or address tea-rags hands back (`next` args, N6
`suggestions`, N2 `nearest`, N1 `resolvedAs`) is followed by the agent verbatim.
When the agent's tree and the index diverge — linked worktree, `changedFiles` >
0, a cloned index — a hint that drops `path`, or names the registered checkout
instead of the addressed tree, silently moves the next call to another tree and
another overlay.

- Any emitted call's `args` carry `project` = `workingTree.project` and `path` =
  `workingTree.tree` of the answer that produced it — never the registry's
  checkout path when the caller addressed another tree.
- Emitted paths (`nearest`, directory `files`, `next.args.files`) are
  repo-relative to that tree, so they stay valid under the same `path`.
- One shared builder produces the `{ project, path }` pair from the answer's
  `WorkingTreeMarker`; no tool assembles it by hand.
- Test per tool: linked worktree whose tree diverges from the index (added file,
  `changedFiles` > 0) → every emitted call carries the worktree `path`;
  executing the emitted call returns the tree's version, not the index's.

Assumption: "the agent's workdir" = the `path` the caller passed (the server
cannot see an agent cwd it was not given). Defaulting an absent `path` from the
MCP client's `roots` is out of scope here unless requested.

## Order, verification, total

| Wave | Items                                                                              | Rerun check (3 tasks, A/C)                     |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | N6, N5                                                                             | recall C vs A; empty-answer exits to shell = 0 |
| 2    | N4                                                                                 | search tool-result tokens −60% or better       |
| 3    | N1, N2                                                                             | whole-file `Read` / `cat` gone; turns −1…2     |
| then | phase 2: R1 merge → R2–R5 rule / skill / plugin rewrite, N4 consumer audit applied | Bash calls in C ≤ 2                            |

N6 goes first: N1 and N2 reuse its `EmptyAnswerExplanation` type. Live
validation of every wave needs a build + `npm link` + MCP reconnect (user-gated
when more than one worktree is active); none of the items move the chunk set, so
no reindex is required except where the grouper fixes (N2) change outline
rendering only — query-time, no reindex.

Total (phase 1): P25 3 / P50 4 / P75 5 burst days — anchor `trace_path` (9
commits, 1 burst day) scaled by five items of similar size, substrate discount
×0.6, parallel load ×1.3.
