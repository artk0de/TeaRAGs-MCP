---
name: bug-hunt
description: Use when debugging a specific bug or unexpected behavior — developer describes the symptom, skill directs search toward historically buggy code
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## MANDATORY RULES

1. **Use `rank_chunks` with `rerank="bugHunt"`** — PRIMARY tool of this skill. You MUST call it.
2. **Do NOT use `git log`, `git diff`, `git blame`** — TeaRAGs overlay already has git signals.
3. **Max 2 `semantic_search` calls** — one to discover, one optional refinement.
4. **Do NOT read files before triage** — overlay labels first, then read ONLY prime suspects.
5. **Use ripgrep MCP** if available. Grep only as last fallback.

## Steps

### 1. DISCOVER

ONE `semantic_search` query=$ARGUMENTS → find area. Note top 3-5 file paths from results.

### 2. DRILL DOWN (parallel)

Run both at the same time, scoped to files from step 1 (not entire directory):

1. `rank_chunks` rerank="bugHunt", pathPattern for specific files from step 1, limit=15. Returns functions ranked by burstActivity + volatility + bugFix + relativeChurn.
2. `hybrid_search` query=$ARGUMENTS + "error exception fail", rerank="bugHunt", pathPattern same scope. Fallback: `semantic_search` if hybrid unavailable.

### 3. TRIAGE + ANALYZE

Merge steps 2 results. Triage by overlay labels:

- chunk.bugFixRate "critical" + chunk.churnRatio "concentrated" → **prime suspect**
- chunk.bugFixRate "concerning" → **secondary suspect**
- chunk.bugFixRate "healthy" → skip

Read code of prime suspects ONLY. Look for: missing guards, race conditions, duplicate processing, retry without idempotency.

### 4. SPREAD CHECK

If root cause pattern found (e.g. missing idempotency guard):

`find_similar` from prime suspect chunk ID → find code with same structure that may have the same bug (copy-paste bugs, shared patterns across services).

Flag any similar code with elevated bugFixRate — same fix likely needed there too.

Present ranked list with signals + observation per suspect. Note spread if found.

If fix needed → `/tea-rags:data-driven-generation`.
