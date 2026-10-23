---
name: data-driven-generation
description:
  'Decide HOW to write or change code by inspecting git signals on neighbors —
  classifies task mode (CREATE / EXTEND / MODIFY), pulls strategy and templates
  from proven low-churn implementations, reuses existing shared helpers instead
  of reinventing what the project already solved. Triggers on "implement
  function X", "add method to class Y", "write a helper for Z", "modify function
  X", "change behavior of Y", "напиши функцию", "добавь метод", "поправь метод",
  "измени поведение", "overlay labels → strategy?". NOT for discovery or
  exploration — use $explore for that. NOT for pure rename/extract; a file MOVE
  still runs Step 6 restructure SIM + Step 7 gate. An overlay → strategy
  question runs Step 1 and answers it, even with no code to write.'
---

# Data-Driven Generation

Don't invent — find how it's solved HERE, repeat: strategy from overlay labels
(not thresholds), helpers via reuse gate, style from live code.

**References MANDATORY when their step runs** — open the file, never work the
step from this summary: Step 5 → `references/step-5-style.md`; Step 6 →
`references/step-6-generate.md` + `$test-first`; Step 7 →
`references/step-7-verify.md`; each finding family → its
`<plugin root>/repair/<family>.md` (plugin root = folder holding `skills/`; Step
7 map).

## Prerequisites

**Addressing:** every tea-rags call passes `project=<alias>` +
`path=<your working directory>` — `tea-rags://guide/freshness`.

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license `cat`
/ `grep` / `Read` over code — `tea-rags://guide/freshness`.

**Area context required:** files, pathPattern, per-symbol overlay labels in
conversation. Labels from `find_symbol(rerank=<preset>, metaOnly=false)` on
target symbols — explore PRE-GEN PG-2 (SIGNAL LOOKUP); no full risk-assessment
scan. Missing → STOP, say "area context missing"; plan step 1, by name: invoke
`$explore` (PRE-GEN) for target area, then resume — never own `semantic_search`
instead; approved design ≠ area context. Explore output here → use it.

**Session-context reuse:** outlines, bodies, search hits fetched here = source
of truth for their file until it is edited. Before any search or `find_symbol`,
reuse what the conversation holds; re-fetch ONLY a file edited after fetch.
State both halves: "re-fetch <edited symbol>; reuse in-context <other files>".

## Reading Overlay Labels

`rankingOverlay.file.<signal>` / `rankingOverlay.chunk.<signal>`, each
`{ value: N, label: "high" }` — result table (2+ rows): columns
`rankingOverlay.chunk.<signal>.value` / `.label`. Only preset's `overlayMask`
fields labelled — pick preset by labels needed; raw `payload.git.*` unlabelled.
Meanings: `tea-rags://guide/signal-labels`. Raw value needs label → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap`
(read_mcp_resource).

---

## Step 0: MODE

After Prerequisites. `find_symbol(metaOnly=true)` on named target, zero
guessing:

| Probe result                                       | Mode   |
| -------------------------------------------------- | ------ |
| Target symbol exists (find_symbol reads your tree) | MODIFY |
| Container exists, symbol new ("add method to Y")   | EXTEND |
| Neither exists                                     | CREATE |

Ambiguous → ask which mode (one question).

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

- **Hotfix** (exact location given) = MODIFY, skip STRATEGY + blame part of
  STYLE — say so. REUSE still applies to introduced logic; lexicon runs when fix
  introduces a name (MODIFY row: `types` = signature + local types, `anchors` =
  the symbol, `names` = only new names, no `concept`). VERIFY in full.
  Location + fix named ("line 88 nil — reload X before send") = this skill, no
  clarifying question; bug-hunt only when cause unknown.
- **Bug fix** = MODIFY; cause unknown → `bug-hunt` locates it first; fix still
  runs 6a in order: baseline GREEN → reproduction test (asserts correct output,
  e.g. `formatDuration(0) === "0s"`) RED on that assertion → only then patch.
- **Pure refactor / move** (no behaviour change) — THIS skill, Steps 1–5
  skipped: 6a baseline (`tests-at-risk` pins + target's own tests) GREEN BEFORE
  first move, no new test; file move → Step 6 restructure SIM; same tests re-run
  green, none edited; Step 7 gate.
- **Greenfield** = CREATE over empty area — TEMPLATE/STYLE degrade, don't
  pre-skip.
- **REUSE never skipped in any mode.**
- **RED never skipped** except a named `test-first` exception (no-tests language
  / config-docs only), stated in one line. Hotfix included.
- **VERIFY never skipped. Ever.**

## Workflow

### Step 1: STRATEGY SELECTION

Signal source per mode (matrix row 1).

**Custom strategies FIRST:** scan `.claude/skills/` for `strategy-*`, read each
`## When`; matching custom condition wins, hard rules below not consulted — say
this ordering when listing them (also for "which custom strategies exist?"
before generation).

