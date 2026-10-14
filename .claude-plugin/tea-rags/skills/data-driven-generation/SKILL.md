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
  for that. NOT for pure refactor (rename, move, extract) with no behavior
  change. This skill activates ONCE the agent is about to write or change code.
---

# Data-Driven Generation

Don't invent — find how it's solved HERE, repeat. Strategy from git signal
labels, helpers via reuse gate, style from live code. Overlay labels — not
hardcoded thresholds — strategies adapt per codebase.

## Prerequisites

**Addressing:** every tea-rags call passes `path=<your working directory>` —
search-cascade "Addressing the Codebase"; never project alone.

**Area context required:** files, pathPattern, per-symbol overlay labels must be
in conversation. Labels come from `find_symbol(rerank=<preset>, metaOnly=false)`
on target symbols — explore PRE-GEN step PG-2 (SIGNAL LOOKUP). No full
risk-assessment scan needed. If missing, invoke `/tea-rags:explore` for target
area — explore detects pre-generation intent, gathers context automatically. If
explore output already exists this conversation, use it.

**Session-context reuse:** outlines, symbol bodies and search hits already
fetched in this conversation are the source of truth for their file until that
file is edited. Before any search or `find_symbol`, check the conversation for
the file; reuse what is there. Re-fetch ONLY a file edited after it was fetched
(by you or a tool). Re-searching an unedited file spends tokens and adds
nothing.

## Reading Overlay Labels

Labels live in `rankingOverlay.file.<signal>` and
`rankingOverlay.chunk.<signal>`. Each labeled value:
`{ value: N, label: "high" }`. Only fields in the preset's `overlayMask` are
labelled — choose the preset by the labels you need; raw values under
`payload.git.*` are never labelled.

For label definitions: `tea-rags://schema/signal-labels`. For thresholds:
`get_index_metrics`.

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
same as implementation. Chosen placement → Step 6b pre-write simulation before
the file is written.

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
   - Codegraph off (prime `## Enrichment` lacks `codegraph.symbols`): gate on
     `imports` signal + locality-only (L1/L2 → reuse, L3 → copy approach); note
     gate ran on import-proxy.
4. Template's own imports pass gate automatically (Step 2).
5. **Almost-fits:** helper passes gate but lacks a parameter/branch → extend it
   minimal-diff, do NOT write a sibling. Extending `popular`/`hub` helper → user
   confirmation MANDATORY before edit. Blast radius → Step 8.

Output: **reuse manifest** (helpers to call) → Step 6.

### Step 5: STYLE

Session-context reuse (Prerequisites): the container, template and symbol bodies
fetched in Steps 0–4 are the style source — read them from the conversation; a
file is re-fetched only when edited since. Same for naming: types, anchors and
signatures already in context feed `get_naming_lexicon` without new lookups.

Source per mode: CREATE → blame-owner table below. EXTEND → match the container
file itself. MODIFY → match the symbol itself; blame table = review routing
only.

