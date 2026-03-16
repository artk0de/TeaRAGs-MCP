---
name: bug-hunt
description: Use when debugging a specific bug — finds probable root cause locations using git signal analysis and symptom-driven search
argument-hint: [bug description or symptom]
---

# Bug Hunt

Finds probable root cause of a specific bug by combining semantic search with git signal analysis. Developer passes the symptom — the skill directs search toward historically buggy code in the relevant area.

## STRICT: Tool Parameters

Use EXACTLY the tool names, presets, and parameters specified in each step.
Do NOT substitute presets (e.g. do NOT use `hotspots` when `bugHunt` is specified).
`bugHunt` and `hotspots` are different presets with different weight distributions.

## Step 1: SEMANTIC DISCOVER

`semantic_search` query=$ARGUMENTS — find area by symptom meaning.

## Step 2: SIGNAL-RANKED CANDIDATES

**MUST use:** `rank_chunks` with `rerank="bugHunt"`, pathPattern=<discovered area from Step 1>.
Do NOT use `hotspots` — it weights differently (chunkSize, chunkChurn). `bugHunt` specifically weights burstActivity + volatility + bugFix + relativeChurn.

Top results = functions that historically broke in this area.

## Step 3: MARKER SEARCH

`hybrid_search` query=$ARGUMENTS + "error exception retry duplicate fail crash timeout", pathPattern=<area>.
Fallback: `semantic_search` with same query if hybrid_search unavailable (hybrid requires index with enableHybrid=true).

Catches both semantic relevance and exact error markers that pure vector search misses.

## Step 4: CHUNK-LEVEL TRIAGE

For top candidates from Steps 2+3, read chunk-level overlay labels:

| chunk.bugFixRate | chunk.churnRatio | Classification |
|------------------|------------------|----------------|
| "critical" | "concentrated" | **Prime suspect** — absorbs most bugs in the file |
| "concerning" | any | **Secondary suspect** — elevated fix rate, worth investigating |
| "critical" | "normal" | **Distributed problem** — bugs spread across file, not localized |
| "healthy" | any | Unlikely root cause — deprioritize |

Also consider:
- chunk.commitCount "extreme" + chunk.churnVolatility "erratic" = reactive patching pattern
- chunk.ageDays "legacy" + chunk.bugFixRate "critical" = long-standing fragile code

## Step 5: ROOT CAUSE ANALYSIS

Read code of prime and secondary suspects. Analyze:
- What patterns correlate with the described symptom
- Edge cases in control flow (missing guards, off-by-one)
- Missing validation or error handling
- Race conditions, duplicate processing, stale state
- Retry logic without idempotency

Present findings as prioritized list:

```
Root cause candidates (ranked by signal confidence):

1. processPayment() [src/payment/processor.ts:45-89]
   chunk.bugFixRate: "critical", chunk.churnRatio: "concentrated"
   Observation: no idempotency check, retry logic re-enters without guard

2. handleWebhook() [src/webhook/handler.ts:12-34]
   chunk.bugFixRate: "concerning", chunk.commitCount: "high"
   Observation: async callback may fire twice on timeout
```

## Step 6: VERIFY

Validate ALL findings from Steps 1-5 before presenting to developer:

1. **tree-sitter** — structural overview of suspect functions (signatures, callers). Confirm they are reachable from the code path described in the bug.
2. **ripgrep** — search for symptom-related patterns (DB writes, API calls, error strings) inside suspects. 0 matches = false positive, remove from candidate list.
3. **ripgrep** — confirm the specific mechanism identified in Step 5 (missing guard, duplicate call, race condition) actually exists in current code, not just in git history.
4. **Fallback** — Grep/Glob if ripgrep/tree-sitter unavailable.

Discard any candidate that fails verification. Only present verified suspects to the developer.

If fix needed → invoke `/tea-rags:data-driven-generation` for the target function.
