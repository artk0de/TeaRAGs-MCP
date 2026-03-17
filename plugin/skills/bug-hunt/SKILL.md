---
name: bug-hunt
description:
  Use when debugging a specific bug or unexpected behavior — developer describes
  the symptom, skill directs search toward historically buggy code
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
3. **No built-in Search/Grep for code discovery** — only TeaRAGs tools + ripgrep
   MCP.
4. **Labels are triage.** bugFixRate "healthy" → SKIP. Trust it.
5. **Max 3 file reads** total. Source code ONLY.
6. **Query type matters.** Intent/behavior → `semantic_search`. Code symbols →
   `hybrid_search` (BM25 catches exact tokens).
   - BAD:
     `"batch create job automations perform false unavailable disabled offline client"`
     (10 tokens — BM25 requires ALL → noise)
   - GOOD: `"def automations_disabled_reasons"` (exact symbol with definition
     keyword)

## Loop

```
SEARCH → CHECKPOINT → all 3 fields filled?
  YES → PRESENT
  NO  → what specifically is missing? → SEARCH (next tool) → CHECKPOINT → ...
```

**Budget: max 3 search calls.** If root cause not found after 3 searches → read
file (max 1-2). No "one more search for confidence".

**CHECKPOINT after EVERY tool call.** Fill these three fields:

- **Suspect file(s):** \_\_\_
- **Buggy line/method:** \_\_\_
- **Why it breaks:** \_\_\_

All three filled → **PRESENT immediately.** Don't confirm, don't validate, don't
search for "how the other flow works".

One or more empty → **state which field is missing**, then pick the next tool to
fill it.

**"Not sure" ≠ "don't know."** If you have a candidate but aren't 100% confident
— present it with a confidence note. Confirmatory searches almost never change
the answer. They only waste time.

## Tools (pick by need)

| What you need                | Tool                                  | Notes                                                                                                                                                         |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find code by intent/behavior | `semantic_search` NO rerank, limit=15 | First call. Most specific query from symptom                                                                                                                  |
| Rank suspects by git signals | `rank_chunks` rerank="bugHunt"        | ≤5 files: level="chunk" first. >5 files: level="file" first. Fallback to other level if empty                                                                 |
| Find exact symbol definition | `hybrid_search`                       | One symbol per query with definition keyword (`def`, `function`, `class`)                                                                                     |
| Find similar patterns        | `find_similar` from chunk ID          | After root cause found — copy-paste bugs                                                                                                                      |
| Read suspect code            | Read file                             | Only if returned code snippets aren't enough. Max 3. When you see a method call in results and need the body — read the file, don't search for the definition |

### pathPattern rules

Use exact `relativePath` values from search results joined with braces. Do NOT
hand-craft globs.

- GOOD:
  `{app/services/workflow/pipelines/stage_clients/batch_create.rb,app/services/workflow/pipelines/jobs/create.rb}`
- BAD: `**/workflow/pipelines/{stage_clients/batch_create,jobs/create}**`
  (slashes inside braces = broken glob → empty results)

## Triage by signals

When rank_chunks returns overlay labels:

- file.bugFixRate "critical" → **prime suspect**
- file.bugFixRate "concerning" + relativeChurn high → **secondary suspect**
- file.bugFixRate "healthy" → **SKIP**

## PRESENT

Ranked list with signals + observation per suspect.

If root cause pattern found → `find_similar` from chunk ID for copy-paste bugs.

If fix needed → `/tea-rags:data-driven-generation`.
