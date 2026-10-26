---
name: data-driven-generation
description:
  Decide HOW to write or change code by inspecting git signals on neighbors —
  classifies task mode (CREATE / EXTEND / MODIFY), pulls strategy and templates
  from proven low-churn implementations, reuses existing shared helpers instead
  of reinventing what the project already solved. Triggers on "implement
  function X", "add method to class Y", "write a helper for Z", "modify function
  X", "change behavior of Y", "напиши функцию", "добавь метод", "поправь метод",
  "измени поведение", "overlay labels → strategy?", a hotfix with location +
  fix named (cause known → not bug-hunt). NOT for discovery — use
  tea-rags:explore. NOT for pure rename/extract; a file MOVE still runs Step 6
  restructure SIM + Step 7 gate. Overlay → strategy question: Step 1 answers it,
  no code needed.
---

# Data-Driven Generation

Don't invent — find how it's solved HERE, repeat: strategy from overlay labels
(not thresholds), helpers via reuse gate, style from live code.

**References: open in the turn that answers the step** — real run, plan-only or
a question about it alike; "I'll open it when Step N runs" = step not done. Step
5 → `references/step-5-style.md`; Step 6 → `references/step-6-generate.md` +
`tea-rags:test-first`; Step 7 → `references/step-7-verify.md`; each finding
family → its `<plugin root>/repair/<family>.md` (plugin root = folder holding
`skills/`; map in step-7-verify.md).

## Prerequisites

**Addressing:** every tea-rags call passes `project=<alias>` +
`path=<your working directory>` — `tea-rags://guide/freshness`. Every step (Step
7 verify and `references/*` included); a call shown below without `path` still
carries both.

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license `cat`
/ `grep` / `Read` over code — `tea-rags://guide/freshness`.

**Area context required:** files, pathPattern, per-symbol overlay labels in
conversation. Labels from `find_symbol(rerank=<preset>, metaOnly=false)` on
target symbols — explore PRE-GEN PG-2 (SIGNAL LOOKUP); no full risk-assessment
scan. Hotfix (location + fix named) → exempt, no PRE-GEN, no STRATEGY: Step 0
MODIFY, first line `HOTFIX → MODIFY: STRATEGY + blame STYLE skipped`. Otherwise
missing → STOP, say "area context missing"; plan step 1, by name: invoke
`/tea-rags:explore` (PRE-GEN) for target area, then resume — never own
`semantic_search` instead; approved design ≠ area context. Explore output here →
use it.

**Session-context reuse:** outlines, bodies, search hits fetched here = source
of truth for their file until it is edited. Before any search or `find_symbol`,
reuse what the conversation holds; re-fetch ONLY a file edited after fetch (by
you or a tool). State both halves: "re-fetch <edited symbol>; reuse in-context
<other files>".

## Reading Overlay Labels

