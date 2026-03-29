---
name: explore
description:
  Use when developer asks to explain, understand, or explore how code works —
  "how does X work", "show me the architecture of Y", "what does Z do", "where
  is X used". Also handles pattern search intents — "find all X", "antipatterns
  in X", "best example of X". NOT for pre-generation research — use
  tea-rags:research instead
argument-hint: [what to explore — feature, module, or question]
---

# Explore

Understand how code works. Breadth-first discovery → depth-first tracing →
explain to developer.

**This skill is for human understanding, NOT for code generation input.** If
you're researching code before generating/modifying it → use
`/tea-rags:research` instead.

**CRITICAL: search-cascade governs all tool selection.** Built-in Search, Grep,
Glob, `grep`, `rg`, `find` are PROHIBITED for code discovery. When this skill
prescribes a specific tool (e.g., hybrid_search for "where is X used"), use it
directly. For intents not listed here, defer to search-cascade decision tree. Do
NOT add ripgrep "verification" or "completeness" passes after tea-rags calls —
tea-rags results are complete. ripgrep is only for exact text patterns (TODO,
FIXME, import paths) per search-cascade rules.

**MANDATORY: After every search call, run @post-search-validation.md checks
(no-match detection + disambiguation). Do NOT skip.**

## Step 0: CLASSIFY INTENT

Translate $ARGUMENTS to English (if not already). If user's language differs,
optionally run a secondary query in the original language for non-English docs.

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

## Flow

```
BREADTH (search) → pick interesting results →
  LATERAL (find_similar) — same pattern elsewhere?
  DEPTH (find_symbol) — trace specific symbol?
→ explain to developer
```

### 1. BREADTH

Search with query=$ARGUMENTS. Search-cascade determines the tool.

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
