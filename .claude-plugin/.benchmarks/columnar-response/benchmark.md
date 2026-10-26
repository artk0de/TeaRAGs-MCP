# Benchmark: columnar tool responses

**Date:** 2026-10-23 **Bead:** tea-rags-mcp-zn0fg **Surface:** search tools'
`structuredContent.results` and every text tool's record arrays, now
`{ columns, rows }` **Status:** gate passed

## Summary

Agents read the column tables as accurately as the old record arrays: 36/36 on
both arms. The six probe answers cost 34.8% fewer Claude tokens than the
compact-JSON records `main` sends today. The gate asked for no accuracy loss and
at least 30% fewer tokens; both hold.

## Arms

| Arm        | Server build                                          | Guidance                                   |
| ---------- | ----------------------------------------------------- | ------------------------------------------ |
| `row`      | `59f815339` (branch base), built from a `git archive` | that commit's `.claude-plugin/tea-rags`    |
| `columnar` | this branch, `be5508a8f` + benchmark files            | plugin 0.44.11 (`## Response shape` added) |

Both arms read the same tree (this worktree) against the same `tea-rags` index.
No `npm link`, no reindex.

## Accuracy

`scripts/columnar-response-eval.ts`, cases in `cases.json`. Per case the agent
(`claude -p --model sonnet`, the arm's plugin via `--plugin-dir`, the arm's
server via `--mcp-config --strict-mcp-config`, user settings off) makes one
prescribed tea-rags call, receives the answer the way Claude Code delivers it,
and replies `ANSWER: <value>`. Truth = the same call made directly against that
arm's build, read through the record view. 3 runs per case and arm.

| Case             | What the agent reads                                      | row | columnar |
| ---------------- | --------------------------------------------------------- | --- | -------- |
| `row-field`      | `payload.relativePath` of row 3                           | 3/3 | 3/3      |
| `score`          | `score` of row 2                                          | 3/3 | 3/3      |
| `overlay-label`  | `rankingOverlay.chunk.bugFixRate.label` of row 4          | 3/3 | 3/3      |
| `part-parent`    | row 5 is `#partN` → `find_symbol(parentSymbolId)` endLine | 3/3 | 3/3      |
| `drill-symbol`   | `find_symbol(symbolId of row 4)` startLine                | 3/3 | 3/3      |
| `path-pattern`   | brace `pathPattern` over rows 1–5                         | 3/3 | 3/3      |
| `filter-column`  | symbolIds of rows with `chunkType == "function"`          | 3/3 | 3/3      |
| `distinct-files` | distinct `relativePath` count                             | 3/3 | 3/3      |
| `envelope`       | `workingTree.changedFiles` beside row 1                   | 3/3 | 3/3      |
| `callers-field`  | `get_callers`: `sourceRelPath` of caller 4                | 3/3 | 3/3      |
| `callers-filter` | `get_callers`: callExpressions filtered by path           | 3/3 | 3/3      |
| `trace-step`     | `trace_path`: last step of path 1 (steps stay a cell)     | 3/3 | 3/3      |
| **Total**        |                                                           | 36  | 36       |

`drill-symbol` first scored 0/3 on both arms: the truth expression took
`find_symbol`'s first hit, but `defaultDeps` exists in several files and every
agent correctly kept the one in row 4's file. The truth now filters by that
`relativePath`; the case was re-run on both arms (3/3 each).

The agents' sessions themselves are ~170k input tokens (plugin rules, tool
list); the response shape moves that by <2%, so the token gate is measured on
the answers alone, below.

## Tokens

The six TaxDome probes of the first measurement (2026-10-23), captured from both
builds at the same moment as what the model receives: compact
`structuredContent` for search tools, the text block for `get_callers`. Counted
with the Claude tokenizer (`claude -p --model haiku` usage, empty-prompt
baseline 559 subtracted).

| Probe           | row (compact records) |   columnar |          Δ |
| --------------- | --------------------: | ---------: | ---------: |
| `semantic_meta` |                11 660 |      6 844 |     −41.3% |
| `semantic_code` |                14 676 |      7 284 |     −50.4% |
| `hybrid_usages` |                31 947 |     26 920 |     −15.7% |
| `rank_hotspots` |                32 830 |     16 092 |     −51.0% |
| `callers`       |                 3 951 |      2 641 |     −33.2% |
| `outline`       |                 9 256 |      8 205 |     −11.4% |
| **Total**       |           **104 320** | **67 986** | **−34.8%** |

