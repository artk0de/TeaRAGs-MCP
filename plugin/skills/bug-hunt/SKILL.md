---
name: bug-hunt
description: Use when debugging a specific bug or unexpected behavior — developer describes the symptom, skill directs search toward historically buggy code
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## MANDATORY RULES

1. **Execute this skill YOURSELF** — do NOT delegate to a subagent. Subagents don't have this skill loaded and will ignore the rules.
2. **Use `rank_chunks` with `rerank="bugHunt"`** — PRIMARY tool. You MUST call it. Not custom weights, not hotspots. Exactly `"bugHunt"`.
3. **Do NOT use `git log`, `git diff`, `git blame`** — overlay already has git signals.
4. **Max 2 `semantic_search` calls** total.
5. **Overlay labels are your triage tool.** After step 2, look at `chunk.bugFixRate` and `chunk.churnRatio` labels in results. If label is "healthy" → SKIP that result. Do not read the file. Do not search further. Trust the label.
6. **Max 3 file reads** — only prime suspects from triage. Not 15 files.
7. **Use ripgrep MCP** (`mcp__ripgrep__search`) for ALL text searches. Do NOT use built-in Search/Grep when ripgrep MCP is available. Max 3 calls after triage. **Always scope ripgrep to the discovered area** (pathPattern from step 1) — never search the entire project.

## Steps

### 1. DISCOVER

ONE `semantic_search` query=$ARGUMENTS, **no rerank** (pure similarity) → find area. Note top 3-5 file paths. Do NOT use rerank="bugHunt" here — discovery is about finding the right area, not ranking by signals.

### 2. DRILL DOWN (parallel)

Run both at the same time, scoped to files from step 1:

1. `rank_chunks` rerank="bugHunt", pathPattern for specific files, limit=15.
2. `hybrid_search` query=$ARGUMENTS + "error exception fail", rerank="bugHunt", same scope. Fallback: `semantic_search` if hybrid unavailable.

### 3. TRIAGE + ANALYZE

**STOP and read overlay labels before doing anything else.**

Merge step 2 results. For each result check `rankingOverlay`:
- chunk.bugFixRate "critical" + chunk.churnRatio "concentrated" → **prime suspect**
- chunk.bugFixRate "concerning" → **secondary suspect**
- chunk.bugFixRate "healthy" → **SKIP. Do not read. Do not search.**

Read code of prime suspects ONLY (max 3 files). Look for: missing guards, race conditions, duplicate processing, retry without idempotency.

### 4. PRESENT + SPREAD CHECK

Present ranked list with signals + observation per suspect.

If root cause pattern found → `find_similar` from prime suspect chunk ID to catch copy-paste bugs with same pattern.

If fix needed → `/tea-rags:data-driven-generation`.
