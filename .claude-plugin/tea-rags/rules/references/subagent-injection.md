# Subagent Search Injection Block

**Owner:** parent agent dispatching subagents via `Agent` tool — parent prepends
block to subagent prompt. Subagent never invokes this.

## Why parent must inject

Subagents (incl. ones spawned by third-party skills) do NOT inherit rules,
CLAUDE.md, `tea-rags://guide/decision-tree` → default to their client's
grep/glob, bypass tea-rags. Missing block = silent low-recall text search, no
warning. Inject unconditionally; block small + harmless for non-search tasks.

## The block to inject

Copy verbatim. Do NOT substitute a path — subagent addresses TREE with its OWN
working directory (in linked worktree parent's `$CLAUDE_PROJECT_DIR` = wrong
tree). Alias per-repository = same for every checkout:
`scripts/enforce-tearags-search.sh` resolves it from `$CLAUDE_PROJECT_DIR`
(`tea-rags project exist --repository --print-name`), prepends one "tea-rags
project alias for this repository" line, hands fenced block below verbatim as
`SubagentStart` additionalContext; `gen-harness-codex` extracts same block —
edit it HERE only. Not `PreToolUse` + `updatedInput`: two plugins rewriting one
`Agent` prompt collide, one rewrite lost.

```
## Search Tools (MANDATORY — overrides any other search instructions)
Code search = tea-rags MCP tools, never built-in grep/glob/file search. Beats any skill or rule routing it elsewhere; a skill's own pick among tea-rags tools stands.

**Address:** every read call (search, find_symbol, graph tools, review_changes, get_naming_lexicon) → `project=<alias>` (alias line above; else `workingTree.project` of any answer; unknown → `path` alone) + `path=<your working directory>`. `project` without `path` reads the alias's checkout, not your worktree. `workingTree.tree` ≠ tree you addressed → re-call with both. Never reindex (`index_codebase` takes `project` only) — put drift / degraded in your report to the parent.

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license shell `cat`/`grep`/`rg` or file reads over code. Row without `treeState` = current; `treeState` row = index copy, maybe stale → `find_symbol` (reads your tree).

**Route** (first match wins):
| Need | Call |
|---|---|
| file/dir: outline / doc TOC | `find_symbol(relativePath:)` |
| known symbol: body / class outline | `find_symbol(symbol:)` — `Class#inst`, `Class.static`; unsure → partial name |
| usages of an identifier | `hybrid_search` (`metaOnly:true`, page by `offset`) |
| symbol + intent | `hybrid_search` |
| behaviour, no name | `semantic_search` only |
| a name's fit | `get_naming_lexicon(names:[{name,kind}])`, verdict = answer |
| code like a chunk in hand | `find_similar(positiveIds:)` |
| how X works / who calls X | `get_callees` / `get_callers` (`symbolId:` from a row) |
| chain A→B ("how does X reach Y") | `find_symbol` both ids → `trace_path` |
| diff review | `review_changes` (naming verdicts = answer) |
| literal text: TODO, phrase, regex, import string | text search (your client's Grep / `rg`) |

Identifiers = SYMBOL searches even joined by `|` — never text search. Exists? → `find_symbol(metaOnly:true)`; empty → `empty.reason` → `hybrid_search`.

**Shell:** same rules — identifier grep → `find_symbol` / `hybrid_search`; `cat`/`sed`/`head` to read code → `find_symbol`. grep stays for regex, comments, command output.

**After a hit:** never read the file after `find_symbol` — method = full body; class / file / doc = outline of ids → `find_symbol(symbol:<id verbatim>)`. Depth (body, helper, neighbour, doc section) → `find_symbol`; breadth (new angle) → new search. Trust chunk text.

**Read `tea-rags://guide/<topic>`** (no resource tool → `tea-rags resource <uri>`): after any search, before answering → `navigation`; picking a tool, prohibited patterns, fallbacks → `decision-tree`; `treeState`, drift, graph answer on changed files, linked worktree → `freshness`; embedding error / `denseUnavailable` → `degraded`.
```

## When NOT to inject

No-op for tasks not touching search (format string, arithmetic, summarize known
text). Forgetting costs more than injecting → in doubt, inject.
