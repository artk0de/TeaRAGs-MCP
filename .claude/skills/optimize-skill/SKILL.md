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
   eval-viewer used in Phases 5-7. Keep it loaded throughout the session.
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

Present findings. Get user approval before fixing.

## Phase 2: FIX

Apply fixes from audit. Track:

- Lines before/after (target: -30% or more for verbose skills)
- Each fix with reason

## Phase 3: EVAL

### 3.1 Design eval cases

Create eval cases targeting:

1. **Each new/changed behavior** — one case per fix
2. **Regression controls** — unchanged behaviors that must still work
3. **Edge cases** — non-English input, code snippet input, ambiguous intent
4. **Subagent routing** — if skill is used by subagents

Each case has:

```
Eval-N: "<user prompt>"
Expected: <tool sequence>. NOT <wrong tools>.
Failure mode: <what we're testing against>
```

**Minimum 8 cases.** Balance: ~50% new behaviors, ~30% controls, ~20% edges.

### 3.2 Run with-rule eval

Spawn ONE subagent with the **full skill text injected** into its prompt.
Present ALL eval cases in a single prompt. Agent describes tool selection plan
for each — does NOT execute tools.

Grade each case: PASS / FAIL against expected behavior.

### 3.3 Run without-rule baseline

Spawn ONE subagent with NO skill text — only the list of available MCP tools.
Same eval cases. Agent describes its natural tool selection.

This establishes the **delta** — how much the skill improves behavior.

### 3.4 Grade

```
With-rule:    N/M PASS (X%)
Without-rule: N/M PASS (Y%)
Delta:        +Zpp
```

**Target: 100% with-rule pass rate.** If not met → iterate (Phase 4).

## Phase 4: ITERATE (if needed)

For each FAIL:

1. Identify **why** the agent chose wrong — ambiguous instruction? missing rule?
   conflicting guidance?
2. Fix the specific instruction
3. Re-run ONLY failed cases + 2 random controls (not full suite)
4. Repeat until 100%

**Max 3 iterations.** If still failing after 3 — the skill design needs
rethinking, not tweaking. Report to user.

## Phase 5: PERSIST

Save results to `.claude-plugin/benchmarks/<skill-name>/`:

```
benchmarks/<skill-name>/
├── benchmark.md        — committed. Permanent optimization record.
└── workspace/          — gitignored. Recreatable by this skill.
    ├── evals.json      — eval cases + assertions
    ├── skill-snapshot/  — frozen copy of skill before/after optimization
    └── iteration-N/    — subagent outputs per iteration
```

1. **Create workspace/** dir (gitignored —
   `.claude-plugin/benchmarks/**/workspace/`)
2. **Save evals.json** to `workspace/`
3. **Copy SKILL.md** before and after to `workspace/skill-snapshot/`
4. **Write benchmark.md** (committed) with: summary, iterations table, delta,
   eval results detail, bugs found, changes made, key design decisions
5. **Update README.md** in `benchmarks/` with new skill row

Present final state to user:

```
Skill: [name]
Lines: [before] → [after] ([delta]%)
Eval cases: [N] (with-rule [X]%, baseline [Y]%, delta +[Z]pp)
Iterations: [count]
Benchmark: .claude-plugin/benchmarks/[name]/benchmark.md
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

## Phase 6: DESCRIPTION OPTIMIZATION (optional)

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

## Phase 7: FULL INTEGRATION EVAL (optional)

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

Key difference from Phase 3: integration eval tests **end-to-end behavior**
(tool calls, outputs, quality). Phase 3 tests **instruction clarity** (does the
agent know which tool to pick). Use Phase 3 first — it's faster. Escalate to
Phase 7 only when tool selection is correct but output quality is uncertain.

## Anti-patterns

- **Running real MCP calls in Phase 3 eval** — unnecessary, tests tool not skill
- **One subagent per eval case** — wasteful, use one subagent for all cases
- **Skipping baseline** — can't measure delta without it
- **Fixing skill without re-eval** — any fix can break other cases
- **Inflating eval count** — 20+ cases with no new failure modes is waste
- **Skipping Phase 3, jumping to Phase 7** — Phase 7 is 10x slower. Always start
  with lightweight tool-selection eval
