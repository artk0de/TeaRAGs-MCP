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

Unified code investigation. Breadth-first discovery → depth-first tracing →
output shaped by intent (human explanation OR pre-generation context).

Use tea-rags tools for code discovery. Built-in Search/Grep/Glob prohibited.
Search results are complete — no ripgrep verification passes.

## Step 0: CLASSIFY INTENT

Translate $ARGUMENTS to English (if not already). If user's language differs,
optionally run a secondary query in the original language for non-English docs.

### Pre-generation intent → PRE-GEN flow

Check $ARGUMENTS for pre-generation signals. **First match wins** → PRE-GEN flow
(skip all other classification).

| Signal                    | Examples                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| Explicit coding intent    | "before I modify/change/refactor/add/implement", "before coding"       |
| Research request + coding | "research X — I need to add Y", "what should I know before touching X" |
| Context for generation    | "context for changing X", "risks before refactoring X"                 |

**Match found → go to PRE-GEN flow (below).**

### Risk intent → delegate to risk-assessment

If $ARGUMENTS contains risk-assessment signals ("risk surface", "risk zones",
"code health", "assess risks", "problematic areas") → delegate to
`risk-assessment/SKILL.md`. This check runs BEFORE keyword matching below — risk
intent overrides Spread/Collect keywords.

### Pattern-search intents → delegate

Check $ARGUMENTS against these keyword groups. **First match wins** → delegate.

| Strategy        | Keywords (any match)                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Collect**     | all, every, each, find all, list all, enumerate, gather, all implementations, all uses, all instances, everywhere, wherever |
| **Spread**      | across, across modules, between modules, compare implementations, variations of, side by side, divergence, per module       |
| **Antipattern** | antipattern, smell, debt, violation, deprecated, fragile, risky, refactor, cleanup, too complex, duplicate, decompose       |
| **Reference**   | best, correct, canonical, reference implementation, cleanest, template, pattern to follow, recommended way, good example    |

**No match** → continue to explore flow (Step 1).

**Exception:** If EXPLAIN section (Step 3) has a specific pattern for this
intent (e.g., "What calls X?" with "all call sites"), the EXPLAIN pattern wins
over keyword classification. EXPLAIN is more specific than generic Collect.

**Match found (no EXPLAIN override) → STOP and delegate.** Do NOT continue to
explore flow.

- Antipattern + broad scope (no specific entity) → read and follow
  `refactoring-scan/SKILL.md`
- All other matches → read and follow `pattern-search/SKILL.md`

Delegated skill handles everything — search, output, formatting. Do NOT search
yourself before or after delegating.

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

### 3. EXPLAIN

Structure by what was asked:

- **"How does X work?"** → flow: entry → processing → output. Key files + roles.
- **"Architecture of X?"** → components, responsibilities, connections,
  boundaries.
- **"Where is X used?"** → hybrid_search (BM25 = full recall for exact symbol
  names, dense = semantic context). Paginate with offset until all usages found
  (see `references/pagination.md`).
- **"How is X different from Y?"** → contrastive decomposition:
  1. ONE hybrid_search for the shared concept (e.g., "preloading" for
     lazy_preload vs includes) — BM25 catches both names, semantic catches
     context
  2. Scan results for X-only, Y-only, and both groups by file path
  3. Present as three groups: only-X, only-Y, both Do NOT run two separate
     semantic searches — close concepts produce 80%+ overlap.
- **"What changed recently in X?"** → rank_chunks with `rerank="codeReview"` +
  pathPattern for X + `maxAgeDays=14`. Shows recent changes ranked by review
  relevance (recency, burstActivity, chunkChurn).
- **"Who owns X?" / "Who knows about X?"** → rank_chunks with
  `rerank="ownership"` + pathPattern. Overlay shows `dominantAuthor`,
  `dominantAuthorPct`, `authors[]`. Report ownership distribution.
- **"Is X tested?" / "Show tests for X"** → find_symbol for X with pathPattern
  targeting test directories. Discover test dir first: Glob for
  `**/{test,tests,spec,specs,__tests__}` to find project's test convention, then
  use that as pathPattern. `metaOnly=true` for existence check, `metaOnly=false`
  for test content. Fallback: hybrid_search for X name + pathPattern if
  find_symbol returns 0 results (test files may not use exact symbolId).
- **"What calls X?" (backward trace)** → iterative hybrid_search. Start:
  hybrid_search for X → note callers from results → hybrid_search for each
  caller → repeat until entry point or 3 levels deep. Present as chain:
  `A → B → C → X`.
- **"What does X call?" / "What does X depend on?" (forward trace)** → two
  levels of resolution, both from find_symbol (instant, no embedding):
  1. **File-level:** find_symbol for X → chunk payload has `imports[]` array
     showing all file dependencies. This is the dependency graph.
  2. **Method-level:** from the same find_symbol result, read the method body →
     note called methods → find_symbol for each → repeat up to 3 levels. Present
     both: file deps as flat list, method calls as tree:
     `X → { Y.method(), Z.method() } → { ... }`.

Code citations: `file:line`. Quote 3-5 relevant lines, don't dump functions.

---

## PRE-GEN Flow (pre-generation context)

Triggered by Step 0 classification. Gathers actionable context for code
generation — files, risk signals, overlay labels.

### PG-1. DISCOVER

Find target area files. Select tool directly:

- **Behavior/intent query** → `semantic_search` (query=$ARGUMENTS,
  metaOnly=true, limit=10, documentation="exclude")
- **Known symbol + context** → `hybrid_search` (query=$ARGUMENTS, metaOnly=true,
  limit=10, documentation="exclude")

Add `pathPattern` if module is known. Add `language` if polyglot codebase.
`documentation="exclude"` prevents RFC/docs from taking result slots.

**Checkpoint:** Found target files (3-5 paths)?

- YES → extract pathPattern, proceed to PG-2
- NO → reformulate query (narrower scope, different angle), retry once

### PG-2. SIGNAL LOOKUP

For each key symbol from PG-1 (2-5 symbols), call `find_symbol` with rerank to
get overlay labels. One call per symbol — find_symbol is instant (scroll, no
embedding).

```
find_symbol:
  symbolId: <symbol name from PG-1>
  path: <project>
  rerank: "techDebt"          ← any preset works, overlay is preset-independent
  metaOnly: false             ← need overlay labels
```

Extract per-symbol: bugFixRate, ageDays, churnVolatility, commitCount,
dominantAuthor, dominantAuthorPct. These feed DDG strategy selection.

**Interpretation:** when presenting overlay findings to the user (pre-gen
context or explore), do not read single signals in isolation. Consult
`references/signal-interpretation.md` for pair diagnostics — especially when
churn, age, or ownership are high. Single-signal conclusions mislead (high churn
≠ active development; mono ownership ≠ silo risk).

### PG-3. DEEP TRACE (optional)

If specific symbols need structural understanding before generation:

- `find_symbol` for 1-2 key symbols (definition + imports)
- Fallback: `hybrid_search` if find_symbol returns 0

**Limit:** Do NOT trace call chains or dependency trees.

### PG-4. OUTPUT

```
Pre-generation context for: [area]

Files: [list with pathPattern-ready format]
Language: [detected language]
Symbols with overlay:
  - symbolName: { bugFixRate, ageDays, churnVolatility, commitCount,
                  dominantAuthor, dominantAuthorPct }

Context for generation:
  - pathPattern: [ready for data-driven-generation]
  - overlay labels: [per-symbol from PG-2]
```

Output is self-contained. data-driven-generation reads overlay labels directly.
