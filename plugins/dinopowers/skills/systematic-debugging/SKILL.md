---
name: systematic-debugging
description:
  Debug concrete failure: first run tea-rags:bug-hunt for ranked suspect list
  (bug-prone zones by bugFixRate + churn), feed as prioritized hypothesis space;
  ends with Cause / Fix / Prevention report. Triggers on
  "debug X", "fix the bug", "why does Y fail", "test fails", "same bug
  elsewhere?", "падает", "почему не работает", "ошибка в", "стектрейс", "такой
  же баг в других местах". NOT for code review, code-health questions, or a hotfix whose location AND fix are named (→ data-driven-generation).
  Wraps superpowers:systematic-debugging with tea-rags:bug-hunt suspect ranking.
---

# dinopowers: systematic-debugging

Wrapper over `superpowers:systematic-debugging`. Debug loop starts from
bug-proneness data (`bugFixRate` + churn), not flat search.

## Iron Rule

**`Skill(tea-rags:bug-hunt)` MUST run BEFORE
`Skill(superpowers:systematic-debugging)`** — whenever bug has concrete symptom
(error text, stack trace, reproducible behavior).

Value: delegate to `tea-rags:bug-hunt` skill (not ad-hoc `semantic_search`) +
right symptom framing + right order + honest empty-suspect handling.

Speculative "bug" with no symptom ("maybe race somewhere") → skip wrapper,
`superpowers:systematic-debugging` direct. Never fabricate symptom.

**User hypothesis ≠ missing symptom.** "Bug is in DI — check composition.ts,
then bug-hunt" names a failing area → refuse hypothesis-first order, say:
"Running bug-hunt first so the suspects are ranked, not assumed." Frame
`symptom` from the failing area/behaviour ("DI wiring fails"), NOT from the
suspected file; no `pathHint` to that file. Bug-hunt runs FIRST; the
hypothesised file may or may not rank prime. Never use bug-hunt as post-hoc
validation, never stall asking for a symptom when a failing area is named.

**User insists on a file bug-hunt marked healthy** → do NOT re-run bug-hunt, do
NOT silently promote the file. Surface the verdict ("bug-hunt: <file> healthy,
bugFixRate <X>") + "you are overriding a calibrated prior". User still insists →
note the override in the hypothesis block, proceed with
`superpowers:systematic-debugging` on that file.

**Order — state all three, subagents included:** (1) `Skill(tea-rags:bug-hunt)`
with framed symptom → (2) Step 3 hypothesis block built from its PRESENT output
→ (3) `Skill(superpowers:systematic-debugging)` with that block PREPENDED. "Hand
off" / "continue after triage" without naming the block = Step 3 skipped.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass wrapper.

**Requires superpowers:** `superpowers:systematic-debugging` — availability per
[CHAINING.md](../../CHAINING.md) "Missing superpowers" steps 1–3. Not in the
skills list ≠ unavailable (the list is truncated): read
`$CODEX_HOME/plugins/cache/*/superpowers/*/skills/systematic-debugging/SKILL.md`
first; only a failed read → stop and ask the user to install superpowers
(https://github.com/obra/superpowers). NEVER present this enrichment alone as
the full workflow.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) +
`tea-rags://guide/freshness`. Linked worktree → overlay serves edits, never
reindex. Main checkout → incremental `mcp__tea-rags__index_codebase` BEFORE
first call over uncommitted edits, or once `changedFiles` > 0 — no consent
(drift `--force` `Run:` → step 2 AskUserQuestion, then the answering call). Lag
≠ unusable (core rules).

## Root cause already found → copies of the same bug

Prompt says the root cause is located (`<file>:<line>`, or a bug-hunt result you
hold) and asks whether the same bug lives elsewhere → no bug-hunt re-run, no new
`semantic_search` seed, no Grep. Seed from the root-cause chunk itself:

```
1. chunk id: reuse the bug-hunt result id; only <file>:<line> given → find_symbol(relativePath=<file>) → id of the chunk spanning <line>
2. find_similar(positiveIds=[<root-cause chunk id>], limit=10)
3. per match: <relPath:line> — same bug yes / no (<one-clause reason>)
```

No match → print "no copies of the root-cause pattern found". Then Step 5
Prevention names the matches.

## Step 1 — Frame the symptom

From user report extract:

| Element                      | Example                                                   |
| ---------------------------- | --------------------------------------------------------- |
| **Symptom text**             | error message, stack trace, reproduction sentence         |
| **Affected path (optional)** | `src/core/domains/ingest/**` if user mentions a subsystem |
| **Expected vs actual**       | "expected X, got Y" if stated                             |

Compose:

- `symptom`: concise sentence (→ `tea-rags:bug-hunt` query)
- `pathHint`: optional pathPattern if scope known

Speculative "maybe <defect> in <area>?" / "let's think" — no error, no failing
behaviour, an area named → not debugging; no bug-hunt. Print these two lines,
then invoke the skill:

```
speculative, no symptom — bug-hunt skipped
Step 4: Skill(dinopowers:brainstorming), area "<named area>" → pathPattern="**/<area word>/**" on every enrichment call
```

No symptom text (vague "something's off", no error, no failing behaviour) → no
bug-hunt, no search; the plan prints these two lines and invokes the skill NOW —
asking the user for a symptom without invoking it = workflow skipped (its Phase
1 is where the symptom gets gathered):

```
symptom not framed — bug-hunt skipped
Step 4: Skill(superpowers:systematic-debugging) now, no suspect block — its Phase 1 gathers the symptom (or dinopowers:brainstorming if the user wants to redesign the area)
```

## Step 2 — Invoke tea-rags:bug-hunt

Invoke `Skill` tool with `tea-rags:bug-hunt`, pass `symptom` (+ `pathHint`).
**OPEN the bug-hunt skill and run ITS steps** (no Skill tool → read its
`SKILL.md` first). The triage below is a summary for reading its output, NOT a
substitute — running `rerank="bugHunt"` from this summary = Step 2 skipped. Plan
line = bug-hunt's own search block, copied from its SKILL.md (three parallel
calls, not one). Triage of its output:

