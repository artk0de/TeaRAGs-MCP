# Wave 2 — Body Restructuring (8 long skills + 10 dinopowers wrappers)

## Summary

Restructure the BODY of 8 long SKILL.md files for better Opus 4.7
instruction-following. Critical prescriptive content was buried mid- or
bottom-file where 4.7 routinely skips it. Hoisted to within the first ~50 lines,
marked with explicit MUST/STOP/⚠️ markers.

Also extracted the 25-line "Chaining rule" boilerplate that was duplicated
across all 10 dinopowers wrappers into a single shared `CHAINING.md`.

## Context

Wave 1 fixed description triggering (skill fires correctly). Wave 2 fixes
instruction-following (skill, once triggered, executes the right steps in the
right order).

Opus 4.7 instruction-following failure modes:

- Skim drop-off: rules below line ~150 are easily dropped
- Soft markers ignored: "should" treated as optional, only MUST/STOP honored
- Buried steps in long procedures: agent jumps straight to chain step, skipping
  intermediate
- Identical boilerplate at top dilutes unique workflow steps below

## Methodology

No formal eval was run for Wave 2 (would require per-skill following eval = 8+
subagent runs minimum). The triage findings from Phase 1 are the hypothesis
driving each restructure. The mechanical nature of changes (hoist content, add
MUST markers, extract to references) keeps regression risk low.

Future work: per-skill following eval as Phase 8 (full integration eval) for the
most-used skills.

## Restructures Applied

### dinopowers wrappers

| File                           | Before   | After    | Change                                                             |
| ------------------------------ | -------- | -------- | ------------------------------------------------------------------ |
| executing-plans                | 277      | 258      | Hoisted "Mandatory Step Order" checklist with MUST on Step 5       |
| verification-before-completion | 197      | 176      | Hoisted Verdict Ladder to line 35 with 🛑 STOP marker              |
| writing-plans                  | 210      | 191      | Replaced soft prose with MUST-tagged blame*/recent* decision table |
| brainstorming                  | 187      | 159      | Chaining-rule extracted to CHAINING.md                             |
| finishing-a-development-branch | 187      | 160      | Chaining-rule extracted                                            |
| receiving-code-review          | 184      | 158      | Chaining-rule extracted                                            |
| requesting-code-review         | 201      | 173      | Chaining-rule extracted                                            |
| systematic-debugging           | 174      | 147      | Chaining-rule extracted                                            |
| test-driven-development        | 190      | 163      | Chaining-rule extracted                                            |
| writing-skills                 | 151      | 126      | Chaining-rule extracted                                            |
| **TOTAL dinopowers**           | **1958** | **1711** | **-247 lines**                                                     |
| New: dinopowers/CHAINING.md    | —        | 30       | Single source of truth for chain redirection rule                  |

### tea-rags long skills

| File                                                                | Before | After     | Change                                                                                          |
| ------------------------------------------------------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------- |
| risk-assessment                                                     | 355    | 329       | Phase Order checklist at line 13; classification-tiers + anti-patterns extracted to references/ |
| explore                                                             | 249    | 136       | Intent Classification table at line 17; 4 sub-pattern files extracted to references/            |
| New: risk-assessment/references/classification-tiers.md             | —      | (content) | Hoisted full 13-tier classification                                                             |
| New: risk-assessment/references/anti-patterns.md                    | —      | (content) | Full anti-pattern set                                                                           |
| New: explore/references/{explain,trace,pre-gen,exemplar}-pattern.md | —      | (content) | 4 strategy reference files                                                                      |

### project long skills

| File             | Before | After     | Change                                                                                                       |
| ---------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------ |
| optimize-skill   | 282    | 299 (+17) | Non-Negotiables block + Top-3 Anti-Patterns hoisted to top                                                   |
| add-migration    | 286    | 312 (+26) | Pick Template First decision table + Store Interface First gate hoisted                                      |
| add-mcp-endpoint | 264    | 280 (+16) | Implementation Checklist hoisted to line 13 with 🛑 gate marker; section 1.3 prose → MUST/MUST NEVER bullets |

Net +59 lines for project skills — intentional, since hoisted content is
duplicated near the top while leaving original sections intact (with one-line
pointers from old position to new). This optimizes for 4.7's "reads top
reliably" behavior.

## Cross-cutting fix: Chaining-rule extraction

The 25-30 line block describing how dinopowers wrappers redirect superpowers:\*
skills was identical (modulo one cross-plugin addendum in `executing-plans`)
across all 10 wrappers. Now lives in `dinopowers/CHAINING.md`; each wrapper has
a one-line pointer:

```
**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X redirects superpowers:X. NEVER bypass the wrapper.
```

Net effect: each wrapper's unique workflow steps now appear ~25 lines higher in
the file, well within 4.7's reliable read window.

## Caveats

- No formal regression eval run for Wave 2. Hypothesis-driven changes only.
- `risk-assessment` did not hit the 180-200 line target (landed at 329) — agent
  prioritized PRESERVE-ALL constraint over line target. Acceptable: phase bodies
  are core procedural rules, not reference material.
- Pre-existing dangling references to `signal-interpretation.md` and
  `pagination.md` (in risk-assessment, explore) preserved as-is — were broken
  before this restructure, not in scope.
- `optimize-skill` net grew because hoisted Non-Negotiables and Top
  Anti-Patterns are intentionally duplicated near the top. Original
  anti-patterns section at bottom kept with a "Top 3 are duplicated near the top
  — read both" pointer.

## Plugin Version Bumps

- `dinopowers`: 0.14.2 → **0.15.0** (new file CHAINING.md + body restructures
  across 10 wrappers)
- `tea-rags`: 0.18.0 → **0.19.0** (6 new reference files + body restructures in
  risk-assessment, explore)
- project skills (no plugin) — bumps not applicable

## Future Work (deferred)

- Per-skill following eval (Phase 8 integration) for risk-assessment,
  executing-plans, optimize-skill — the 3 most consequential
- Real-world observation period: track skill-fire rates on next 10 sessions and
  compare to prior baseline
- Sync dinopowers/tea-rags marketplace copies
  (`~/.claude/plugins/marketplaces/`) so runtime sees the new descriptions
