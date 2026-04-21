---
name: systematic-debugging
description:
  Use when debugging a concrete bug symptom (error message, stack trace,
  reproducible misbehavior, test failure). Triggers on phrases like "debug X",
  "find why Y fails", "error message Z", "падает с <stack trace>", "почему не
  работает X". Runs tea-rags:bug-hunt on the symptom FIRST to produce a ranked
  suspect list (bug-prone zones by bugFixRate + churn), then feeds it to
  superpowers:systematic-debugging as prioritized hypothesis space. NOT for
  reviewing code or exploratory investigation (use dinopowers:brainstorming).
---

# dinopowers: systematic-debugging

Wrapper over `superpowers:systematic-debugging`. Ensures the debug loop starts
from real bug-proneness data — historically buggy code ranked by `bugFixRate` +
churn — not from flat search over the whole codebase.

## Iron Rule

**`Skill(tea-rags:bug-hunt)` MUST run BEFORE
`Skill(superpowers:systematic-debugging)`** — whenever the bug has a concrete
symptom (error text, stack trace, reproducible behavior).

Correct delegation (`tea-rags:bug-hunt` skill, not ad-hoc `semantic_search`) +
correct symptom framing + correct ordering + honest handling of empty suspects
is the core value.

If the "bug" is purely speculative ("maybe there's a race condition somewhere")
with no symptom: skip the wrapper, invoke `superpowers:systematic-debugging`
directly. Do not fabricate a symptom to justify `bug-hunt`.

## Chaining rule (MANDATORY)

When the wrapped `superpowers:` skill runs its cycle it may instruct you to
invoke another `superpowers:Y` skill next (TDD after planning, verification
after editing, review after completion, etc.). **Redirect every such onward
`Skill(superpowers:Y)` call to `Skill(dinopowers:Y)` whenever a `dinopowers:Y`
wrapper exists.**

Wrapped skills — use the `dinopowers:` form, NOT `superpowers:`:

- `dinopowers:brainstorming`
- `dinopowers:executing-plans`
- `dinopowers:finishing-a-development-branch`
- `dinopowers:receiving-code-review`
- `dinopowers:requesting-code-review`
- `dinopowers:systematic-debugging`
- `dinopowers:test-driven-development`
- `dinopowers:verification-before-completion`
- `dinopowers:writing-plans`
- `dinopowers:writing-skills`

Why: each `dinopowers:Y` wrapper injects tea-rags signals (ownership, churn,
imports, bugFixRate, risk tiers) BEFORE the inner skill runs. A direct
`superpowers:Y` call skips that enrichment — exactly what this wrapper layer
prevents.

Only invoke `superpowers:Y` directly when Y is NOT in the list above (e.g.
`superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`).

## Step 1 — Frame the symptom

From the user report, extract:

| Element                      | Example                                                   |
| ---------------------------- | --------------------------------------------------------- |
| **Symptom text**             | error message, stack trace, reproduction sentence         |
| **Affected path (optional)** | `src/core/domains/ingest/**` if user mentions a subsystem |
| **Expected vs actual**       | "expected X, got Y" if stated                             |

Compose:

- `symptom`: concise sentence (goes into `tea-rags:bug-hunt` as query)
- `pathHint`: optional pathPattern if scope is known

If no symptom text at all (only vague "something's off"): skip to Step 4 with no
suspect block and state "symptom not framed — bug-hunt skipped".

## Step 2 — Invoke tea-rags:bug-hunt

Invoke the `Skill` tool with `tea-rags:bug-hunt`. Pass the `symptom` (and
`pathHint` if present) as the input. The skill internally runs `semantic_search`
with `rerank="bugHunt"` preset and applies its own triage:

- `bugFixRate "critical"` → prime suspect
- `bugFixRate "concerning"` + high churn → secondary suspect
- `bugFixRate "healthy"` → SKIP

Wait for its `PRESENT` output — a ranked suspect list with `file:line` + signal
labels + one-sentence observation per suspect.

Do NOT substitute:

