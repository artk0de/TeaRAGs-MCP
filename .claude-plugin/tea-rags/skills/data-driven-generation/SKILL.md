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

**Area context required:** files, pathPattern, per-symbol overlay labels must be
in conversation. Labels come from `find_symbol(rerank=<preset>, metaOnly=false)`
on target symbols — explore PRE-GEN step PG-2 (SIGNAL LOOKUP). No full
risk-assessment scan needed. If missing, invoke `/tea-rags:explore` for target
area — explore detects pre-generation intent, gathers context automatically. If
explore output already exists this conversation, use it.

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

`find_symbol(metaOnly=true)` on named target. Zero guessing:

| Probe result                                     | Mode   |
| ------------------------------------------------ | ------ |
| Target symbol exists in index                    | MODIFY |
| Container exists, symbol new ("add method to Y") | EXTEND |
| Neither exists                                   | CREATE |

Probe ambiguous → ask user which mode. One question, genuine ambiguity only.

**Step matrix** — mode selects steps + signal sources:

| Step        | CREATE                      | EXTEND                         | MODIFY                     |
| ----------- | --------------------------- | ------------------------------ | -------------------------- |
| 1 STRATEGY  | area labels                 | container labels               | symbol's own labels        |
| 2 TEMPLATE  | run                         | run                            | skip                       |
| 3 PLACEMENT | run                         | fixed = container; guard fires | skip                       |
| 4 REUSE     | run                         | run                            | run — for introduced logic |
| 5 STYLE     | blame-owner + lexicon       | container file + lexicon       | symbol itself + lexicon    |
| 6 GENERATE  | strategy + style + manifest | same                           | minimal diff per strategy  |
| 7 VERIFY    | symbol risks + N-th-way     | same                           | + tests-at-risk            |
| 8 IMPACT    | blastRadius of new code     | container fanIn                | `get_callers` — MANDATORY  |

- **Hotfix** (user gives exact location) = MODIFY, additionally skip STRATEGY
  and the blame part of STYLE. REUSE still applies to introduced logic; the
  lexicon still runs when the fix introduces a name.
- **Greenfield** = CREATE over empty area — TEMPLATE/STYLE searches degrade to
  empty naturally, don't pre-skip.
- **REUSE never skipped in any mode** — shared infra exists even when feature is
  new.
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
same as implementation.

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
- `concept` = a DESCRIPTION of what the new symbol denotes ("pulls signed
  envelopes from the e-signature vendor into tax documents") — never the draft
  name: a draft pulls in its own lexical neighbours.
- `names[]` = drafts with `kind` (`local`/`param`/`field`/`return`) and `type`
  when known. Type unknown but bound from a call →
  `callee: { member, receiver? }`. A new class, module, interface, enum or
  constant →
  `{ name, kind: "type", path: <its file>, extends?: <planned ancestor> }`: the
  ancestor's family and the directory set the expected role suffix.

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
- `names[]`: `CONFORMS` → keep. `MISFIT` → take `suggestion` (`holder` shows
  where the project uses it; a type MISFIT names the missing `role`). `NEW_TERM`
  → adopt a `topTerms` term or an `alternatives` word if it denotes the same
  concept; otherwise the concept is new — keep the term, justify it in Step 6.
  `COLLISION` → the short name is already a type elsewhere (`existing`); pick a
  distinct name.
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

### Step 6: GENERATE

Apply strategy + style + reuse manifest — call manifest helpers, NEVER
reimplement them. MODIFY: minimal diff per strategy.

Names come from the Step 5 vocabulary, built by the dominant shape. A word
outside it is `NEW_TERM` and gets one line in the output:
`NEW_TERM <term> — <why no project term denotes this>`.

Tests alongside (CREATE/EXTEND): invoke `tea-rags:tests-as-context` recipe
`fixture-lookup` (intent = setup you need) — existing setup patterns, not
invented mocks. SKIP verdict → proceed without.

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
3. **MODIFY:** `tea-rags:tests-as-context` recipe `tests-at-risk` (affectedFiles
   = [target file], intent = change description) → run the pinning scenarios.
   SKIP verdict → note behavior unpinned, proceed.
4. **Naming review before commit** (codegraph on): GENERATE writes names Step 5
   never judged (helpers, locals, constants, types). ONE
   `get_naming_lexicon(changes: {})` — every name added lines declare vs HEAD.
   Skip when every added declaration was a Step 5 draft. `review.findings` (flat
   `{relPath, line, name, kind, type?, verdict, …}`) grouped by verdict:
   `MISFIT` → rename to `suggestion` before commit; `COLLISION` → rename;
   `NEW_TERM` → take an `alternatives` word for same concept, else keep +
   justify (soft); `genericName` → generic name, rename. `review.novel` = no
   precedent to compare, no action. Tests not judged (`notJudged`). Never
   hand-list written names into `names[]`.

Step 7 is the extension point for post-generation structural checks — add them
here, not as a second verification step.

### Step 8: IMPACT

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
