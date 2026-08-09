# Data-Driven Generation v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. In this repo the executing wrapper is
> `dinopowers:executing-plans`.

**Goal:** Rewrite the `data-driven-generation` skill per the approved spec —
mode matrix (CREATE/EXTEND/MODIFY), REUSE gate, PLACEMENT guard,
tests-as-context wiring, find_similar self-check — and fix every cross-reference
the step renumbering breaks.

**Architecture:** Single prose artifact rewrite plus mechanical reference fixes.
The skill body ships caveman `ultra`, the frontmatter description caveman
`full`. Cross-references to DDG steps switch from numbers to step names so the
next renumbering costs nothing.

**Tech Stack:** Markdown skill files, markdownlint MCP, plugin.json versioning.

**Spec:** `docs/superpowers/specs/2026-08-08-ddg-mode-reuse-design.md`

## Global Constraints

- Skill body prose: caveman `ultra`; frontmatter description: caveman `full`
  (`.claude/rules/caveman-compression.md`). Tables, code fences, tool names,
  output formats stay byte-exact.
- All plugin docs English-only.
- Every commit touching `.claude-plugin/` bumps the affected plugin's
  `plugin.json` (`.claude/rules/plugin-versioning.md`): tea-rags 0.31.3 →
  **0.32.0** (feature-class skill upgrade — precedent: explore ORIENT phase
  shipped as 0.32.0-style minor), dinopowers 0.19.1 → **0.19.2** (mechanical
  reference fixes).
- markdownlint clean on every edited file before commit.
- No edits to `extract-project-patterns/SKILL.md` or `tests-as-context/SKILL.md`
  (consumed as-is; their "Step 2 (TEMPLATE)" references stay valid).
- Impact enrichment unavailable: `.claude-plugin/**` is excluded from the
  tea-rags index (measured this session) — no signal table for these files.
- TDD note: prose artifact — validation is lint + spec-coverage check + the four
  eval scenarios in Task 3, not failing unit tests.

---

### Task 1: Rewrite data-driven-generation SKILL.md + strategy name-refs + tea-rags bump

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md` (full
  replacement below)
- Modify:
  `.claude-plugin/tea-rags/skills/data-driven-generation/strategies/standard.md:7-8`
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (version)

**Interfaces:**

- Consumes: spec sections "Step 0: MODE", "Step 4: REUSE", "Step 3: PLACEMENT",
  "tests-as-context wiring", "find_similar self-check".
- Produces: step names
  `MODE, STRATEGY, TEMPLATE, PLACEMENT, REUSE, STYLE, GENERATE, VERIFY, IMPACT`
  — Task 2 rewrites dinopowers references against exactly these names.

- [ ] **Step 1: Replace SKILL.md content entirely**

Write this exact content to
`.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`:

```markdown
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

**Area context required:** files, pathPattern, overlay labels from
risk-assessment must be in conversation. If missing, invoke `/tea-rags:explore`
for target area — explore detects pre-generation intent, gathers context
automatically. If explore output already exists this conversation, use it.

## Reading Overlay Labels

Labels live in `rankingOverlay.file.<signal>` and
`rankingOverlay.chunk.<signal>`. Each labeled value:
`{ value: N, label: "high" }`.

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

| Step        | CREATE                                 | EXTEND                         | MODIFY                        |
| ----------- | -------------------------------------- | ------------------------------ | ----------------------------- |
| 1 STRATEGY  | area labels                            | container labels               | symbol's own labels           |
| 2 TEMPLATE  | run                                    | run                            | skip                          |
| 3 PLACEMENT | run                                    | fixed = container; guard fires | skip                          |
| 4 REUSE     | run                                    | run                            | run — for introduced logic    |
| 5 STYLE     | blame-owner                            | container file itself          | symbol itself; blame = review |
| 6 GENERATE  | strategy + style + manifest            | same                           | minimal diff per strategy     |
| 7 VERIFY    | identifiers + declaration + self-check | same                           | + tests-at-risk               |
| 8 IMPACT    | blastRadius of new code                | container fanIn                | `get_callers` — MANDATORY     |

- **Hotfix** (user gives exact location) = MODIFY, additionally skip STRATEGY
  and STYLE. REUSE still applies to introduced logic.
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

### Step 6: GENERATE

Apply strategy + style + reuse manifest — call manifest helpers, NEVER
reimplement them. MODIFY: minimal diff per strategy.

Tests alongside (CREATE/EXTEND): invoke `tea-rags:tests-as-context` recipe
`fixture-lookup` (intent = setup you need) — existing setup patterns, not
invented mocks. SKIP verdict → proceed without.

### Step 7: VERIFY

Verify ALL referenced identifiers:

