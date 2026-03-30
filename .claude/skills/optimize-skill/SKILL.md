---
name: optimize-skill
description:
  Eval-driven skill optimization. Use when a skill needs improvement — wrong
  tool selection, missing use cases, verbose instructions, stale rules. Runs
  structured eval cycles with parallel subagents to measure skill quality and
  iterate until 100% pass rate.
argument-hint: [skill path or name to optimize]
---

# Optimize Skill

Structured eval-driven methodology for optimizing Claude Code skills. Measures
actual agent behavior against expected tool selection, identifies gaps, fixes
them, and verifies fixes.

## Prerequisites

1. **Load skill-creator toolkit** — invoke `/example-skills:skill-creator` via
   the Skill tool BEFORE starting any phase. It provides scripts, agents, and
   eval-viewer used in Phases 6-8. Keep it loaded throughout the session.
2. Skill file to optimize (SKILL.md path)
3. Understanding of what the skill should do (read it first)

## Phase 1: AUDIT

Read the skill. Identify problems by category:

| Category              | What to look for                                               |
| --------------------- | -------------------------------------------------------------- |
| **Stale rules**       | References to removed tools, old patterns, outdated stats      |
| **Conflicts**         | Contradicts search-cascade or other skills                     |
| **Verbosity**         | Repeated instructions, keyword lists that could be tables      |
| **Missing use cases** | User intents the skill doesn't handle                          |
| **Wrong routing**     | Skill sends agent to wrong tool for a given intent             |
| **Anti-patterns**     | Read after search, ripgrep for semantic queries, Glob for code |

Present findings as numbered list. Get user approval on each finding (interview
style, one at a time, with recommended resolution).

## Phase 2: BASELINE EVAL (before fixing)

**Measure first, fix second.** Audit findings are hypotheses — eval confirms
them. Do NOT apply fixes until baseline proves the skill is actually broken.

### 2.1 Design eval cases

Create eval cases targeting:

1. **Each audit finding** — one case per identified problem. The case should
   FAIL if the problem exists and PASS if the skill handles it correctly
2. **Regression controls** — unchanged behaviors that must still work
3. **Edge cases** — non-English input, code snippet input, ambiguous intent
4. **Subagent routing (MANDATORY)** — ALWAYS include 2+ cases simulating skill
   invocation from different agent contexts:
   - `[subagent: explore]` — skill called during codebase exploration
   - `[subagent: task-agent]` — skill called during autonomous task execution
   - `[subagent: plan-executor]` — skill called as a plan step
   - `[subagent: other]` — any other agent type that might use the skill These
     cases test whether skill instructions work when the calling agent has
     limited context (no CLAUDE.md, no rules, no search-cascade). Frame prompts
     as a subagent would phrase them — with explicit paths, not vague intents.

Each case has:

```
Eval-N: "<user prompt>"
Expected: <tool sequence>. NOT <wrong tools>.
Failure mode: <what we're testing against>
Audit finding: <N or "control">
```

**Minimum 8 cases.** Balance: ~50% audit findings, ~30% controls, ~20% edges.

### 2.2 Run with-rule eval

Spawn ONE subagent with the **full skill text injected** into its prompt.
Present ALL eval cases in a single prompt. Agent describes tool selection plan
for each — does NOT execute tools.

Grade each case: PASS / FAIL against expected behavior.

### 2.3 Run without-rule baseline

Spawn ONE subagent with NO skill text — only the list of available MCP tools.
Same eval cases. Agent describes its natural tool selection.

This establishes the **delta** — how much the skill improves behavior.

### 2.4 Grade and triage

```
With-rule:    N/M PASS (X%)
Without-rule: N/M PASS (Y%)
Delta:        +Zpp
```

**Triage audit findings by eval results:**

- Finding FAILS in with-rule eval → **confirmed problem**, proceed to fix
- Finding PASSES in with-rule eval → **not broken**, drop from fix list
- Finding PASSES in both with-rule and without-rule → **skill adds no value
  here**, consider if the instruction is dead weight

Present triage to user. Only confirmed problems proceed to Phase 3.

## Phase 3: FIX

Apply fixes ONLY for confirmed problems (eval-proven failures from Phase 2).

Track:

- Lines before/after (target: -30% or more for verbose skills)
- Each fix with reason and linked eval case

## Phase 4: VERIFY

Re-run full eval suite against fixed skill.

### 4.1 Run with-rule eval (fixed skill)

Same eval cases from Phase 2. All previously failing cases must now PASS.
Previously passing cases must not regress.

### 4.2 Grade

```
Before fix:   N/M PASS (X%)
After fix:    N/M PASS (X'%)
Baseline:     N/M PASS (Y%)
Delta:        +Zpp
```

**Target: 100% with-rule pass rate.** If not met → iterate (Phase 5).

## Phase 5: ITERATE (if needed)

For each remaining FAIL:

1. Identify **why** the agent chose wrong — ambiguous instruction? missing rule?
   conflicting guidance?
2. Fix the specific instruction
3. Re-run ONLY failed cases + 2 random controls (not full suite)
4. Repeat until 100%

**Max 3 iterations.** If still failing after 3 — the skill design needs
rethinking, not tweaking. Report to user.

## Phase 6: PERSIST (MANDATORY — execute inline, not deferred)