`rankingOverlay.file.<signal>` / `rankingOverlay.chunk.<signal>`, each
`{ value: N, label: "high" }` — result table (2+ rows): columns
`rankingOverlay.chunk.<signal>.value` / `.label`. Only preset's `overlayMask`
fields labelled — pick preset by labels needed; raw `payload.git.*` unlabelled,
and absent from a metaOnly payload unless `fields` names it (`["git"]`).
Meanings: `tea-rags://guide/signal-labels`. Raw value needs label → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap`
(ReadMcpResourceTool).

---

## Step 0: MODE

Target's file outline / body already in the conversation and unedited since →
that IS the probe, no call; print
`REUSE <file> — unedited since fetch; in-context outline/body stand, no find_symbol`.
Otherwise `find_symbol(metaOnly=true)` on named target, zero guessing:

| Probe result                                       | Mode   |
| -------------------------------------------------- | ------ |
| Target symbol exists (find_symbol reads your tree) | MODIFY |
| Container exists, symbol new ("add method to Y")   | EXTEND |
| Neither exists                                     | CREATE |

Ambiguous → ask which mode (one question, genuine ambiguity only).

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

- **Hotfix** (location + fix named: "line 42 raises on nil — reload the record
  before save") = THIS skill, MODIFY — no clarifying question, no bug-hunt /
  debugging wrapper (those = cause unknown). Answer lines, in order:
  `HOTFIX → MODIFY: STRATEGY + blame STYLE skipped`; Step 4 REUSE for introduced
  logic; each introduced name → ONE
  `get_naming_lexicon(language, types: [<signature + local types>], anchors: [<symbol>], names: [<new names only, each { name, kind, type }>])`
  — no `concept`, no existence sweep; RED; Step 7 in full.
- **Bug fix** = MODIFY; cause unknown → `bug-hunt` locates it first; fix still
  runs 6a in order: baseline GREEN → reproduction test (asserts correct output,
  e.g. `formatDuration(0) === "0s"`) RED on that assertion → only then patch.
- **Pure refactor / move** (no behaviour change) — THIS skill, Steps 1–5
  skipped: 6a baseline (`tests-at-risk` pins + target's own tests) GREEN BEFORE
  first move, no new test; file move → Step 6 restructure SIM; same tests re-run
  green, none edited; Step 7 gate.
- **Greenfield** = CREATE over empty area — TEMPLATE/STYLE degrade, don't
  pre-skip.
- **REUSE never skipped in any mode** — shared infra exists even when the
  feature is new.
- **RED never skipped** except a named `test-first` exception (no-tests language
  / config-docs only), stated in one line. Hotfix included.
- **VERIFY never skipped. Ever.**

## Workflow

### Step 1: STRATEGY SELECTION

Signal source per mode (matrix row 1). A TEMPLATE chunk's labels ("template
search returned a chunk with X — use it?") are not a strategy signal → Step 2
gate line, no strategy selection.

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

**Autonomous Judgment Protocol** (no hard rule matches) — all three steps:

1. **Decide** — closest NAMED strategy
   (DEFENSIVE/STABILIZATION/CONSERVATIVE/STANDARD) by the signal axes. No name =
   Step 1 not done, code or not.
2. **Justify** — each label → its axis → why + specific actions.
3. **Ask if uncertain** — present the dilemma with options. "X leaning Y" → last
   line, even when justified: `X or Y?`

Signal axes:

- **Risk** grows: bugFixRate healthy→concerning→critical, churnVolatility
  stable→erratic
- **Stability** grows: ageDays recent→legacy
- **Confidence** falls: commitCount "low" = few data points

Answer opens with this line, slots filled:
`No hard rule matches → Autonomous Judgment: Risk <…>, Stability <…>, Confidence <…> → <X> leaning <Y>`
— then actions, then `<X> or <Y>?`. E.g.
`bugFixRate healthy, ageDays old, commitCount low` → Risk low, Stability high,
Confidence low → CONSERVATIVE leaning STANDARD (CONSERVATIVE's hard rule needs
`legacy`).

**Load strategy (MANDATORY, name the file):** custom `strategy-<mode>` skill →
use it; else READ `strategies/<mode>.md` (DEFENSIVE → `strategies/defensive.md`)
before Step 2. Strategy named, file not loaded = Step 1 not done.

### Step 2: TEMPLATE — CREATE / EXTEND

Chunk / outline / body already here → `positiveIds` / `positiveCode` as is, no
re-search.

Delegate to `tea-rags:extract-project-patterns`:

- `positiveIds` | `positiveCode` = best verified chunk from explore PG-OUTPUT /
  Step 1 signals (else `behaviorQuery`)
- `pathPatternL1` = pathPattern from explore PG-OUTPUT
- `limit` = 10

`templates[0]` = reference for Step 6. Recipe owns locality cascade (L1 =
subdomain, L2 = first semantic segment (infra prefixes kept in glob, not
counted), L3 = project) + quality gate (commitCount low/typical + ageDays
old/legacy + bugFixRate healthy; lone ideal on hub file also accepts; reject
bugFixRate critical or ageDays recent + commitCount low).

Template chunk with labels handed in ("use it?", "OK?") → answer with this line,
slots filled, never a bare reject:
`REJECT template <path>: <bugFixRate critical | ageDays recent + commitCount low = not yet proven> → next-best: templates[1] if it passes the gate, else re-run extract-project-patterns one level wider for an older, proven candidate`
(passes → `ACCEPT template <path>: <labels>`).

`locality` = WHAT of the template to reuse (how closely: Step 5 ownership
label): `L1` → template's `blameDominantAuthor` = Step 5 style owner + review
routing; `L2` → author reviews technique, not exact code; `L3` → technique only,
verify architectural fit before adopting verbatim; `none` → no template,
generate from scratch, tell user to scrutinize result.

**Template imports = pre-approved REUSE vocabulary** — proven in context, Step 4
gate passes them automatically. The list:
`get_callees(relativePath: <template file>)` (codegraph on) or the template's
own import lines — a search row's `imports` is only a count
(`includeImports: true` returns the list).

### Step 3: PLACEMENT — CREATE (EXTEND: fixed = container)

Home for new code, priority: 1. target file named by user; 2. template's path as
prior; 3. `semantic_search` by responsibility inside L1 pathPattern.

**God-module guard:** candidate's `memberCount` / `moduleMethodCount` label =
god-module → do NOT grow it; propose sibling module or extraction, surface
choice to user. EXTEND: guard fires on container.

New file where home module exists = structural N-th way. New code (file, import,
edge) → Step 7 gate judges placement, no pre-write simulation.

### Step 4: REUSE — all modes

1. Enumerate general-purpose blocks in about-to-write code: retry, validation,
   caching, parsing, error wrapping, logging, serialization… ≤5 searches,
   `metaOnly: true`.
2. Per block: `hybrid_search` / `find_symbol` for existing helper.
3. **Gate — import helper IF** helper file in L1/L2 of target (locality per
   `extract-project-patterns`) **OR** its `fanIn` label `popular`/`hub`.
   **ELSE** follow its approach, do NOT import — no new cross-boundary coupling.
   Boundary = actual import graph. Codegraph off → gate on `imports` signal +
   locality only (L1/L2 reuse, L3 copy approach); note gate ran on import-proxy.
4. Template's own imports pass gate automatically.
5. **Almost-fits:** helper passes gate, lacks a parameter/branch → extend it
   minimal-diff, never a sibling. Extending `popular`/`hub` helper → user
   confirmation MANDATORY before edit. Blast radius → Step 8.

Output: **reuse manifest** (helpers to call) → Step 6.

### Step 5: STYLE

Open [references/step-5-style.md](./references/step-5-style.md) (lexicon
detail). Style source: CREATE → template's live-line owner, EXTEND → container
file, MODIFY → symbol itself (owner = review routing only). How closely = the
dominant-author label in context (`file.blameDominantAuthorPct`; any supplied
`*DominantAuthorPct` label reads the same rows):

| Label        | Behaviour                                               |
| ------------ | ------------------------------------------------------- |
| deep-silo    | match exactly; owner reviews                            |
| silo         | match dominant patterns closely; owner reviews          |
| concentrated | follow dominant patterns, minor flexibility             |
| shared       | project conventions, unify; never copy one author style |

First Step 5 line, label given = row applied:
`STYLE <label> → <behaviour>; review: <owner | none>`.

Naming (codegraph on): ONE `get_naming_lexicon` call before GENERATE — project's
name for a value it already names. Print the call, arguments filled from the
task, then its result lines:
`get_naming_lexicon(language, types: [<held value types>], anchors: [...], concept: <description — new type/service only>, names: [{ name: <draft>, kind: <local|param|field|return>, type: <its value type when known> }, …])`.

Every name you are about to write is a draft in `names[]`, each entry carrying
its own `type` (the same type also in `types[]`) — user's included:
`rec = load_entry(id)` returning `LedgerEntry` →
`{ name: "rec", kind: "local", type: "LedgerEntry" }`,
`{ name: "load_entry", kind: "return", type: "LedgerEntry" }`. New class /
module / interface →
`{ name, kind: "type", path: <new file>, symbolKind, extends: <planned ancestor> }`
— never name a type from neighbours without the call. `concept` = DESCRIPTION of
what it does (never draft name) + `language`. `MISFIT` → take `suggestion`, type
MISFIT included (missing `role` suffix: `PaymentRetryHandler` extending
`RetryPolicy` → `PaymentRetryPolicy`); keep draft only when
`role.evidence: "directory"` and type outside `role.examples`' family.
`NEW_TERM` + same-meaning word in `topTerms` / `alternatives` → name the adopted
term now, say why (user says "coupon", `voucher` in topTerms → `VoucherIssuer`).
Codegraph off → concept-only `semantic_search` per the reference; split holders'
symbolIds and paths into words, recurring word = project term; values named as
template's code names the same types.

Holder (`concept` / `names[].holder`) that already IS what you are about to
write = missed reuse, not naming → back to Step 4, its gate run on THAT holder,
printed:
`BACK-EDGE <holder symbolId> → Step 4 gate: locality <L1|L2|L3>, fanIn <label> → <import | extend minimal-diff | follow approach>`
— never rename the draft and write a sibling.

Step 5 output = CONCRETE final names, one line per draft:
`<draft> → <name> (<shape>, <kind>)`, `<name>` = the top name of
`byType[].kinds.<kind>` (highest `n`; listed order when `n` absent), in its
casing, whatever the dominant shape — `FREE` = project names by role → that top
name, never the type-spelled draft: `rec → ledger_entry (EXACT, local)`,
`load_entry → find_ledger_entry! (VERB_TYPE, return)`,
`graph_db_client → client (TAIL, param — client n=40 beats graphDb n=12)`,
`fileHandle → out (FREE, param — kinds.param: out, w, sink)`. Concept new (no
same-meaning term, even when context names its namespace/class or gives the
lexicon) → pick the term now; print BOTH slots filled:
`NEW_TERM Debouncer — no project term denotes coalescing bursts into one call`.
A line still showing `<term>`, conditional ("X is a candidate, conventions
decide"), or described not printed = not the line. "Project vocabulary" / "a
name that describes the lookup" without the name = Step 5 not done. Lexicon
result not in hand (plan-only, call planned): the lines still print, NOW —
project code already in hand holding the same type (context line, template,
container: `<x> = <finder>(id)`) gives the names, read like `byType` top names:
`rec → ledger_entry (EXACT expected, local — lexicon confirms)`; no such code →
`<draft> → [planned; not run] (lexicon decides; MISFIT → suggestion)`. "Apply
the returned verdicts" alone = no line.

### Step 6: GENERATE — RED → GREEN → REFACTOR

**MANDATORY open
[references/step-6-generate.md](./references/step-6-generate.md) before
writing.** 6a RED = INVOKE `tea-rags:test-first` (run it, not cite it) — DDG
owns RED and GREEN; never `dinopowers:test-driven-development` / superpowers TDD
as separate phase. **No production edit without a recorded RED block** (or its
one-line named exception). RED block = each test RUN, failing for the RIGHT
reason — assertion / missing behaviour (stub); import, compile, syntax,
missing-fixture failures are not red. Per test, the line `tea-rags:test-first`
Step 4 defines:
`RED <test> — FAIL: <failure excerpt | [planned; not run]> — right reason: <assertion | stub>`;
"I would run the test" without it = no RED. Plan-given test code goes in
byte-exact. MODIFY / bug fix / refactor-move: `tests-at-risk` pins + target's
own tests GREEN BEFORE first edit or move — then bug fix: reproduction red;
behaviour change an existing pin asserts (old default) → that pin, updated to
spec value, IS the red: `PIN-UPDATED <test> — <spec line>`, other pins
untouched, run red, then edit; refactor: no new test, same tests green after.
Moving first, testing after = baseline skipped. 6b GREEN — minimal; call
reuse-manifest helpers, NEVER reimplement. 6c REFACTOR under green only.

Move / merge / split of existing files → ONE `get_architecture_report`
`restructure` hypothesis first (`move{files, toComponent}` +
`addEdge`/`removeEdge` per retargeted import); `introduced` → open that family's
`<plugin root>/repair/<family>.md` `## Ops recipe`, pick its alternative
placement, re-simulate, then move. Output line:
`SIM restructure: introduced=<n> → <placement from ## Ops recipe> → re-simulated introduced=0`.

