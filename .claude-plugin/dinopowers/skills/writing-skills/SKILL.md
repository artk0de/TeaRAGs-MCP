---
name: writing-skills
description:
  Author/rewrite SKILL.md inside .claude-plugin/dinopowers/, enforce wrapper
  pattern (tea-rags enrichment step then chain into superpowers:*) + description
  style to win against parent skills. Triggers on "add dinopowers:X", "create a
  wrapper skill", "write a SKILL.md", "напиши скилл", "новый wrapper", "новый
  dinopowers скилл", "edit dinopowers wrapper", "rewrite dinopowers SKILL.md",
  "fix skill description", "improve a dinopowers skill", "tweak SKILL.md
  frontmatter". NOT for SKILL.md files outside .claude-plugin/dinopowers/. Wraps
  superpowers:writing-skills with dinopowers wrapper-pattern enforcement.
---

# dinopowers: writing-skills

Wrapper over `superpowers:writing-skills`. New dinopowers skills inherit
structural conventions + **correct tea-rags invocation patterns** from indexed
SKILL.md corpus, not invented.

## Iron Rule

**`mcp__tea-rags__semantic_search` MUST be called BEFORE
`Skill(superpowers:writing-skills)`.**

Core value of every dinopowers wrapper = correct tea-rags tool + params +
ordering — this skill bootstraps that for all future wrappers.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

## Step 1 — Extract intent

From request identify:

| Element                        | Example                          |
| ------------------------------ | -------------------------------- |
| **Verb** — what the skill does | "wraps", "enriches", "detects"   |
| **Object** — what it acts on   | "brainstorming", "test patterns" |
| **Trigger** — when it fires    | "before code modification"       |

Compose single-sentence intent → Step 2 `query`.

## Step 2 — Search existing skill patterns (tea-rags)

`mcp__tea-rags__semantic_search` with exactly:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
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

- `rerank` preset — want pure semantic similarity; git bias (techDebt, hotspots,
  ownership) irrelevant for skill authoring
- `filter` with git signals — SKILL.md history doesn't inform patterns
- `testFile: "exclude"` or similar — SKILL.md files aren't tests

0 results / empty index → report
`"no SKILL.md corpus indexed — falling back to direct superpowers:writing-skills"`,
Step 4 without pattern block. NEVER fabricate patterns.

## Step 3 — Extract pattern block

From top-K extract 3-5 bullets (structural signal only, never raw results):

- Frontmatter `description` phrasing convention (e.g. "Use when…" prefix)
- Main section order (Overview → Iron Rule → Steps → Red Flags → Mistakes)
- Step numbering style (numbered vs named)
- Tool-invocation format (parameter tables vs inline code)
- Presence/absence of Red-Flags / Common-Mistakes sections

## Step 4 — Invoke superpowers:writing-skills

Invoke `Skill` tool with `superpowers:writing-skills`. Prepend Step 3 block.
Handoff:

> "Use the structural pattern block as template. When your cycle would next
> invoke `superpowers:writing-plans` / `superpowers:test-driven-development` (or
> any wrapped `superpowers:Y`), invoke the `dinopowers:Y` wrapper instead — see
> the Chaining rule section above."

Inner skill runs RED-GREEN-REFACTOR — wrapper enriches, not replaces.

## Red Flags — STOP and restart from Step 2

- "I already know the SKILL.md format" / "tea-rags slow, skip" → run Step 2
- Used `hybrid_search` / `find_similar` / Grep on SKILL.md → redo with
  `semantic_search`
- Set `rerank` (`techDebt` / `hotspots` / `ownership`) → redo without
- `superpowers:writing-skills` first, tea-rags after as "validation" → wrong
  order, restart
- Writing new SKILL.md without pattern block → revert, restart
- Raw `semantic_search` results passed to inner skill → extract 3-5 bullets
- Inner skill chained raw `superpowers:writing-plans` /
  `superpowers:test-driven-development` → intercept, invoke `dinopowers:Y`
  (Chaining rule)
