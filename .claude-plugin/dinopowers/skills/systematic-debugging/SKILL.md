---
name: systematic-debugging
description:
  Debug concrete failure: first run tea-rags:bug-hunt for ranked suspect list
  (bug-prone zones by bugFixRate + churn), feed as prioritized hypothesis space
  — investigation starts where code history says fragile. Triggers on "debug X",
  "fix the bug", "why does Y fail", "test fails", "падает", "почему не работает",
  "ошибка в", "стектрейс". NOT for code review or general code-health questions.
  Wraps superpowers:systematic-debugging with tea-rags:bug-hunt suspect ranking.
---

# dinopowers: systematic-debugging

Wrapper over `superpowers:systematic-debugging`. Debug loop starts from real
bug-proneness data — historically buggy code ranked by `bugFixRate` + churn —
not flat search over whole codebase.

## Iron Rule

**`Skill(tea-rags:bug-hunt)` MUST run BEFORE
`Skill(superpowers:systematic-debugging)`** — whenever bug has concrete symptom
(error text, stack trace, reproducible behavior).

Core value: correct delegation (`tea-rags:bug-hunt` skill, not ad-hoc
`semantic_search`) + correct symptom framing + correct ordering + honest
handling of empty suspects.

If "bug" purely speculative ("maybe there's a race condition somewhere") with no
symptom: skip wrapper, invoke `superpowers:systematic-debugging` directly. Do
not fabricate symptom to justify `bug-hunt`.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) and
`tea-rags/rules/index-freshness.md`. No background reindex hook — worktree-plan
freshness explicit (clone + per-task reindex in `dinopowers:executing-plans`);
run `mcp__tea-rags__index_codebase` manually to search code edited but not
committed, BEFORE first tea-rags call.

## Step 1 — Frame the symptom

From user report, extract:

| Element                      | Example                                                   |
| ---------------------------- | --------------------------------------------------------- |
| **Symptom text**             | error message, stack trace, reproduction sentence         |
| **Affected path (optional)** | `src/core/domains/ingest/**` if user mentions a subsystem |
| **Expected vs actual**       | "expected X, got Y" if stated                             |

Compose:

- `symptom`: concise sentence (goes into `tea-rags:bug-hunt` as query)
- `pathHint`: optional pathPattern if scope is known

If no symptom text (only vague "something's off"): skip to Step 4 with no
suspect block, state "symptom not framed — bug-hunt skipped".

## Step 2 — Invoke tea-rags:bug-hunt

Invoke `Skill` tool with `tea-rags:bug-hunt`. Pass `symptom` (and `pathHint` if
present) as input. Skill internally runs `semantic_search` with
`rerank="bugHunt"` preset, applies own triage:

- `bugFixRate "critical"` → prime suspect
- `bugFixRate "concerning"` + high churn → secondary suspect
- `bugFixRate "healthy"` → SKIP

Wait for its `PRESENT` output — ranked suspect list with `file:line` + signal
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

Take `bug-hunt` PRESENT output, reshape as hypothesis block:

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

## Step 3.5 — Trace the causal chain to a suspect (optional but preferred)

Bug-hunt gives **flat** suspect list. When you also have **entry/repro point** —
symbol where failing flow starts (test, request handler, CLI entry, symbol in
top user-code stack frame) — promote prime suspect from point to **chain**: call
`mcp__tea-rags__trace_path` from entry symbol to suspect symbol. **Requires
codegraph** (prime shows `codegraph.symbols`); when off `trace_path` not
registered — skip this step, stay with flat suspect list from Step 2/3.

```
mcp__tea-rags__trace_path(
  from="<entry/repro symbol>",   # e.g. the failing test or request handler
  to="<prime suspect symbol>",   # the bugFixRate-critical symbol from Step 2/3
  rerank="bugHunt"               # danger-rank the steps the same lens as bug-hunt
)
```

What this collapses: instead of N manual `get_callers` / `get_callees` turns to
hand-walk call graph from entry to fault, `trace_path` returns static call CHAIN
in one call AND attaches temporal risk to every step.

Read the result like this:

- **`dangerRanking[0]`** — step to inspect FIRST. Not entry, not suspect
  necessarily — riskiest hop on path between them. Start hypothesis there.
- **`dangerOverlay`** per step — carries `bugFixRate` / churn for that hop, so
  quiet-looking intermediate function with critical history surfaces instead of
  hiding between entry and suspect.
- **Empty result** — NO static call path from `from` to `to`. Hypothesis "the
  entry flow reaches this suspect" is **structurally false**. Useful negative
  signal: either repro point wrong, bug reached via dynamic/async edge static
  graph doesn't see, or suspect unrelated. Drop it, trace to next suspect.

