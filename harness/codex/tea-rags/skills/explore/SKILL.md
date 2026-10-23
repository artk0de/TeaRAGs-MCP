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

## Intent Classification (REQUIRED — pick ONE row before any tool call)

| User intent contains                                | Strategy | Skip if                                                              |
| --------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| "how does X work", "explain Y", "what does Z do"    | EXPLAIN  | active bug → bug-hunt                                                |
| "where is X used", "find all X", "imports of X"     | TRACE    | structural-only → use find_symbol direct                             |
| "before I refactor X", "what should I know about Y" | PRE-GEN  | already mid-refactor → executing-plans                               |
| "best example of X", "antipatterns in Y"            | EXEMPLAR | no rerank corpus → hybrid_search (text search only for literal text) |

🛑 Unsure → ask user. NEVER assume strategy from partial signals.

## Risk intent → delegate to risk-assessment

$ARGUMENTS has risk signals ("risk surface", "risk zones", "code health",
"assess risks", "problematic areas") → delegate `risk-assessment/SKILL.md`.
Checked FIRST — overrides EXPLAIN/TRACE/PRE-GEN/EXEMPLAR keywords.

## Codegraph intent (edge truth) → checked BEFORE content-matching table

Graph-shape questions answered from real call/import edges — content matching
can't derive them. Order: risk → this table → EXPLAIN/TRACE/PRE-GEN/EXEMPLAR.
Top-to-bottom, first match wins.

| Priority | Intent contains                                                                  | Sub-pattern                                                                |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1        | "циклы", "cycle", "circular dependency", "dependency loop"                       | [references/cycle-pattern.md](./references/cycle-pattern.md)               |
| 2        | "кто использует/вызывает X", "callers of X", "callees of X", "trace flow"        | [references/usage-pattern.md](./references/usage-pattern.md)               |
| 3        | "где начинается", "entry point", "main flow", "входная точка", "where X starts"  | [references/entry-point-pattern.md](./references/entry-point-pattern.md)   |
| 4        | "архитектура", "structure", "backbone", "что центральное", "how X is organized"  | [references/architecture-pattern.md](./references/architecture-pattern.md) |
| 5        | "как в проекте называют X", "what does the project call X", "is this name right" | `get_naming_lexicon` — see below                                           |

**Naming (row 5):** `get_naming_lexicon(concept+language | types | names)` —
`concept` for "what do we call X", `types` for "how are values of T named",
`names[]` for verdict. Answer = dominant shape + top names/terms with holders;
reading + codegraph-off fallback: `../data-driven-generation/SKILL.md` Step 5
"Naming (lexicon)".

**Match intent phrasing, not symbol substrings.** Classify by verb frame, NOT
characters in symbol name. "what does X call?" / "who calls X?" = USAGE (row 2)
even when X = `findCycles` / `CycleDetector`. Row 1 only on phrasing about the
loop itself ("circular dependency", "dependency loop", "cycles in <scope>").

**Codegraph availability:** sub-patterns need codegraph. Codegraph on = graph
tools (`get_callers`, `trace_path`, …) in your tool list; unsure → read
`tea-rags://project/<alias>/metrics?section=registry` (`codegraph on|off`).
Graph tools absent = not registered, NOT empty result — never call absent tool
to probe, never read absence as positive fact. Codegraph off → content-matching
table: TRACE covers usage, EXPLAIN covers architecture. Each sub-pattern states
own fallback.

## Pattern-search keyword groups (EXEMPLAR routing)

| Strategy        | Keywords (any match)                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Collect**     | all, every, each, find all, list all, enumerate, gather, all implementations, all uses, all instances, everywhere, wherever |
| **Spread**      | across, across modules, between modules, compare implementations, variations of, side by side, divergence, per module       |
| **Antipattern** | antipattern, smell, debt, violation, deprecated, fragile, risky, refactor, cleanup, too complex, duplicate, decompose       |
| **Reference**   | best, correct, canonical, reference implementation, cleanest, template, pattern to follow, recommended way, good example    |

**Exception:** EXPLAIN reference has specific pattern for intent (e.g. "What
calls X?" with "all call sites") → EXPLAIN wins over generic Collect.

---

Flow: orientation (broad scope only) → breadth → depth → output by intent (human
explanation OR pre-generation context). Search results complete — no text-search
verification passes. Addressing + lag protocol: core rule +
`tea-rags://guide/freshness`.

## Step 0: CLASSIFY INTENT

Translate $ARGUMENTS to English. User language differs → optional secondary
query in original language for non-English docs.

Apply tables above, first match:

1. Risk intent → `risk-assessment/SKILL.md`.
2. Codegraph intent row → that sub-pattern (cycle / usage / entry-point /
   architecture / naming).
3. EXEMPLAR → [references/exemplar-pattern.md](./references/exemplar-pattern.md)
   (refactoring-scan for broad antipattern, pattern-search otherwise).
4. PRE-GEN → [references/pre-gen-pattern.md](./references/pre-gen-pattern.md).
5. EXPLAIN → Explore Flow below, format per
   [references/explain-pattern.md](./references/explain-pattern.md).
6. TRACE → Explore Flow below, format per
   [references/trace-pattern.md](./references/trace-pattern.md).

### Scope extraction

Extract `pathPattern` from $ARGUMENTS:

**Explicit markers** — `in/inside/within/under/from <X>` → `**/<X>/**`

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
DEFINITION → find_symbol; known/bare name, need USAGES → hybrid_search.

**Broad scope → split axes** per `../../rules/references/axis-splitting.md`
(sources FIRST via `testFile: "exclude", documentation: "exclude"`; tests axis =
expected behavior; docs axis = intent — hypothesis, behavioral claims verified
in code). Point questions: no split.

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
