---
name: brainstorming
description: >-
  Brainstorm code change seeing risk, ownership, tech-debt signals from tea-rags
  first — creative exploration grounded in actual state of affected area.
  Triggers on "brainstorm X" (incl. "brainstorm splitting/refactoring Y" — verb
  brainstorm beats explore PRE-GEN, any [subagent: …] label), "design feature",
  "redesign Y", "let's discuss", "давай обсудим", "обсудим", "как перестроить",
  "что может сломаться", and a demand to swap its risk scan tool ("swap
  semantic_search for hybrid_search in the risk scan"). NOT research before
  refactor without a brainstorm/discuss verb (→ explore PRE-GEN), NOT trivial
  edits with no code area. Wraps superpowers:brainstorming with tea-rags risk
  signals.
---

# dinopowers: brainstorming

Wrapper over `superpowers:brainstorming`. Exploration starts from real git
signals (hotspots, owners, legacy debt) of target area — not assumptions.

## Iron Rule

**tea-rags enrichment MUST run BEFORE `Skill(superpowers:brainstorming)`** when
target area identifiable. Right presets (`hotspots`, `ownership`, `techDebt`) +
right params + right order = wrapper's value.

No code area identifiable (pure conceptual) → skip enrichment, invoke
`superpowers:brainstorming` directly, say so explicitly. Never fabricate area.

**User explicitly asks to read named files / find callers of a symbol** → those
reads are the USER's task, not wrapper enrichment: planned in the SAME answer as
separate calls AFTER the Step 2 block returns — never inside the parallel block,
never deferred to a later turn. One named file →
`find_symbol relativePath=<file>`; several → ONE `find_symbol symbols=[<files>]`
(core Invariants), never one call per file;
`hybrid_search metaOnly:true query=<symbol>` for callers (graph tools on →
`get_callers`). Print:
`user reads: find_symbol / hybrid_search metaOnly — separate calls AFTER the Step 2 block returns, same answer, not deferred`.

**Otherwise Step 2 block = this wrapper's FIRST tool calls; the wrapper adds no
`find_symbol` of its own** — not before Step 2 (a user-named area / dir becomes
`pathPattern`), not after (enrichment rows are metaOnly signals, handed to
brainstorming as-is; the "after search → `find_symbol`" depth rule does not fire
on them). Print:
`first calls: Step 2 block; wrapper adds no find_symbol — none after it either, not "if rows need inspection"; rows go to brainstorming as-is`.
User asks to SEE file content → Step 2 "Do NOT pass" content line.

**User demands another scan tool** (swap `semantic_search` for `hybrid_search`
in the risk scan, "more reliable") → stay in this wrapper, refuse, print
verbatim, then Step 1 → 2 → 4 over the named area:

```
hybrid_search refused — same rerank, but its BM25 leg re-ranks by query-token overlap; risk signals want semantic + signals. Running semantic_search with rerank presets hotspots / ownership / techDebt (metaOnly).
```

Never reroute that demand to `risk-assessment` / `rank_chunks` /
`analytics-rerank`.

**Chaining rule:** [CHAINING.md](../../CHAINING.md) — every onward
`superpowers:Y` → `dinopowers:Y`. NEVER bypass wrapper.

**Requires superpowers:** `superpowers:brainstorming` — availability per
[CHAINING.md](../../CHAINING.md) "Missing superpowers" steps 1–3. Not in the
skills list ≠ unavailable (the list is truncated): run
`ls $CODEX_HOME/plugins/cache/*/superpowers/*/skills/brainstorming/SKILL.md` as
written first — a hand-built path failing proves nothing; only that glob
matching nothing → stop and ask the user to install superpowers
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

Disqualifier first: user rules files out ("no specific files", "без конкретных
файлов", "conceptually") → no area, a subsystem word in the request ("cache
layer design") notwithstanding — never glob it; Step 4 without enrichment.

Directory scope → `pathPattern="<dir>/**"` (`src/app/widgets/` →
`src/app/widgets/**`); a bare `<dir>/` matches no file. Print it:
`dir "<dir>/" → pathPattern="<dir>/**"`.

Named path new / not in git yet → `pathPattern` = that path exactly (dir →
`<dir>/**`), Step 2 calls still RUN (new path ≠ no area). NEVER widen to a
parent dir to find signals.

Compose `pathPattern` (e.g. `**/auth/**`,
`src/core/domains/ingest/**/chunker/**`) + `query` (one sentence, change
intent). Area named by a word, no directory given ("the auth flow", "cache
layer") → glob of that word, `**/<word>/**` (`**/auth/**`, `**/cache/**`) — set
on EVERY enrichment call; pathPattern unset while an area is named = un-scoped
enrichment, wrong. Print it:

```
area "<named area>" → pathPattern="**/<word>/**"
```

No area mentioned/derivable → Step 4, empty enrichment. Report "no area
identifiable — proceeding without tea-rags enrichment".

## Step 2 — Codegraph decision, then ONE parallel block (A–E on / A–C off)

**2.0 — decide codegraph state FIRST, state it in output before the block:**
graph tools (`get_callers`, `trace_path`, …) in your tool list → print the
`codegraph on` line of the block below; absent → its `codegraph off` line.
Unsure → SessionStart digest: `codegraph off` line = off, silent = on — no probe
call. No stated decision = Step 2 not started.

Plan-only with the state not given in the prompt → print BOTH lines, each branch
complete (the off line is never implied by the on line):

```
codegraph on (graph tools in my list) → A–E in one block: A hotspots, B ownership, C techDebt, D architecturalHub (semantic_search, metaOnly, pathPattern=<Step 1>) + E get_naming_lexicon(concept, language, pathPattern=<Step 1>)
codegraph off → A–C in one block: A hotspots, B ownership, C techDebt (semantic_search, metaOnly, pathPattern=<Step 1>); backbone + vocabulary not assessed
```

Print these lines verbatim — also when entered from another wrapper (plan step,
subagent). "follow the wrapper's enrichment order" / "run Step 2" without the
calls + presets named = Step 2 not stated.

Presets FIXED: A hotspots, B ownership, C techDebt — area type never swaps one
(security / auth / payments area → still `techDebt`, NEVER `securityAudit` or
another preset in its place).

Then ALL calls **in parallel** (one tool block — D + E in the SAME block as A–C,
never appended after): A–D `mcp__tea-rags__semantic_search`, each
`metaOnly: true` (signals, not content); E `get_naming_lexicon`:

| Call           | `rerank` preset                     | Why                                                                                                                                 |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A — Hotspots   | `"hotspots"`                        | Bug-prone zones the brainstorm must account for (high churn + recency + bugFix)                                                     |
| B — Ownership  | `"ownership"`                       | Knowledge silos — single-owner files that need reviewer pairing                                                                     |
| C — Tech debt  | `"techDebt"`                        | Legacy zones where "just refactor it" hides cost (age + churn + bugFix)                                                             |
| D — Backbone   | `"architecturalHub"`                | **Codegraph only** — structural hubs (high `fanIn` / `isHub`) the design must respect; a change to a backbone has wide blast radius |
| E — Vocabulary | `get_naming_lexicon` (not a search) | **Codegraph only** — words the project already uses for the area; SAME parallel block as A–D                                        |

Call D ONLY when codegraph on = digest without `codegraph off` line, context
listing `codegraph.symbols`, or `get_naming_lexicon` available (explicit, no
further check), or graph tools (`get_callers`, `trace_path`, …) in tool list;
unsure → digest: `codegraph off` line = off, silent = on. Off → A/B/C only, note
backbone not assessed (NEVER pass similarity-ranked list off as "the hubs"). →
`tea-rags://guide/navigation` "Graph navigation" — for the on/off read only; its
after-search `find_symbol` depth step does not apply to enrichment rows.

**Call E — vocabulary (codegraph only, same parallel block — MANDATORY when
codegraph on; A–D without E = incomplete Step 2):**
`get_naming_lexicon(concept=<Step 1 query>, language, pathPattern)` →
`concept.terms` = words project already uses for area. `concept` = change intent
sentence, NEVER a draft symbol name. `language` = area's language from its path
/ project stack; unsure → still run E, never skip it over a language-capability
doubt. Output → two block lines, both printed: "Project vocabulary" from
`concept.terms`, and "Names check (handoff)": names the design proposes for new
symbols go through `get_naming_lexicon(names=[…])` before being fixed.

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
| `mcp__tea-rags__hybrid_search` | Same rerank, but its BM25 leg re-ranks by query-token overlap — signal scan wants semantic + signals |
| `mcp__tea-rags__find_similar`  | Requires an existing symbolId; brainstorm targets an area, not a known symbol                        |
| `mcp__tea-rags__find_symbol`   | Returns one symbol; brainstorming needs area-wide risk distribution                                  |
| Running the calls sequentially | Wastes time; they are independent — issue them in one parallel block                                 |

Do NOT pass:

- `metaOnly: false` — content unneeded, payload bloats. No "show / read the
  content" in the prompt → no content call, conditional ones included. Prompt
  asks to SEE content → enrichment stays `metaOnly: true`; content = separate
  call AFTER the Step 2 block returns (same answer, never in the block, never
  deferred): `find_symbol relativePath=<row.relativePath>` (outline → drill
  ids); several rows → ONE `find_symbol symbols=[<row paths or ids>]`
- custom `rerank` weights instead of named presets — loses calibrated semantics
- `filter` on `git.ageDays` / `git.commitCount` — presets encode them; filters
  shrink set, hide debt

All risk calls 0 results (new / unindexed area) → report "no git-enriched
results for pathPattern `<X>` — area is new or excluded from indexing", Step 4
WITHOUT block: no Step 3 block, no `[planned; not run]` rows, never "pass the
enrichment". No retry: no wider `pathPattern`, no other tool. NEVER fabricate.
Plan-only, path new / not in git → calls are NOT skipped: list the A–C calls (+
D/E when on) with pathPattern = that path, then the outcome of their result:

```
A hotspots, B ownership, C techDebt (semantic_search, metaOnly, pathPattern=<new path>) → when they return 0 rows: "no git-enriched results — area is new"; superpowers:brainstorming invoked WITHOUT enrichment block
```

NEVER "skip the enrichment calls" / "no tea-rags call" because the path is new —
0 rows is the calls' result, not a reason to not issue them.

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

**Names check (handoff):** names the design proposes for new symbols go through get_naming_lexicon(names=[{name, kind}], language) before being fixed — MISFIT → take suggestion; NEW_TERM → vocabulary term if same meaning, else justify the new word.
```

Codegraph on → both last lines printed verbatim, plan-only answer included
(`[planned; not run]` covers the terms, never the Names check line).

Cap 3 per section. File in several sections → mark (`→ also in Hotspots`) —
overlap = strong signal. No raw JSON; `relativePath` + 2-3 key signals per
entry. Values: `rankingOverlay.{file,chunk}.<field>` (preset-surfaced, labelled)
— the only signal source: a metaOnly payload is locator-only, no raw `git.*`; a
signal the preset does not surface → leave it out. File-level presets
(ownership, architecturalHub) → no startLine.

**Done-check before Step 4 (codegraph on) — state all three, else Step 2/3
incomplete:** (1) E issued in the same parallel block as A–D; (2) block carries
"Project vocabulary" line from `concept.terms`; (3) block carries the "Names
check (handoff)" line verbatim.

## Step 4 — Invoke superpowers:brainstorming

Invoke `Skill` tool with `superpowers:brainstorming`. Prepend enrichment block
from Step 3 as context. Phrase handoff as:

> "Before exploring, note these risk signals in the target area: …<block>… Use
> them to pressure-test ideas — especially around the hotspot files. Apply the
> block's Names check line to every name the design proposes for a new symbol.
>
> Chaining rule reminder: if your cycle would next invoke a `superpowers:Y`
> skill (writing-plans, test-driven-development, etc.), invoke the
> `dinopowers:Y` wrapper instead when one exists — see the Chaining rule section
> above."

`superpowers:brainstorming` runs full cycle — wrapper grounds, never replaces.

## Red Flags — STOP, restart from Step 2

- "I know the hotspots here" → run Step 2; memory stale
- "3 calls slow, do one" → presets = different lenses; one loses two
- Custom weights / `rerank: "relevance"` instead of risk presets → redo
- `hybrid_search` / `find_similar` / `find_symbol` substituted → redo with
  `semantic_search` + preset
- Wrapper-own `find_symbol` before or after Step 2 (named dir, result paths, doc
  TOC) → drop it; Step 2 block first, brainstorming next. User-asked reads of
  named files / callers stay (see Iron Rule)
- Scan-tool demand rerouted to `risk-assessment` / `rank_chunks` → back here,
  print the refusal line, `semantic_search` presets
- Calls sequential → reissue parallel
- Block issued without stated codegraph decision, or graph tools in list but
  only A–C → add D + E in the same block, restate
- `superpowers:brainstorming` first, tea-rags after as "validation" → wrong
  order, restart
- `metaOnly: false` "to see content" → restart with `metaOnly: true`
- Raw `results[]` JSON in handoff → extract 3 entries per lens
- User named area but skipped as "abstract" → enrich it
- Inner cycle chains raw `superpowers:Y` → intercept, invoke `dinopowers:Y`