| Wrong approach                                                  | Why wrong                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Direct `mcp__tea-rags__semantic_search` with `rerank="bugHunt"` | Bypasses the `tea-rags:bug-hunt` triage (healthy → SKIP, concerning+churn rule) and the PRESENT format |
| Named preset `"hotspots"` / `"techDebt"`                        | `bugHunt` is calibrated for symptom→suspect matching; these are broader risk lenses                    |
| `mcp__tea-rags__hybrid_search` on the error string              | BM25 on error text returns wherever that string is logged, not where the bug originates                |
| Custom rerank weights                                           | `bug-hunt` skill owns the weighting logic — don't duplicate it in the wrapper                          |
| Built-in Grep / Read on stack trace files                       | Loses bugFixRate signal; you'll read code that's actually healthy                                      |
| `git log --grep` / `git blame` for bug history                  | `bug-hunt` reads git signals via overlay; manual git commands are slower and noisier                   |

## Step 3 — Convert suspects to hypothesis block

Take the `bug-hunt` PRESENT output and reshape as a hypothesis block:

```
### Bug-hunt priors for: "<symptom>"

**Prime suspects (bugFixRate critical):**
- <file>:<startLine>-<endLine> — <observation>
  signals: bugFixRate <X%>, commitCount <N>, ageDays <N>

**Secondary suspects (concerning + churn):**
- <file>:<startLine>-<endLine> — <observation>
  signals: bugFixRate <X%>, relativeChurn <Y>

**Skipped (healthy):** <N> files with bugFixRate=healthy — likely not the root cause.
```

If `bug-hunt` returned 0 suspects (all healthy): state "no bug-prone zones for
this symptom — root cause likely in recently-added untracked code or external
dependency".

## Step 4 — Invoke superpowers:systematic-debugging

Invoke the `Skill` tool with `superpowers:systematic-debugging`. Prepend the
hypothesis block as context. Phrase the handoff as:

> "Before forming hypotheses, note these bug-hunt priors: …<block>… Start
> hypothesis space with prime suspects; escalate to secondary only if primes
> rule out.
>
> Chaining rule reminder: when you (the inner skill) would next invoke
> `superpowers:test-driven-development` or
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:systematic-debugging` run its standard hypothesis-form /
experiment / rule-out cycle. The wrapper does not replace it — it seeds the
hypothesis space.

## Red Flags — STOP and restart from Step 2

- "I already know where the bug is" → run Step 2 anyway; your mental model may
  be stale
- "bug-hunt is slow, let me grep the error string" → grep finds log callsites,
  not bug origins. Run Step 2.
- Substituted direct `semantic_search` with `rerank="bugHunt"` → missed the
  triage. Invoke the skill.
- Started forming hypotheses before bug-hunt output → revert, wait for suspect
  list
- Passed raw bug-hunt JSON to `superpowers:systematic-debugging` → extract the
  hypothesis block first
- Fabricated a `symptom` when user only said "it feels off" → skip Step 2, state
  it
- Let `superpowers:systematic-debugging` chain into a raw
  `superpowers:test-driven-development` /
  `superpowers:verification-before-completion` without redirecting to the
  `dinopowers:Y` wrapper → intercept and invoke the wrapper instead (see
  Chaining rule)

## Common Mistakes

| Mistake                                                                       | Reality                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Start `superpowers:systematic-debugging` with the error message as hypothesis | Flat search. Bug-hunt narrows to bug-prone zones first.                                                           |
| Use `tea-rags:bug-hunt` AFTER hypotheses formed ("to validate")               | Wrong order. Bug-hunt seeds the hypothesis space, not validates it post-hoc.                                      |
| Ignore the "healthy" skip signal                                              | Healthy zones are calibrated-out by bug-hunt. If you still want to look there, you're overriding a trusted prior. |
| Re-run bug-hunt on each new hypothesis                                        | One bug-hunt call per symptom. Hypothesis iteration is `superpowers:systematic-debugging`'s job.                  |
| Invoke on speculative "maybe there's a race" questions                        | That's brainstorming (use `dinopowers:brainstorming`), not debugging a symptom.                                   |
| Pass the full stack trace as `symptom`                                        | Stack traces contain noise (framework frames). Extract the user-code frame or error message only.                 |
