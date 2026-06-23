---
name: explore
description:
  Use when developer asks to explore, understand, explain, or investigate code —
  "how does X work", "show me the architecture of Y", "what does Z do", "where
  is X used", "find all X", "antipatterns in X", "best example of X". Also use
  for pre-generation investigation — "before I code/change/modify/refactor X",
  "what should I know before touching X", "research before coding", "context for
  changing X", "risks before refactoring X". NOT for active bugs (use bug-hunt),
  NOT for standalone code health scan without specific area (use
  risk-assessment)
argument-hint: [what to explore — feature, module, or question]
---

# Explore

## Intent Classification (REQUIRED — pick ONE row before any tool call)

| User intent contains                                | Strategy | Skip if                                  |
| --------------------------------------------------- | -------- | ---------------------------------------- |
| "how does X work", "explain Y", "what does Z do"    | EXPLAIN  | active bug → bug-hunt                    |
| "where is X used", "find all X", "imports of X"     | TRACE    | structural-only → use find_symbol direct |
| "before I refactor X", "what should I know about Y" | PRE-GEN  | already mid-refactor → executing-plans   |
| "best example of X", "antipatterns in Y"            | EXEMPLAR | no rerank corpus → ripgrep               |

🛑 If unsure, ask the user. NEVER assume strategy from partial signals.

## Risk intent → delegate to risk-assessment

If $ARGUMENTS contains risk-assessment signals ("risk surface", "risk zones",
"code health", "assess risks", "problematic areas") → delegate to
`risk-assessment/SKILL.md`. This check runs BEFORE the intent table — risk
intent overrides EXPLAIN/TRACE/PRE-GEN/EXEMPLAR keywords.

## Codegraph intent (edge truth) → checked BEFORE the content-matching table

Graph-shape questions are answered from real call/import edges (codegraph
DuckDB), which content matching cannot derive. When $ARGUMENTS matches a row
below, route to that sub-pattern — these checks run AFTER risk-assessment but
**BEFORE** the EXPLAIN/TRACE/PRE-GEN/EXEMPLAR table (edge truth beats content
matching for graph shape). Evaluate top-to-bottom; first match wins.

| Priority | Intent contains                                                                 | Sub-pattern                                                                |
| -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1        | "циклы", "cycle", "circular dependency", "dependency loop"                      | [references/cycle-pattern.md](./references/cycle-pattern.md)               |
| 2        | "кто использует/вызывает X", "callers of X", "callees of X", "trace flow"       | [references/usage-pattern.md](./references/usage-pattern.md)               |
| 3        | "где начинается", "entry point", "main flow", "входная точка", "where X starts" | [references/entry-point-pattern.md](./references/entry-point-pattern.md)   |
| 4        | "архитектура", "structure", "backbone", "что центральное", "how X is organized" | [references/architecture-pattern.md](./references/architecture-pattern.md) |

**Match on intent phrasing, not symbol substrings.** Classify by the request's
verb frame, NOT by characters inside a symbol name. "what does X call?" / "who
calls X?" is always USAGE (row 2) even when X is named `findCycles` /
`CycleDetector` — the word "cycle" inside the target symbol does NOT make it a
CYCLE (row 1) request. Row 1 fires only on graph-shape phrasing about the loop
itself ("circular dependency", "dependency loop", "cycles in <scope>").

**Codegraph availability:** these sub-patterns need a codegraph index. The prime
digest lists `codegraph.symbols` under `## Enrichment` when it is active; when
that line is absent the graph tools (`get_callers` / `get_callees` /
`find_cycles`) are **not registered** — they are absent from the tool list, not
returning empty. Check prime first. With codegraph off, fall back to the
content-matching table below — TRACE covers usage, EXPLAIN covers architecture —
and never read an absent tool as a positive fact. Each sub-pattern states its
own fallback.

## Pattern-search keyword groups (used by EXEMPLAR routing)

| Strategy        | Keywords (any match)                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Collect**     | all, every, each, find all, list all, enumerate, gather, all implementations, all uses, all instances, everywhere, wherever |
| **Spread**      | across, across modules, between modules, compare implementations, variations of, side by side, divergence, per module       |
| **Antipattern** | antipattern, smell, debt, violation, deprecated, fragile, risky, refactor, cleanup, too complex, duplicate, decompose       |
| **Reference**   | best, correct, canonical, reference implementation, cleanest, template, pattern to follow, recommended way, good example    |

