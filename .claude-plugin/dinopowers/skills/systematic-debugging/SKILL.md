---
name: systematic-debugging
description:
  Debug a concrete failure by first running tea-rags:bug-hunt to produce a
  ranked suspect list (bug-prone zones by bugFixRate + churn) and feeding it as
  prioritized hypothesis space, so investigation starts with code history
  actually says is fragile. Triggers on "debug X", "fix the bug", "why does Y
  fail", "test fails", "падает", "почему не работает", "ошибка в", "стектрейс".
  NOT for code review or general code-health questions. Wraps
  superpowers:systematic-debugging with a tea-rags:bug-hunt suspect ranking.
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

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — MUST run
`mcp__tea-rags__reindex_changes` if any file was edited in this session, BEFORE
the first tea-rags call.

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

## Step 3.5 — Trace the causal chain to a suspect (optional but preferred)

Bug-hunt gives a **flat** suspect list. When you also have an **entry/repro
point** — the symbol where the failing flow starts (the test, the request
handler, the CLI entry, the symbol in the top user-code stack frame) — promote
the prime suspect from a point to a **chain**: call `mcp__tea-rags__trace_path`
from the entry symbol to the suspect symbol.

```
mcp__tea-rags__trace_path(
  from="<entry/repro symbol>",   # e.g. the failing test or request handler
  to="<prime suspect symbol>",   # the bugFixRate-critical symbol from Step 2/3
  rerank="bugHunt"               # danger-rank the steps the same lens as bug-hunt
)
```

What this collapses: instead of N manual `get_callers` / `get_callees` turns to
hand-walk the call graph from entry to fault, `trace_path` returns the static
call CHAIN in one call AND attaches temporal risk to every step.

Read the result like this:

- **`dangerRanking[0]`** — the step to inspect FIRST. Not the entry, not the
  suspect necessarily — the riskiest hop on the path between them. Start the
  hypothesis there.
- **`dangerOverlay`** per step — carries `bugFixRate` / churn for that hop, so a
  quiet-looking intermediate function with a critical history surfaces instead
  of hiding between entry and suspect.
- **Empty result** — there is NO static call path from `from` to `to`. The
  hypothesis "the entry flow reaches this suspect" is **structurally false**.
  That is a useful negative signal: either the repro point is wrong, the bug is
  reached via a dynamic/async edge the static graph doesn't see, or this suspect
  is unrelated. Drop it and trace to the next suspect.

Preset selection for the trace:

| Situation                                       | `rerank`      |
| ----------------------------------------------- | ------------- |
| General symptom, history-ranked chain (default) | `bugHunt`     |
| **Fresh regression** — "worked last release"    | `recent`      |
| Suspect is a hot, frequently-touched path       | `hotspots`    |
| Failure smells like a wide blast-radius change  | `blastRadius` |

For a fresh regression prefer `rerank="recent"`: it ranks the most
**recently-changed** step on the path first — the hop most likely introduced by
the change that broke things. Bound the search with `maxDepth` / `maxPaths` if
the graph is deep or branchy.

Append the traced chain under the hypothesis block from Step 3:

```
**Causal chain (entry → prime suspect), danger-ranked:**
- inspect first: <dangerRanking[0] symbol> @ <file>:<line>
  overlay: bugFixRate <X%>, churn <Y>
- full path: <from> → … → <to> (<N> hops)
```

If you have no clear entry/repro point, skip this step — bug-hunt's flat ranking
from Step 3 is enough to seed hypotheses.

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

| Mistake                                                                       | Reality                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Start `superpowers:systematic-debugging` with the error message as hypothesis | Flat search. Bug-hunt narrows to bug-prone zones first.                                                            |
| Use `tea-rags:bug-hunt` AFTER hypotheses formed ("to validate")               | Wrong order. Bug-hunt seeds the hypothesis space, not validates it post-hoc.                                       |
| Ignore the "healthy" skip signal                                              | Healthy zones are calibrated-out by bug-hunt. If you still want to look there, you're overriding a trusted prior.  |
| Re-run bug-hunt on each new hypothesis                                        | One bug-hunt call per symptom. Hypothesis iteration is `superpowers:systematic-debugging`'s job.                   |
| Invoke on speculative "maybe there's a race" questions                        | That's brainstorming (use `dinopowers:brainstorming`), not debugging a symptom.                                    |
| Pass the full stack trace as `symptom`                                        | Stack traces contain noise (framework frames). Extract the user-code frame or error message only.                  |
| Hand-walk `get_callers` / `get_callees` from entry to suspect                 | `trace_path(from, to, rerank="bugHunt")` returns the whole chain in one call and danger-ranks the hops.            |
| Treat an empty `trace_path` result as "tool failed"                           | Empty = no static call path. The hypothesis that the entry reaches that suspect is structurally false — drop it.   |
| Use `rerank="recent"` for an old, always-flaky symptom                        | `recent` ranks the newest-changed hop first — that's for fresh regressions. For long-standing bugs keep `bugHunt`. |