Preset selection for trace:

| Situation                                       | `rerank`      |
| ----------------------------------------------- | ------------- |
| General symptom, history-ranked chain (default) | `bugHunt`     |
| **Fresh regression** — "worked last release"    | `recent`      |
| Suspect is a hot, frequently-touched path       | `hotspots`    |
| Failure smells like a wide blast-radius change  | `blastRadius` |

For fresh regression prefer `rerank="recent"`: ranks most **recently-changed**
step on path first — hop most likely introduced by change that broke things.
Bound search with `maxDepth` / `maxPaths` if graph deep or branchy.

Append traced chain under hypothesis block from Step 3:

```
**Causal chain (entry → prime suspect), danger-ranked:**
- inspect first: <dangerRanking[0] symbol> @ <file>:<line>
  overlay: bugFixRate <X%>, churn <Y>
- full path: <from> → … → <to> (<N> hops)
```

If no clear entry/repro point, skip this step — bug-hunt's flat ranking from
Step 3 enough to seed hypotheses.

## Step 4 — Invoke superpowers:systematic-debugging

Invoke `Skill` tool with `superpowers:systematic-debugging`. Prepend hypothesis
block as context. Phrase handoff as:

> "Before forming hypotheses, note these bug-hunt priors: …<block>… Start
> hypothesis space with prime suspects; escalate to secondary only if primes
> rule out.
>
> Chaining rule reminder: when you (the inner skill) would next invoke
> `superpowers:test-driven-development` or
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:systematic-debugging` run its standard hypothesis-form /
experiment / rule-out cycle. Wrapper does not replace it — it seeds hypothesis
space.

## Red Flags — STOP and restart from Step 2

- "I already know where the bug is" → run Step 2 anyway; your mental model may
  be stale
- "bug-hunt is slow, let me grep the error string" → grep finds log callsites,
  not bug origins. Run Step 2.
- Substituted direct `semantic_search` with `rerank="bugHunt"` → missed triage.
  Invoke the skill.
- Started forming hypotheses before bug-hunt output → revert, wait for suspect
  list
- Passed raw bug-hunt JSON to `superpowers:systematic-debugging` → extract
  hypothesis block first
- Fabricated `symptom` when user only said "it feels off" → skip Step 2, state
  it
- Let `superpowers:systematic-debugging` chain into raw
  `superpowers:test-driven-development` /
  `superpowers:verification-before-completion` without redirecting to
  `dinopowers:Y` wrapper → intercept, invoke wrapper instead (see Chaining rule)

## Common Mistakes

| Mistake                                                                       | Reality                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start `superpowers:systematic-debugging` with the error message as hypothesis | Flat search. Bug-hunt narrows to bug-prone zones first.                                                                                                                                                                                                                                                                                                          |
| Use `tea-rags:bug-hunt` AFTER hypotheses formed ("to validate")               | Wrong order. Bug-hunt seeds the hypothesis space, not validates it post-hoc.                                                                                                                                                                                                                                                                                     |
| Ignore the "healthy" skip signal                                              | Healthy zones are calibrated-out by bug-hunt. If you still want to look there, you're overriding a trusted prior.                                                                                                                                                                                                                                                |
| Re-run bug-hunt on each new hypothesis                                        | One bug-hunt call per symptom. Hypothesis iteration is `superpowers:systematic-debugging`'s job.                                                                                                                                                                                                                                                                 |
| Invoke on speculative "maybe there's a race" questions                        | That's brainstorming (use `dinopowers:brainstorming`), not debugging a symptom.                                                                                                                                                                                                                                                                                  |
| Pass the full stack trace as `symptom`                                        | Stack traces contain noise (framework frames). Extract the user-code frame or error message only.                                                                                                                                                                                                                                                                |
| Hand-walk `get_callers` / `get_callees` from entry to suspect                 | `trace_path(from, to, rerank="bugHunt")` returns the whole chain in one call and danger-ranks the hops.                                                                                                                                                                                                                                                          |
| Treat an empty `trace_path` result as "tool failed"                           | **When codegraph is on** (prime shows `codegraph.symbols`): empty = no static call path, so the hypothesis that the entry reaches that suspect is structurally false — drop it. **When codegraph is off** `trace_path` is not registered (absent, not empty) — that is NOT evidence; keep the hypothesis and verify via bug-hunt suspects / manual call reading. |
| Use `rerank="recent"` for an old, always-flaky symptom                        | `recent` ranks the newest-changed hop first — that's for fresh regressions. For long-standing bugs keep `bugHunt`.                                                                                                                                                                                                                                               |
