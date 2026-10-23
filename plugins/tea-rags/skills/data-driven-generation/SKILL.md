---
name: data-driven-generation
description:
  Decide HOW to write or change code by inspecting git signals on neighbors —
  classifies task mode (CREATE / EXTEND / MODIFY), pulls strategy and templates
  from proven low-churn implementations, reuses existing shared helpers instead
  of reinventing what the project already solved. Triggers on "implement
  function X", "add method to class Y", "write a helper for Z", "modify function
  X", "change behavior of Y", "напиши функцию", "добавь метод", "поправь метод",
  "измени поведение". NOT for discovery or exploration — use tea-rags:explore
  for that. NOT for pure refactor (rename, move, extract) — tests green before
  AND after it. Activates ONCE the agent is about to write or change code.
---

# Data-Driven Generation

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
risk-assessment scan needed. Missing → STOP, say "area context missing", invoke
`/tea-rags:explore` for target area FIRST (it runs PRE-GEN, returns context),
then resume here — never your own `semantic_search` in its place. Explore output
already in this conversation → use it.

**Session-context reuse:** outlines, symbol bodies and search hits already
fetched in this conversation are the source of truth for their file until that
file is edited. Before any search or `find_symbol`, check the conversation for
the file; reuse what is there. Re-fetch ONLY a file edited after it was fetched
(by you or a tool). State both halves: "re-fetch <edited symbol>; reuse
in-context <other files>". Re-searching an unedited file spends tokens and adds
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
(ReadMcpResourceTool).

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
  and the blame part of STYLE — say so in one line. REUSE still applies to
  introduced logic; the lexicon still runs when the fix introduces a name
  (MODIFY row: `types` = symbol signature + local types, `anchors` = the symbol,
  `names` = only the new names, no `concept`). VERIFY runs in full. Location +
  fix named ("line 88 nil — reload X before send") = this skill, no clarifying
  question; bug-hunt only when the cause is still unknown.
- **Bug fix** = MODIFY; cause unknown → `bug-hunt` locates it first, the fix
  still runs 6a in order: baseline GREEN → reproduction test (asserts the
  correct output, e.g. `formatDuration(0) === "0s"`) run RED on that assertion →
  only then patch.
- **Pure refactor / move** (no behaviour change) — outside this skill's scope
  (no Steps 1–5), but this rule still binds: 6a baseline (`tests-at-risk` pins +
  target's own tests) run GREEN BEFORE the first move, no new test; move (file
  moves → pre-write simulation, Step 6); same tests re-run green, none edited;
  Step 7 gate.
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

**Load strategy (MANDATORY, name the file):** project skill `strategy-<mode>` in
`.claude/skills/` → use it; else READ `strategies/<mode>.md` (DEFENSIVE →
`strategies/defensive.md`) before Step 2. Strategy named, file not loaded = Step
1 not done.

**Custom strategy discovery:** Scan `.claude/skills/` for `strategy-*` skills.
Read `## When` section. Custom conditions evaluated before hard rules.

### Step 2: TEMPLATE — CREATE / EXTEND

Session-context reuse (Prerequisites): a candidate chunk, outline or body
already in the conversation feeds `positiveIds` / `positiveCode` as is — no
re-search of an unedited file.

Delegate to `tea-rags:extract-project-patterns` with:

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
same as implementation. New code (new file, new import, new edge) → Step 7 gate
judges placement; no pre-write simulation. Task MOVES / merges / splits existing
files → pre-write simulation BEFORE touching them (Step 6 reference): moving
first and fixing after the gate = every importer re-touched twice.

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

Every name you are about to write is a draft and goes into that call — user's
drafts included (`row = find_vendor_envelope(id)` → `row` as `local`,
`find_vendor_envelope` as `return`), the value types they hold into `types[]`.
New class / module / interface →
`{ name, kind: "type", path: <new file>, symbolKind, extends: <planned ancestor> }`
— never name a type from neighbours without the call. `MISFIT` → take
`suggestion`, type MISFIT included (missing `role` suffix →
`RubyConstReceiverPass` → `RubyConstReceiverStrategy`); keep the draft only when
`role.evidence: "directory"` and the type is outside `role.examples`' family.
Codegraph off (no `get_naming_lexicon`) → concept-only `semantic_search` per
`references/step-5-style.md`; split the holders' symbolIds and paths into words,
the recurring word = the project term; values named as the template's code names
the same types.

