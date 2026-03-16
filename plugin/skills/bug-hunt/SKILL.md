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

**MANDATORY: Use ripgrep MCP if available.** Check for `mcp__ripgrep__search` tool. If present — use it for ALL verification searches. Do NOT fall back to Grep when ripgrep MCP is installed.

**Fallback chain:** ripgrep MCP → Grep tool (only if ripgrep MCP unavailable).

## Step 1: DISCOVER

`semantic_search` query=$ARGUMENTS — find area by symptom meaning.

## Step 2: VERIFY DISCOVER

Verify per search-cascade rule (tree-sitter structure → ripgrep call-sites).
Discard unverified candidates. Note the pathPattern for discovered area.

## Step 3: HUNT (parallel)

Run both searches at the same time on the discovered area:

1. `rank_chunks` with `rerank="bugHunt"`, pathPattern=<area> — find functions with worst bug history regardless of symptom similarity
2. `hybrid_search` query=$ARGUMENTS + "error exception retry duplicate fail crash timeout", rerank="bugHunt", pathPattern=<area> — find functions matching symptom AND markers

Fallback: `semantic_search` with same query if hybrid_search unavailable (hybrid requires enableHybrid=true).

Merge results from both, deduplicate by file path + function name.

## Step 4: ANALYZE

For merged candidates, read chunk-level overlay labels and code in one pass:

**Triage by signals:**

| chunk.bugFixRate | chunk.churnRatio | Classification |
|------------------|------------------|----------------|
| "critical" | "concentrated" | **Prime suspect** — absorbs most bugs in the file |
| "concerning" | any | **Secondary suspect** — elevated fix rate |
| "critical" | "normal" | **Distributed problem** — bugs spread, not localized |
| "healthy" | any | Deprioritize |

Also: commitCount "extreme" + churnVolatility "erratic" = reactive patching.

**Root cause analysis** — read code of prime and secondary suspects:
- Patterns correlating with described symptom
- Missing guards, off-by-one, missing validation
- Race conditions, duplicate processing, stale state
- Retry logic without idempotency

Present as prioritized list:

```
Root cause candidates (ranked by signal confidence):

1. processPayment() [src/payment/processor.ts:45-89]
   chunk.bugFixRate: "critical", chunk.churnRatio: "concentrated"
   Observation: no idempotency check, retry logic re-enters without guard

2. handleWebhook() [src/webhook/handler.ts:12-34]
   chunk.bugFixRate: "concerning", chunk.commitCount: "high"
   Observation: async callback may fire twice on timeout
```

## Step 5: VERIFY + FIX

Verify analysis per search-cascade rule — ripgrep confirm the identified patterns actually exist in current code, not just in git history.

If fix needed → invoke `/tea-rags:data-driven-generation` for the target function. It will run its own danger check and select appropriate strategy (likely DEFENSIVE for code with "critical" bugFixRate).