**Exception:** If the EXPLAIN reference (sub-pattern table) has a specific
pattern for this intent (e.g., "What calls X?" with "all call sites"), the
EXPLAIN pattern wins over keyword classification. EXPLAIN is more specific than
generic Collect.

## Strategy references

- Strategy: see
  [references/explain-pattern.md](./references/explain-pattern.md).
- Strategy: see [references/trace-pattern.md](./references/trace-pattern.md).
- Strategy: see
  [references/pre-gen-pattern.md](./references/pre-gen-pattern.md).
- Strategy: see
  [references/exemplar-pattern.md](./references/exemplar-pattern.md).
- Codegraph: see [references/cycle-pattern.md](./references/cycle-pattern.md).
- Codegraph: see [references/usage-pattern.md](./references/usage-pattern.md).
- Codegraph: see
  [references/entry-point-pattern.md](./references/entry-point-pattern.md).
- Codegraph: see
  [references/architecture-pattern.md](./references/architecture-pattern.md).

---

Unified code investigation. Breadth-first discovery → depth-first tracing →
output shaped by intent (human explanation OR pre-generation context).

Use tea-rags tools for code discovery. Built-in Search/Grep/Glob prohibited.
Search results are complete — no ripgrep verification passes.

## Step 0: CLASSIFY INTENT

Translate $ARGUMENTS to English (if not already). If user's language differs,
optionally run a secondary query in the original language for non-English docs.

Apply the Intent Classification table above. Then:

1. If risk intent matches → delegate to `risk-assessment/SKILL.md`.
2. If a Codegraph intent row matches → follow that sub-pattern (cycle / usage /
   entry-point / architecture). These run BEFORE EXEMPLAR/EXPLAIN/TRACE/PRE-GEN.
3. If EXEMPLAR row matches → delegate per
   [references/exemplar-pattern.md](./references/exemplar-pattern.md)
   (refactoring-scan for broad antipattern, pattern-search otherwise).
4. If PRE-GEN row matches → follow
   [references/pre-gen-pattern.md](./references/pre-gen-pattern.md).
5. If EXPLAIN row matches → continue to Explore Flow below, then format per
   [references/explain-pattern.md](./references/explain-pattern.md).
6. If TRACE row matches → continue to Explore Flow below, then format per
   [references/trace-pattern.md](./references/trace-pattern.md).

### Scope extraction

Extract `pathPattern` from $ARGUMENTS:

**Explicit markers** — `in/inside/within/under/from <X>` → `**/<X>/**`

**Directory matching** — if a word looks like a directory name:

1. Search `**/<word>/**` and `**/<word>s/**` (plural)
2. One match → use as pathPattern. Multiple → pick deepest or ask. Zero → no
   pathPattern.

Do NOT hardcode aliases — filesystem is source of truth.

### Direct-input intents (no BREADTH needed)

If the user provides **code snippet or chunk** (not a question) → skip BREADTH,
go straight to find_similar with the code as input. Then EXPLAIN similarities.

## Explore Flow (human understanding)

```
BREADTH (search) → pick interesting results →
  LATERAL (find_similar) — same pattern elsewhere?
  DEPTH (find_symbol) — trace specific symbol?
→ explain to developer
```

### 1. BREADTH

Search with query=$ARGUMENTS. Tool selection: behavior/intent → semantic_search,
known symbol → hybrid_search, bare symbol name → hybrid_search.

Scan results: files, modules, patterns. Note domain boundaries.

### 2. PICK + EXPLORE

For each interesting result:

- **"Same thing elsewhere?"** → find_similar (code or chunk ID)
- **"What is this symbol?"** → find_symbol (returns full definition, no Read
  needed). Fallback: hybrid_search if 0 results.
- **"Need surrounding context"** → Read file (offset=startLine,
  limit=endLine-startLine from chunk metadata)

Repeat as needed. Fewer deep dives > many shallow ones.

### 3. EXPLAIN / TRACE / PRE-GEN

Format the answer per the strategy reference selected in Step 0:

- EXPLAIN intents →
  [references/explain-pattern.md](./references/explain-pattern.md)
- TRACE intents → [references/trace-pattern.md](./references/trace-pattern.md)
- PRE-GEN intents →
  [references/pre-gen-pattern.md](./references/pre-gen-pattern.md)
- EXEMPLAR intents →
  [references/exemplar-pattern.md](./references/exemplar-pattern.md)
