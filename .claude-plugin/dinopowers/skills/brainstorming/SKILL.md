---
name: brainstorming
description:
  Brainstorm a code change while seeing risk, ownership, and tech-debt signals
  from tea-rags first, so creative exploration is grounded in the actual state
  of the affected area. Triggers on "brainstorm X", "design feature", "refactor
  Y", "let's discuss", "давай обсудим", "как перестроить", "что может
  сломаться". NOT for trivial edits or stylistic questions with no code area to
  enrich. Wraps superpowers:brainstorming with a tea-rags risk-signal enrichment
  step.
---

# dinopowers: brainstorming

Wrapper over `superpowers:brainstorming`. Ensures creative exploration starts
from real git signals (hotspots, owners, legacy debt) of the target area — not
from assumptions about how the code looks today.

## Iron Rule

**tea-rags enrichment MUST be called BEFORE `Skill(superpowers:brainstorming)`**
— whenever the target area is identifiable. Correct preset selection
(`hotspots`, `ownership`, `techDebt`) + correct parameters + correct ordering is
the core value of this wrapper.

If no code area is identifiable from the user request (pure conceptual
brainstorming): skip enrichment and invoke `superpowers:brainstorming` directly.
State that explicitly — do not fabricate an area.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — a post-commit hook
auto-reindexes after commits/merges; run `mcp__tea-rags__index_codebase`
manually only to search code edited but not yet committed, BEFORE the first
tea-rags call.

## Step 1 — Extract target area

From the user request identify:

| Element                                        | Example                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| **Area** — path or domain                      | `src/core/domains/ingest/**`, `auth/`, "rerank presets" |
| **Change type** — what the brainstorm is about | "new feature", "refactor", "bug-fix approach"           |
| **Scope hint** — narrower filter if mentioned  | file name, class name, symbol                           |

Compose:

- `pathPattern` for Step 2 (e.g. `**/auth/**`,
  `src/core/domains/ingest/**/chunker/**`)
- `query` — a single sentence describing the change intent

If no area is mentioned or derivable: skip to Step 4 with empty enrichment.
Report "no area identifiable — proceeding without tea-rags enrichment".

## Step 2 — Three tea-rags enrichment calls (four with codegraph)

Run these three `mcp__tea-rags__semantic_search` calls **in parallel** (same
tool call block), each with `metaOnly: true` (we want signals, not content):

| Call          | `rerank` preset      | Why                                                                                                                                 |
| ------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A — Hotspots  | `"hotspots"`         | Bug-prone zones the brainstorm must account for (high churn + recency + bugFix)                                                     |
| B — Ownership | `"ownership"`        | Knowledge silos — single-owner files that need reviewer pairing                                                                     |
| C — Tech debt | `"techDebt"`         | Legacy zones where "just refactor it" hides cost (age + churn + bugFix)                                                             |
| D — Backbone  | `"architecturalHub"` | **Codegraph only** — structural hubs (high `fanIn` / `isHub`) the design must respect; a change to a backbone has wide blast radius |

Call D runs ONLY when codegraph is active (prime `## Enrichment` lists
`codegraph.symbols`). When that line is absent, omit Call D — run A/B/C only and
note structural backbone was not assessed (do NOT substitute a similarity-ranked
list as "the hubs"). See search-cascade "Graph navigation".

Exact parameters for each call:

```
project:     <alias from list_projects — RECOMMENDED, omit path when set>
path:        <current project path — fallback when no alias is registered>
query:       <intent sentence from Step 1>
pathPattern: <pathPattern from Step 1>
rerank:      "hotspots" | "ownership" | "techDebt" | "architecturalHub"
limit:       10
metaOnly:    true
```

(`"architecturalHub"` = Call D, codegraph-gated per the note above.)

Do NOT substitute:

| Wrong tool                           | Why wrong                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `mcp__tea-rags__hybrid_search`       | Preset-based reranking is tied to `semantic_search`; `hybrid` ignores risk presets |
| `mcp__tea-rags__find_similar`        | Requires an existing symbolId; brainstorm targets an area, not a known symbol      |
| `mcp__tea-rags__find_symbol`         | Returns one symbol; brainstorming needs area-wide risk distribution                |
| Running the three calls sequentially | Wastes time; they are independent — issue them in one parallel block               |

Do NOT pass:

- `metaOnly: false` — content is not needed; larger payloads slow the wrapper
- Custom `rerank` weights instead of the three named presets — loses the
  calibrated risk-assessment semantics
- `filter` on `git.ageDays` / `git.commitCount` — the presets already encode
  these signals; adding filters shrinks the result set and hides debt

If all three calls return 0 results (area is new, untouched by git): report "no
git-enriched results for pathPattern `<X>` — area is new or excluded from
indexing" and skip to Step 4 without enrichment block. Do NOT fabricate signals.

## Step 3 — Build enrichment block

From the three result sets, compose a compact block (max ~15 lines):

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
```

Cap each section at 3 entries. If a file appears in multiple sections, note it
explicitly (`→ also in Hotspots`) — overlap is a strong brainstorming signal. Do
NOT paste raw JSON. Extract readable `relativePath` + 2-3 key signals per entry.

## Step 4 — Invoke superpowers:brainstorming

Invoke the `Skill` tool with `superpowers:brainstorming`. Prepend the enrichment
block from Step 3 as context. Phrase the handoff as:

> "Before exploring, note these risk signals in the target area: …<block>… Use
> them to pressure-test ideas — especially around the hotspot files.
>
> Chaining rule reminder: if your cycle would next invoke a `superpowers:Y`
> skill (writing-plans, test-driven-development, etc.), invoke the
> `dinopowers:Y` wrapper instead when one exists — see the Chaining rule section
> above."

Let `superpowers:brainstorming` run its full exploration cycle — this wrapper
does not replace it, only grounds it.

## Red Flags — STOP and restart from Step 2

- "I already know which files are hotspots here" → run Step 2 anyway; memory is
  stale
- "tea-rags is slow for 3 calls, let me do one" → three presets are different
  lenses; one call loses two of them
- Substituted `hybrid_search` / `find_similar` / `find_symbol` → redo with
  `semantic_search` + preset
- Ran the three calls sequentially → reissue as parallel (same tool block)
- Invoked `superpowers:brainstorming` first, tea-rags after as "validation" →
  wrong order, restart
- Set `metaOnly: false` to "see content" → unnecessary; restart with
  `metaOnly: true`
- Let `superpowers:brainstorming` chain into a raw `superpowers:Y` (e.g.
  `superpowers:writing-plans`) without redirecting to `dinopowers:Y` → intercept
  and invoke the wrapper instead (see Chaining rule)

## Common Mistakes

| Mistake                                                     | Reality                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Skip tea-rags because "brainstorming is abstract"           | If the user named a code area, it's not abstract. Enrich it.                   |
| Use `rerank: "relevance"` instead of the three risk presets | Loses the point — brainstorming should see risk, not just relevance            |
| Collapse three calls into one with custom weights           | Custom weights ≠ calibrated presets; output is noisy and hard to interpret     |
| Paste raw `results[]` JSON into Step 4 handoff              | `superpowers:brainstorming` drowns in noise; extract 3 entries per lens        |
| Fabricate an area when user didn't name one                 | Explicit "no area — skipping enrichment" is honest; faked pathPattern is a lie |
