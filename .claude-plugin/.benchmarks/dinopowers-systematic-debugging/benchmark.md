# dinopowers:systematic-debugging Optimization Benchmark

**Date:** 2026-04-20 **Skill created:**
`.claude-plugin/dinopowers/skills/systematic-debugging/SKILL.md` **Eval cases:**
15 (5 core-rule/delegation/tool, 2 edges, 3 pressure/wrong-tool/wrong-order, 2
verdict-respect + subagent, 3 controls)

## Metrics

| Metric                | Value             |
| --------------------- | ----------------- |
| Lines (SKILL.md)      | 108               |
| Words (SKILL.md)      | 898               |
| With-rule pass rate   | 100% (15/15)      |
| Without-rule baseline | 27% (4/15)        |
| Delta                 | +73pp             |
| Iterations            | 1 (no fix needed) |

## Context

Fifth skill of `dinopowers`. First wrapper to **compose with an existing
tea-rags skill** rather than call tea-rags tools directly. `tea-rags:bug-hunt`
exists with its own methodology (FIND → INVESTIGATE → PRESENT + triage rules:
healthy→SKIP, critical→prime, concerning+churn→secondary). This wrapper
delegates to that skill, then feeds the ranked suspect list to
`superpowers:systematic-debugging` as a seeded hypothesis space.

**Core value**: correct delegation (invoke `tea-rags:bug-hunt` skill, don't
rebuild its logic via ad-hoc `semantic_search`) + symptom framing (strip
framework noise from stack traces) + strict ordering (bug-hunt before
systematic-debugging) + honest handling when bug-hunt returns 0 suspects.

## Eval Cases

| ID      | Category                      | Prompt gist                               | With-rule | Baseline |
| ------- | ----------------------------- | ----------------------------------------- | --------- | -------- |
| eval-1  | core-rule                     | config-zod test failure                   | PASS      | FAIL     |
| eval-2  | delegation                    | Chunker hangs > 10MB                      | PASS      | FAIL     |
| eval-3  | tool-selection                | Qdrant segfault at pool > 100             | PASS      | FAIL     |
| eval-4  | symptom-framing               | Stack trace with framework frames         | PASS      | FAIL     |
| eval-5  | edge (no symptom)             | Vague "something's off"                   | PASS      | PASS     |
| eval-6  | edge (all healthy)            | bug-hunt returns 0 suspects               | PASS      | PASS     |
| eval-7  | ordering (task-agent)         | Ollama unavailable debug                  | PASS      | FAIL     |
| eval-8  | pressure                      | "Не парься с bug-hunt, скажи где баг"     | PASS      | FAIL     |
| eval-9  | wrong-tool-pressure           | "Используй hybrid_search на error string" | PASS      | FAIL     |
| eval-10 | wrong-order-trap              | "Проверь composition.ts потом bug-hunt"   | PASS      | FAIL     |
| eval-11 | respect-healthy-skip          | "bug-hunt healthy но я уверен"            | PASS      | FAIL     |
| eval-12 | subagent-routing (explore)    | Qdrant collection not found               | PASS      | FAIL     |
| eval-13 | control (listing)             | "Какие функции в client.ts?"              | PASS      | PASS     |
| eval-14 | control (brainstorm vs debug) | "Может race condition?"                   | PASS      | PASS     |
| eval-15 | post-root-cause               | find_similar from bug-hunt chunk          | PASS      | FAIL     |

## Key Design Decisions

1. **Compose via `Skill(tea-rags:bug-hunt)`, not ad-hoc `semantic_search`**
   (Step 2, eval-2). `tea-rags:bug-hunt` owns the triage logic (healthy→SKIP,
   critical→prime, concerning+churn→secondary) and the PRESENT format. Direct
   `semantic_search` with `rerank="bugHunt"` skips all of that. This is a
   deviation from previous dinopowers wrappers (which call tea-rags tools
   directly) — chosen because a domain skill already exists.

2. **Symptom framing before bug-hunt** (Step 1, eval-4). Strip framework frames
   from stack traces; extract user-code frames + error message only. Baseline
   dumps raw trace into search, getting noise.

3. **Strict ordering Iron Rule** (eval-7, eval-10). bug-hunt FIRST,
   systematic-debugging SECOND. Baseline goes straight to Read/Grep on the error
   string or follows user's "check X first" ordering trap.

4. **Pressure resistance** (eval-8, eval-9). "Не парься с bug-hunt" and
   "используй hybrid_search на error string" are both rejected. Baseline
   complies with both. Iron Rule placement + explicit "Do NOT substitute" table
   resist.

5. **Respect the "healthy" skip verdict** (eval-11). If bug-hunt says
   `bugFixRate=healthy`, don't silently promote that file to prime suspect
   because of user hunch. Surface the verdict, note the override if user
   insists. Baseline silently re-investigates.

6. **Empty-suspects honesty** (eval-6). bug-hunt returns 0 → state "no bug-prone
   zones — root cause likely in recently-added untracked code or external
   dependency". Don't retry or fabricate.

7. **Post-root-cause uses `find_similar`** (eval-15). After bug-hunt identifies
   the chunk where the bug lives, copy-paste occurrences in other files are
   found via `mcp__tea-rags__find_similar` with the chunk ID — NOT by re-running
   bug-hunt or Grep. Baseline defaults to semantic_search or Grep.

8. **Symptom-vs-speculation boundary** (eval-14). "Maybe race condition?" has no
   symptom — route to `dinopowers:brainstorming`, not bug-hunt. Explicit Common
   Mistake.

## Bootstrap Observation

Bootstrap `semantic_search` returned 6 chunks from `tea-rags:bug-hunt` SKILL.md
(scores 0.55-0.70) + 2 from `dinopowers:brainstorming` (0.47-0.52). Pattern
extraction lifted:

- bug-hunt's triage semantics (healthy→SKIP, critical→prime,
  concerning+churn→secondary)
- bug-hunt's PRESENT format (file:line + signals + observation)
- bug-hunt's anti-patterns (parallel searches, curiosity search, full file
  reads)
- dinopowers step structure (Iron Rule, Step 1-4, Red Flags, Common Mistakes)

Combining both gave a **composition-style** wrapper — first of its kind. Draft
hit 100% on first iteration.

## Iteration Log

**Iteration 0 (bootstrapped draft):** 15/15 PASS with-rule. 4/15 PASS
without-rule. Delta +73pp.

No iteration needed.

## Risks and follow-ups

- **bug-hunt skill versioning**: this wrapper depends on `tea-rags:bug-hunt`'s
  interface (PRESENT format, triage labels). If bug-hunt changes, this wrapper
  silently breaks. Phase 8 should integration-test the composition.

- **Symptom framing is agent judgment**: "strip framework frames" is a
  heuristic. Phase 8 should eval framing quality with real stack traces from the
  project's test suite.

- **Skill-invocation ordering enforcement**: no hard enforcement exists that
  `Skill(tea-rags:bug-hunt)` must complete before
  `Skill(superpowers:systematic-debugging)` — this is protocol, not mechanism.
  Consider adding a PreToolUse hook in the dinopowers plugin that rejects
  `Skill(superpowers:systematic-debugging)` calls unless recent conversation
  includes a `tea-rags:bug-hunt` invocation for the same symptom.

- **Delegation pattern precedent**: this is the first dinopowers wrapper to use
  `Skill(other-dinopowers-or-tea-rags-skill)` internally. Future wrappers
  (receiving-code-review, requesting-code-review,
  finishing-a-development-branch) may want to compose with
  `tea-rags:risk-assessment` similarly — apply this pattern there.