### Step 7: VERIFY

Open [references/step-7-verify.md](./references/step-7-verify.md) (how to fill
each check, triage, repair rounds) — never skipped, also on "tests green,
finalize" / "can I commit?".

#### Step 7 answer block

Every Step 7 answer — real run, plan-only, supplied findings, "tests green,
finalize", "can I commit?", a hand-back report to a parent — is these lines, in
this order, as the steps of the answer, copied, slots filled. Only definition of
Step 7 output.

```
RISK <symbol> <chunk.<field>.label> → defensive call: <guard>; pinned by <test> | UNPINNED
N-TH-WAY find_similar(positiveCode = generated code): <near-duplicate module → Step 4> | none
PINS tests-at-risk + 6a pins: green                                   (MODIFY)
NAMING <name> <MISFIT|COLLISION|genericName|NEW_TERM> → renamed <new name> | kept: <one-line why> | adopted <alternative>   (per non-conforming verdict of the review's naming section)
INTRODUCED <family> <edge|symbol> — repair: <concrete operation>      (per non-preExisting finding)
FALSE-POSITIVE <family> <edge> — counter-evidence: <quoted hunk | find_symbol absence> — issue <id | [planned; not run] filing call>   (per accepted false positive, replaces its INTRODUCED line)
REMEDY-APPLIED <family> <edge|symbol> — preExisting, server remedy applied: <remedy operation>   (per preExisting WITH remedy — never optional)
REPORT-ONLY <family> <edge|symbol> — preExisting, left unchanged — bead: <suggested title naming the finding>   (per preExisting, no remedy)
PARTNER <path> — edited in this diff: <contract it depends on> | not touched because <checkable reason citing a symbol>   (per incompleteChange / silentCoupling partner)
PARTNER <manifest path> — version manifest: known noise per repair/silentCoupling.md (detector drops manifests; bump follows the versioning rule), no coupling edit   (per plugin.json / package.json / lockfile partner)
GATE review_changes: introduced=<INTRODUCED lines>, partial=<true|false>
RE-REVIEW same review_changes + targeted tests: target gone, no new finding
GATE review_changes: introduced=0, partial=false
```