1. find_symbol(metaOnly=true) for every function name, type name. ripgrep for
   import paths (find_symbol doesn't cover imports).
2. 0 results = hallucinated identifier → fix before committing.
3. Generated class declaration modeled on template (superclass / include / mixin
   / implements): chunk headers DON'T carry declarations — Read template file
   head (`templates[0].path`, declaration lines only, limit ~30) + verify
   generated declaration against real one. Wrong base class / missing include →
   fix before committing. Sanctioned Read: declaration lives OUTSIDE chunk.
4. **N-th-way self-check:** `find_similar` with `positiveCode` = generated code;
   ignore hits on template + target file. Near-duplicate hit in another module =
   you wrote the N-th way → back to Step 4 gate (import instead) or surface to
   user.
5. **MODIFY:** `tea-rags:tests-as-context` recipe `tests-at-risk` (affectedFiles
   = [target file], intent = change description) → run the pinning scenarios.
   SKIP verdict → note behavior unpinned, proceed.

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
```

- [ ] **Step 2: Fix stale step numbers in strategies/standard.md**

In
`.claude-plugin/tea-rags/skills/data-driven-generation/strategies/standard.md`
replace:

```text
- Find stable template (Step 3) and follow its patterns
- Match domain owner's style (Step 5)
```

with:

```text
- Find stable template (TEMPLATE step) and follow its patterns
- Match domain owner's style (STYLE step)
```

(Other three strategy files carry no step references — verified by grep.)

- [ ] **Step 3: Lint both edited files**

Run `mcp__markdownlint__lint_markdown` on SKILL.md and standard.md. Fix any
issue (wide tables → trim cell text, keep column meaning).

- [ ] **Step 4: Spec-coverage check**

Confirm against the spec, section by section: MODE table + matrix + hotfix /
greenfield / REUSE-never-skipped notes; PLACEMENT priority list + guard; REUSE 5
items incl. codegraph-off fallback + almost-fits user gate; template-imports
line in Step 2; fixture-lookup in Step 6; self-check + tests-at-risk in Step 7;
get_callers line in Step 8; description triggers for modification; NOT-clauses
preserved.

- [ ] **Step 5: Bump tea-rags plugin version**

In `.claude-plugin/tea-rags/.claude-plugin/plugin.json`: `"version": "0.31.3"` →
`"version": "0.32.0"`. If a merge from main has already moved the version past
0.31.3, bump minor from whatever is current.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md \
        .claude-plugin/tea-rags/skills/data-driven-generation/strategies/standard.md \
        .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "feat(dx): data-driven-generation v2 — mode matrix + reuse gate, plugin 0.32.0"
```

---

### Task 2: Name-based DDG step references in dinopowers + bump

**Files:**

- Modify: `.claude-plugin/dinopowers/README.md:42`
- Modify: `.claude-plugin/dinopowers/skills/writing-plans/SKILL.md:76,95`
- Modify:
  `.claude-plugin/dinopowers/skills/verification-before-completion/SKILL.md:112`
- Modify: `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md:153`
- Modify: `.claude-plugin/dinopowers/.claude-plugin/plugin.json` (version)

**Interfaces:**

- Consumes: step name `IMPACT` from Task 1 (old "Step 6" = IMPACT, now Step 8).
- Produces: nothing downstream; mechanical de-drift.

- [ ] **Step 1: Replace "Step 6" with "IMPACT step" in all four files**

Each occurrence references the DDG impact-analysis idiom. Replace the exact
phrase `` `tea-rags:data-driven-generation` Step 6 `` with
`` `tea-rags:data-driven-generation` IMPACT step `` in:

1. `README.md` line 42 (context: "Deviation breaks cross-wrapper")
2. `skills/writing-plans/SKILL.md` line 76 (context: "**impact analysis** idiom
   from") — the phrase wraps across lines 76-77; keep wrapping natural
3. `skills/writing-plans/SKILL.md` line 95 (context: "don't invent other
   weights")
4. `skills/verification-before-completion/SKILL.md` line 112 (context:
   "cross-skill comparability")
5. `skills/executing-plans/SKILL.md` line 153 (context: "for" + comparability
   sentence)

Names survive future renumbering; numbers don't. Do NOT touch `executing-plans`
line 64 ("Step 5 below" — its own internal step) or any "Step 2 (TEMPLATE)"
reference (still valid; TEMPLATE stays Step 2).

- [ ] **Step 2: Lint the four edited files**

`mcp__markdownlint__lint_markdown` on each; fix issues.

- [ ] **Step 3: Bump dinopowers plugin version**

`.claude-plugin/dinopowers/.claude-plugin/plugin.json`: `"version": "0.19.1"` →
`"version": "0.19.2"`.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/dinopowers/README.md \
        .claude-plugin/dinopowers/skills/writing-plans/SKILL.md \
        .claude-plugin/dinopowers/skills/verification-before-completion/SKILL.md \
        .claude-plugin/dinopowers/skills/executing-plans/SKILL.md \
        .claude-plugin/dinopowers/.claude-plugin/plugin.json
git commit -m "docs(dx): name-based DDG step refs in dinopowers, plugin 0.19.2"
```

---

### Task 3: Eval-scenario walkthrough (validation)

**Files:**

- Read: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md` (as
  rewritten by Task 1)

**Interfaces:**

- Consumes: final SKILL.md text.
- Produces: pass/fail verdict per scenario; failures loop back into Task 1
  content fixes before merge.

Walk the four spec eval scenarios against the literal skill text — for each,
read ONLY the skill and check the described behavior is unambiguously derivable
from it:

- [ ] **Scenario 1 — mode misclassification:** "change the retry backoff in
      `HttpClient.fetchWithRetry`" (symbol exists). Text must route MODIFY: no
      TEMPLATE, no PLACEMENT, style from the symbol, tests-at-risk in VERIFY,
      get_callers in IMPACT.
- [ ] **Scenario 2 — reuse gate, deny branch:** helper found at L3, fanIn label
      "typical". Text must produce copy-approach, no import — and name the
      reason (fails both gate arms).
- [ ] **Scenario 3 — extend-vs-new escalation:** helper passes gate (hub), lacks
      a parameter. Text must produce minimal-diff extension + MANDATORY user
      confirmation before editing the hub helper.
- [ ] **Scenario 4 — self-check firing:** generated code near-duplicates a chunk
      in another module. Text must send the agent back to the Step 4 gate or to
      the user — not silently keep the duplicate.

Any scenario where the text is ambiguous → fix SKILL.md wording inline, re-lint,
amend into a follow-up commit (do not rewrite Task 1's commit).

Out of scope (file as follow-up bead at teardown): full
`/optimize-skill data-driven-generation` eval loop with parallel subagents;
`evals/cases.json` fixtures for the four scenarios above.
