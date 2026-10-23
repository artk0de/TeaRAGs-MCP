---
name: data-driven-generation
description:
  'Decide HOW to write or change code by inspecting git signals on neighbors —
  classifies task mode (CREATE / EXTEND / MODIFY), pulls strategy and templates
  from proven low-churn implementations, reuses existing shared helpers instead
  of reinventing what the project already solved. Triggers on "implement
  function X", "add method to class Y", "write a helper for Z", "modify function
  X", "change behavior of Y", "напиши функцию", "добавь метод", "поправь метод",
  "измени поведение". NOT for discovery or exploration — use /explore for that.
  NOT for pure refactor (rename, move, extract) with no behavior change. This
  skill activates ONCE the agent is about to write or change code.'
---

# Data-Driven Generation

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Don't invent — find how it's solved HERE, repeat. Strategy from git signal
labels, helpers via reuse gate, style from live code. Overlay labels — not
hardcoded thresholds — strategies adapt per codebase.

## Prerequisites

**Addressing:** every tea-rags call passes `project=<alias>` +
`path=<your working directory>` — `tea-rags://guide/freshness` "Addressing the
Codebase".

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license `cat`
/ `grep` / `Read` over code — `tea-rags://guide/freshness`.

**Area context required:** files, pathPattern, per-symbol overlay labels must be
in conversation. Labels come from `find_symbol(rerank=<preset>, metaOnly=false)`
on target symbols — explore PRE-GEN step PG-2 (SIGNAL LOOKUP). No full
risk-assessment scan needed. If missing, invoke `/explore` for target area —
explore detects pre-generation intent, gathers context automatically. If explore
output already exists this conversation, use it.

**Session-context reuse:** outlines, symbol bodies and search hits already
fetched in this conversation are the source of truth for their file until that
file is edited. Before any search or `find_symbol`, check the conversation for
the file; reuse what is there. Re-fetch ONLY a file edited after it was fetched
(by you or a tool). Re-searching an unedited file spends tokens and adds
nothing.

## Reading Overlay Labels

Labels live in `rankingOverlay.file.<signal>` and
`rankingOverlay.chunk.<signal>`. Each labeled value:
`{ value: N, label: "high" }` — in a result table (2+ rows) the columns
`rankingOverlay.chunk.<signal>.value` / `.label`. Only fields in the preset's
`overlayMask` are labelled — choose the preset by the labels you need; raw
values under `payload.git.*` are never labelled.