- One `RISK` line per checked symbol (≤ 5). `N-TH-WAY` always printed.
- `NAMING` = one line per naming verdict that is not conforming, rename done
  before the commit; none → line dropped.
- First `GATE` line = the review held NOW, printed even at zero findings, its
  `introduced=` = count of `INTRODUCED` lines (= `change.introducedCount` when
  supplied; `preExisting` findings never counted). It is never replaced by the
  closing line: partial review (`truncated` / `built: false` /
  `scopeSkippedFiles`) → `partial=true` here, then `files` batches as the
  repair, then the closing line.
- `INTRODUCED` operation = concrete: the `remedy` spelled out (`retargetImport`
  → "in `<source>` import `<names>` from `<to>` instead of `<from>`"), else the
  repair file's `## No remedy` step spelled out as the edit it prescribes (e.g.
  "retarget the import to `<facade>`"), never the heading name.
- `RE-REVIEW` + closing `GATE` = the re-run every repair or batch ends with; a
  plan prints the closing line as the result required to commit, followed by its
  fallback:
  `else after round 2: ESCALATE <family>: <metric> <before> → <after> vs <threshold>, edge <src> → <dst>`
  (hubLike: efferent count vs cut, the new import) + AskUserQuestion, no commit.
- Nothing to repair and not partial → `RE-REVIEW` + closing line dropped; the
  first `GATE` line is final. Repair already done before this answer (hand-back
  after a clean re-run) → print the closing line.
