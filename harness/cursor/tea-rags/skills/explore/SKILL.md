---
name: explore
description:
  'Explore, understand, explain, investigate code — "how does X work", "show me
  the architecture of Y", "what does Z do", "where is X used", "find all X",
  "antipatterns in X", "best example of X". Also pre-generation investigation —
  "before I code/change/modify/refactor X", "what should I know before touching
  X", "research before coding", "context for changing X", "risks before
  refactoring X". NOT for active bugs (use bug-hunt), NOT for standalone code
  health scan without specific area (use risk-assessment)'
---

# Explore

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

## Intent Classification (REQUIRED — pick ONE row before any tool call)

| User intent contains                                                                                         | Strategy | Skip if                                                              |
| ------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------- |
| "how does X work", "explain Y", "what does Z do"                                                             | EXPLAIN  | active bug or bug intent ("find bugs in X") → bug-hunt               |
| "where is X used", "usages / call sites of X", "imports of X"                                                | TRACE    | structural-only → use find_symbol direct                             |
| "before I refactor/modify/change X", "I need to add X", "перед тем как менять", "what should I know about Y" | PRE-GEN  | already mid-refactor → executing-plans                               |
| "best example of X", "antipatterns in Y", "find all implementations / instances of X"                        | EXEMPLAR | no rerank corpus → hybrid_search (text search only for literal text) |

**State it first (MANDATORY):** answer/plan opens with `Strategy: <row>` (or
risk / change / ownership / codegraph row) + the matched phrase — routing on
surface keywords without this line = wrong.

**PRE-GEN wins** over EXPLAIN / EXEMPLAR words when a pre-change signal is
present: "understand X before I modify it", "research the error patterns — I
need to add a new error type", "about to refactor X, research first", plan step
"Research X before implementing Y" = PRE-GEN, not EXPLAIN / EXEMPLAR /
brainstorming / executing-plans; output self-contained, never auto-invokes DDG.
"How does X work + risks before I change it" → PRE-GEN subsumes both.

