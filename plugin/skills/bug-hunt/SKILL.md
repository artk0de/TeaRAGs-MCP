---
name: bug-hunt
description: Use when debugging a specific bug or unexpected behavior — developer describes the symptom, skill directs search toward historically buggy code in the relevant area
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation. Developer provides symptom → skill finds historically problematic code in that area.

## Tool Rules

- Presets: use `bugHunt` exactly. NOT `hotspots` (different weights).
- Verification: use ripgrep MCP (`mcp__ripgrep__search`) if available. Grep only as fallback.
- Hybrid fallback: `semantic_search` if `hybrid_search` unavailable.

## Workflow

### 1. DISCOVER

`semantic_search` query=$ARGUMENTS → find area by symptom.
Verify candidates: tree-sitter (structure) + ripgrep (call-sites) in parallel.

### 2. RANK

`rank_chunks` rerank=bugHunt, pathPattern=\<area from step 1\>.

Returns functions ranked by burstActivity + volatility + bugFix + relativeChurn — worst bug history first, independent of symptom similarity.

### 3. MATCH

`hybrid_search` query=$ARGUMENTS + "error exception retry duplicate fail crash timeout", pathPattern=\<area\>.

Catches symptom-related code that rank_chunks misses (semantic + keyword).

### 4. TRIAGE + ANALYZE

Merge results from steps 2+3. Read chunk-level overlay labels + code:

| chunk.bugFixRate | chunk.churnRatio | Verdict |
|------------------|------------------|---------|
| "critical" | "concentrated" | **Prime suspect** |
| "concerning" | any | **Secondary suspect** |
| "healthy" | any | Skip |

Read code of suspects. Look for: missing guards, race conditions, duplicate processing, retry without idempotency, stale state.

Present:

```
1. processPayment() [src/payment/processor.ts:45-89]
   bugFixRate: "critical", churnRatio: "concentrated"
   → no idempotency check, retry re-enters without guard

2. handleWebhook() [src/webhook/handler.ts:12-34]
   bugFixRate: "concerning", commitCount: "high"
   → async callback may fire twice on timeout
```

### 5. VERIFY + FIX

ripgrep: confirm identified mechanism exists in current code (not just git history).

Fix → invoke `/tea-rags:data-driven-generation` for target function.
