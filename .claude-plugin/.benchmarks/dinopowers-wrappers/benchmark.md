# Benchmark — dinopowers wrappers

## Summary

| Metric                                | Value                                          |
| ------------------------------------- | ---------------------------------------------- |
| Date                                  | 2026-04-29                                     |
| Skills optimized                      | 10 (all dinopowers wrappers)                   |
| Eval cases                            | 15 (9 audit + 2 subagent + 2 control + 2 edge) |
| Honest baseline (CLAUDE.md respected) | **6/15 PASS (40.0%)**                          |
| After fix                             | **15/15 PASS (100%)**                          |
| Delta                                 | **+60pp**                                      |
| Iterations                            | 1 (target hit on first verify)                 |
| Plugin version                        | 0.13.1 → 0.14.0                                |

## Problem

User reported: "агент все еще предпочитает superpowers". The dinopowers wrappers
exist precisely to inject tea-rags signals before chaining into `superpowers:*`,
but in main sessions the agent kept picking the parent skill directly, bypassing
enrichment entirely.

## Root causes (Phase 1 audit, all confirmed by Phase 2 eval)

| #     | Finding                                                                                                                                                                                        | Root cause                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A     | Conditional vs imperative                                                                                                                                                                      | dinopowers descriptions use "Use when X has Y" while superpowers use "You MUST use this"   |
| B     | Self-defeating description                                                                                                                                                                     | Each wrapper said "Triggers when superpowers:X would fire AND..." — advertises the parent  |
| C     | Fall-back exits in description                                                                                                                                                                 | "NOT for X — use superpowers:Y directly" pushes the router toward the parent on edge cases |
| D     | Length / density                                                                                                                                                                               | dinopowers ~80 words of conditions; superpowers ~15 words of imperative                    |
| E     | PreToolUse hook only fires on `Agent`                                                                                                                                                          | Subagents got the routing block; main session did not                                      |
| F     | No "preferred over X" marker anywhere visible to the router                                                                                                                                    |
| G     | Russian triggers only present in `brainstorming`; the other 9 wrappers were English-only                                                                                                       |
| H     | No "USE INSTEAD OF superpowers:X" phrasing — the strongest possible steering signal was absent                                                                                                 |
| **I** | **(NEW, critical)** Global `~/.claude/CLAUDE.md` names `superpowers:brainstorming` and `superpowers:test-driven-development` as MANDATORY; dinopowers is mentioned nowhere in user-level rules |

## Fix bundle

### 1. Rewrote all 10 descriptions (`skills/*/SKILL.md` frontmatter)

Each description now follows the same template:

```
USE INSTEAD OF superpowers:<X> whenever <broad imperative trigger>.
This wrapper <one-sentence value prop> BEFORE <handoff>, then chains into
superpowers:<X>. Triggers on "<en-1>", "<en-2>", "<ru-1>", "<ru-2>", ...
Always prefer this over superpowers:<X>.
```

Removed:

- "Triggers when superpowers:X would fire AND..." (anti-marketing)
- "NOT for X — use superpowers:Y directly" (router exits)

Added:

- Russian trigger phrases in all 9 wrappers (was: only in `brainstorming`)
- "USE INSTEAD OF superpowers:X" lead
- "Always prefer this over superpowers:X" close

### 2. New `UserPromptSubmit` hook

`scripts/inject-main-session-routing.sh` injects the wrapper-routing table into
every main-session user prompt. Closes finding E — the existing
`PreToolUse(Agent)` hook only saw subagent prompts.

Registered in `.claude-plugin/plugin.json` alongside the existing
`PreToolUse(Agent)` hook.

### 3. New project rule `rules/wrapper-priority.md`

Explicit mapping table (dinopowers → superpowers) plus the rationale for why the
wrapper takes priority even when global CLAUDE.md names the parent directly.
Closes finding I — gives the agent a project-level signal that overrides the
global rule's naming.

### 4. Version bump

`.claude-plugin/plugin.json`: 0.13.1 → 0.14.0 (multiple skills + new hook =
minor per `.claude/rules/plugin-versioning.md`).

## Iterations

| #   | Configuration                                            | PASS             | Delta                              |
| --- | -------------------------------------------------------- | ---------------- | ---------------------------------- |
| 0a  | Original + curated 18-skill list, no CLAUDE.md weighting | 15/15 (100%)     | — _(unrealistic — selection bias)_ |
| 0b  | Original + full context + CLAUDE.md respected            | **6/15 (40%)**   | — _(honest baseline)_              |
| 1   | Fix bundle applied                                       | **15/15 (100%)** | **+60pp**                          |

