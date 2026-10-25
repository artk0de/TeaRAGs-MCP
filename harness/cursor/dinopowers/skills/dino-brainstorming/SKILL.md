---
name: dino-brainstorming
description:
  'Brainstorm code change seeing risk, ownership, tech-debt signals from
  tea-rags first — creative exploration grounded in actual state of affected
  area. Triggers on "brainstorm X", "design feature", "redesign Y", "let''s
  discuss", "давай обсудим", "как перестроить", "что может сломаться". NOT
  research before refactor (→ explore PRE-GEN), NOT trivial edits with no code
  area. Wraps /brainstorming with tea-rags risk signals.'
---

# dinopowers: brainstorming

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Wrapper over `/brainstorming`. Exploration starts from real git signals
(hotspots, owners, legacy debt) of target area — not assumptions.

## Iron Rule

**tea-rags enrichment MUST run BEFORE `/brainstorming`** when target area
identifiable. Right presets (`hotspots`, `ownership`, `techDebt`) + right
params + right order = wrapper's value.

No code area identifiable (pure conceptual) → skip enrichment, invoke
`/brainstorming` directly, say so explicitly. Never fabricate area.

**Chaining rule:** [CHAINING.md](../../CHAINING.md) — every onward `/Y` →
`/dino-Y`. NEVER bypass wrapper.