- `bugFixRate "critical"` → prime suspect
- `bugFixRate "concerning"` + high churn → secondary suspect
- `bugFixRate "healthy"` → SKIP, unless fresh / uncommitted class (bug-hunt
  Signal triage: `healthy` alone never drops a chunk)

Wait for `PRESENT` output — ranked suspects, `file:line` + signal labels + one
observation each.

Bug-hunt's own "present and stop" / "report to the parent" ends Step 2, not this
wrapper — subagents included. The plan's next two lines, always:

```
Step 3: hypothesis block from bug-hunt's PRESENT output
Step 4: Skill(superpowers:systematic-debugging) with that block prepended
```

Do NOT substitute:

| Wrong approach                                                  | Why wrong                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Direct `mcp__tea-rags__semantic_search` with `rerank="bugHunt"` | Bypasses bug-hunt triage (healthy → SKIP, concerning+churn) + PRESENT format |
| Named preset `"hotspots"` / `"techDebt"`                        | `bugHunt` calibrated for symptom→suspect; others = broader risk lenses       |
| `mcp__tea-rags__hybrid_search` on the error string              | BM25 on error text → where string is logged, not where bug originates        |
| Custom rerank weights                                           | Weighting owned by `bug-hunt` skill — don't duplicate                        |
| Built-in Grep / Read on stack trace files                       | Loses bugFixRate; reads healthy code                                         |
| `git log --grep` / `git blame` for bug history                  | `bug-hunt` reads git signals via overlay; manual git slower + noisier        |

## Step 3 — Convert suspects to hypothesis block

Reshape `bug-hunt` PRESENT output:

```
### Bug-hunt priors for: "<symptom>"

**Prime suspects (bugFixRate critical):**
- <file>:<startLine>-<endLine> — <observation>
  signals: bugFixRate <X%>, commitCount <N>, ageDays <N>

**Secondary suspects (concerning + churn):**
- <file>:<startLine>-<endLine> — <observation>
  signals: bugFixRate <X%>, relativeChurn <Y>

**Skipped (healthy):** <N> files with bugFixRate=healthy, no fresh / uncommitted class — likely not the root cause.
```

