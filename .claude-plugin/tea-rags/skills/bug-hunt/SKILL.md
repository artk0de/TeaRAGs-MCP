---
name: bug-hunt
description:
  Search for the source of a concrete failure by ranking historically buggy code
  (high bugFixRate + churn) against the symptom. Triggers on "debug X", "why
  does Y fail", "test fails", "stack trace says Z", "падает", "почему не
  работает". NOT for code health scanning without a specific symptom — use
  risk-assessment for that.
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## Rules

1. **Execute YOURSELF** — no subagents.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
3. **No built-in Search/Grep for code discovery** — TeaRAGs + ripgrep MCP only.
4. **Search results contain code.** `metaOnly=false` (default) returns chunk
   content + startLine/endLine. Evaluate checkpoint from search results BEFORE
   any Read or navigation.
5. **Partial reads only.**
   `Read(path, offset=startLine, limit=endLine-startLine)` using coordinates
   from search results. Never read full files.
6. **Labels are triage.** bugFixRate "healthy" → SKIP. Trust it.

## Loop

```
1. Search (search-cascade, rerank="bugHunt", limit=10).

2. CHECKPOINT — fill from ALL available info:
   - Suspect file(s): ___
   - Buggy line/method: ___
   - Why it breaks: ___

   All filled? → PRESENT. STOP.
   "Not sure" ≠ "don't know" — present with confidence note.

3. ONLY IF checkpoint incomplete — ONE action for what's missing.
   Search-cascade for tool selection. Go to step 2.
```

## PRESENT

Ranked suspect list. Per suspect: file:line, signal labels (bugFixRate,
relativeChurn), and one-sentence observation of why it's the root cause.

## Anti-patterns

- **Parallel searches in discovery.** ONE search finds the area. If it returns
  batch_create AND jobs/create — both suspects are already found.
- **Curiosity search.** "How does the other path work?" → Read or LSP, not
  search. You already know WHERE the code is.
- **Confirmatory search.** If checkpoint has a candidate — present it. Don't
  search for "proof." Confirmatory searches almost never change the answer.
- **Full file reads.** Chunk coordinates exist. Use them.

## pathPattern rules

Use exact `relativePath` values from search results joined with braces:

- GOOD: `{app/services/batch_create.rb,app/services/jobs/create.rb}`
- BAD: `**/services/{batch_create,jobs/create}**` (slashes inside braces =
  broken glob)

## Signal triage

When rank_chunks returns overlay labels:

- file.bugFixRate "critical" → **prime suspect**
- file.bugFixRate "concerning" + relativeChurn high → **secondary suspect**
- file.bugFixRate "healthy" → **SKIP**

**High bugFixRate + high `imports` (fan-in):** suspect may be a coupling point
propagating bugs from upstream, not the origin. Check callers before fixing
here. See `references/signal-interpretation.md` (bug attractor vs coupling).

## Trace the chain between suspects

Signal triage gives a **flat** list — WHAT is historically buggy. `trace_path`
turns it into a **causal chain** — WHICH step on the route from an entry point
to a suspect is riskiest.

**Use when** a suspect surfaced but the symptom enters elsewhere (a handler,
controller, job) — you need the danger-ranked call path between them, not just
the endpoints.

```text
trace_path(from=<entry point>, to=<suspect>, rerank="bugHunt")
```

Per-step `dangerOverlay` carries the same git signals as triage (bugFixRate,
relativeChurn) for every hop on the path. Read the response top-down:

- `dangerRanking[0]` → **inspect-first step** — the riskiest hop on the route.
- each step's `dangerOverlay` → triage that hop exactly like the flat list
  (`critical` → prime, `concerning` + churn → secondary, `healthy` → SKIP).
- `aggregateDanger` → ranks competing paths when `maxPaths > 1`; the
  highest-danger route is the one to walk first.
- **Empty result = no static call path** from `from` to `to`. Negative signal:
  the suspect is not reachable from that entry — wrong entry, dynamic dispatch,
  or wrong suspect. Re-pick before reading code.

**Fresh-regression bisect:** `rerank="recent"` instead of `bugHunt` ranks the
path by recency, surfacing the step that changed most recently — the likely
regression on a route that worked before.

Curated danger presets for `trace_path`: `bugHunt` (default), `dangerous`,
`hotspots`, `recent`, `ownership`, `blastRadius`, `securityAudit`, `techDebt`,
`codeReview`. Bound the search with `maxDepth` / `maxPaths`.

## After root cause found

Pattern found → `find_similar` from chunk ID for copy-paste bugs in other files.
Fix needed → `/tea-rags:data-driven-generation`.
