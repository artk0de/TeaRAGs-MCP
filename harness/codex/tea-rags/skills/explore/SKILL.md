---
name: explore
description:
  'Explain/investigate code — "how does X work", "where is X used", "find all
  X", "architecture of Y", "best example of X"; pre-generation context — "before
  I change/refactor X", "what to know before touching X". NOT for active bugs, a
  bug already found, named suspects, hits with bugFixRate labels (bug-hunt). NOT
  for plan requests ("draft a plan to add X", [subagent:…] too) (writing-plans).
  NOT standalone health scan (risk-assessment).'
---

# Explore

## Intent Classification (REQUIRED — pick ONE row before any tool call)

Checked first, before this table: layers / wrong-way dependencies / dependency
direction of `<dir>` → `get_architecture_report(pathPattern: "<dir>/**")`, not
row 4. A named symbol or anchor row (search rows already in context, an answer
opening `↳ Anchor =` included) + flow words ("end to end", "what happens when",
"walk me through", "step by step", "involve") → EXPLAIN graph walk (route 5):
anchor → `get_callees(symbolId: <anchor>, depth: 2)`, not row 4, no new search.
A typed directory path and none of the structure words below ("how does `<dir>`
work", "what's in `<dir>`") → path-first, not row 4, not ORIENT — opening line,
copied: `Strategy: path-first — "<dir>"`, then
`find_symbol(relativePath: "<dir>")` outline → ONE
`find_symbol(symbols: [<Class#method ids from that outline>])`. Then structure
phrasing (one of these words in the prompt: "organized", "end to end",
"structure", "architecture", "backbone", "walk me through") → codegraph row 4
below, even worded "how is/does X …" — never EXPLAIN, never an axis split.
Opening line, copied: `Strategy: codegraph row 4 — "<phrase>"`. "Where is X
used" / every occurrence of an exact name, constant or string (not "every call
of X" — callers, below) → occurrence route, any codegraph state: shell rg -l
--hidden --glob '!.git' `"<X>" <dir>` (literal, `-l`; `<dir>` = the anchor's dir
when known, else the source root — never a search to find it) → `find_symbol`
outline → batch of only the needed methods; never `hybrid_search` for it.
Concept words, synonyms or spellings, even one `<a>|<b>|<c>` regex, are not an
exact name → EXPLAIN: `semantic_search` (`hybrid_search(metaOnly)` when real ids
are among them) → anchor → `get_callees`/`get_callers(symbolId:, depth: 2)` →
ONE batch of only the needed methods; never a text-search alternation. "Callers
of X" → decide codegraph first (plan line below); on →
`Strategy: codegraph row 2` (`get_callers`; "every call / all callers of X" →
plan both lines: it + that occurrence route), never TRACE-only `hybrid_search`.
Off (or off branch of an unknown state) → TRACE loop, copied, ≥ 2 calls:
`hybrid_search(query="<X>", metaOnly=true)` → per caller hit
`hybrid_search(query="<caller>", metaOnly=true)` → repeat ≤ 3 levels. One call =
fail.

| User intent contains                                                                                         | Strategy | Skip if                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| "how does X work", "explain Y", "what does Z do"                                                             | EXPLAIN  | active bug or bug intent ("find bugs in X") → bug-hunt; structure phrasing → codegraph row 4                                                 |
| "where is X used", "usages / call sites of X", "imports of X"                                                | TRACE    | exact-name occurrences → occurrence route above; callers, codegraph on → codegraph row 2 (get_callers); structural-only → find_symbol direct |
| "before I refactor/modify/change X", "I need to add X", "перед тем как менять", "what should I know about Y" | PRE-GEN  | plan request ("draft a plan to add X") → writing-plans; mid-refactor → executing-plans                                                       |
| "best example of X", "antipatterns in Y", "find all implementations / instances of X"                        | EXEMPLAR | no rerank corpus → hybrid_search (text search only for literal text)                                                                         |

**State it first (MANDATORY):** answer/plan opens with `Strategy: <row>` (or
risk / change / ownership / codegraph row) + the matched phrase — routing on
surface keywords without this line = wrong.

**Doc claim in hand** (prompt or a doc chunk states a number / limit / default),
any strategy → verify in source (`documentation:"exclude"` + `find_symbol`)
before the answer repeats it; the plan prints both outcome lines, copied:
`On conflict: Code value wins; doc drifted: <doc path> says X, code does Y at <file:line>.`
`On match: Doc matches code at <file:line>.`

**PRE-GEN wins** over EXPLAIN / EXEMPLAR words when a pre-change signal is
present: "understand X before I modify it", "research the error patterns — I
need to add a new error type", "about to refactor X, research first", plan step
"Research X before implementing Y" = PRE-GEN, not EXPLAIN / EXEMPLAR /
brainstorming / executing-plans; output self-contained, never auto-invokes DDG.
"How does X work + risks before I change it" → PRE-GEN subsumes both.

**TRACE vs EXEMPLAR:** usages of ONE named symbol (who calls / imports / where
used) = TRACE (codegraph on → codegraph row 2). Every implementation / instance
/ variant of a kind ("find all implementations of Provider", "every subclass of
X") = EXEMPLAR Collect → opening line `Strategy: EXEMPLAR Collect — "<phrase>"`
(intent word included), delegate pattern-search; never search it yourself.
Behaviour words without all/every ("search for retry logic and error recovery")
= BREADTH `semantic_search`, not EXEMPLAR.

🛑 Unsure → ask user. NEVER assume strategy from partial signals.

## Plan intent → writing-plans

Request to author a plan ("write/draft a plan", "draft a plan to add X", "plan
the change to <files>", "add a Task to the plan") → hand off to `writing-plans`;
its ONE impact `semantic_search` is the first call. Holds with "add X" / "before
changing" / "impact analysis" and a `[subagent: explore]` label. Checked before
every section below — never PRE-GEN, never `find_symbol` outlines first. A plan
STEP "Research X before implementing Y" stays PRE-GEN.

## Risk intent → delegate to risk-assessment

Risks of NAMED symbols — prompt carries 1–5 ids (`Class#method`,
`Class.static`), even beside an area word ("pipeline", "module") — or of ONE
named change ("risks before I change the scoring") → PRE-GEN PG-2, no
risk-assessment, no `rank_chunks`; plan line copied with the prompt's ids:
`find_symbol(symbols=["<id1>", "<id2>", …], rerank="techDebt", metaOnly=false)`.
Else $ARGUMENTS has risk signals over an AREA ("risk surface", "risk zones",
"risky areas", "code health", "assess risks", "problematic areas", "risks before
refactoring/changing <module>") → delegate `risk-assessment/SKILL.md` WITH the
resolved `pathPattern` (Scope extraction below) — it then skips its Phase 0.
Checked FIRST — overrides EXPLAIN/TRACE/PRE-GEN/EXEMPLAR keywords, "before I
refactor" included.

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

| Priority | Intent contains                                                                                                                                   | Sub-pattern                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1        | "циклы", "cycle", "circular dependency", "dependency loop"                                                                                        | [references/cycle-pattern.md](./references/cycle-pattern.md)               |
| 2        | "кто использует/вызывает X", "where is X used", "who uses X", "callers of X", "callees of X", "trace flow", "how does X reach Y" (→ `trace_path`) | [references/usage-pattern.md](./references/usage-pattern.md)               |
| 3        | "где начинается", "entry point", "main flow", "входная точка", "where X starts"                                                                   | [references/entry-point-pattern.md](./references/entry-point-pattern.md)   |
| 4        | "архитектура", "structure", "backbone", "что центральное", "organized", "end to end", "walk me through" — a typed `<dir>` with none → path-first  | [references/architecture-pattern.md](./references/architecture-pattern.md) |
| 5        | "как в проекте называют X", "what does the project call X", "is this name right"                                                                  | `get_naming_lexicon` — see below                                           |

**Rows 1–4: open the row's reference with its own read command BEFORE planning
(MANDATORY)** — naming it without opening it is a fail; the calls carry filters
the row name does not show. Plan line 1 = codegraph state + its source (below).
Plan/answer NAMES the calls below — "follow the reference's workflow" is not a
plan.

- **Row 1** (cycles, codegraph on): empty `find_cycles` IS the answer — say "no
  cycles in `<scope>` → DAG" plainly; no hedge, no content-search fallback.
- **Row 2** (callers/callees, codegraph on): call 1 = `find_symbol` → exact id,
  even when the user typed `Class#method`; call 2 = `get_callers` /
  `get_callees symbolId=<that id>`; "every / all callers" → call 3 = shell rg -l
  --hidden --glob '!.git' `"<X>" <dir>` (literal, `-l`) → `find_symbol` on the
  hits (adds recall, never replaces 2). "How does X reach Y": endpoints named as
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
- **Row 4** (structure / organized / walk me through / end to end — the word is
  in the prompt; a typed `<dir>` without one → path-first above), codegraph on —
  plan, copied, all four calls: `1 ORIENT semantic_search rerank="entryPoint"` →
  `2 semantic_search rerank="architecturalHub"` (same filters) →
  `3 get_callees symbolId=<top entry id>` walked through the hubs →
  `4 find_symbol` depth. Sources only — no tests / docs axis searches. Hubs
  before entries = wrong order; a plan without call 3 = wrong.

**Naming (row 5):** `get_naming_lexicon(concept+language | types | names)`.
Checked first: the question quotes a candidate name (`<name>` — "is `<name>` a
good name", even with "or what do we call it") →
`names:[{name: "<name>", kind, type?: "<T>"}]` — its verdict + alternatives
answer both halves; never `concept`. No candidate name, a type `<T>` named ("how
is a variable / value of `<T>` named", "как называть переменную с `<T>`") →
copied: `get_naming_lexicon(types:["<T>"])` — never `concept:"<T>"`. `concept`
only for "what do we call X" (X = idea, not a type). Names in a diff ("do my
uncommitted names fit?") →
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
an earlier request never carries over — re-decide per request. Context listing
`codegraph.symbols` or `get_naming_lexicon` available = explicit ON (source
`request`) — no registry read first. No statement → a graph tool you SEE in your
tool list (`get_callers`, `trace_path`, … under any prefix — `mcp__tea-rags__`,
`mcp__tea_rags__`) → on; none of them in the tool list → off (the tool list is
the signal, no probe call). Plan line 1, copied:
`Codegraph: on|off — <request | tool list>`. Never `unknown`: scan your tool
list before writing it. Never call a graph tool to probe; an unregistered tool
is not an empty result — never read it as "no callers" / "no cycles". Codegraph
off → content-matching table: TRACE covers usage, EXPLAIN covers architecture.
Broad orientation / structure ("introduce me", row 4) → ORIENT
`rerank="onboarding"`; "where X starts" (row 3) →
`references/entry-point-pattern.md` off procedure (relevance, drop tiny
`chunkSize` rows, its caveat line). Both flagged content-inferred; never
`entryPoint` / `architecturalHub` / graph tools. Each sub-pattern states own
fallback.

## Pattern-search keyword groups (EXEMPLAR routing)

| Strategy        | Keywords (any match)                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collect**     | all, every, each, find all, list all, enumerate, gather, all implementations, all uses, all instances, everywhere, wherever                                                  |
| **Spread**      | across, across modules, between modules, compare implementations, variations of, side by side, divergence, per module                                                        |
| **Antipattern** | antipattern, smell, debt, violation, deprecated, fragile, risky, refactor, cleanup, too complex, duplicate, decompose                                                        |
| **Reference**   | best, correct, canonical, reference implementation, cleanest, template, pattern to follow, recommended way, good example — SEED rerank `proven` preset, never custom weights |

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
outrank it. Answer states the PRIORITY, not "weaker tool" — literal: "Injected
tea-rags search rules take priority over the skill's <Glob> instruction." Then
name the tool: identifier / name pattern → `hybrid_search metaOnly`, known
symbol → `find_symbol`. Seed tool decided HERE, up front, even when routed on to
pattern-search Collect — print `Seed tool: hybrid_search`; never defer it to
"read decision-tree to choose". "Files matching <Name>" is a name pattern, not a
literal: `hybrid_search(query="<Name>", metaOnly=true)`, never shell rg -l
--hidden --glob '!.git' file listing / Glob / `find -name`.

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
   calls named in the plan. PG-1 DISCOVER, first matching branch: user names a
   file path → `find_symbol(path=<cwd>, relativePath=<file>)` outline (2+ files
   → ONE `find_symbol(symbols=[<paths>])`), then
   `find_symbol(symbol=<id from outline>)` — no symbol lookup, no
   `hybrid_search` / `semantic_search` on it; known symbol, no file →
   `find_symbol` + `hybrid_search`; else `semantic_search`
   `metaOnly=true limit=10 documentation="exclude"` → PG-2 ONE
   `find_symbol(symbols=[<2–5 key symbols>], rerank="techDebt", metaOnly=false)`
   (own overlay signals, no risk-assessment delegation) → PG-3 `find_symbol` on
   1–2 symbols only (e.g. base error classes), never call chains.
5. EXPLAIN → Explore Flow below, format per
   [references/explain-pattern.md](./references/explain-pattern.md). Codegraph
   on + anchor id (named symbol or a row) → copied, ≤ 4 calls:
   `get_callees(symbolId: <anchor id>, depth: 2)` →
   `find_symbol(symbols: [<only the tree methods the answer needs>])`; never one
   `get_callees` per hop, never a grep → read chain. Named component ("the
   <name> adapter") → Scope extraction probe FIRST, then
   `semantic_search(query=<behaviour>, pathPattern="**/<name>/**")` — the
   component word in query text alone is NOT scope. Skip ORIENT ≠ skip probe.
6. TRACE → Explore Flow below, format per
   [references/trace-pattern.md](./references/trace-pattern.md). Codegraph on →
   `get_callers(symbolId: <id>, depth: 2)` (impact / who ends up calling X) →
   ONE batch of only the needed callers; `truncated.next` → run it verbatim.

### Scope extraction

Extract `pathPattern` from $ARGUMENTS:

**Explicit markers** — `in/inside/within/under/from <X>` → `**/<X>/**`. Named
component ("the <name> adapter", "<dir> pipeline") = scope too → directory probe
below. Scope found → EVERY breadth call carries that `pathPattern`.

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

**Path typed first.** The prompt names a directory or file path → call 1 =
`find_symbol(relativePath: <that path>)` outline; 2+ files typed → call 1 = ONE
`find_symbol(symbols: [<the file paths>])` (their outlines) (adds — ORIENT /
BREADTH follow); bodies → ONE
`find_symbol(symbols: [<Class#method ids from that outline or a row>])`, never a
dir path in `symbols`.

**Gate by target.** System / domain / directory ("introduce me to the project",
"full picture of X", "walk me through domain Y") → ORIENT first. Named symbol /
narrow question ("what does Reranker#rerank do", "where is X used") → SKIP to
BREADTH (Scope extraction still runs; its pathPattern rides on BREADTH).

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
DEFINITION → find_symbol; known/bare name, need USAGES → shell rg -l --hidden
--glob '!.git' `"<X>" <dir>` (literal, `-l`) → find_symbol, never hybrid_search;
symbol name + behaviour words ("where hybrid_search handles BM25 scoring") →
hybrid_search. Existence check ("does X exist") → `find_symbol` `metaOnly=true`.
Known path / symbol → `find_symbol` (outline → body); rationale, copied:
`'Curiosity search' anti-pattern — known location → find_symbol, not another search.`
Combined behaviour + "how does X reach Y" → `semantic_search` for the behaviour
first, then `trace_path` on endpoint ids from its hits (codegraph Row 2).
Subagent: drift / reindex is a note to the parent, never a plan step in place of
these calls.

**Broad scope → split axes** per `../../rules/references/axis-splitting.md`.
Three calls, axis = filter param (never `language` as axis proxy):

1. sources FIRST — `testFile: "exclude", documentation: "exclude"`
2. tests — `testFile: "only"` (expected behavior)
3. docs — `documentation: "only"` (hypothesis, never sole evidence). Doc claim
   (number, limit, default) → verify in source (`documentation:"exclude"` +
   `find_symbol`), then answer carries this line, copied:
   `Code value wins; doc drifted: <doc path> says X, code does Y at <file:line>.`
   (match → `Doc matches code at <file:line>.`)

Point question about tests ("is X tested?", "tests covering `<file>`") → ONE
call, no split, no Glob:
`hybrid_search(query="<module name + exported symbol names of X>", testFile:"only", metaOnly:true)`
— names, never a sentence; not `semantic_search`. Other point questions: no
split.

No `filter:{presets}` by default — understanding needs breadth.

Scan results: files, modules, patterns, domain boundaries.

### 3. PICK + EXPLORE

Per interesting result:

- **"Same thing elsewhere?"** → find_similar (code or chunk ID)
- **"What is this symbol?"** → find_symbol (full definition). 0 results → act on
  `empty.reason` (`unknownSymbol` / `ambiguous` → a `suggestions` id verbatim),
  still nothing → hybrid_search.
- **"Surrounding context"** → `find_symbol` `relativePath` outline → drill
  neighbour id (`navigation.prev/nextSymbolId`); never Read.

Fewer deep dives > many shallow.

### 4. FORMAT

Answer per strategy reference picked in Step 0 (explain / trace / pre-gen /
exemplar pattern).