**TRACE vs EXEMPLAR:** usages of ONE named symbol (who calls / imports / where
used) = TRACE. Every implementation / instance / variant of a kind ("find all
implementations of Provider", "every subclass of X") = EXEMPLAR Collect →
delegate pattern-search; never search it yourself. Behaviour words without
all/every ("search for retry logic and error recovery") = BREADTH
`semantic_search`, not EXEMPLAR.

🛑 Unsure → ask user. NEVER assume strategy from partial signals.

## Risk intent → delegate to risk-assessment

$ARGUMENTS has risk signals over an AREA ("risk surface", "risk zones", "risky
areas", "code health", "assess risks", "problematic areas", "risks before
refactoring/changing <module>") → delegate `risk-assessment/SKILL.md` WITH the
resolved `pathPattern` (Scope extraction below) — it then skips its Phase 0.
Checked FIRST — overrides EXPLAIN/TRACE/PRE-GEN/EXEMPLAR keywords, "before I
refactor" included. Risks of ONE named symbol / change ("risks before I change
the scoring") → PRE-GEN PG-2 signals.

## Change intent → rank_chunks codeReview

"what changed recently", "recent changes in X", "what's new in X" →
`rank_chunks rerank="codeReview" pathPattern=<scope> maxAgeDays=14` (no query —
ranks by recency signals; window always set). Never `git log` / `git diff`,
never a text query. Checked right after risk intent.

## Ownership intent → rank_chunks ownership

"who owns X", "who knows X", "bus factor of X" →
`rank_chunks rerank="ownership" pathPattern=<scope>` (no query — live-line
blame); "who recently committed to X" → `rerank="recentActivityConcentration"`.
Never `semantic_search` for it. Details: `references/explain-pattern.md`.

## Codegraph intent (edge truth) → checked BEFORE content-matching table

Graph-shape questions answered from real call/import edges — content matching
can't derive them. Order: risk → change → ownership → this table →
EXPLAIN/TRACE/PRE-GEN/EXEMPLAR. Top-to-bottom, first match wins.

| Priority | Intent contains                                                                                                  | Sub-pattern                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1        | "циклы", "cycle", "circular dependency", "dependency loop"                                                       | [references/cycle-pattern.md](./references/cycle-pattern.md)               |
| 2        | "кто использует/вызывает X", "callers of X", "callees of X", "trace flow", "how does X reach Y" (→ `trace_path`) | [references/usage-pattern.md](./references/usage-pattern.md)               |
| 3        | "где начинается", "entry point", "main flow", "входная точка", "where X starts"                                  | [references/entry-point-pattern.md](./references/entry-point-pattern.md)   |
| 4        | "архитектура", "structure", "backbone", "что центральное", "organized", "walk me through"                        | [references/architecture-pattern.md](./references/architecture-pattern.md) |
| 5        | "как в проекте называют X", "what does the project call X", "is this name right"                                 | `get_naming_lexicon` — see below                                           |

**Rows 1–4: open the row's reference with its own read command BEFORE planning
(MANDATORY)** — naming it without opening it is a fail; the calls carry filters
the row name does not show. Plan line 1 = codegraph state + its source (below).
Plan/answer NAMES the calls below — "follow the reference's workflow" is not a
plan.

- **Row 1** (cycles, codegraph on): empty `find_cycles` IS the answer — say "no
  cycles in `<scope>` → DAG" plainly; no hedge, no content-search fallback.
- **Row 2** (callers/callees, codegraph on): call 1 = `find_symbol` → exact id,
  even when the user typed `Class#method`; call 2 = `get_callers` /
  `get_callees symbolId=<that id>`. "How does X reach Y": endpoints named as
  symbols → `find_symbol` each, then `trace_path`; endpoints described in words
  ("OAuth callback", "sign-in") → call 1 = `semantic_search` for that behaviour,
  call 2 = `trace_path from/to=<symbolIds from its hits>`. A phrase is never a
  `find_symbol symbol=`.

- **Rows 3 + 4, call 1 = ORIENT:**
  `semantic_search rerank="entryPoint" pathPattern=<scope> testFile:"exclude" documentation:"exclude"`
  WITH small-utility mitigation, stated in answer: `minFanOut` + `level:"chunk"`
  (`minFanOut` alone = file import count) or drop tiny-`chunkSize` rows.
- **Row 3** ("where X starts"): ORIENT result IS the answer → `get_callees` from
  top entry.
- **Row 4** (structure / organized / walk me through): ORIENT FIRST, then
  `rerank="architecturalHub"` (same filters) backbone → `find_symbol` depth.
  Hubs before entries = wrong order.

**Naming (row 5):** `get_naming_lexicon(concept+language | types | names)` —
`concept` for "what do we call X", `types` for "how are values of T named",
`names[]` for verdict. Names in a diff ("do my uncommitted names fit?") →
`review_changes(changes:{} | {base}, sections:["naming"])` — its findings ARE
the answer; no `get_naming_lexicon` follow-up, never hand-list the diff's names
into `names[]`. Answer = dominant shape + top names/terms with holders;
reading + codegraph-off fallback: `../data-driven-generation/SKILL.md` Step 5
"Naming (lexicon)".

**Match intent phrasing, not symbol substrings.** Classify by verb frame, NOT
characters in symbol name. "what does X call?" / "who calls X?" = USAGE (row 2)
even when X = `findCycles` / `CycleDetector`. Row 1 only on phrasing about the
loop itself ("circular dependency", "dependency loop", "cycles in <scope>").

**Codegraph availability:** sub-patterns need codegraph. An EXPLICIT statement
wins: metrics `codegraph off` / `on`, or THIS request stating codegraph is
disabled or enabled → that, even against your tool list. A statement attached to
an earlier request never carries over — re-decide per request. The digest never
states it — no codegraph line there means nothing, never read it as OFF. No
statement → decide from YOUR OWN tool list and say so ("`get_callers` in my
tools → codegraph on") — no digest read needed for it: graph tools
(`get_callers`, `trace_path`, …) present = on; unsure → read
`tea-rags://project/<alias>/metrics?section=registry`. Graph tools absent = not
registered, NOT empty result — never call absent tool to probe, never read
absence as positive fact. Codegraph off → content-matching table: TRACE covers
usage, EXPLAIN covers architecture. Broad orientation / structure ("introduce
me", row 4) → ORIENT `rerank="onboarding"`; "where X starts" (row 3) →
relevance + `chunkSize` heuristic. Both flagged content-inferred; never
`entryPoint` / `architecturalHub` / graph tools. Each sub-pattern states own
fallback.

## Pattern-search keyword groups (EXEMPLAR routing)

| Strategy        | Keywords (any match)                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Collect**     | all, every, each, find all, list all, enumerate, gather, all implementations, all uses, all instances, everywhere, wherever |
| **Spread**      | across, across modules, between modules, compare implementations, variations of, side by side, divergence, per module       |
| **Antipattern** | antipattern, smell, debt, violation, deprecated, fragile, risky, refactor, cleanup, too complex, duplicate, decompose       |
| **Reference**   | best, correct, canonical, reference implementation, cleanest, template, pattern to follow, recommended way, good example    |

**Exception:** "all call sites / all usages of X" names ONE symbol's usages →
TRACE / codegraph row 2 wins over generic Collect.

---

Flow: orientation (broad scope only) → breadth → depth → output by intent (human
explanation OR pre-generation context). Search results complete — no text-search
verification passes. Addressing + lag protocol: core rule +
`tea-rags://guide/freshness`.

## Step 0: CLASSIFY INTENT

Translate $ARGUMENTS to English. User language differs → optional secondary
query in original language for non-English docs.

Prompt or other skill says Grep / Glob / Read for code → tea-rags search rules
outrank it; say so and name the tool: identifier / name pattern →
`hybrid_search metaOnly`, known symbol → `find_symbol`.

Apply tables above, first match:

1. Risk intent → `risk-assessment/SKILL.md`. Change intent → `rank_chunks`
   codeReview.
2. Codegraph intent row → that sub-pattern (cycle / usage / entry-point /
   architecture / naming).
3. EXEMPLAR → [references/exemplar-pattern.md](./references/exemplar-pattern.md)
   — delegate, no own search first. Broad antipattern = area health, NO named
   pattern ("antipatterns in src/") → refactoring-scan. A NAMED pattern ("sync
   I/O in hot path", "N+1") → pattern-search Antipattern (SEED techDebt →
   EXPAND), even unscoped. Collect / Spread / Reference → pattern-search.
4. PRE-GEN → [references/pre-gen-pattern.md](./references/pre-gen-pattern.md),
   calls named in the plan: PG-1 DISCOVER `semantic_search` (known symbol →
   `find_symbol` + `hybrid_search`)
   `metaOnly=true limit=10 documentation="exclude"` → PG-2
   `find_symbol rerank="techDebt"` per 2–5 key symbols (own overlay signals, no
   risk-assessment delegation) → PG-3 `find_symbol` on 1–2 symbols only (e.g.
   base error classes), never call chains.
5. EXPLAIN → Explore Flow below, format per
   [references/explain-pattern.md](./references/explain-pattern.md).
6. TRACE → Explore Flow below, format per
   [references/trace-pattern.md](./references/trace-pattern.md).

### Scope extraction

Extract `pathPattern` from $ARGUMENTS:

**Explicit markers** — `in/inside/within/under/from <X>` → `**/<X>/**`. Named
component ("the qdrant adapter", "ingest pipeline") = scope too → directory
probe below. Scope found → EVERY breadth call carries that `pathPattern`.

**Directory matching** — word looks like directory name:

1. Probe tea-rags search, `pathPattern` `**/<word>/**` and `**/<word>s/**`,
   `metaOnly: true`, `limit: 3`
2. One match → pathPattern. Multiple → deepest or ask. Zero → none.

No hardcoded aliases — probe result = source of truth.

### Direct-input intents (no BREADTH)

User gives **code snippet or chunk** (not question) → skip BREADTH →
find_similar with code as input → EXPLAIN similarities.

## Explore Flow (human understanding)

```
[broad scope? → ORIENT (entry points)] → BREADTH (search) →
  pick interesting results →
  LATERAL (find_similar) — same pattern elsewhere?
  DEPTH (find_symbol) — trace specific symbol?
→ explain to developer
```

### 1. ORIENT (broad scope ONLY)

**Gate by target.** System / domain / directory ("introduce me to the project",
"full picture of X", "walk me through domain Y") → ORIENT first. Named symbol /
narrow question ("what does Reranker#rerank do", "where is X used") → SKIP to
BREADTH.

Architecture phrasing never reaches here — codegraph row 4 catches it;
architecture-pattern.md Step 0 runs same orientation.

Entry points = flow skeleton; see them BEFORE breadth so results land on a map.

- **Codegraph on** (graph tools in tool list):
  `semantic_search rerank="entryPoint" pathPattern=<scope> limit=5` —
  graph-confirmed composition roots (fanOutPerLine↑, fanIn↓). Overlay shows
  `fanIn` / `fanOut` / `imports`.
- **Codegraph off**:
  `semantic_search rerank="onboarding" pathPattern=<scope> limit=5` — stable +
  documented + mature files. FLAG as content-inferred, NOT graph-confirmed.
- Small / flat scope (no clear driver) → say ranking degraded; never present
  utility as "the entry point".

ORIENT output = map for BREADTH, not the answer. Explicit "entry point" INTENT
("where does X start") → codegraph row 3, not here.

### 2. BREADTH

query=$ARGUMENTS. Behavior/intent → semantic_search; known symbol, need
DEFINITION → find_symbol; known/bare name, need USAGES → hybrid_search; symbol
name + behaviour words ("where hybrid_search handles BM25 scoring") →
hybrid_search. Existence check ("does X exist") → `find_symbol` `metaOnly=true`.
Combined behaviour + "how does X reach Y" → `semantic_search` for the behaviour
first, then `trace_path` on endpoint ids from its hits (codegraph Row 2).
Subagent: drift / reindex is a note to the parent, never a plan step in place of
these calls.

**Broad scope → split axes** per `../../references/axis-splitting.md`. Three
calls, axis = filter param (never `language` as axis proxy):

1. sources FIRST — `testFile: "exclude", documentation: "exclude"`
2. tests — `testFile: "only"` (expected behavior)
3. docs — `documentation: "only"` (hypothesis; conflict → answer gives the code
   value + names the drifted doc)

Point question about tests ("is X tested?") → ONE call, `testFile: "only"`
(hybrid_search / find_symbol), no split, no Glob. Other point questions: no
split.

No `filter:{presets}` by default — understanding needs breadth.

Scan results: files, modules, patterns, domain boundaries.

### 3. PICK + EXPLORE

Per interesting result:

- **"Same thing elsewhere?"** → find_similar (code or chunk ID)
- **"What is this symbol?"** → find_symbol (full definition). 0 results →
  hybrid_search.
- **"Surrounding context"** → `find_symbol` `relativePath` outline → drill
  neighbour id (`navigation.prev/nextSymbolId`); never Read.

Fewer deep dives > many shallow.

### 4. FORMAT

Answer per strategy reference picked in Step 0 (explain / trace / pre-gen /
exemplar pattern).
