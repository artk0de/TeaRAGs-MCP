---
name: writing-skills
description:
  Use when creating a new SKILL.md inside .claude-plugin/dinopowers/ or
  substantially rewriting an existing dinopowers wrapper skill. Triggers on
  phrases like "create a wrapper skill", "add dinopowers:X", "write SKILL.md for
  X", or when a plan step requires authoring a dinopowers wrapper over
  superpowers:*.
---

# dinopowers: writing-skills

Wrapper over `superpowers:writing-skills`. Ensures new dinopowers skills inherit
structural conventions and **correct tea-rags invocation patterns** from the
indexed SKILL.md corpus, instead of being invented from scratch.

## Iron Rule

**`mcp__tea-rags__semantic_search` MUST be called BEFORE
`Skill(superpowers:writing-skills)`.**

Correct tea-rags tool + correct parameters + correct ordering is the entire
point of this wrapper. The core value of every dinopowers wrapper is correct
tea-rags tool selection — this skill bootstraps that correctness for all future
wrappers.

## Chaining rule (MANDATORY)

When the wrapped `superpowers:` skill runs its cycle it may instruct you to
invoke another `superpowers:Y` skill next (TDD after planning, verification
after editing, review after completion, etc.). **Redirect every such onward
`Skill(superpowers:Y)` call to `Skill(dinopowers:Y)` whenever a `dinopowers:Y`
wrapper exists.**

Wrapped skills — use the `dinopowers:` form, NOT `superpowers:`:

- `dinopowers:brainstorming`
- `dinopowers:executing-plans`
- `dinopowers:finishing-a-development-branch`
- `dinopowers:receiving-code-review`
- `dinopowers:requesting-code-review`
- `dinopowers:systematic-debugging`
- `dinopowers:test-driven-development`
- `dinopowers:verification-before-completion`
- `dinopowers:writing-plans`
- `dinopowers:writing-skills`

Why: each `dinopowers:Y` wrapper injects tea-rags signals (ownership, churn,
imports, bugFixRate, risk tiers) BEFORE the inner skill runs. A direct
`superpowers:Y` call skips that enrichment — exactly what this wrapper layer
prevents.

Only invoke `superpowers:Y` directly when Y is NOT in the list above (e.g.
`superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`).

## Step 1 — Extract intent

From the user request identify three elements:

| Element                        | Example                          |
| ------------------------------ | -------------------------------- |
| **Verb** — what the skill does | "wraps", "enriches", "detects"   |
| **Object** — what it acts on   | "brainstorming", "test patterns" |
| **Trigger** — when it fires    | "before code modification"       |

Compose a single-sentence intent. This becomes the `query` in Step 2.

## Step 2 — Search existing skill patterns (tea-rags)

Call `mcp__tea-rags__semantic_search` with these exact parameters:

```
path:        <current project path>
query:       <intent sentence from Step 1>
pathPattern: "**/SKILL.md"
limit:       8
```

Do NOT substitute:

| Wrong tool                            | Why wrong                                         |
| ------------------------------------- | ------------------------------------------------- |
| `mcp__tea-rags__hybrid_search`        | BM25 surface tokens drown out semantic intent     |
| `mcp__tea-rags__find_similar`         | Requires an existing symbolId; new skill has none |
| `mcp__tea-rags__find_symbol`          | SKILL.md frontmatter is not a code symbol         |
| Built-in Grep / Glob on `**/SKILL.md` | String match misses semantic similarity           |

Do NOT pass:

- `rerank` preset — pure semantic similarity is what we want; git bias
  (techDebt, hotspots, ownership) is irrelevant for skill authoring
- `filter` with git signals — SKILL.md git history doesn't inform pattern
  matching
- `testFile: "exclude"` or similar — SKILL.md files aren't tests

If `semantic_search` returns 0 results or the index is empty: report
`"no SKILL.md corpus indexed — falling back to direct superpowers:writing-skills"`
and skip to Step 4 without a pattern block. Do NOT fabricate patterns.

## Step 3 — Extract pattern block

From top-K results extract as 3-5 concise bullets:

- Frontmatter `description` phrasing convention (e.g. "Use when…" prefix)
- Main section order (Overview → Iron Rule → Steps → Red Flags → Mistakes)
- Step numbering style (numbered vs named)
- Tool-invocation format (parameter tables vs inline code)
- Presence/absence of Red-Flags / Common-Mistakes sections

Do NOT paste raw search results into the next step. Extract the structural
signal only.

## Step 4 — Invoke superpowers:writing-skills

Invoke the `Skill` tool with `superpowers:writing-skills`. Prepend the pattern
block from Step 3 as context. Phrase the handoff as:

> "Use the structural pattern block as template. When your cycle would next
> invoke `superpowers:writing-plans` / `superpowers:test-driven-development` (or
> any wrapped `superpowers:Y`), invoke the `dinopowers:Y` wrapper instead — see
> the Chaining rule section above."

Let `superpowers:writing-skills` run its RED-GREEN-REFACTOR cycle — this wrapper
does not replace it, only enriches it.

## Red Flags — STOP and restart from Step 2

- "I already know the SKILL.md format" → run Step 2 anyway
- "tea-rags is slow, let me skip it" → run Step 2
- Used `hybrid_search` / `find_similar` / Grep on SKILL.md → redo with
  `semantic_search`
- Called `superpowers:writing-skills` first, tea-rags after as "validation" →
  wrong order, restart
- Started writing the new SKILL.md without a pattern block → revert, restart
- Let `superpowers:writing-skills` chain into a raw `superpowers:writing-plans`
  / `superpowers:test-driven-development` without redirecting to the
  `dinopowers:Y` wrapper → intercept and invoke the wrapper instead (see
  Chaining rule)

## Common Mistakes

| Mistake                                                            | Reality                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Call `Skill(superpowers:writing-skills)` directly without tea-rags | New skill won't match project conventions. Defeats the wrapper. |
| Use `hybrid_search` for SKILL.md discovery                         | Token-level ranking returns noise, not structural analogs       |
| Set `rerank: "techDebt"` / `"hotspots"` / `"ownership"`            | SKILL.md churn/authors irrelevant to new skill authoring        |
| Pass raw `semantic_search` results to `superpowers:writing-skills` | Too noisy. Extract 3-5 structural bullets first                 |
| Fabricate a pattern block when index returns 0 results             | Lie. Fallback explicitly.                                       |
