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
6. **Max 3 file reads total.** Only prime suspects from triage. Not 10 files.
7. **Parallel reads.** When reading 2+ suspect files, use a single message with
   multiple Read calls. Never read files one-by-one.
8. **No persisted output parsing.** If a search result is persisted (>10KB),
   re-run the same query with `metaOnly=true`. Do NOT attempt to Read the
   persisted file.
9. **Short queries.** Keep semantic_search queries to 3-5 meaningful tokens.
   BAD:
   `"batch create job automations perform false unavailable disabled offline client"`
   (10 tokens → noise). GOOD:
   `"batch create stage clients automations disabled"`.

## Flow

```
1. DISCOVER — find the area (pure similarity, NO rerank)
   ONE semantic_search: query=symptom description, limit=10
   Do NOT use rerank="bugHunt" here — discovery is about finding the right
   area, not ranking by signals. Read the returned code to understand the
   area. Note top 3-5 file paths from results.

   CHECKPOINT: fill three fields:
   - Suspect file(s): ___
   - Buggy line/method: ___
   - Why it breaks: ___

   All filled? → step 5 (PRESENT). Do NOT verify or refine further.
   Not all? → step 2 (REFINE)

2. REFINE — drill down into suspects with signals
   rank_chunks: rerank="bugHunt", pathPattern="{file1.rb,file2.rb}"
   (from step 1 paths), limit=10. This ranks suspects by git signals
   without a query — pure signal-driven triage.

   Read top 2-3 prime suspects IN PARALLEL (single message, multiple
   Read calls with offset+limit for partial reads).

   If rank_chunks insufficient:
   - Know symbol → hybrid_search with exact symbol
   - Need similar pattern → find_similar (code or chunk ID)
   - Need deeper analytics → rank_chunks with different rerank preset
   - Results relevant but insufficient → offset pagination (no limit)
   - Results not relevant → reformulate (max 3 attempts per cascade rules)
   → back to CHECKPOINT

3. VERIFY — confirm root cause:
   Full profile:   LSP goToDefinition/documentSymbol + partial Read
   No-LSP profile: ripgrep MCP (scoped to suspect dirs) + partial Read

   Read only when context beyond chunk boundaries needed.
   Use startLine/endLine from chunks for partial Read (offset + limit).
   Scope ripgrep to suspect directories, not entire project.

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

## Bug pattern hints

**"works single, fails batch"** — compare both paths immediately. Search for the
single-create AND batch-create service in one step. The bug is almost always:
batch path skips a check that single path does.

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
