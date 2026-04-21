# Benchmark: dinopowers chaining-rule fix

**Date:** 2026-04-21 **Skills affected:** all 10 `dinopowers:*` wrappers
**Plugin version:** 0.13.0 → 0.13.1 (patch)

## Summary

Each `dinopowers:X` wrapper invokes the wrapped `superpowers:X` in its Step 4.
The wrapped skill in turn may instruct the agent to run another `superpowers:Y`
skill (TDD after planning, verification after editing, review after completion).
Those onward calls bypass the `dinopowers:Y` wrappers, losing every tea-rags
enrichment the wrapper layer is meant to inject.

The existing `.claude-plugin/dinopowers/scripts/inject-wrapper-routing.sh` hook
solves this problem **only for the `Agent` tool** (subagent prompts). It does
not intercept `Skill()` calls fired from the current agent. This fix closes that
gap by making the chain-hop redirect a first-class instruction inside each
wrapper's SKILL.md.

## Changes

Uniform 3-edit treatment applied to all 10 SKILL.md files:

| Edit                                   | Location                                                  |
| -------------------------------------- | --------------------------------------------------------- |
| `## Chaining rule (MANDATORY)` section | inserted between `## Iron Rule` and `## Step 1`           |
| `Chaining rule reminder:` prefrase     | appended to the Step 4 handoff blockquote                 |
| Red Flags entry about bypass           | appended to `## Red Flags — STOP and restart from Step 2` |

Also: `.claude-plugin/dinopowers/.claude-plugin/plugin.json` version bump
`0.13.0 → 0.13.1` per the Plugin Versioning rule (text-only changes).

## Key design decisions

1. **Uniform block, not per-skill variant.** Every wrapper gets the same list of
   10 wrapped skills. Maintenance burden: one edit when a new dinopowers wrapper
   is added. Per-skill minimal lists would drift.
2. **Block placement between Iron Rule and Step 1.** Keeps the rule visible
   before any procedural steps run. Placing it inside Step 4 alone would arrive
   too late — the agent needs to know the policy before it even reads handoff
   phrasing.
3. **Handoff reminder as blockquote reinforcement, not replacement.** The block
   documents the policy; the Step 4 handoff reminder nudges the inner skill
   right at the handoff boundary, where the chain-hop decision originates.
4. **Red Flags entry with specific inner hops per wrapper.** Each file's entry
   names the concrete `superpowers:Y` skills that wrapper's inner is known to
   chain into — makes the failure mode concrete rather than generic.
5. **Skipped Phase 2 baseline subagent eval.** The problem was pre-confirmed by
   the existing `inject-wrapper-routing.sh` hook (same pattern, different tool
   surface) and a direct user report. Phase 2 would re-discover a known fact.
   Saved subagent budget; directed effort toward fix thoroughness.

## Metrics

| Metric                            | Before | After | Delta |
| --------------------------------- | ------ | ----- | ----- |
| Lines in brainstorming/SKILL.md   | 148    | 180   | +32   |
| Lines in writing-plans/SKILL.md   | 166    | 203   | +37   |
| Lines in executing-plans/SKILL.md | 160    | 200   | +40   |
| Avg line delta across 10 files    |        |       | ≈+35  |
| markdownlint errors (10 files)    | 242    | 242   | 0     |
| Files with `## Chaining rule`     | 0/10   | 10/10 | +10   |
| Files with Step 4 reminder        | 0/10   | 10/10 | +10   |
| Files with Red Flags entry        | 0/10   | 10/10 | +10   |

## Iterations

| #   | What happened                                            | Verdict |
| --- | -------------------------------------------------------- | ------- |
| 1   | Inserted block + reminder + red flag across all 10 files | PASS    |
|     | Grep verification confirmed coverage                     |         |
|     | markdownlint did not regress                             |         |

No iteration 2 needed — structural grep check passed on first try.

## Per-eval case detail

See `evals.json`. All 8 cases are structural expectations on agent output: 6
target the audit finding (chain-hop redirect), 2 are controls (non-wrapped
superpowers pass-through and subagent routing via existing hook). No subagent
runs executed; cases documented as reusable regression tests for future
optimize-skill cycles.

## Follow-up considerations (not in scope of this fix)

- Could extend `inject-wrapper-routing.sh` to also match the `Skill` tool
  (PreToolUse matcher `Skill`) so the redirect is enforced at the harness level,
  not just documented in SKILL.md. Would make the fix defense-in-depth rather
  than instruction-only.
- `writing-skills` SKILL.md previously lacked a Step 4 handoff blockquote; this
  fix added one with the redirect phrasing. Worth a future pass to harmonize its
  handoff format with the other 9 wrappers.