Step 5 output = the CONCRETE final names, one line per draft:
`<draft> → <name> (<shape>, <kind>)`, built from the dominant row of
`byType[].kinds.<kind>` (highest `n`), in the casing those rows show:
`row → tax_automation_document (EXACT, local)`,
`find_vendor_envelope → find_tax_automation_document! (VERB_TYPE, return)`,
`graph_db_client → client (TAIL, param — client n=40 beats graphDb n=12)`.
"Project vocabulary" / "a name that describes the lookup" without the name =
Step 5 not done.

### Step 6: GENERATE — RED → GREEN → REFACTOR

**Read [references/step-6-generate.md](./references/step-6-generate.md) before
Step 6.** 6a RED = invoke `tea-rags:test-first` — DDG owns RED and GREEN; never
`dinopowers:test-driven-development` / superpowers TDD as a separate phase. **No
production edit without a recorded RED block** (or its one-line named
exception). MODIFY / bug fix / refactor-move: `tests-at-risk` pins + target's
own tests run GREEN BEFORE the first edit or move — then bug fix: reproduction
red; behaviour change an existing pin asserts (old default) → that pin, updated
to the spec value, IS the red: `PIN-UPDATED <test> — <spec line>`, other pins
untouched, run red, then edit; refactor: no new test, same tests green after.
Moving first and testing after = baseline skipped. 6b GREEN — minimal
implementation; call reuse-manifest helpers, NEVER reimplement. 6c REFACTOR
under green only. Move / merge / split of existing files → ONE
`get_architecture_report` `restructure` hypothesis first
(`move{files, toComponent}` + `addEdge`/`removeEdge` per retargeted import);
`introduced` → other placement per that family's `repair/<family>.md`
`## Ops recipe`, re-simulate, then move.

### Step 7: VERIFY

**Read [references/step-7-verify.md](./references/step-7-verify.md) before Step
7 — never skipped, also on "tests green, finalize".** In order:

1. Symbol risks — `find_symbol(symbol, rerank: "criticalPath", metaOnly: true)`
   on called / changed symbols, ≤ 5, most central first; read
   `rankingOverlay.chunk.<field>.label`. Callee `bugFixRate` critical → call it
   defensively + name the test pinning the relied-on scenario (else report
   unpinned). Not `get_callers`, not an existence sweep, not `dangerous`.
   Changed symbol `pageRank` critical / `fanIn` central → Step 8 `get_callers`
   trigger.
2. N-th-way `find_similar` (`positiveCode` = generated code).
3. MODIFY (signature change included): `tests-at-risk`
   (`tea-rags:tests-as-context`, `affectedFiles` = changed file) scenarios + 6a
   pins re-run green. No 6a baseline recorded (edit made outside this flow) →
   run `tests-at-risk` now.
4. **GATE `review_changes` before EVERY commit** + fix-at-write loop. ONE call,
   ALL five sections
   `["naming","incompleteChange","cohesion","architecture","norms"]` — a wrapper
   prescribing fewer never narrows it. Base: `changes: {}` (uncommitted) or
   `git merge-base HEAD main` — never sibling / integration branch; stack-below
   findings = owner's, cite the commit, no triage. Each family with a finding →
   load its `repair/<family>.md` (cohesion → `splitCandidates.md`) only.
   - **Confirm first:** the finding's edge / symbol exists in the diff AND is
     the edge in its evidence → REAL (type-only import = edge). Looks-wrong ≠
     false positive.
   - Triage: no `preExisting` → repair (`remedy` present → apply verbatim);
     `preExisting` + `remedy` → apply the remedy; `preExisting`, no `remedy` /
     pre-existing cohesion cluster → one report line + bead suggestion, never
     refactored here, commit allowed; own new cohesion cluster → move it now.
     Flap (≤ 0.02 over tolerance) = ordinary introduced: fix if cheap, else
     report metric before/after, threshold, moving diff edge — user decides.
     Co-change partner: inspect each — depends on the changed contract → edit in
     this diff; else known-noise class shown to hold (version manifest per
     `silentCoupling.md`) or checkable `not touched because` line.
   - **After every repair: re-run the SAME `review_changes` + targeted tests,
     state "target gone, no new finding".** ANY new finding or red test → round
     regressed → revert the WHOLE round (even if target gone), different repair
     next round; never fix the new finding on top. Round ≤ 2; must-fix left →
     AskUserQuestion (finding, each round tried, why reverted; options fix this
     way / accept with reason / bead), no commit until answered.
   - `truncated` / `built: false` / skipped files = PARTIAL ≠ pass, even at zero
     findings → re-run with `files: [...]` batches until every changed file is
     judged; `partial=true` until then.
   - Accepted false positive = counter-evidence + FILED detector issue +
     `FALSE-POSITIVE … — issue <id>` line; no issue → not accepted.

Gate fails → no commit, no "done". Report quotes gate line verbatim:
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