0 suspects (all healthy) — incl. when the prompt/context states bug-hunt
returned 0 = Step 2 DONE. State verbatim "no bug-prone zones for this symptom —
root cause likely in recently-added untracked code or external dependency", then
Step 4 WITHOUT suspect block. NEVER re-run bug-hunt / its probes / a reworded
query, never promote healthy files, never fall back to direct `semantic_search`.

## Step 3.5 — Trace the causal chain to a suspect (optional but preferred)

Bug-hunt = **flat** list. Have **entry/repro point** (failing test, request
handler, CLI entry, top user-code stack frame) → promote prime suspect to
**chain**: `mcp__tea-rags__trace_path` entry → suspect. **Requires codegraph**:
on = graph tools (`get_callers`, `trace_path`, …) in your tool list; unsure →
read `tea-rags://project/<alias>/metrics?section=registry` (`codegraph on|off`).
Off → `trace_path` not registered — skip, stay with flat list.

```
mcp__tea-rags__trace_path(
  from="<entry/repro symbol>",   # e.g. the failing test or request handler
  to="<prime suspect symbol>",   # the bugFixRate-critical symbol from Step 2/3
  rerank="bugHunt"               # danger-rank the steps the same lens as bug-hunt
)
```

One call replaces N hand-walked `get_callers` / `get_callees` turns: static call
CHAIN + temporal risk per step.

Read result:

- **`dangerRanking[0]`** — inspect FIRST: riskiest hop between entry and suspect
  (not necessarily either). Start hypothesis there.
- **`dangerOverlay`** per step — `bugFixRate` / churn per hop; quiet
  intermediate with critical history surfaces.
