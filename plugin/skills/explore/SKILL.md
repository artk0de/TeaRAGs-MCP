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

**CRITICAL: ALL code discovery MUST go through search-cascade.** Built-in
Search, Grep, Glob, `grep`, `rg`, `find` are PROHIBITED for finding code. If you
feel the urge to grep — STOP and use the search-cascade decision tree instead.
TeaRAGs tools are the primary instruments; ripgrep MCP is the only acceptable
fallback, and only after TeaRAGs returned no results.

## Step 0: CLASSIFY INTENT

Before any search, translate $ARGUMENTS to English (if not already) and
classify. If the user's language differs from English, optionally run a
secondary query in the user's language to surface non-English documentation that
English queries miss.

### Pattern-search intents → delegate to pattern-search/SKILL.md

Check $ARGUMENTS against these keyword groups. Match = delegate to
pattern-search strategy. **First match wins.**

**Collect** — find all implementations:

```
all, every, each, find all, list all, show all, show me all,
enumerate, gather, collect, inventory, catalog,
all implementations, all uses, all instances, all occurrences,
all places where, everywhere, wherever, anywhere,
how many ways, how many places, what are the ways,
what are, where are, list, show me
```

**Spread** — compare across modules:

```
across, across modules, across domains, between modules,
different approaches, different ways, how different modules,
compare implementations, compare approaches, variations of,
side by side, contrast, divergence, inconsistency between,
differently, each module, per module,
how does each, how do different
```

**Antipattern** — find problematic code:

```
antipattern, anti-pattern, bad, wrong, incorrect, broken,
smell, code smell, problematic, ugly, messy, hacky, hack,
debt, tech debt, violation, violates, inconsistent,
deprecated usage, misuse, misused, abuse, abused,
should not, shouldn't, not supposed to, dangerous,
fragile, brittle, risky, suspicious, questionable,
refactor, refactoring, needs refactoring, what to refactor,
cleanup, clean up, simplify, improve,
too complex, too large, too long, overloaded, bloated,
god class, god method, monolith, spaghetti, tangled, coupled, coupling,
duplicate, duplication, duplicated, copy-paste, copied,
unmaintainable, unreadable, confusing,
decompose, extract, split, break up, break apart
```

**Reference** — find best example:

```
best, correct, proper, canonical, exemplary, ideal,
reference implementation, gold standard, cleanest,
most readable, well-written, stable example,
model, template, blueprint, pattern to follow,
how should, how to properly, right way to, recommended way,
good example, show me a good, well-designed
```

**No match** → continue to explore flow (Step 1).

### Scope extraction (independent from intent)

After determining strategy, extract `pathPattern` from $ARGUMENTS:

**Explicit scope markers** — pattern: `<marker> <name>`:

```
in <X>            → **/X/**
in domain <X>     → **/domains/X/**
in module <X>     → **/X/**
inside <X>        → **/X/**
within <X>        → **/X/**
under <X>         → **/X/**
from <X>          → **/X/**
```

**Directory name matching** — if a word in $ARGUMENTS looks like a directory
name (not a generic English word):

1. Search for matching directories: `**/<word>/**` and `**/<word>s/**` (plural).
2. If exactly one match → use it as pathPattern.
3. If multiple matches → pick the deepest (most specific) path, or ask user.
4. If zero matches → no pathPattern (search whole codebase).

Do NOT hardcode alias lists — they are project-specific and go stale. Let the
filesystem be the source of truth.

**No scope markers or directory matches** → no pathPattern (search whole
codebase).

### Delegation

If pattern-search intent detected:

1. State: `Pattern search: strategy=[X], scope=[pathPattern or "all"]`
2. **Antipattern + broad scope** (refactoring/cleanup without specific entity):
   - Read and follow `refactoring-scan/SKILL.md`
   - Examples: "what to refactor in explore", "cleanup ingest domain"
3. **All other pattern-search intents**:
   - Read and follow `pattern-search/SKILL.md`
4. Do NOT return to explore flow — delegated skill handles output

## Tools

**Follow search-cascade decision tree** for tool selection. Do NOT hard-code
tool choice. The cascade determines the tool based on query shape.

Explore strategies map to cascade inputs:

| Strategy    | What to pass to search-cascade                   |
| ----------- | ------------------------------------------------ |
| **Breadth** | query=$ARGUMENTS (cascade picks search tool)     |
| **Lateral** | code/chunk from results (cascade → find_similar) |
| **Depth**   | symbol name from results (cascade → semantic)    |
| **Read**    | Read file — focused range, not whole file        |

## Flow

```
BREADTH (search-cascade picks tool) → pick interesting results →
  LATERAL (find_similar) — same pattern elsewhere?
  DEPTH (search-cascade for symbol) — trace specific symbol?
  READ — understand the code?
→ explain to developer
```

### 1. BREADTH

Follow search-cascade with query=$ARGUMENTS. Cascade determines the tool.

Scan results: which files, which modules, what patterns. Note domain boundaries.

### 2. PICK + EXPLORE

For each interesting result, follow search-cascade:

- **"Same thing elsewhere?"** → pass code/chunk ID to cascade (→ find_similar)
- **"What is this method?"** → pass symbol name to cascade (→ hybrid_search for
  symbol + context, semantic_search for bare symbol names)
- **"Need to understand this"** → Read file (focused range)

Repeat as needed. Prefer fewer deep dives over many shallow ones.

### 3. EXPLAIN

Structure by what was asked:

- **"How does X work?"** → flow: entry → processing → output. Key files + roles.
- **"Architecture of X?"** → components, responsibilities, connections,
  boundaries.
- **"Where is X used?"** → follow search-cascade exhaustive usage branch:
  semantic_search to verify naming, then ripgrep MCP for exhaustive call-site
  list. semantic_search alone gives ~13% recall for usage queries.
- **"How is X different from Y?"** → always use contrastive decomposition. Run
  in parallel: (1) ONE semantic_search for the shared concept (e.g.,
  "preloading" for lazy_preload vs includes), (2) ripgrep for files containing X
  but not Y, (3) ripgrep for files containing Y but not X. Present as three
  groups: only-X, only-Y, both. Do NOT run two separate semantic searches —
  close concepts produce 80%+ overlap, wasting calls.
- **Legacy/generic model names** (e.g., `Contact`, `Client` at top-level) may
  score lower than namespaced alternatives. Supplement with ripgrep:
  `rg 'class Contact < ' app/models/` when core entities are missing from
  semantic results.

Code citations: `file:line`. Quote 3-5 relevant lines, don't dump functions.
