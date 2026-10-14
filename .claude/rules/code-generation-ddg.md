---
paths:
  - "src/**"
  - "tests/**"
  - "scripts/**"
  - ".claude-plugin/**/*.ts"
  - ".claude-plugin/**/*.mjs"
  - ".claude-plugin/**/*.sh"
---

# All code is written through data-driven-generation (MANDATORY)

Owner decision 2026-10-13 (bd tea-rags-mcp-89k7k.1.19), scoped 2026-10-14. Code
is written through `/tea-rags:data-driven-generation` (DDG) at three points: at
the start of a session, before a bug fix once the defect is located, and before
every new task. This binds the main session and every subagent alike.

One-line and few-line mechanical edits (applying a detector remedy, a retarget,
a rename) skip the DDG workflow. They do NOT skip the gate: `review_changes`
still runs before the commit and its findings are repaired.

## What that means in practice

- Before the first edit of a task (the three points above), invoke the DDG skill
  and follow its steps: context from tea-rags (reuse what this session already
  fetched — never re-search a file whose outline or body is already in the
  conversation unless it was edited since), proven templates, naming through
  `get_naming_lexicon`, then write.
- DDG Step 7 (VERIFY) is a gate, not optional. `review_changes` runs before
  every commit and acts on the findings: introduced architecture findings are
  repaired (the per-family procedure lives in
  `.claude-plugin/tea-rags/repair/<family>.md`, loaded only for a family that
  has a finding), pre-existing ones are repaired only when cheap, false
  positives are accepted only with evidence (a detector flag or a cited rule)
  plus a filed detector bead. A PARTIAL review is not a pass. After two repair
  rounds with introduced findings left, stop and ask the user — never commit
  around them. The hand-back quotes the gate line
  (`GATE review_changes: introduced=0, partial=false`); no gate line, task not
  done.
- Inside this repo, run `review_changes` (and the pre-write
  `get_architecture_report` simulation) from your own checkout's build:
  `node build/cli/index.js call review_changes '<json params>'` — the global MCP
  server process may run older extraction and report false findings (bd
  tea-rags-mcp-2plk2). MCP only when the checkout has no build.
- TDD still applies inside DDG: the red-first test is the first thing DDG writes
  for a behaviour change.

## Subagents

Subagents do not inherit rules. Every implementation subagent prompt carries
this line verbatim:

```
Write all code through /tea-rags:data-driven-generation (invoke it before the
first edit). Its Step 7 GATE runs before every commit: review_changes from your
own build (node build/cli/index.js call review_changes '<json>'; MCP only with
no build), repair introduced findings, quote the GATE line in your report.
Reuse tea-rags results already in your context instead of re-searching.
```

## Not covered

Pure prose (docs, specs, plans, rule files, skill Markdown) is not code; DDG is
not required for it.

## Why

Architecture violations were found and fixed after the fact (epic 89k7k.35 moved
158 report violations to 78 by hand). Repairing them at write time, while the
edge is one line in the agent's own diff, is the cheapest point at which they
will ever be fixed.
