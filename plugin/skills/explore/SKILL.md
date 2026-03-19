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
classify.

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

**Known domain aliases** — if found anywhere in $ARGUMENTS:

```
pipeline, ingest, explore, trajectory, adapters, contracts,
infra, mcp, api, bootstrap, chunker, enrichment, sync,
rerank, presets, signals, hooks
```

Match → `**/<alias>/**`

**No scope markers or aliases** → no pathPattern (search whole codebase).

### Delegation

If pattern-search intent detected:

1. State: `Pattern search: strategy=[X], scope=[pathPattern or "all"]`
2. Read and follow `pattern-search/SKILL.md`
3. Do NOT return to explore flow — pattern-search handles output

## Tools

| Strategy    | Tool                         | Purpose                                                    |
| ----------- | ---------------------------- | ---------------------------------------------------------- |
| **Breadth** | `search_code`                | Broad discovery, human-readable. "Everything related to X" |
| **Lateral** | `find_similar` from chunk ID | Same pattern in other modules                              |
| **Depth**   | `hybrid_search`              | Exact symbol lookup: `"def method_name"`                   |
| **Read**    | Read file                    | Focused range around function, not whole file              |

## Flow

```
BREADTH (search_code) → pick interesting results →
  LATERAL (find_similar) — same pattern elsewhere?
  DEPTH (hybrid_search) — trace specific symbol?
  READ — understand the code?
→ explain to developer
```

### 1. BREADTH

`search_code` query=$ARGUMENTS, limit=10.

Scan results: which files, which modules, what patterns. Note domain boundaries.

### 2. PICK + EXPLORE

For each interesting result:

- **"Same thing elsewhere?"** → `find_similar` from chunk ID
- **"What is this method?"** → `hybrid_search` query="def method_name"
- **"Need to understand this"** → Read file (focused range)

Repeat as needed. Prefer fewer deep dives over many shallow ones.

### 3. EXPLAIN

Structure by what was asked:

- **"How does X work?"** → flow: entry → processing → output. Key files + roles.
- **"Architecture of X?"** → components, responsibilities, connections,
  boundaries.
- **"Where is X used?"** → call-sites with context (why each caller uses it).
- **"How is X different from Y?"** → side-by-side with code citations.

Code citations: `file:line`. Quote 3-5 relevant lines, don't dump functions.