- `FALSE-POSITIVE` = not counted in `introduced`. Filing the issue in the
  session's tracker is part of this step (no separate consent); the issue id
  comes from that filing call — **Confirm first** in the reference.
- Codegraph off → gate lines become
  `GATE review_changes: architecture not judged (codegraph off)`.
- Paraphrase ("gate is clean", "review_changes clean", "report the updated
  result", "re-run the gate") = no line. **No gate line = task not done.**

Checks:

1. Symbol risks — `find_symbol(symbol, rerank: "criticalPath", metaOnly: true)`
   on called / changed symbols, ≤ 5, most central first; read
   `rankingOverlay.chunk.<field>.label`. Not `get_callers`, not existence sweep,
   not `dangerous`.
2. N-th-way `find_similar` (`positiveCode` = generated code) — every mode.
3. MODIFY: `tests-at-risk` scenarios + 6a pins re-run green.
4. **GATE `review_changes` before EVERY commit** — ONE call, ALL five sections
   `["naming","incompleteChange","cohesion","architecture","norms"]`; a wrapper
   prescribing fewer never narrows it. Base `changes: {}` or
   `git merge-base HEAD main`. Triage, repair files, rounds, partial: the
   reference.

Gate fails → no commit, no "done". **No gate line = task not done.**

### Step 8: IMPACT

No `codegraph` floor while `changedFiles` > 0 → edges touching changed files are
the index's (`tea-rags://guide/freshness`).

Blast radius of generated change:

- **Codegraph on:** `rerank="blastRadius"`, metaOnly=true — real `fanIn` +
  churn + bugFix over actual call/import edges. Warn on high-`fanIn` / `isHub`
  dependents.
- **Codegraph off** (`fanIn` absent): custom weights
  `{ imports: 0.5, churn: 0.3, ownership: 0.2 }`, metaOnly=true, note
  approximate (import-proxy) — `tea-rags://guide/navigation` "Graph navigation".
- **MODIFY: `get_callers` on modified symbol MANDATORY** — changed behaviour
  propagates through real call edges; import proxy insufficient.

Warn on high-impact modules. Flag shared taskIds → coordinated change: taskIds
are raw `git.*`, which metaOnly drops — both calls above carry
`fields: ["relativePath", "imports", "git"]`.