**Hard rules** (no custom match):

| Condition                                                  | Strategy              |
| ---------------------------------------------------------- | --------------------- |
| chunk.bugFixRate "critical" + file.ageDays "old"/"legacy"  | DEFENSIVE             |
| chunk.commitCount "high"+ + file.churnVolatility "erratic" | STABILIZATION         |
| file.ageDays "legacy" + chunk.commitCount "low"            | CONSERVATIVE          |
| No match                                                   | Autonomous Judgment ↓ |

**Autonomous Judgment Protocol.** Answer = each label → its axis → NAMED
strategy (DEFENSIVE/STABILIZATION/CONSERVATIVE/STANDARD) → why + actions. "X
leaning Y" → end with ONE question to user naming both. No name = Step 1 not
done, code or not. Axes: **Risk** grows bugFixRate healthy→concerning→critical,
churnVolatility stable→erratic; **Stability** grows ageDays recent→legacy;
**Confidence** falls with commitCount "low". E.g.
`bugFixRate concerning, ageDays recent, commitCount typical` → Risk rising,
Stability low, Confidence medium → STANDARD leaning STABILIZATION; DEFENSIVE
needs `critical` + old.

**Load strategy (MANDATORY, name the file):** custom `strategy-<mode>` skill →
use it; else READ `strategies/<mode>.md` (DEFENSIVE → `strategies/defensive.md`)
before Step 2. Strategy named, file not loaded = Step 1 not done.

### Step 2: TEMPLATE — CREATE / EXTEND

Chunk / outline / body already here → `positiveIds` / `positiveCode` as is, no
re-search.

Delegate to `$extract-project-patterns`:

- `positiveIds` | `positiveCode` = best verified chunk from explore PG-OUTPUT /
  Step 1 signals (else `behaviorQuery`)
- `pathPatternL1` = pathPattern from explore PG-OUTPUT
- `limit` = 10

`templates[0]` = reference for Step 6. Recipe owns locality cascade (L1 =
subdomain, L2 = first semantic segment (infra prefixes kept in glob, not
counted), L3 = project) + quality gate (commitCount low/typical + ageDays
old/legacy + bugFixRate healthy; lone ideal on hub file also accepts; reject
bugFixRate critical or ageDays recent + commitCount low).

`locality` → Step 5: `L1` → template's `blameDominantAuthor` for style + review
routing; `L2` → author reviews technique, not exact code; `L3` → technique only,
verify architectural fit before adopting verbatim; `none` → no template,
generate from scratch, tell user to scrutinize result.

**Template imports = pre-approved REUSE vocabulary** — proven in context, Step 4
gate passes them automatically.

### Step 3: PLACEMENT — CREATE (EXTEND: fixed = container)

Home for new code, priority: 1. target file named by user; 2. template's path as
prior; 3. `semantic_search` by responsibility inside L1 pathPattern.

**God-module guard:** candidate's `memberCount` / `moduleMethodCount` label =
god-module → do NOT grow it; propose sibling module or extraction, surface
choice to user. EXTEND: guard fires on container.

New file where home module exists = structural N-th way. New code (file, import,
edge) → Step 7 gate judges placement, no pre-write simulation. Moves / merges /
splits of files → Step 6 restructure SIM BEFORE touching them.

### Step 4: REUSE — all modes

1. Enumerate general-purpose blocks in about-to-write code: retry, validation,
   caching, parsing, error wrapping, logging, serialization… ≤5 searches,
   `metaOnly: true`.
2. Per block: `hybrid_search` / `find_symbol` for existing helper.
3. **Gate — import helper IF** helper file in L1/L2 of target (locality per
   `extract-project-patterns`) **OR** its `fanIn` label `popular`/`hub` .
   **ELSE** follow its approach, do NOT import — no new cross-boundary coupling.
   Boundary = actual import graph. Codegraph off → gate on `imports` signal +
   locality only (L1/L2 reuse, L3 copy approach); note gate ran on import-proxy.
4. Template's own imports pass gate automatically.
5. **Almost-fits:** helper passes gate, lacks a parameter/branch → extend it
   minimal-diff, never a sibling. Extending `popular`/`hub` helper → user
   confirmation MANDATORY before edit. Blast radius → Step 8.

