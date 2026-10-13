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

Owner decision 2026-10-13 (bd tea-rags-mcp-89k7k.1.19). Every code change in
this repository — new code, modification, refactor, bug fix, test code — is
written through `/tea-rags:data-driven-generation` (DDG). This binds the main
session and every subagent alike.

## What that means in practice

- Before the first edit of a task, invoke the DDG skill and follow its steps:
  context from tea-rags (reuse what this session already fetched — never
  re-search a file whose outline or body is already in the conversation unless
  it was edited since), proven templates, naming through `get_naming_lexicon`,
  then write.
- DDG Step 7 (VERIFY) is not optional. It runs `review_changes` and acts on the
  findings before the commit: introduced architecture findings are repaired (the
  per-family procedure lives in `.claude-plugin/tea-rags/repair/<family>.md`,
  loaded only for a family that has a finding), pre-existing ones are repaired
  only when cheap, false positives are accepted only with evidence (a detector
  flag or a cited rule). After two repair rounds with introduced findings left,
  stop and ask the user — never commit around them.
- TDD still applies inside DDG: the red-first test is the first thing DDG writes
  for a behaviour change.

## Subagents

Subagents do not inherit rules. Every implementation subagent prompt carries
this line verbatim:

```
Write all code through /tea-rags:data-driven-generation (invoke the skill
before the first edit; its Step 7 review_changes fix-at-write loop runs before
every commit). Reuse tea-rags results already in your context instead of
re-searching.
```

## Not covered

Pure prose (docs, specs, plans, rule files, skill Markdown) is not code; DDG is
not required for it.

## Why

Architecture violations were found and fixed after the fact (epic 89k7k.35 moved
158 report violations to 78 by hand). Repairing them at write time, while the
edge is one line in the agent's own diff, is the cheapest point at which they
will ever be fixed.
