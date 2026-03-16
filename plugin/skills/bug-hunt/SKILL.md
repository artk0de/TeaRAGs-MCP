---
name: bug-hunt
description: Use when debugging a specific bug or unexpected behavior — developer describes the symptom, skill directs search toward historically buggy code
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **`rank_chunks` rerank="bugHunt"** is the PRIMARY tool. You MUST call it.
3. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
4. **No built-in Search/Grep for code discovery** — use only TeaRAGs tools (semantic_search, hybrid_search, rank_chunks, find_similar) and ripgrep MCP. Built-in Search is prohibited for finding code.
5. **Labels are triage.** bugFixRate "healthy" → SKIP. Trust it.
6. **Max 3 file reads** total. Read only prime suspects.

## Steps

### 1. DISCOVER (parallel, 2-3 queries)

Run 2-3 `semantic_search` calls **in parallel**, NO rerank (pure relevance), limit=10 each:

1. **Technical query** — implementation terms from the symptom (e.g. "batch create jobs pipeline automation")
2. **Behavioral query** — what the code does wrong (e.g. "send email unavailable offline client validation")
3. **Error path query** (optional) — error handling related to symptom (e.g. "disabled automation check fail")

Intersect results: files appearing in 2+ queries = high-confidence area. Use those file paths for step 2.

### 2. DRILL DOWN (parallel)

Scoped to intersection files from step 1:

1. `rank_chunks` rerank="bugHunt", pathPattern=\<intersection files\>, limit=10.
2. `hybrid_search` query=$ARGUMENTS + "error exception fail", rerank="bugHunt", same scope, limit=10. Fallback: `semantic_search` if hybrid unavailable.

### 3. TRIAGE + ANALYZE

**STOP. Read overlay labels first.**

- chunk.bugFixRate "critical" + chunk.churnRatio "concentrated" → **prime suspect**
- chunk.bugFixRate "concerning" → **secondary suspect**
- chunk.bugFixRate "healthy" → **SKIP**

Read code of prime suspects ONLY (max 3 files).

### 4. PRESENT

Present ranked list with signals + observation per suspect.

If root cause pattern found → `find_similar` from chunk ID for copy-paste bugs.

If fix needed → `/tea-rags:data-driven-generation`.