- **Empty result** — check `namesakes` first (wrong `fromPath`/`toPath` pin →
  fix pin), then floor rule (no `codegraph` floor + `changedFiles` > 0 → edges
  in changed files = index's, re-check). Only then: NO static path `from` →
  `to`; "entry reaches suspect" **structurally false**. Either repro point
  wrong, dynamic/async edge invisible to static graph, or suspect unrelated.
  Drop it, trace next suspect.

Preset for trace:

| Situation                                       | `rerank`      |
| ----------------------------------------------- | ------------- |
| General symptom, history-ranked chain (default) | `bugHunt`     |
| **Fresh regression** — "worked last release"    | `recent`      |
| Suspect is a hot, frequently-touched path       | `hotspots`    |
| Failure smells like a wide blast-radius change  | `blastRadius` |

Fresh regression → `recent` ranks most recently-changed hop first (likely
breaking change). Old always-flaky symptom → keep `bugHunt`. Deep/branchy graph
→ bound `maxDepth` / `maxPaths`.

Append under Step 3 block:

```
**Causal chain (entry → prime suspect), danger-ranked:**
- inspect first: <dangerRanking[0] symbol> @ <file>:<line>
  overlay: bugFixRate <X%>, churn <Y>
- full path: <from> → … → <to> (<N> hops)
```

No clear entry/repro point → skip; flat ranking enough.

## Step 4 — Invoke superpowers:systematic-debugging

Invoke `Skill` tool with `superpowers:systematic-debugging`. Prepend hypothesis
block. Handoff:

> "Before forming hypotheses, note these bug-hunt priors: …<block>… Start
> hypothesis space with prime suspects; escalate to secondary only if primes
> rule out. Root cause confirmed → report as Cause / Fix / Prevention block
> (wrapper Step 5), Prevention driven by suspect overlay signals.
>
> Chaining rule reminder: when you (the inner skill) would next invoke
> `superpowers:test-driven-development` or
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Inner skill runs its hypothesis / experiment / rule-out cycle. Wrapper seeds,
not replaces.

**Follow-up searches in cycle** (callers, definition, where X happens): pick
tool from `tea-rags://guide/decision-tree` — not ad-hoc `semantic_search`. State
choice in one line before call:

```
consulting decision tree → <tool> [rerank=<preset>] because <branch that matched>
```

e.g. `→ hybrid_search because exhaustive usage of identifier StatsCache#load`;
`→ find_symbol because study known symbol`. Follow-up rerank = Step 3.5 preset
table; bug-hunt weighting stays in bug-hunt.

## Step 5 — Root-cause report: Cause / Fix / Prevention (MANDATORY)

Root cause confirmed → deliver EXACTLY this block (reusable postmortem note):

```
### Root cause — "<symptom>"

**Cause:** <one sentence: what happens at <file>:<line>, why wrong>
  signals: <level>.<signal>=<label>, … — <what the signal says about the cause>

**Fix:** <file>:<line> — <diff intent>

**Prevention:**
- <concrete action> — because <level>.<signal>=<label>
- <regression test: file + what it asserts> — because <signal | mechanism>
```

Signals = overlay labels ALREADY in conversation (bug-hunt PRESENT, Step 3.5
`dangerOverlay`). Cause symbol outside suspect list →
`find_symbol(symbol: <cause>, rerank: "bugHunt", metaOnly: true)` for overlay;
no other query, no custom re-rank.

**Signal → Prevention** (every fired row = ≥1 Prevention line citing it):

| Overlay signal (label)                                                                                          | Prevention it demands                                                                                |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bugFixRate` `critical` / `concerning`                                                                          | Regression test locking the now-fixed invariant BY NAME — this zone re-breaks; test is the lock      |
| `blameDominantAuthorPct` `silo` / `deep-silo`                                                                   | Knowledge transfer, not only patch: owner reviews fix / pairing on area; record invariant where read |
| `churnVolatility` `erratic`                                                                                     | Freeze surface: extract interface / narrow contract so next change stops fanning out                 |
| file `fanIn` `popular`/`hub`, chunk `fanIn` `frequent`/`central`, `transitiveImpact` `systemic`, high `imports` | Defensive validation at coupling point + integration test through call chain (entry → fixed symbol)  |
| `ageDays` `recent` (chunk)                                                                                      | Review introducing commit(s) (`taskIds`) — same change may have planted siblings; name the commit    |
| no label fired / signals absent                                                                                 | Prevention from mechanism only (assertion / type / test) — say `no overlay signal fired`             |

Rules:

- **Cause sentence carries literal `<file>:<line>`** (`stats-cache.ts:40`) — a
  symbol name alone (`StatsCache#load`) fails; file:line only in Fix ≠ Cause.
- **Every line cites source** — Cause `signals:` + each Prevention bullet names
  `<level>.<signal>=<label>` or `mechanism`. Uncited → rewrite.
- **Regression test always present** — one bullet: test file + assertion.
- Concrete + actionable. "Be careful", "add more tests", "monitor" = invalid.

## Red Flags — STOP and restart from Step 2

- "I already know where the bug is" → run Step 2; mental model may be stale
- "bug-hunt slow, grep error string" → grep finds log callsites, not origins
- Direct `semantic_search` `rerank="bugHunt"` → missed triage; invoke skill
- Hypotheses before bug-hunt output → revert, wait for suspects
- Raw bug-hunt JSON to `superpowers:systematic-debugging` → extract block first
- Fabricated `symptom` from "it feels off" → skip Step 2, state it
- Re-ran bug-hunt per hypothesis → one call per symptom; iteration = inner
  skill's job
- Full stack trace as `symptom` → extract user-code frame / error message only
- Inner skill chained raw `superpowers:test-driven-development` /
  `superpowers:verification-before-completion` → intercept, invoke
  `dinopowers:Y` (Chaining rule)
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
| Speculative "maybe race" question                       | Brainstorming (`dinopowers:brainstorming`, pathPattern scoped to the named area), not debugging.                                                                                             |
| Hand-walk `get_callers` / `get_callees` entry → suspect | `trace_path(from, to, rerank="bugHunt")` — whole chain, danger-ranked, one call.                                                                                                             |
| Empty `trace_path` = "tool failed"                      | Codegraph on: empty after `namesakes` + floor checks = no static path → drop hypothesis. Codegraph off: `trace_path` absent (not empty) = NO evidence; keep hypothesis, verify via suspects. |