Label meanings: `tea-rags://guide/signal-labels`. Bands (thresholds) when a raw
value needs a label → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap`
(FetchMcpResource).

---

## Step 0: MODE

Runs after Prerequisites (area context present).

`find_symbol(metaOnly=true)` on named target. Zero guessing:

| Probe result                                       | Mode   |
| -------------------------------------------------- | ------ |
| Target symbol exists (find_symbol reads your tree) | MODIFY |
| Container exists, symbol new ("add method to Y")   | EXTEND |
| Neither exists                                     | CREATE |

Probe ambiguous → ask user which mode. One question, genuine ambiguity only.

**Step matrix** — mode selects steps + signal sources:

| Step        | CREATE                         | EXTEND                         | MODIFY                                      |
| ----------- | ------------------------------ | ------------------------------ | ------------------------------------------- |
| 1 STRATEGY  | area labels                    | container labels               | symbol's own labels                         |
| 2 TEMPLATE  | run                            | run                            | skip                                        |
| 3 PLACEMENT | run                            | fixed = container; guard fires | skip                                        |
| 4 REUSE     | run                            | run                            | run — for introduced logic                  |
| 5 STYLE     | blame-owner + lexicon          | container file + lexicon       | symbol itself + lexicon                     |
| 6a RED      | test-first: new red tests      | same                           | tests-at-risk green baseline, then red      |
| 6b GREEN    | strategy + style + manifest    | same                           | find_co_changed + minimal diff per strategy |
| 6c REFACTOR | under green                    | same                           | same                                        |
| 7 VERIFY    | symbol risks + N-th-way + gate | same                           | + re-run 6a baseline pins                   |
| 8 IMPACT    | blastRadius of new code        | container fanIn                | `get_callers` — MANDATORY                   |

- **Hotfix** (user gives exact location) = MODIFY, additionally skip STRATEGY
  and the blame part of STYLE. REUSE still applies to introduced logic; the
  lexicon still runs when the fix introduces a name.
- **Greenfield** = CREATE over empty area — TEMPLATE/STYLE searches degrade to
  empty naturally, don't pre-skip.
- **REUSE never skipped in any mode** — shared infra exists even when feature is
  new.
- **RED never skipped** except a named `test-first` exception (no-tests language
  / config-docs only), stated in one line. Hotfix included.
- **VERIFY never skipped. Ever.**

## Workflow

### Step 1: STRATEGY SELECTION

Signal source per mode (matrix row 1: area / container / symbol's own labels).
Apply **hard rules** first:

| Condition                                                  | Strategy      |
| ---------------------------------------------------------- | ------------- |
| chunk.bugFixRate "critical" + file.ageDays "old"/"legacy"  | DEFENSIVE     |
| chunk.commitCount "high"+ + file.churnVolatility "erratic" | STABILIZATION |
| file.ageDays "legacy" + chunk.commitCount "low"            | CONSERVATIVE  |
| No match                                                   | STANDARD      |

**Autonomous Judgment Protocol** — when no hard rule matches:

1. **Decide** — choose closest strategy based on signal axes
2. **Justify** — show labels, axes, specific actions
3. **Ask if uncertain** — present dilemma with options

Signal axes:

- **Risk** grows: bugFixRate healthy→concerning→critical, churnVolatility
  stable→erratic
- **Stability** grows: ageDays recent→legacy
- **Confidence** falls: commitCount "low" = few data points

**Load strategy:** Check for project skill `strategy-<mode>` in
`.claude/skills/`. If found → use it. If not → read `strategies/<mode>.md`.

**Custom strategy discovery:** Scan `.claude/skills/` for `strategy-*` skills.
Read `## When` section. Custom conditions evaluated before hard rules.

### Step 2: TEMPLATE — CREATE / EXTEND

Session-context reuse (Prerequisites): a candidate chunk, outline or body
already in the conversation feeds `positiveIds` / `positiveCode` as is — no
re-search of an unedited file.

Delegate to `/extract-project-patterns` with:

<!-- extract-project-patterns applies filter:{presets:"battleTested"} internally;
     on empty it relaxes to {presets:"production"} and annotates diagnostics -->

- `positiveIds` | `positiveCode` = best verified chunk from explore PG-OUTPUT /
  Step 1 signals (or set `behaviorQuery` if no chunk/code available)
- `pathPatternL1` = pathPattern from explore PG-OUTPUT
- `limit` = 10

Read `templates[0]` as reference for Step 6 (GENERATE). Recipe owns the locality
cascade (L1 = subdomain, L2 = first semantic segment (infra prefixes kept in
glob, not counted), L3 = project) and the quality gate (commitCount
low/typical + ageDays old/legacy + bugFixRate healthy; lone ideal on hub file
also accepts; reject if bugFixRate critical or ageDays recent + commitCount
low).

Read `locality` to inform Step 5 (STYLE):

- `L1` → use template's `blameDominantAuthor` for style + review routing.
- `L2` → `blameDominantAuthor` reviews technique, not exact code.
- `L3` → `blameDominantAuthor` reviews technique only; verify architectural fit
  before adopting verbatim.
- `none` → no template; generate from scratch, surface to user so they
  scrutinize result.

**Template imports = pre-approved REUSE vocabulary.** What the template calls is
proven in context — Step 4 gate passes them automatically.

### Step 3: PLACEMENT — CREATE (EXTEND: fixed = container)

Home for new code, priority order:

1. Target file named by user.
2. Template's path as prior ("this kind of thing lives there").
3. `semantic_search` by responsibility inside L1 pathPattern.

