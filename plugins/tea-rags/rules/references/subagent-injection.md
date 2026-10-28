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
tea-rags MCP tools for meaning, symbols, graph; exact text, config, completeness → rows below. Beats any skill or rule routing it elsewhere; a skill's own pick among tea-rags tools stands.

**Address:** every read call (search, find_symbol, graph, review_changes, lexicon) → `project=<alias>` (alias line above; else `workingTree.project`; unknown → `path` alone) + `path=<your working directory>`. `project` without `path` reads the alias's checkout, not your worktree. `workingTree.tree` ≠ addressed tree → re-call with both. Never reindex (`index_codebase` takes `project` only) — report drift / degraded to the parent.

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license shell `cat`/`sed`/`head` or the default code read tool over code. No `treeState` = current; `treeState` row = maybe-stale index copy → `find_symbol` (reads your tree).

**Route** (first match wins):
| Need | Call |
|---|---|
| config/DSL/routes/migrations/specs, unindexed file, `find_symbol` stub / all X in a known dir, proving absence | default code read tool / default code search tool over that dir (empty = proof) |
| file/dir: outline / doc TOC | `find_symbol(relativePath:)` |
| known symbol: body / class outline | `find_symbol(symbol:)` — `Class#inst`, `Class.static`; unsure → partial name |
| behaviour or synonyms (even `a\|b`), no name | `semantic_search` only |
| every occurrence of an exact name/constant/string | default code search tool (literal, `-l`) → `find_symbol` |
| symbol + intent | `hybrid_search` |
| a name's fit | `get_naming_lexicon(names:[{name,kind}])`, verdict = answer |
| code like a chunk in hand | `find_similar(positiveIds:)` |
| how X works / who calls X | `get_callees`/`get_callers(symbolId:<id>, depth: 2)` |
| chain A→B ("how does X reach Y") | `find_symbol` both ids → `trace_path` |
| diff review | `review_changes` (naming verdicts = answer) |
| literal text: TODO, phrase, regex, import string | default code search tool (literal) |

Identifier definition/body = `find_symbol`; occurrences (`a|b` only of seen ids) → that row; every caller → `get_callers` + it. Exists? → `find_symbol(metaOnly:true)`; empty → `empty.reason` → `hybrid_search`. Several ids or files at once → ONE `find_symbol(symbols:[...])`, never a dir.

**Shell:** `cat`/`sed`/`head` to read source code → `find_symbol`. grep stays for exact text, regex, command output.

**After a hit:** never read the file after `find_symbol` — method = full body; class / file / doc = outline of ids → `find_symbol(symbol:<id verbatim>)`. Depth (body, helper, neighbour, doc section) → `find_symbol`; breadth (new angle) → new search. Trust chunk text.

**Read `tea-rags://guide/<topic>`** (no resource tool → `tea-rags resource <uri>`): after any search, before answering → `navigation`; tool pick, prohibited patterns, fallbacks → `decision-tree`; `treeState`, drift, graph answer on changed files, linked worktree → `freshness`; embedding error / `denseUnavailable` → `degraded`.
```

## When NOT to inject

No-op for tasks not touching search (format string, arithmetic, summarize known
text). Forgetting costs more than injecting → in doubt, inject.