**This phase is NOT optional.** Save results immediately after Phase 4/5
completes. Do not wait for user to ask. Do not skip because "session is ending".
Benchmark artifacts are the proof that optimization happened — without them, the
work is unverifiable.

Save results to `.claude-plugin/.benchmarks/<skill-name>/`:

```
.benchmarks/<skill-name>/
├── benchmark.md        — committed. Permanent optimization record.
├── evals.json          — committed. Eval cases + assertions + results.
└── workspace/          — gitignored. Recreatable by this skill.
    ├── skill-snapshot/  — frozen copy of skill before/after optimization
    └── iteration-N/    — subagent outputs per iteration
```

**Execute these steps in order:**

1. **Create workspace/** dir (gitignored —
   `.claude-plugin/.benchmarks/**/workspace/`)
2. **Save evals.json** to `.benchmarks/<skill-name>/evals.json` (NOT inside
   workspace/) — must include ALL eval cases with: prompt, expected output,
   assertions, audit finding references, and final pass/fail results per
   iteration. This file is committed — eval cases are reusable test artifacts.
3. **Copy SKILL.md** before and after to `workspace/skill-snapshot/`
4. **Write benchmark.md** (committed) with: summary, changes table, key design
   decisions, metrics (lines before/after), iterations table (pass rates per
   iteration), per-eval detail table (prompt + before/after grade), integration
   test results if Phase 7/8 was run
5. **Update README.md** in `.benchmarks/` with new skill row

Present final state to user:

```
Skill: [name]
Lines: [before] → [after] ([delta]%)
Eval cases: [N] (with-rule [X]%, baseline [Y]%, delta +[Z]pp)
Iterations: [count]
Benchmark: .claude-plugin/.benchmarks/[name]/benchmark.md
```

## Key Principles

**Eval tests INSTRUCTION QUALITY, not tool correctness.** We verify that the
skill text unambiguously guides the agent to the right tool. Whether the tool
itself works is a separate concern (integration tests).

**Parallel subagents for with/without.** Always run both in parallel when
establishing baseline. Re-runs (iterations) only need with-rule.

**One subagent per eval suite.** All cases in one prompt — cheaper and shows
whether instructions scale when agent handles multiple intents in context.

**Delta is the metric.** A skill that scores 100% but baseline also scores 90%
adds little value. Target: +50pp minimum delta.

**Minimum viable eval.** Don't over-test. 8-15 cases covers most skills. Add
cases only for discovered failure modes.

## Phase 7: DESCRIPTION OPTIMIZATION (optional)

After skill body is stable, optimize the `description` field in frontmatter for
better triggering accuracy. Follow the **Description Optimization** section from
`/example-skills:skill-creator` (loaded in Prerequisites step 1):

1. Generate 20 trigger eval queries (10 should-trigger, 10 should-not-trigger)
2. Review with user via HTML template (`assets/eval_review.html` from
   skill-creator)
3. Run optimization loop from the skill-creator directory:
   ```bash
   python -m scripts.run_loop \
     --eval-set <path-to-trigger-eval.json> \
     --skill-path <path-to-skill> \
     --model <model-id> \
     --max-iterations 5 --verbose
   ```
4. Apply `best_description` to SKILL.md frontmatter

This is separate from body optimization — description controls **when** the
skill triggers, body controls **what it does** once triggered.

## Phase 8: FULL INTEGRATION EVAL (optional)

When lightweight tool-selection eval is not enough (complex multi-step skills,
skills that produce files), follow the **Running and evaluating test cases**
section from `/example-skills:skill-creator` (loaded in Prerequisites step 1):

1. Save eval cases to `evals/evals.json` (see skill-creator's
   `references/schemas.md` for schema)
2. Spawn with-skill and baseline subagents that **execute the skill** on real
   tasks
3. Save outputs to `<skill-name>-workspace/iteration-N/`
4. Grade using `agents/grader.md` from skill-creator, then review via:
   ```bash
   python <skill-creator-path>/eval-viewer/generate_review.py \
     <workspace>/iteration-N \
     --skill-name "<name>" \
     --benchmark <workspace>/iteration-N/benchmark.json
   ```
5. Aggregate benchmarks:
   ```bash
   python -m scripts.aggregate_benchmark <workspace>/iteration-N \
     --skill-name <name>
   ```

Key difference from Phase 2: integration eval tests **end-to-end behavior**
(tool calls, outputs, quality). Phase 2 tests **instruction clarity** (does the
agent know which tool to pick). Use Phase 2 first — it's faster. Escalate to
Phase 8 only when tool selection is correct but output quality is uncertain.

## Anti-patterns

- **Skipping PERSIST** — benchmark artifacts are proof of work. Without
  evals.json and benchmark.md, the optimization is unverifiable and
  unrepeatable. Execute Phase 6 inline, immediately after verify passes
- **Fixing before measuring** — audit findings are hypotheses. Run baseline eval
  (Phase 2) to confirm problems exist before applying fixes. A finding that
  passes eval is not broken — drop it from the fix list
- **Running real MCP calls in Phase 2 eval** — unnecessary, tests tool not skill
- **One subagent per eval case** — wasteful, use one subagent for all cases
- **Skipping baseline** — can't measure delta without it
- **Fixing skill without re-eval** — any fix can break other cases
- **Inflating eval count** — 20+ cases with no new failure modes is waste
- **Skipping Phase 2, jumping to Phase 8** — Phase 8 is 10x slower. Always start
  with lightweight tool-selection eval