**Requires superpowers:** `/brainstorming` — availability per
[CHAINING.md](../../CHAINING.md) "Missing superpowers" steps 1–3. Not in the
skills list ≠ unavailable (the list is truncated): read
`$CODEX_HOME/plugins/cache/*/superpowers/*/skills/brainstorming/SKILL.md` first;
only a failed read → stop and ask the user to install superpowers
(https://github.com/obra/superpowers). NEVER present this enrichment alone as
the full workflow.

**Freshness:** [FRESHNESS.md](../../FRESHNESS.md) (owner
`tea-rags://guide/freshness`). Lag ≠ unusable — never Bash `cat`/`grep`/`Read`
over code; `treeState` row → `find_symbol`.

## Step 1 — Extract target area

| Element                                        | Example                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| **Area** — path or domain                      | `src/core/domains/ingest/**`, `auth/`, "rerank presets" |
| **Change type** — what the brainstorm is about | "new feature", "refactor", "bug-fix approach"           |
| **Scope hint** — narrower filter if mentioned  | file name, class name, symbol                           |

Compose `pathPattern` (e.g. `**/auth/**`,
`src/core/domains/ingest/**/chunker/**`) + `query` (one sentence, change
intent).

No area mentioned/derivable → Step 4, empty enrichment. Report "no area
identifiable — proceeding without tea-rags enrichment".

## Step 2 — Codegraph decision, then ONE parallel block (A–E on / A–C off)

**2.0 — decide codegraph state FIRST, state it in output before the block:**
graph tools (`get_callers`, `trace_path`, …) in your tool list → write
"codegraph on (graph tools in my list) → A–E"; absent → "codegraph off → A–C,
backbone + vocabulary not assessed". Unsure → metrics `codegraph on|off`
(below). SessionStart digest never states it — silence ≠ off. No stated decision
= Step 2 not started.

Plan-only with the state not given in the prompt → print BOTH lines, each branch
complete (the off line is never implied by the on line):

```
codegraph on (graph tools in my list) → A–E in one block
codegraph off → A–C in one block; backbone + vocabulary not assessed
```

Then ALL calls **in parallel** (one tool block — D + E in the SAME block as A–C,
never appended after): A–D `semantic_search`, each `metaOnly: true` (signals,
not content); E `get_naming_lexicon`:

| Call           | `rerank` preset                     | Why                                                                                                                                 |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A — Hotspots   | `"hotspots"`                        | Bug-prone zones the brainstorm must account for (high churn + recency + bugFix)                                                     |
| B — Ownership  | `"ownership"`                       | Knowledge silos — single-owner files that need reviewer pairing                                                                     |
| C — Tech debt  | `"techDebt"`                        | Legacy zones where "just refactor it" hides cost (age + churn + bugFix)                                                             |
| D — Backbone   | `"architecturalHub"`                | **Codegraph only** — structural hubs (high `fanIn` / `isHub`) the design must respect; a change to a backbone has wide blast radius |
| E — Vocabulary | `get_naming_lexicon` (not a search) | **Codegraph only** — words the project already uses for the area; SAME parallel block as A–D                                        |

Call D ONLY when codegraph on = graph tools (`get_callers`, `trace_path`, …) in
tool list; unsure → read `tea-rags://project/<alias>/metrics?section=registry`
(`codegraph on|off`). Off → A/B/C only, note backbone not assessed (NEVER pass
similarity-ranked list off as "the hubs"). → `tea-rags://guide/navigation`
"Graph navigation".

**Call E — vocabulary (codegraph only, same parallel block — MANDATORY when
codegraph on; A–D without E = incomplete Step 2):**
`get_naming_lexicon(concept=<Step 1 query>, language, pathPattern)` →
`concept.terms` = words project already uses for area. `concept` = change intent
sentence, NEVER a draft symbol name. `language` = area's language from its path
/ project stack; unsure → still run E, never skip it over a language-capability
doubt. Output → "Project vocabulary" line in the block + handoff rule (names[]
check). Reading: `/data-driven-generation` Step 5 "Naming (lexicon)".

Exact parameters per call:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
query:       <intent sentence from Step 1>
pathPattern: <pathPattern from Step 1>
rerank:      "hotspots" | "ownership" | "techDebt" | "architecturalHub"
limit:       10
metaOnly:    true
```

(`"architecturalHub"` = Call D, codegraph-gated per the note above.)

Do NOT substitute:

| Wrong tool                     | Why wrong                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `hybrid_search`                | Same rerank, but its BM25 leg re-ranks by query-token overlap — signal scan wants semantic + signals |
| `find_similar`                 | Requires an existing symbolId; brainstorm targets an area, not a known symbol                        |
| `find_symbol`                  | Returns one symbol; brainstorming needs area-wide risk distribution                                  |
| Running the calls sequentially | Wastes time; they are independent — issue them in one parallel block                                 |

Do NOT pass:

- `metaOnly: false` — content unneeded, payload bloats. User asks to SEE content
  → enrichment stays `metaOnly: true`; content = separate call AFTER Step 2:
  `find_symbol relativePath=<row.relativePath>` (outline → drill ids)
- custom `rerank` weights instead of named presets — loses calibrated semantics
- `filter` on `git.ageDays` / `git.commitCount` — presets encode them; filters
  shrink set, hide debt

All risk calls 0 results (new / unindexed area) → report "no git-enriched
results for pathPattern `<X>` — area is new or excluded from indexing", Step 4
without block. NEVER fabricate signals.

## Step 3 — Build enrichment block

Compact block (max ~15 lines):

```
### tea-rags enrichment for <pathPattern>

**Hotspots (bug-prone):**
- <relativePath>:<startLine>-<endLine> — bugFixRate <N>, commitCount <N>, ageDays <N>
- ... (top 3)

**Knowledge silos (single live-line owner):**
- <relativePath> — <blameDominantAuthor> (<blameDominantAuthorPct>%), <commitCount> commits
- ... (top 3)

**Tech debt (legacy + churn):**
- <relativePath> — ageDays <N>, commitCount <N>, relativeChurn <X>
- ... (top 3)

**Project vocabulary (Call E):** <term> (<holder>), ... (top 5)
```

Cap 3 per section. File in several sections → mark (`→ also in Hotspots`) —
overlap = strong signal. No raw JSON; `relativePath` + 2-3 key signals per
entry. Values: `rankingOverlay.{file,chunk}.<field>` (preset-surfaced,
labelled); metaOnly `git.*` = essentials only (commitCount, ageDays, taskIds,
blame\*), raw. File-level presets (ownership, architecturalHub) → no startLine.

**Done-check before Step 4 (codegraph on) — state all three, else Step 2/3
incomplete:** (1) E issued in the same parallel block as A–D; (2) block carries
"Project vocabulary" line from `concept.terms`; (3) handoff carries the names[]
rule — every new-symbol name the design proposes → `get_naming_lexicon(names)`
before it is fixed.

## Step 4 — Invoke /brainstorming

Invoke `Skill` tool with `/brainstorming`. Prepend enrichment block from Step 3
as context. Phrase handoff as:

> "Before exploring, note these risk signals in the target area: …<block>… Use
> them to pressure-test ideas — especially around the hotspot files. A name the
> design proposes for a new symbol goes through
> `get_naming_lexicon(names, language)` before the design fixes it: `MISFIT` →
> take `suggestion`; `NEW_TERM` → a vocabulary term if it means the same,
> otherwise justify the new word.
>
> Chaining rule reminder: if your cycle would next invoke a `/Y` skill
> (writing-plans, test-driven-development, etc.), invoke the `/dino-Y` wrapper
> instead when one exists — see the Chaining rule section above."

`/brainstorming` runs full cycle — wrapper grounds, never replaces.

## Red Flags — STOP, restart from Step 2

- "I know the hotspots here" → run Step 2; memory stale
- "3 calls slow, do one" → presets = different lenses; one loses two
- Custom weights / `rerank: "relevance"` instead of risk presets → redo
- `hybrid_search` / `find_similar` / `find_symbol` substituted → redo with
  `semantic_search` + preset
- Calls sequential → reissue parallel
- Block issued without stated codegraph decision, or graph tools in list but
  only A–C → add D + E in the same block, restate
- `/brainstorming` first, tea-rags after as "validation" → wrong order, restart
- `metaOnly: false` "to see content" → restart with `metaOnly: true`
- Raw `results[]` JSON in handoff → extract 3 entries per lens
- User named area but skipped as "abstract" → enrich it
- Inner cycle chains raw `/Y` → intercept, invoke `/dino-Y`
