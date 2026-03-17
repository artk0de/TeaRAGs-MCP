---
name: research
description: Use when researching code before generating or modifying it — pre-generation investigation with index verification, symbol validation, and overlay labels for strategy selection
argument-hint: [area or feature to research before coding]
---

# Research

Pre-generation investigation. Produces verified area analysis with overlay labels for `/tea-rags:data-driven-generation`.

**This skill feeds into code generation.** Results must be verified — unverified symbols in generated code = compilation errors.

## Pre-checks

1. `get_index_status` → if drift or stale → `reindex_changes`.
2. Confirm overlay labels are loaded (from session start `get_index_metrics`).

## Flow

```
DISCOVER (semantic_search) → VERIFY symbols → ASSESS signals (rank_chunks) →
  output: verified area + overlay labels + suspects
```

### 1. DISCOVER

`semantic_search` query=$ARGUMENTS, limit=10. NO rerank — pure relevance for discovery.

Note top 3-5 file paths from results.

### 2. VERIFY SYMBOLS

For key identifiers found in step 1 (class names, method names, imports):
- **LSP** "Find References" if available — confirms symbol is real and used.
- **ripgrep** as fallback — `pattern="ClassName.method"`. 0 matches = stale result, discard.

**Only verified files proceed to step 3.**

### 3. ASSESS SIGNALS

`rank_chunks` rerank="bugHunt", pathPattern=<verified files from step 2>, metaOnly=false.

Read overlay labels:
- file.bugFixRate → risk level
- file.ageDays → maturity
- file.churnVolatility → stability
- chunk.commitCount, chunk.churnRatio → granular risk

**Output for data-driven-generation:**
- Verified file paths
- Overlay labels per suspect
- Recommended strategy (DEFENSIVE / STABILIZATION / CONSERVATIVE / STANDARD)
- Domain owner (from dominantAuthor in overlay)

### 4. OPTIONAL: DEEP TRACE

If step 1 results show method calls that need tracing:
- `hybrid_search` query="def method_name" — one symbol per query.
- Or Read file if file already known.

## Output Format

```
Research complete for: [area]
Verified files: [list]
Strategy recommendation: [mode] because [signals]
Domain owner: [author] ([dominantAuthorPct]%)
Key signals:
  - file.bugFixRate: [label] ([value])
  - file.ageDays: [label] ([value])
  - chunk.commitCount: [label] ([value])
```

Invoke `/tea-rags:data-driven-generation` with these results.
