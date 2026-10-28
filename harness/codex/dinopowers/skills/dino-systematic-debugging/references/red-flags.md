# systematic-debugging — substitutes, red flags, common mistakes

Checklist form of the SKILL.md rules — read when a draft plan deviates (direct
search instead of bug-hunt, hypothesis-first, fix without Step 5). SKILL.md
stays the owner of every printed line.

Do NOT substitute:

| Wrong approach                                                                      | Why wrong                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Direct `semantic_search` with `rerank="bugHunt"`                                    | Bypasses bug-hunt triage (healthy → SKIP, concerning+churn) + PRESENT format |
| Named preset `"hotspots"` / `"techDebt"`                                            | `bugHunt` calibrated for symptom→suspect; others = broader risk lenses       |
| `hybrid_search` on the error string (even naming an identifier, even user-demanded) | BM25 on error text → where string is logged, not where bug originates        |
| Custom rerank weights                                                               | Weighting owned by `bug-hunt` skill — don't duplicate                        |
| Built-in Grep / Read on stack trace files                                           | Loses bugFixRate; reads healthy code                                         |
| `git log --grep` / `git blame` for bug history                                      | `bug-hunt` reads git signals via overlay; manual git slower + noisier        |

## Red Flags — STOP and restart from Step 2

- "I already know where the bug is" → run Step 2; mental model may be stale
- "bug-hunt slow, grep error string" → grep finds log callsites, not origins
- Direct `semantic_search` `rerank="bugHunt"` → missed triage; invoke skill
- Hypotheses before bug-hunt output → revert, wait for suspects
- Raw bug-hunt JSON to `$systematic-debugging` → extract block first
- Fabricated `symptom` from "it feels off" → skip Step 2, state it
- Re-ran bug-hunt per hypothesis → one call per symptom; iteration = inner
  skill's job
- Full stack trace as `symptom` → named user-code frames + error message only
- Inner skill chained raw `$test-driven-development` /
  `$verification-before-completion` → intercept, invoke `$dino-Y` (Chaining
  rule)
- Root cause found, answer = fix only → add Step 5 block
- Prevention bullet without `<signal>=<label>` / `mechanism`, or overlay showed
  `deep-silo` / `erratic` / `hub` and Prevention ignores it → rewrite from
  Signal → Prevention table
- Follow-up search without "consulting decision tree → …" line → state branch,
  re-pick tool

## Common Mistakes

| Mistake                                                 | Reality                                                                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error message as first hypothesis, no bug-hunt          | Flat search. Bug-hunt narrows to bug-prone zones first.                                                                                                                                      |
| bug-hunt AFTER hypotheses ("to validate")               | Wrong order — seeds, not validates.                                                                                                                                                          |
| Ignore "healthy" skip                                   | Calibrated-out by bug-hunt; looking there = overriding trusted prior.                                                                                                                        |
| Speculative "maybe race" question                       | Brainstorming (`$dino-brainstorming`, pathPattern scoped to the named area), not debugging.                                                                                                  |
| Hand-walk `get_callers` / `get_callees` entry → suspect | `trace_path(from, to, rerank="bugHunt")` — whole chain, danger-ranked, one call.                                                                                                             |
| Empty `trace_path` = "tool failed"                      | Codegraph on: empty after `namesakes` + floor checks = no static path → drop hypothesis. Codegraph off: `trace_path` absent (not empty) = NO evidence; keep hypothesis, verify via suspects. |