The first run (0a) showed 100% PASS and looked like the skills were fine — that
turned out to be a methodology error: when only the 18 wrapper-vs-parent
descriptions are listed in isolation, the dinopowers descriptions match the
prompts more specifically and win. The realistic context — full skill list +
global CLAUDE.md naming `superpowers:*` — exposed the actual 40% failure rate.
This is what "agent still prefers superpowers" actually meant in practice.

## Per-eval detail

| ID  | Prompt (truncated)                                             | Expected                   | Baseline-realistic     | After-fix |
| --- | -------------------------------------------------------------- | -------------------------- | ---------------------- | --------- |
| 1   | "Давай обсудим новую фичу для chunker/"                        | dinopowers:brainstorming   | FAIL → superpowers     | PASS      |
| 2   | "fix off-by-one bug ... write failing test first"              | dinopowers:tdd             | FAIL → superpowers     | PASS      |
| 3   | "execute first Task of plan ... modifies strategies/\*.ts"     | dinopowers:executing-plans | FAIL → superpowers     | PASS      |
| 4   | "Падает тест ... Cannot read property of undefined"            | dinopowers:debug           | FAIL → superpowers     | PASS      |
| 5   | "Готов закоммитить ... проверь перед commit"                   | dinopowers:verification    | FAIL → superpowers     | PASS      |
| 6   | "Напиши implementation plan для рефакторинга dto/"             | dinopowers:writing-plans   | FAIL → superpowers     | PASS      |
| 7   | "Готовлю PR ... собери review request с диффом"                | dinopowers:requesting      | FAIL → superpowers     | PASS      |
| 8   | "Reviewer suggested renaming EnrichmentCoordinator.process()"  | dinopowers:receiving       | FAIL → superpowers     | PASS      |
| 9   | "Branch ready — decide: merge / PR / cleanup"                  | dinopowers:finishing       | FAIL → superpowers     | PASS      |
| 10  | "[subagent: explore] Investigate trajectory/git/ — risk areas" | dinopowers:brainstorming   | PASS (PreToolUse hook) | PASS      |
| 11  | "[subagent: task-agent] Execute Task 3 ... edit sync/\*.ts"    | dinopowers:executing-plans | PASS (PreToolUse hook) | PASS      |
| 12  | "Fix the typo in line 42 of README.md"                         | no skill                   | PASS                   | PASS      |
| 13  | "brainstorm distributed systems in general — no code area"     | superpowers:brainstorming  | PASS                   | PASS      |
| 14  | "Show me git log for last 5 commits"                           | no skill                   | PASS                   | PASS      |
| 15  | "Add new dinopowers:reviewing-architecture-doc wrapper"        | dinopowers:writing-skills  | PASS                   | PASS      |

## Files changed

| Path                                                               | Change                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `.claude-plugin/dinopowers/skills/*/SKILL.md` × 10                 | Frontmatter description rewritten                         |
| `.claude-plugin/dinopowers/scripts/inject-main-session-routing.sh` | NEW — UserPromptSubmit hook                               |
| `.claude-plugin/dinopowers/.claude-plugin/plugin.json`             | Version 0.13.1 → 0.14.0; UserPromptSubmit hook registered |
| `.claude-plugin/dinopowers/rules/wrapper-priority.md`              | NEW — explicit override of global CLAUDE.md naming        |

## Key design decisions

1. **Three layers of redundancy**, not one. Description-only fix would still
   lose to the global CLAUDE.md mention; hook-only fix would not fix subagents
   that bypass the hook (e.g., agents spawned via SDK); rule-only fix would not
   steer the description router. All three together close findings A-I.

2. **"USE INSTEAD OF" is the only phrasing** that consistently outranks "You
   MUST use" in the realistic eval. Tested in iteration design before commit.

3. **No body-text edits** to any of the 10 SKILL.md bodies — they were already
   correct and well-tested. Only the frontmatter `description` field was
   changed. Per project rule "do NOT rewrite existing tests/code unless logic
   changed", same logic applied to skill bodies.

4. **Version 0.14.0** (minor) per project's
   `.claude/rules/plugin-versioning.md`: "New skill or rule file → minor bump".
   A new rule file (`rules/wrapper-priority.md`) and a new hook script qualify
   as minor.

## Anti-pattern caught

Phase 2 initial run scored 100% — almost shipped a "no fix needed" verdict. The
error: the curated 18-skill eval context did not include the global CLAUDE.md
mention of `superpowers:*`. Adding the realistic context dropped score to 40%,
exposing the actual failure mode. Lesson: skill-router evals **must** simulate
the agent's full context (global rules + plugin rules + hook injections), not
just the description list.