Use `blameDominantAuthor` from explore pre-gen output (live-line owner — person
whose code you'd match/extend). Style copy mirrors CURRENT code, not historical
commit activity, so use blame-based.

| file.blameDominantAuthorPct.label | Behavior                                              |
| --------------------------------- | ----------------------------------------------------- |
| "deep-silo"                       | Match exactly. Flag the live-line owner for review.   |
| "silo"                            | Match dominant patterns closely. Owner should review. |
| "concentrated"                    | Follow dominant patterns, minor flexibility.          |
| "shared"                          | Project conventions. Opportunity to unify.            |

If `recentDominantAuthor` differs from `blameDominantAuthor` (long-time owner
left, new contributor took over): defer to `blameDominantAuthor` for style
(their code is what's there now), but flag `recentDominantAuthor` as secondary
reviewer for fastest turnaround.

#### Naming (lexicon)

Names are the project's ontology. A value the project already names gets the
project's name; a new term only for a genuinely new concept. Learn the
CONVENTION — how a name relates to its value's type and to the call it is bound
from — not one name to copy.

Canonical failure (taxdome, Ruby): the project writes
`tax_automation_document = find_tax_automation_document!(id)`, and a second
binding of that model in one scope gets a qualifier
(`tax_automation_document_ignored`). The agent wrote
`row = find_vendor_envelope(id)` returning a `TaxAutomationDocument`: `row`
carries no type (the Ruby resolver types receivers from names, so the graph
loses edges), `vendor_envelope` is a term the project never uses.

**Codegraph on** (prime `## Enrichment` lists `codegraph.symbols`) → ONE
`get_naming_lexicon` call here, before GENERATE — the vocabulary sits in context
while writing, so misfits are prevented, not detected:

| Mode            | `types`                          | `anchors`           | `concept`             | `names`            |
| --------------- | -------------------------------- | ------------------- | --------------------- | ------------------ |
| CREATE          | value types of template+manifest | template + manifest | yes — the new symbol  | the new symbol(s)  |
| EXTEND          | + container field types          | + container         | only for a new method | the new method     |
| MODIFY / hotfix | symbol signature + its locals    | the symbol          | no                    | new locals/methods |

- `language` = target language (required with `concept`); `pathPattern` = target
  area (the tool widens it under 5 rows and reports `scope`).
- Evidence = ONE language namespace per call (languages sharing a
  `typeNamespace`, e.g. TS + JS); other languages' rows never count. So always
  pass `language` with `names[]`; polyglot drafts → one call per language.
  `changes`/`files` split by file language themselves.
- `concept` = a DESCRIPTION of what the new symbol denotes ("pulls signed
  envelopes from the e-signature vendor into tax documents") — never the draft
  name: a draft pulls in its own lexical neighbours.
- `names[]` = drafts with `kind` (`local`/`param`/`field`/`return`) and `type`
  when known. Type unknown but bound from a call →
  `callee: { member, receiver? }`. A new class, module, interface, enum or
  constant →
  `{ name, kind: "type", path: <its file>, symbolKind: <class|module|interface|enum|type_alias|constant>, extends?: <planned ancestor> }`:
  the ancestor's family and the directory set the expected role suffix;
  `symbolKind` keeps interface/type_alias/enum out of a class directory's role,
  class out of a shape directory's.
- A `return` draft with no known `type` is judged too — never invent a type to
  force a verdict. A verb the project uses → CONFORMS; a rare one → NEW_TERM
  (`topTerms`); never a MISFIT toward another verb of the same noun (`find_user`
  and `build_user` are different operations — pick the verb for what the method
  does). Verbless → CONFORMS if declared elsewhere, else NO_CONVENTION.

Reading the answer — the dominant shape per kind IS the convention:

| Shape            | Name to build (casing as the returned names show)                         |
| ---------------- | ------------------------------------------------------------------------- |
| `EXACT`          | the type itself: `tax_automation_document`, plural for a collection       |
| `QUALIFIED`      | EXACT + qualifier, for a second binding of the type in one scope          |
| `TAIL`           | trailing word(s) of the type: `document`                                  |
| `VERB_TYPE`      | `return`: verb + type — `find_tax_automation_document!`                   |
| `CALLEE_DERIVED` | the callee without verb prefix and `!`/`?`: `x = find_x!(id)`             |
| `FREE`           | project names by ROLE — pick from `kinds.<kind>` names; never force EXACT |

- `byType[].kinds.<kind>[].name` = the vocabulary; a dominant name is reused
  verbatim. `confidence` low or `evidence` mostly `name-inferred` = weak
  evidence, prefer the template's code.
- `byCallee` = how the project names values bound from that call (untyped path).
- `concept.terms` = the project's words for the concept. A holder that already
  IS what you are about to write → back to Step 4 and gate that holder (a missed
  reuse, not a naming issue) — never rename and write a sibling.
- `names[]`: `CONFORMS` → keep (it means consistent with the project's
  vocabulary, not a verdict on behaviour; an `alternatives` word on it is the
  project's term for the same concept → prefer it). `MISFIT` → take `suggestion`
  (`holder` shows where the project uses it; a type MISFIT names the missing
  `role`; `role.evidence: "directory"` = location only — rename only when the
  type belongs to `role.examples`' family, else keep the name, reconsider the
  location). `NEW_TERM` → adopt a `topTerms` term or an `alternatives` word if
  it denotes the same concept; otherwise the concept is new — keep the term,
  justify it in Step 6. `NO_CONVENTION` (value) → no demand, not free: take
  `prefer.exact` (type spelled) or a name like `prefer.analogous` (family's);
  justify only a name unlike both. `COLLISION` → the short name is already a
  type elsewhere (`existing`); pick a distinct name.
- `driftWarning` or empty `byType` → no history for the type; take names from
  the template's code and say so.

**Codegraph off** → tool absent; concept part only: `semantic_search` with
`query` = the concept description, `language`, `pathPattern` = L2 (widen to the
project under 5 hits), `filter: { presets: "production" }`,
`rerank: { custom: { similarity: 0.7, imports: 0.3 } }` (import-proxy for the
graph weights), `limit: 30`, `metaOnly: true`. Split holders' symbolIds and
paths into words; recurring terms = the vocabulary. Value names: follow how the
template's code names the same types.

Output: the vocabulary for Step 6.

### Step 6: GENERATE — RED → GREEN → REFACTOR

#### 6a RED

Invoke `tea-rags:test-first` with mode (Step 0) + change kind (CREATE/EXTEND,
MODIFY behaviour, refactor/move, bug fix). Behaviour source: spec / plan
acceptance criteria or test code verbatim when present, else one test per
behaviour of the task. Output = `RED` block: per-test failure reason (assertion
/ missing behaviour — never import, compile, syntax, missing fixture) +
baseline. **No production edit without a recorded RED block** (or its one-line
named exception). Refactor / move → no new test; the green baseline is the
invariant through 6b–6c.

#### 6b GREEN

Minimal implementation that turns every RED test green and keeps every baseline
pin green.

Apply strategy + style + reuse manifest — call manifest helpers, NEVER
reimplement them. MODIFY: minimal diff per strategy.

Failing test → fix the CODE. Never edit a test to pass: business-logic tests are
immutable. Test genuinely wrong (contradicts spec) → report test + spec line to
the user, do not change it silently. Only a `PIN-UPDATED` pin from 6a changes,
and only there.

MODIFY, before the first edit:
`find_co_changed(path=<your working directory>, files: [target])` on the target
file (registered when codegraph is on). Silent partners —
`structurallyLinked: false` — with `strength >= 0.5`, top 5: check whether the
change belongs in them too. Context, not a requirement — never expand the diff
on co-change alone.

Names come from the Step 5 vocabulary, built by the dominant shape. A word
outside it is `NEW_TERM` and gets one line in the output:
`NEW_TERM <term> — <why no project term denotes this>`.

**Pre-write simulation** (codegraph on) — prevent, not repair. Runs BEFORE the
first production edit iff task (a) adds new production file, (b) adds import
edge crossing component boundary, or (c) moves / merges / splits files. Else —
in-file edit, no new file, no cross-component edge — skip, zero calls.

- **Edge-only** (no file added, no move) → cheap check: ONE
  `get_architecture_report(path, plannedEdges: [{source, target}])` for all such
  imports. `MISFIT` → route via `expectedPath` (established direction /
  `transit` role), not planned edge. `NEW_PATTERN` / `UNJUDGED` → write it, one
  line: `NEW_PATTERN|UNJUDGED <source> -> <target> — <reason>`.
- **New file / move / merge / split** → planned change as ONE
  `get_architecture_report(path, restructure: [...])` hypothesis:
  `addFile{file,component?,abstract?}` + `addEdge{from,to}` per planned import
  (+ `removeEdge{from,to}` per dropped / retargeted one),
  `move{files,toComponent}`, `merge{components}`, `split{component,groups}`.
  Delta `introduced` non-empty → choose other placement / edge per
  `../../repair/<family>.md` `## Ops recipe` (absent → `## Apply remedy`; that
  family only), re-simulate. Write when `introduced` empty, or each left entry
  meets Step 7 evidence rules. Edge ops move structural detectors only —
  co-change families answer at the Step 7 gate.
- **Multi-step restructuring** (several remedies, order matters) →
  `tea-rags:refactoring-planning`, not this step.

#### 6c REFACTOR

Clean up under green: duplication, names, extraction. Re-run RED tests +
baseline after each refactor edit; any red → undo that edit. Then Step 7.

### Step 7: VERIFY

No per-identifier existence sweep — specs and the type-checker catch a
hallucinated name; the sweep only spends tokens. Verify what they miss:

1. **Symbol risks** — symbols the new code calls or changes, ≤ 5, most central
   first: `find_symbol(symbol, rerank: "criticalPath", metaOnly: true)`. Its
   chunk mask labels `codegraph.chunk.pageRank`, `codegraph.chunk.fanIn`,
   `codegraph.chunk.fanOut`, `bugFixRate`, `commitCount` — read
   `rankingOverlay.chunk.<field>.label`.
   - Callee `bugFixRate` critical → call it defensively (guard its inputs,
     handle its failure mode); confirm a test pins the scenario you rely on,
     else report it unpinned.
   - Changed symbol `pageRank` critical or `chunk.fanIn` central → Step 8
     `get_callers` (already mandatory for MODIFY).
   - Reviewer routing stays in Step 5 — not repeated here.
   - Codegraph off → `rerank: "dangerous"`: file-level labels only, react to
     `rankingOverlay.file.bugFixRate`. Never `dangerous` while codegraph is on —
     it leaves the chunk labels unread.
2. **N-th-way self-check:** `find_similar` with `positiveCode` = generated code;
   ignore hits on template + target file. Near-duplicate hit in another module =
   you wrote the N-th way → back to Step 4 gate (import instead) or surface to
   user.
3. **MODIFY:** re-run the 6a baseline pins (`tests-at-risk` scenarios) + RED
   tests — all green, none edited except `PIN-UPDATED`. Baseline was "unpinned"
   → note behavior unpinned, proceed.
4. **GATE — `review_changes` before EVERY commit** (codegraph on): ONE
   `review_changes(changes: {}, sections: ["naming", "incompleteChange", "cohesion", "architecture", "norms"])`
   (`{}` = the uncommitted edit about to be committed; every commit passes the
   gate → branch covered by construction), then the fix-at-write loop below.
   Gate fails → no commit, no "done". Edits left uncommitted at hand-back → run
   it once more.
   - **naming** — GENERATE writes names Step 5 never judged (helpers, locals,
     constants, types); the section judges every name the added lines declare vs
     HEAD: `MISFIT` → rename to `suggestion` before commit; `COLLISION` →
     rename; `NEW_TERM` → soft: `alternatives` word only if same meaning, else
     keep + one-line why (never default-rename); `genericName` → rename; `novel`
     = no action. Skip naming when every added declaration was a Step 5 draft.
     Tests not judged (`notJudged`). Never hand-list written names into
     `names[]`.
   - **incompleteChange** = co-change partners the change ignores
     (`support`/`confidence` attached) — a forgotten sibling edit is caught
     here, not in review. Partner verdict rule below.
   - **cohesion** (`splitCandidates`) + **architecture** families → triage
     below.
   - **norms** = dependency-norm verdict per added file edge
     (`addedEdgeVerdicts`) → triage below.
   - **Pass** = ALL: (i) every architecture finding with `preExisting` not true
     and every `change.nonLocal` entry (= `change.introducedCount`) repaired per
     `repair/<family>.md`, or accepted false positive with QUOTED evidence
     (detector flag / cited rule) + filed detector bead; (ii) verdict not
     PARTIAL — any detector row `built: false` or `truncated` (envelope or
     detector row) = PARTIAL ≠ pass → re-run with `files: [...]` batches until
     every finding is listed; (iii) triage table must-fix rows repaired.
   - `preExisting: true` = not yours: cheap repair optional (triage table),
     never blocks gate.
   - **Gate line** — final report quotes the last run verbatim:
     `GATE review_changes: introduced=<n>, partial=<true|false>` (`n` =
     introduced left unrepaired and not accepted) + one `FALSE-POSITIVE …` line
     per accepted entry. Pass = `introduced=0, partial=false`. Codegraph off →
     `GATE review_changes: architecture not judged (codegraph off)`. **No gate
     line = task not done.**

#### Fix-at-write loop

**Confirm first** — before a triage class, per finding. **Default presumption:
REAL.** Read its evidence fields (edge `source`/`target`, symbolId, metric +
tolerance, flags) and check:

1. The edge / symbol it names exists in the diff — or in the tree for a
   `nonLocal` entry (`find_symbol` / the diff hunk, reused if in context).
2. The metric is computed from that edge (the edge appears in the finding's
   evidence; removing it would move the metric).

Both hold → REAL → triage below. A finding that LOOKS wrong but passes 1–2 is
real: fix it, do not argue it away.

**False positive** only with COUNTER-evidence, quoted in its triage line:

- the edge / symbol does NOT exist (diff hunk or `find_symbol` shows its
  absence), or
- the detector misread a role / kind (quote the finding's role/kind vs the
  symbol's actual declaration read this session), or
- a known-noise class from the family's repair file (`## Known false positives`)
  whose CONDITION is shown to hold on THIS edge — cite the condition and the
  fact that meets it. Naming the class is not evidence.

Detector flags (`compositionRoot`, `compositionTable`, `parentSurface`,
`entryPoint`, `foundationTerminal`, `preExisting` without `remedy`) are
detector-sanctioned exemptions, not false positives: valid only QUOTED from the
finding's fields, never inferred from a file's path or role ("it's the bootstrap
folder" ≠ `compositionRoot: true`).

**Every accepted false positive files a detector issue** — the detector is
wrong, that is a defect, never a silent accept. Session has an issue tracker
(project beads, tickets) → file there; else `tea-rags:report-issue`. Body:
family, finding fields verbatim, counter-evidence. Report line:
`FALSE-POSITIVE <family> <edge> — <counter-evidence> — issue <id|url>`. No issue
→ not accepted → fix or ask.

**Triage** every architecture / cohesion / incompleteChange / norms finding
confirmed REAL:

| Finding                   | Class             | Action                                                                               |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| no `preExisting`          | must-fix          | repair in this diff                                                                  |
| `preExisting` + `remedy`  | cheap-preExisting | apply `remedy` (cheap by construction)                                               |
| `change.nonLocal` entry   | must-fix          | introduced away from diff — repair like no `preExisting`                             |
| `change.touchedActive`    | must-fix priority | edit hits live cascade (`tier` active/critical): repair or ask user                  |
| `change.persisting` entry | report-only       | structural; one count line per family, no triage                                     |
| norms `MISFIT`            | must-fix          | route via `expectedPath`; skip only if `exclusionsUnchecked` condition shown to hold |
| norms `NEW_PATTERN`       | report-only       | one-line why                                                                         |
| norms `UNJUDGED`          | report-only       | read `unjudgedReasonCounts` (pre-cap count per reason)                               |

**Base** — `review_changes` base = `git merge-base HEAD main`, the branch's fork
point on main. Never an integration branch, never a sibling `worktree-agent-*`
branch: sibling code enters scope and its findings (naming, cycle edges) look
introduced. Stacked work → base STILL main's merge-base; findings from the stack
below belong to the stack owner — cite the owning commit, do not fix or triage.

`silentCoupling` = git history → always `change.persisting`. incompleteChange
and `splitCandidates` are history verdicts with no `preExisting` split — their
repair file's procedure decides. A family with `built: false` → report "not
judged", never a clean pass.

**Shared rules** (repair files refer here):

- **Cheap** = ALL of: edge edits only — retarget an existing import (internal
  file → component facade; parent facade → declaring file; declared type → an
  EXISTING contract); symbol set unchanged except ≤ 1 export line in one facade;
  no new files, interfaces or moves. Footprint ⊆ diff files + ≤ 1 facade. Re-run
  shows finding gone, no new finding, tests green and untouched. No line-count
  limit. A server `remedy` = cheap, already dry-run-verified.
- **Evidence** — a finding stays unfixed ONLY with: a detector flag QUOTED from
  the finding (`preExisting: true` with `remedy` absent, `compositionRoot`,
  `compositionTable`, `parentSurface`, `entryPoint`, `foundationTerminal`), a
  symbolId / file read THIS session, a cited project rule (file + quoted line),
  or a false positive per **Confirm first** (counter-evidence + filed issue).
  Each introduced / non-`preExisting` finding left unrepaired gets its OWN
  triage line citing one such token. Banned as reasons: "I believe", "by
  design", "budget", "out of scope", "fair nit", "not needed", group dismissal
  (one reason for N findings). Finding conceded valid → repaired, not dropped. A
  real incompleteChange gap (partner test with high `support` the diff should
  have touched) → fixed in the same round. No token → fix or ask.
- **Flap** — metric crosses the tolerance by ≤ 0.02 → ordinary introduced
  finding: fix if cheap, else report metric before/after, threshold and the diff
  edge that moved it; user decides. mainSequence detector drops |ΔD| ≤ 0.02
  itself (`excludedFlapCount`).

**Repair file:** per family with a must-fix or cheap finding, load exactly
`../../repair/<family>.md` (incompleteChange → `silentCoupling.md`, cohesion →
`splitCandidates.md`). ONLY families that have a finding — never preload the
directory.

**Round** (≤ 2):

1. Per finding: `remedy` present → apply it verbatim. `retargetImport`: in
   `sourceRelPath` point the import of `importedNames` from `fromRelPath` to
   `toRelPath`; `addExport` → add that one export line of `names` to
   `facadeRelPath`. `restoreExport`: re-export `names` from `facadeRelPath`.
   Else the repair file's `## No remedy` procedure. Else accept by evidence.
2. Re-run the same `review_changes` + targeted tests.
3. Round added a finding or reddened a test → revert the WHOLE round.
4. Must-fix left after round 2 → STOP, escalate: AskUserQuestion (subagent →
   hand back to orchestrator) with the finding, what was tried, why reverted;
   options: fix this way / accept with a reason / bead. No commit without the
   answer — never commit around an introduced finding.

**Co-change partner verdict** (incompleteChange / `silentCoupling`): inspect
each untouched partner (`find_symbol` outline/body — reuse it if already in
context). Depends on the changed contract (test, doc, registry, mirror) → edit
it in this diff. Else one line `not touched because <reason>` with a CHECKABLE
reason citing the symbol: a named test that already pins the seam, or why the
file cannot change with this edit. "Not needed" / "unrelated" without evidence =
fail → edit it or ask.

**Report:** gate line first, then per class — fixed (remedy / procedure),
accepted (evidence), false positive (counter-evidence + issue), report-only
(line + bead suggestion), families not judged / partial.

Step 7 is the extension point for post-generation structural checks — add them
here, not as a second verification step.

### Step 8: IMPACT

Edges: no `codegraph` floor while `changedFiles` > 0 → edges touching changed
files are the index's (search-cascade "Addressing the Codebase").

Assess blast radius of change you just generated.

- **Codegraph on** (prime `## Enrichment` lists `codegraph.symbols`): use the
  `blastRadius` preset (`rerank="blastRadius"`, metaOnly=true) — real `fanIn` +
  churn + bugFix, ranking reflects actual call/import edges, not raw-import
  proxy. Warn on high-`fanIn` / `isHub` dependents.
- **Codegraph off** (no `codegraph.symbols` in prime → `fanIn` signal absent):
  fall back to custom weights `{ imports: 0.5, churn: 0.3, ownership: 0.2 }`,
  metaOnly=true, note blast radius is approximate (import-proxy, not edge
  truth). See search-cascade "Graph navigation".
- **MODIFY: `get_callers` on the modified symbol MANDATORY** — changed behavior
  propagates through real call edges; import proxy insufficient.

Warn on high-impact modules. Flag shared taskIds → coordinated change.