Output: **reuse manifest** (helpers to call) → Step 6.

### Step 5: STYLE

**MANDATORY open [references/step-5-style.md](./references/step-5-style.md)
before Step 5.** Style source: CREATE → blame-owner table, EXTEND → container
file, MODIFY → symbol itself. No re-fetch of unedited files. Naming (codegraph
on): ONE `get_naming_lexicon` call before GENERATE — project's name for a value
it already names; holder that IS what you are about to write → back to Step 4,
never rename and write a sibling.

Every name you are about to write is a draft and goes into that call — user's
drafts included (`row = find_vendor_envelope(id)` → `row` as `local`,
`find_vendor_envelope` as `return`), held value types into `types[]`. New class
/ module / interface →
`{ name, kind: "type", path: <new file>, symbolKind, extends: <planned ancestor> }`
— never name a type from neighbours without the call. CREATE of new
type/service: `concept` = DESCRIPTION of what it does (never draft name) +
`language` (required with concept); draft name → `names[]`. `MISFIT` → take
`suggestion`, type MISFIT included (missing `role` suffix →
`RubyConstReceiverPass` → `RubyConstReceiverStrategy`); keep draft only when
`role.evidence: "directory"` and type outside `role.examples`' family.
`NEW_TERM` + same-meaning word in `topTerms` / `alternatives` → name the adopted
term now, say why (`organizer` in topTerms → `IntakeOrganizer`). Codegraph off →
concept-only `semantic_search` per the reference; split holders' symbolIds and
paths into words, recurring word = project term; values named as template's code
names the same types.

Step 5 output = CONCRETE final names, one line per draft:
`<draft> → <name> (<shape>, <kind>)`, from dominant row of
`byType[].kinds.<kind>` (highest `n`), in its casing:
`row → tax_automation_document (EXACT, local)`,
`find_vendor_envelope → find_tax_automation_document! (VERB_TYPE, return)`,
`graph_db_client → client (TAIL, param — client n=40 beats graphDb n=12)`.
Concept new (no same-meaning term), also when context names its namespace/class
→ line, prefix literal: `NEW_TERM <term> — <why no project term denotes this>`.
"Project vocabulary" / "a name that describes the lookup" without the name =
Step 5 not done. Context already gives the lexicon and shows no same-meaning
term → decide now and print the literal
`NEW_TERM <term> — <why no project term denotes this>` line in the answer. Do
not make it conditional or describe the line without emitting it.

### Step 6: GENERATE — RED → GREEN → REFACTOR

**MANDATORY open
[references/step-6-generate.md](./references/step-6-generate.md) before
writing.** 6a RED = INVOKE `$test-first` (run it, not cite it) — DDG owns RED
and GREEN; never `test-driven-development` / superpowers TDD as separate phase.
**No production edit without a recorded RED block** (or its one-line named
exception). RED block = each test RUN, failing for the RIGHT reason — assertion
/ missing behaviour (stub); import, compile, syntax, missing-fixture failures
are not red. Say it per test: `RED <test> — right reason: <assertion | stub>`.
Plan-given test code goes in byte-exact. MODIFY / bug fix / refactor-move:
`tests-at-risk` pins + target's own tests GREEN BEFORE first edit or move — then
bug fix: reproduction red; behaviour change an existing pin asserts (old
default) → that pin, updated to spec value, IS the red:
`PIN-UPDATED <test> — <spec line>`, other pins untouched, run red, then edit;
refactor: no new test, same tests green after. Moving first, testing after =
baseline skipped. 6b GREEN — minimal; call reuse-manifest helpers, NEVER
reimplement. 6c REFACTOR under green only.

Move / merge / split of existing files → ONE `get_architecture_report`
`restructure` hypothesis first (`move{files, toComponent}` +
`addEdge`/`removeEdge` per retargeted import); `introduced` → open that family's
`<plugin root>/repair/<family>.md` `## Ops recipe`, pick its alternative
placement, re-simulate, then move. Output line:
`SIM restructure: introduced=<n> → <placement from ## Ops recipe> → re-simulated introduced=0`.

### Step 7: VERIFY

**MANDATORY open [references/step-7-verify.md](./references/step-7-verify.md)
before Step 7 — never skipped, also on "tests green, finalize".** In order:

1. Symbol risks — `find_symbol(symbol, rerank: "criticalPath", metaOnly: true)`
   on called / changed symbols, ≤ 5, most central first; read
   `rankingOverlay.chunk.<field>.label`. Not `get_callers`, not existence sweep,
   not `dangerous`. One line per symbol:
   `RISK <symbol> <label> → defensive call: <guard>; pinned by <test> | UNPINNED`
   (callee `bugFixRate` critical → call defensively, name pinning test). Changed
   symbol `pageRank` critical / `fanIn` central → Step 8 `get_callers`.
2. N-th-way `find_similar` (`positiveCode` = generated code).
3. MODIFY (signature change included): `tests-at-risk` (`$tests-as-context`,
   `affectedFiles` = changed file) scenarios + 6a pins re-run green. No 6a
   baseline (edit outside this flow) → run `tests-at-risk` now.
4. **GATE `review_changes` before EVERY commit** + fix-at-write loop. ONE call,
   ALL five sections
   `["naming","incompleteChange","cohesion","architecture","norms"]` — a wrapper
   prescribing fewer never narrows it. Base: `changes: {}` (uncommitted) or
   `git merge-base HEAD main` — never sibling / integration branch; stack-below
   findings = owner's, cite commit, no triage.
   - **Repair file map:** family = DETECTOR name on the finding, never section
     name. Files: `leakingAbstraction` `hubLike` `cycles` `stableDependencies`
     `layeringBackEdge` `mainSequence` `facadeContract` `silentCoupling`
     `splitCandidates` (`.md`); incompleteChange → `silentCoupling.md`, cohesion
     → `splitCandidates.md`. `repair/architecture.md` /
     `repair/incompleteChange.md` do NOT exist; naming / norms → no repair file.
     Finding given in task context = present → open its file now; only families
     with a finding.
   - **Confirm first:** finding's edge / symbol exists in diff AND is the edge
     in its evidence → REAL (type-only import = edge). Looks-wrong ≠ false
     positive.
   - Triage — `preExisting` absent = must-fix → repair (`remedy` present → apply
     verbatim); `preExisting` + `remedy` → apply remedy; `preExisting`, no
     `remedy` / pre-existing cohesion cluster → one report line + bead
     suggestion, never refactored here, commit allowed; own new cohesion cluster
     → move it now. Flap (≤ 0.02 over tolerance) = ordinary introduced: fix if
     cheap, else report metric before/after, threshold, moving diff edge — user
     decides. Co-change partner: inspect each — depends on changed contract →
     edit in this diff; else known-noise class shown to hold (version manifest
     per `silentCoupling.md`) or checkable `not touched because` line.
   - **After every repair: re-run SAME `review_changes` + targeted tests, state
     "target gone, no new finding".** ANY new finding or red test → round
     regressed → revert WHOLE round (even if target gone), different repair next
     round; never fix new finding on top. Round ≤ 2; must-fix left → ask the
     user (finding, each round tried, why reverted, metric before/after +
     threshold + diff edge that crossed it — hubLike: efferent count vs cut, the
     new import; options fix this way / accept with reason / bead), no commit
     until answered.
   - `truncated` / `built: false` / skipped files = PARTIAL ≠ pass, even at zero
     findings → re-run with `files: [...]` batches until every changed file
     judged; `partial=true` until then.
   - Accepted false positive = counter-evidence + FILED detector issue +
     `FALSE-POSITIVE … — issue <id>` line; no issue → not accepted.
   - Naming `NEW_TERM` → state decision now (keep X / use Y) + one-line why,
     never "needs a decision"; `MISFIT` → rename before commit.

Gate fails → no commit, no "done". Copy gate line LITERALLY, prefix included —
paraphrase ("gate is introduced=0, partial=false") = no gate line:
`GATE review_changes: introduced=<n>, partial=<true|false>` (codegraph off →
`architecture not judged`); `n` counts only non-`preExisting` findings. Repair
round → line before AND after (`introduced=1` → `introduced=0`). **No gate line
= task not done.**

### Step 8: IMPACT

No `codegraph` floor while `changedFiles` > 0 → edges touching changed files are
the index's (`tea-rags://guide/freshness`).

Blast radius of generated change:

- **Codegraph on:** `rerank="blastRadius"`, metaOnly=true (real edges). Warn on
  high-`fanIn` / `isHub` dependents.
- **Codegraph off** (`fanIn` absent): custom weights
  `{ imports: 0.5, churn: 0.3, ownership: 0.2 }`, metaOnly=true, note
  approximate (import-proxy) — `tea-rags://guide/navigation` "Graph navigation".
- **MODIFY: `get_callers` on modified symbol MANDATORY** — import proxy
  insufficient.

Warn on high-impact modules. Flag shared taskIds → coordinated change.
