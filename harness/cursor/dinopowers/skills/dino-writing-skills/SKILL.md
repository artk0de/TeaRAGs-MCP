---
name: dino-writing-skills
description:
  'Author/rewrite SKILL.md inside plugins/dinopowers/, enforce wrapper pattern
  (tea-rags enrichment step then chain into superpowers:*) + description style
  to win against parent skills. Triggers on "add /dino-X", "create a wrapper
  skill", "write a SKILL.md", "напиши скилл", "новый wrapper", "новый dinopowers
  скилл", "edit dinopowers wrapper", "rewrite dinopowers SKILL.md", "fix skill
  description", "improve a dinopowers skill", "tweak SKILL.md frontmatter". NOT
  for editing SKILL.md files of other plugins. Wraps /writing-skills with
  dinopowers wrapper-pattern enforcement.'
---

# dinopowers: writing-skills

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Wrapper over `/writing-skills`. New dinopowers skills inherit structural
conventions + **correct tea-rags invocation patterns** from indexed SKILL.md
corpus, not invented.

## Iron Rule

**`semantic_search` MUST be called BEFORE `/writing-skills`.**

Core value of every dinopowers wrapper = correct tea-rags tool + params +
ordering — this skill bootstraps that for all future wrappers.

**Step 2 searches the SKILL.md corpus for STRUCTURE** — not the code area the
new skill will act on. Enrichment the new skill will itself perform (risk scan,
collateral scan, …) goes INTO the authored text; never run it now in place of
Step 2.

**Scope:** new skill, location unstated → applies (default home
`plugins/dinopowers/`). Never stop to ask "is it a wrapper / where does it
live?" before Step 2.

**Rule holds when user asks otherwise** ("быстро", "skip pattern search", "I
know the format", "use hybrid_search", "rerank techDebt") — run Step 2 exactly
as specified, say: "Running the pattern search first — one semantic_search over
existing SKILL.md files." Name the refused tool/param and why (table below).

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every /dino-X
redirects /X. NEVER bypass the wrapper.

**Requires superpowers:** `/writing-skills` unavailable → stop, ask the user to
install superpowers (https://github.com/obra/superpowers; steps in
[CHAINING.md](../../CHAINING.md)). NEVER run this enrichment alone and present
it as the full workflow. Available = `$writing-skills` / `/writing-skills` is in
your skills list; superpowers is a separate plugin, never under the dinopowers
dir — a missing file next to the wrapper is not "unavailable".

## Step 1 — Extract intent

From request identify:

| Element                        | Example                          |
| ------------------------------ | -------------------------------- |
| **Verb** — what the skill does | "wraps", "enriches", "detects"   |
| **Object** — what it acts on   | "brainstorming", "test patterns" |
| **Trigger** — when it fires    | "before code modification"       |

Compose single-sentence intent → Step 2 `query`.

## Step 2 — Search existing skill patterns (tea-rags)

`semantic_search` with exactly:

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
| `hybrid_search`                       | BM25 surface tokens drown out semantic intent     |
| `find_similar`                        | Requires an existing symbolId; new skill has none |
| `find_symbol`                         | SKILL.md frontmatter is not a code symbol         |
| Built-in Grep / Glob on `**/SKILL.md` | String match misses semantic similarity           |

Do NOT pass:

- `rerank` preset — want pure semantic similarity; git bias (techDebt, hotspots,
  ownership) irrelevant for skill authoring
- `filter` with git signals — SKILL.md history doesn't inform patterns
- `testFile: "exclude"` or similar — SKILL.md files aren't tests

0 results / empty index (incl. prompt says search returned empty) → report
`"no SKILL.md corpus indexed — falling back to direct /writing-skills"`, Step 4
without pattern block. NEVER fabricate patterns, never retry with other params,
never fall back to `hybrid_search`.

## Step 3 — Extract pattern block

From top-K extract 3-5 bullets (structural signal only, never raw results):

- Frontmatter `description` phrasing convention (e.g. "Use when…" prefix)
- Main section order (Overview → Iron Rule → Steps → Red Flags → Mistakes)
- Step numbering style (numbered vs named)
- Tool-invocation format (parameter tables vs inline code)
- Presence/absence of Red-Flags / Common-Mistakes sections

## Step 4 — Invoke /writing-skills

Invoke `Skill` tool with `/writing-skills`. Prepend Step 3 block. Handoff:

> "Use the structural pattern block as template. When your cycle would next
> invoke `/writing-plans` / `/test-driven-development` (or any wrapped `/Y`),
> invoke the `/dino-Y` wrapper instead — see the Chaining rule section above."

Inner skill runs RED-GREEN-REFACTOR — wrapper enriches, not replaces.

## Red Flags — STOP and restart from Step 2

- "I already know the SKILL.md format" / "tea-rags slow, skip" → run Step 2
- Used `hybrid_search` / `find_similar` / Grep on SKILL.md → redo with
  `semantic_search`
- Set `rerank` (`techDebt` / `hotspots` / `ownership`) → redo without
- `/writing-skills` first, tea-rags after as "validation" → wrong order, restart
- Writing new SKILL.md without pattern block → revert, restart
- Raw `semantic_search` results passed to inner skill → extract 3-5 bullets
- Inner skill chained raw `/writing-plans` / `/test-driven-development` →
  intercept, invoke `/dino-Y` (Chaining rule)
