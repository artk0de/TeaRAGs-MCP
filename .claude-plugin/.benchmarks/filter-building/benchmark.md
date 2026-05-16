# Filter Building Benchmark

Last updated: 2026-05-16 (initial — skill created and optimized in single run)

## Summary

New agent-only skill (`user-invocable: false`) extracted from
`search-cascade.md` to keep always-loaded routing thin and move deep
filter-construction guidance behind description-matching invocation.

Two eval coverages:

- **Execution coverage** — prompt explicitly names a filter intent ("exclude
  test files", "modified after 2026-03-01"). Tests whether the agent builds the
  correct filter shape.
- **Trigger coverage** — prompt names a SCOPE but never the word "filter" ("what
  did Alice ship last week", "tests of AuthService", "old ingest code"). Tests
  whether the agent self-triggers the skill and translates the implicit scope
  into typed sugar. Harder probe — measures description
  - Implicit-signals table.

## Results

| Coverage  | With-rule    | Without-rule | Delta |
| --------- | ------------ | ------------ | ----- |
| Execution | 12/12 (100%) | not run\*    | n/a   |
| Trigger   | 10/10 (100%) | 2/10 (20%)   | +80pp |

\* Execution prompts are explicit ("filter to tests only") — without-rule
baseline would only test whether the agent knows tea-rags accepts typed sugar.
That probe is dominated by training-data drift; the meaningful baseline is
trigger coverage, where the prompt is in the agent's natural language.

## Iterations

| Iteration | Skill version            | Trigger pass rate | Key change                                                    |
| --------- | ------------------------ | ----------------- | ------------------------------------------------------------- |
| 1         | initial draft            | not run           | Pre-implicit-signals draft                                    |
| 1         | + Implicit-signals table | 10/10 (100%)      | Added 15-row mapping (paraphrase → filter) before Typed table |
| 1         | baseline (no skill)      | 2/10 (20%)        | Boolean testFile, no level=file, raw filters, doc lookup miss |

100% pass rate without further iteration — the Implicit-signals table closed
both the trigger gap (agent recognizes the scope) and the enum/level enforcement
gap (typed sugar is canonical, level=file is mandatory for time fields).

## Trigger coverage — per-eval result

| ID  | Prompt                                                    | Implicit scope                        | With | Baseline | Baseline failure mode                                 |
| --- | --------------------------------------------------------- | ------------------------------------- | ---- | -------- | ----------------------------------------------------- |
| T1  | "What did Alice ship in payments last week?"              | author + modifiedAfter + level=file   | PASS | FAIL     | Raw filter, no level=file                             |
| T2  | "Show me the tests for the AuthService class."            | testFile: "only"                      | PASS | FAIL     | testFile: true (boolean, not enum)                    |
| T3  | "Production code that handles checkout, not tests."       | testFile: "exclude"                   | PASS | FAIL     | testFile: false (boolean)                             |
| T4  | "What's new in the auth module this sprint?"              | modifiedAfter + level=file            | PASS | FAIL     | Raw filter on git.ageDays, no level=file              |
| T5  | "Find Ruby code that does retries."                       | language: "ruby"                      | PASS | PASS     | (control — typed language is well-known)              |
| T6  | "Old, untouched parts of the ingest domain."              | minAgeDays + level=file               | PASS | FAIL     | Raw filter on git.ageDays, no level=file              |
| T7  | "Code related to ticket JIRA-1234."                       | taskId                                | PASS | PASS     | (functional via raw filter — borderline)              |
| T8  | "Help me onboard — show real production modules…"         | testFile + minCommitCount             | PASS | FAIL     | testFile boolean + no minCommitCount                  |
| T9  | "Where's the docs on rerank presets?"                     | documentation: "only"                 | PASS | FAIL     | find_symbol with symbol='rerank presets' — wrong tool |
| T10 | "[subagent] usages of paymentService in /…/. Skip tests." | pathPattern abs + testFile: "exclude" | PASS | FAIL     | testFile: false (boolean)                             |

## Key design decisions

1. **Implicit-signals table comes BEFORE Typed-filters table.** The first thing
   an agent's reasoning needs is "do I need a filter here?" — the
   paraphrase→filter mapping answers that. The schema-style typed table is
   second-tier reference once the agent decided "yes, build one".

2. **Description is agent-reasoning-style, not user-query-style.** The
   description names paraphrases the user will say ("Alice's code", "this
   sprint") and tells the agent to translate them. Original draft phrased it as
   "Invoke when user says 'filter X by Y'" — that fails the trigger probe
   because users don't speak that way.

3. **`level: "file"` is repeated in three places** (description, Implicit table
   footnote, Typed-filters Warning). Time-based filter without level=file is the
   most common silent failure; redundancy is intentional.

4. **NOT-for routing is concrete.** Description names the four sibling skills
   (analytics-rerank / explore / bug-hunt / risk-assessment) by their exact
   intent so the agent picks the right skill when multiple match.

## Metrics

- Skill body lines: 159 → 175 (+16, Implicit-signals table)
- Description lines: 13 → 22 (+9, paraphrase examples)
- Total file: 175 + frontmatter

## Persistence

- `evals.json` — both coverages, per-eval results
- `workspace/skill-snapshot/after.md` — final SKILL.md
- This benchmark.md

## Limitations

- **No multi-turn eval.** Cases are single-prompt; conversational drift not
  measured.
- **Subagent context approximated.** T10 prefixes prompt with
  `[subagent: task-agent]` — a real subagent invocation may carry more context
  (path hints, prior tool state) that we don't simulate.
- **No real tool execution.** Cases test instruction quality (which tool, which
  params), not tool correctness. Phase 8 integration eval not run — would catch
  cases where the typed sugar is rejected by tea-rags despite being
  shape-correct.
