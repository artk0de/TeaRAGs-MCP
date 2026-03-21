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
5. **Tool selection via search-cascade decision tree** — do not hard-code tool
   choice. Follow the tree: symbol name → hybrid_search, behavior description →
   semantic_search.

## Flow

```
1. DISCOVER — find the area (pure similarity, NO rerank)
   ONE semantic_search: query=symptom description, metaOnly=true, limit=10
   Do NOT use rerank="bugHunt" here — discovery is about finding the right
   area, not ranking by signals. Note top 3-5 file paths from results.

   CHECKPOINT: fill three fields:
   - Suspect file(s): ___
   - Buggy line/method: ___
   - Why it breaks: ___

   All filled? → step 3 (VERIFY)
   Not all? → step 2 (REFINE)

2. REFINE — drill down into suspects with signals
   semantic_search or hybrid_search: rerank="bugHunt", metaOnly=false,
   limit=10, pathPattern="{file1.rb,file2.rb}" (from step 1 paths)

   Additional tools via cascade rules:
   - Know symbol → hybrid_search
   - Need similar pattern → find_similar (code or chunk ID)
   - Need analytics → rank_chunks + rerank
   - Results relevant but insufficient → offset pagination (no limit)
   - Results not relevant → reformulate (max 3 attempts per cascade rules)
   → back to CHECKPOINT

3. VERIFY — confirm root cause:
   Full profile:   LSP goToDefinition/documentSymbol + partial Read
   No-LSP profile: tree-sitter/ripgrep + partial Read

   Read only when context beyond chunk boundaries needed.
   Use LSP partial read (documentSymbol → offset + limit) over whole-file Read.

4. CROSS-LAYER — if bug spans layers:
   semantic_search + language filter — one call, not grep chains.

5. PRESENT — ranked list with signals + observation per suspect.
```

**CHECKPOINT after EVERY tool call.** Fill the three fields above.

All three filled → **PRESENT immediately.** Don't confirm, don't validate, don't
search for "how the other flow works".

One or more empty → **state which field is missing**, then pick the next tool to
fill it.

**"Not sure" ≠ "don't know."** If you have a candidate but aren't 100% confident
— present it with a confidence note. Confirmatory searches almost never change
the answer.

## pathPattern rules

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

## After root cause found

If root cause pattern found → `find_similar` from code/chunk ID for copy-paste
bugs.

If fix needed → `/tea-rags:data-driven-generation`.
