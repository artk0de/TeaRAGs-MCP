---
name: explore
description: Use when developer asks to explain, understand, or explore how code works — "how does X work", "show me the architecture of Y", "what does Z do", "where is X used". NOT for pre-generation research — use tea-rags:research instead
argument-hint: [what to explore — feature, module, or question]
---

# Explore

Understand how code works. Breadth-first discovery → depth-first tracing → explain to developer.

**This skill is for human understanding, NOT for code generation input.** If you're researching code before generating/modifying it → use `/tea-rags:research` instead.

## Tools

| Strategy | Tool | Purpose |
|----------|------|---------|
| **Breadth** | `search_code` | Broad discovery, human-readable. "Everything related to X" |
| **Lateral** | `find_similar` from chunk ID | Same pattern in other modules |
| **Depth** | `hybrid_search` | Exact symbol lookup: `"def method_name"` |
| **Read** | Read file | Focused range around function, not whole file |

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
- **"Architecture of X?"** → components, responsibilities, connections, boundaries.
- **"Where is X used?"** → call-sites with context (why each caller uses it).
- **"How is X different from Y?"** → side-by-side with code citations.

Code citations: `file:line`. Quote 3-5 relevant lines, don't dump functions.