**God-module guard:** candidate's `memberCount` / `moduleMethodCount` label =
god-module → do NOT grow it. Propose sibling module or extraction, surface
choice to user. EXTEND: guard fires on the container.

New file where a home module exists = structural N-th way. Placement converges
same as implementation. Step 7 gate judges chosen placement; no pre-write
simulation.

### Step 4: REUSE — all modes

1. Enumerate general-purpose blocks in about-to-write code: retry, validation,
   caching, parsing, error wrapping, logging, serialization… Cap ≤5 searches,
   `metaOnly: true`.
2. Per block: `hybrid_search` / `find_symbol` for existing helper.
3. **Gate — import helper IF** helper file in L1/L2 of target (locality per
   `extract-project-patterns`) **OR** helper file `fanIn` label `popular`/`hub`
   (project already imports it widely — reuse sanctioned by practice). **ELSE**
   follow its approach, do NOT import — no new cross-boundary coupling. Boundary
   = actual import graph, not theory.
   - Codegraph off (graph tools absent): gate on `imports` signal +
     locality-only (L1/L2 → reuse, L3 → copy approach); note gate ran on
     import-proxy.
4. Template's own imports pass gate automatically (Step 2).
5. **Almost-fits:** helper passes gate but lacks a parameter/branch → extend it
   minimal-diff, do NOT write a sibling. Extending `popular`/`hub` helper → user
   confirmation MANDATORY before edit. Blast radius → Step 8.

Output: **reuse manifest** (helpers to call) → Step 6.

### Step 5: STYLE

**Read [references/step-5-style.md](./references/step-5-style.md) before
Step 5.** Style source per mode: CREATE → blame-owner table, EXTEND → container
file, MODIFY → symbol itself. Session-context reuse — no re-fetch of unedited
files. Naming (codegraph on): ONE `get_naming_lexicon` call before GENERATE —
project's name for a value it already names; a holder that IS what you are about
to write → back to Step 4, never rename and write a sibling.

### Step 6: GENERATE — RED → GREEN → REFACTOR

**Read [references/step-6-generate.md](./references/step-6-generate.md) before
Step 6.** 6a RED via `/test-first` — **no production edit without a recorded RED
block** (or its one-line named exception). 6b GREEN — minimal implementation;
call reuse-manifest helpers, NEVER reimplement. 6c REFACTOR under green only.

### Step 7: VERIFY

**Read [references/step-7-verify.md](./references/step-7-verify.md) before Step
7 — never skipped.** Symbol risks (≤ 5, `criticalPath`), N-th-way
`find_similar`, MODIFY baseline pins re-run, then **GATE `review_changes` before
EVERY commit** + fix-at-write loop. Gate fails → no commit, no "done". Report
quotes gate line verbatim:
`GATE review_changes: introduced=<n>, partial=<true|false>` (codegraph off →
`architecture not judged`). **No gate line = task not done.**

### Step 8: IMPACT

Edges: no `codegraph` floor while `changedFiles` > 0 → edges touching changed
files are the index's (`tea-rags://guide/freshness` "Addressing the Codebase").

Assess blast radius of change you just generated.

- **Codegraph on** (graph tools registered): use the `blastRadius` preset
  (`rerank="blastRadius"`, metaOnly=true) — real `fanIn` + churn + bugFix,
  ranking reflects actual call/import edges, not raw-import proxy. Warn on
  high-`fanIn` / `isHub` dependents.
- **Codegraph off** (graph tools absent → `fanIn` signal absent): fall back to
  custom weights `{ imports: 0.5, churn: 0.3, ownership: 0.2 }`, metaOnly=true,
  note blast radius is approximate (import-proxy, not edge truth). See
  `tea-rags://guide/navigation` "Graph navigation".
- **MODIFY: `get_callers` on the modified symbol MANDATORY** — changed behavior
  propagates through real call edges; import proxy insufficient.

Warn on high-impact modules. Flag shared taskIds → coordinated change.