`callers` on `row` is pretty-printed text (`JSON.stringify(x, null, 2)`), so its
delta combines compact output and the table. `outline` and `hybrid_usages` gain
least: their rows carry long `content` / `imports` cells the table does not
shorten.

## All read tools

Every non-mutating tool of `tools/list` (25 calls; `find_symbol` in its four
modes), TaxDome index, both builds, same Claude-token count. `columnar` is the
branch with the two-row threshold (`3eff6ac85`).

| Call                         |         row |    columnar |          Δ |
| ---------------------------- | ----------: | ----------: | ---------: |
| `get_architecture_report`    |     144 819 |     107 444 |     −25.8% |
| `find_cycles`                |      65 099 |      57 984 |     −10.9% |
| `list_projects`              |      41 709 |      31 320 |     −24.9% |
| `rank_chunks`                |      32 830 |      16 092 |     −51.0% |
| `hybrid_search`              |      32 139 |      27 010 |     −16.0% |
| `get_index_metrics`          |      15 609 |      10 601 |     −32.1% |
| `semantic_search` (content)  |      14 765 |      11 013 |     −25.4% |
| `semantic_search` (metaOnly) |      11 623 |       8 279 |     −28.8% |
| `get_callers` (symbol)       |      11 472 |       8 333 |     −27.4% |
| `get_ontology_report`        |      10 564 |       6 970 |     −34.0% |
| `find_symbol` (class)        |       9 242 |       8 191 |     −11.4% |
| `find_similar`               |       7 828 |       4 460 |     −43.0% |
| `review_changes`             |       5 978 |       4 249 |     −28.9% |
| `find_co_changed`            |       5 277 |       3 143 |     −40.4% |
| `search_code`                |       4 123 |       4 123 |         0% |
| `find_symbol` (file)         |       4 060 |       4 060 |         0% |
| `get_callers` (file)         |       3 951 |       2 641 |     −33.2% |
| `get_callees` (file)         |       2 148 |       1 408 |     −34.5% |
| `get_index_status`           |       1 856 |       1 856 |         0% |
| `find_symbol` (method)       |       1 234 |       1 234 |         0% |
| `get_naming_lexicon`         |       1 098 |         737 |     −32.9% |
| `find_symbol` (doc TOC)      |         993 |         993 |         0% |
| `list_collections`           |         683 |         541 |     −20.8% |
| `get_callees` (symbol)       |         584 |         413 |     −29.3% |
| `trace_path`                 |         417 |         316 |     −24.2% |
| **Total**                    | **430 101** | **323 411** | **−24.8%** |

Before the threshold, the one-row `find_symbol` answers grew (method +27%, doc
TOC +17%, file outline +10%); they now ship the record unchanged. `search_code`
and `get_index_status` are prose, not JSON, and do not change. Graph and report
tools gain least where their records are already short or carry nested arrays,
which stay cells.

The same `semantic_search` calls gave −41…−50% in the six-probe run above and
−25…−29% here: on TaxDome the working-tree overlay mixes rows from the
uncommitted tree, so the answer set differs between runs. Both series are kept.

## Reproduce

```bash
git archive 59f815339 | tar -x -C /tmp/base && ln -s "$PWD/node_modules" /tmp/base/
(cd /tmp/base && npx tsc && npx tsx scripts/copy-build-assets.ts)
npm run build
ARMS="row=/tmp/base,columnar=$PWD" TREE=$PWD RUNS=3 CONC=4 \
  npx tsx scripts/columnar-response-eval.ts
```

`CASES=<id,id>` limits the run to some cases; `OUT=<dir>` moves the results
(default `results/` beside this file, not committed).

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Result: no runnable cases. The 12 cases in `cases.json` (36/36 recorded on
  both arms) need live tea-rags calls and answer extraction from real columnar
  responses; the Task 12 runner protocol is plan-only (no tool execution), so
  nothing was run.
- Last recorded with-skill rate: 100% (36/36). Delta: n/a.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).
