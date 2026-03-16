---
name: bug-hunt
description: Use when debugging a specific bug or unexpected behavior — developer describes the symptom, skill directs search toward historically buggy code
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## MANDATORY RULES

1. **Use `rank_chunks` with `rerank="bugHunt"`** — this is the PRIMARY tool of this skill. It ranks functions by bug history signals. You MUST call it.
2. **Do NOT use `git log`, `git diff`, `git blame`** — TeaRAGs already has all git signals indexed. Reading git directly wastes time.
3. **Do NOT make more than 2 `semantic_search` calls** — one to discover area, one optional refinement. Not 5.
4. **Do NOT read files before triage** — read overlay labels first, then read ONLY prime suspects.
5. **Use ripgrep MCP** (`mcp__ripgrep__search`) for verification if available. Grep only as last fallback.

## Steps

### 1. DISCOVER

ONE `semantic_search` query=$ARGUMENTS → find area. Note pathPattern from top results.

### 2. RANK (most important step)

`rank_chunks` rerank="bugHunt", pathPattern=\<area\>, limit=15.

This returns functions ranked by burstActivity + volatility + bugFix + relativeChurn. The top results are the most historically problematic functions in this area. Read their overlay labels — chunk.bugFixRate, chunk.churnRatio, chunk.commitCount.

### 3. MATCH

`hybrid_search` query=$ARGUMENTS + "error exception fail", rerank="bugHunt", pathPattern=\<area\>.

Fallback: `semantic_search` if hybrid unavailable.

### 4. TRIAGE + ANALYZE

Merge steps 2+3. Triage by overlay labels:

- chunk.bugFixRate "critical" + chunk.churnRatio "concentrated" → **prime suspect**
- chunk.bugFixRate "concerning" → **secondary suspect**
- chunk.bugFixRate "healthy" → skip

Read code of prime suspects ONLY. Look for: missing guards, race conditions, duplicate processing, retry without idempotency.

Present ranked list with signals + observation per suspect.

### 5. VERIFY + FIX

ripgrep: confirm mechanism exists in current code.

Fix → `/tea-rags:data-driven-generation`.
