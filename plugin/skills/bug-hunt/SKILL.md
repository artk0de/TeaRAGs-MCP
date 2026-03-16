---
name: bug-hunt
description: Use when debugging a specific bug or unexpected behavior — developer describes the symptom, skill directs search toward historically buggy code
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## MANDATORY RULES

1. **Execute this skill YOURSELF** — do NOT delegate to a subagent.
2. **Use `rank_chunks` with `rerank="bugHunt"`** — PRIMARY tool. You MUST call it.
3. **Do NOT use `git log`, `git diff`, `git blame`** — overlay already has git signals.
4. **Max 2 `semantic_search` calls** total.
5. **Overlay labels are your triage tool.** bugFixRate "healthy" → SKIP. Trust the label.
6. **Max 3 file reads** — only prime suspects from triage.
7. **Do NOT ripgrep a file you already read.** If you read it, you have the content.
8. **Use ripgrep MCP** (`mcp__ripgrep__search`) when needed. Always scope to discovered area.

## Steps

### 1. DISCOVER

ONE `semantic_search` query=$ARGUMENTS, rerank="bugHunt", limit=10 → find area + pre-filter by bug signals. Note top 3-5 file paths.

### 2. DRILL DOWN (parallel)

Run both at the same time, scoped to files from step 1:

1. `rank_chunks` rerank="bugHunt", pathPattern for specific files, limit=10.
2. `hybrid_search` query=$ARGUMENTS + "error exception fail", rerank="bugHunt", same scope, limit=10. Fallback: `semantic_search` if hybrid unavailable.

Need more results? Use offset, not higher limit.

### 3. TRIAGE + ANALYZE

**STOP and read overlay labels before doing anything else.**

Merge step 2 results. For each check `rankingOverlay`:
- chunk.bugFixRate "critical" + chunk.churnRatio "concentrated" → **prime suspect**
- chunk.bugFixRate "concerning" → **secondary suspect**
- chunk.bugFixRate "healthy" → **SKIP**

Read code of prime suspects ONLY (max 3 files). Look for: missing guards, race conditions, duplicate processing, retry without idempotency.

### 4. PRESENT + SPREAD CHECK

Present ranked list with signals + observation per suspect.

If root cause pattern found → `find_similar` from prime suspect chunk ID to catch copy-paste bugs.

If fix needed → `/tea-rags:data-driven-generation`.
