# Data-Driven Generation v2 — Mode Matrix + Reuse Gate

**Date:** 2026-08-08 **Status:** approved (brainstorm 2026-08-08) **Target:**
`.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`

## Problem

The current skill has three gaps.

**No reuse instinct.** The skill teaches "how code is written here" (TEMPLATE)
but never "what already exists here to call". An agent asked to add retry
handling reproduces the industry-median retry loop even when the project has a
shared `withRetry()` helper used in three places. Worse, Step 2 actively
encourages this: a template is copied together with its inlined logic instead of
calling the helper the template itself imports. Each such duplicate passes
compile, tests, and review — the reviewer sees one diff, not the trend. The
N-th-way accumulation is the only generation failure with no downstream safety
net, and its cost scales with the fraction of code agents write.

**No mode awareness.** Modifying existing code and generating new code are
different regimes with different sources of truth. When modifying, style is
dictated by the symbol being edited (not a blame-owner abstraction), behavior is
pinned by existing tests, and the contract is held by callers. When creating,
placement, template, and style-by-blame all apply. The skill conflates the two:
it triggers on both "implement function X" and "add method to class Y" but runs
one creation-shaped cascade. The existing "Skipping Steps" section
(Hotfix/Greenfield) is an ad-hoc proto-version of modes.

**Open verification loop.** Any preventive helper search depends on the agent
enumerating capabilities correctly. If the enumeration misses a block, the
duplicate is generated anyway and nothing detects it.

## Goals

- The agent calls existing shared infrastructure instead of reinventing it, with
  a mechanical import-or-copy decision — zero DDD vocabulary.
- The skill classifies the task mode (CREATE / EXTEND / MODIFY) mechanically and
  runs only the steps that apply, with mode-correct sources of truth.
- A post-generation detector closes the loop on duplicates the preventive gate
  missed.

## Non-goals

- No DDD/bounded-context reasoning in the skill text. The boundary decision is
  derived from observed signals (import graph, locality), not theory.
- No changes to `extract-project-patterns` (its "Step 2 (TEMPLATE)" reference
  stays valid; the rejected `sharedHelpers[]` extension can be a follow-up if
  dinopowers plan wrappers need it).
- No new MCP tools or signals — everything uses existing tools (`find_symbol`,
  `hybrid_search`, `find_similar`, `semantic_search`, `get_callers`) and
  existing labels (`fanIn`, `imports`, `memberCount`, `moduleMethodCount`).
- No unification/refactoring of already-duplicated code — the skill prevents new
  divergence, it does not repair old.

## Design

### Step 0: MODE — mechanical classification

`find_symbol(metaOnly: true)` on the named target. Zero guessing:

| Probe result                                        | Mode   |
| --------------------------------------------------- | ------ |
| Target symbol exists in index                       | MODIFY |
| Container exists, symbol is new ("add method to Y") | EXTEND |
| Neither exists                                      | CREATE |

Step matrix — the core of the redesign. Steps renumber to: 1 STRATEGY, 2
TEMPLATE, 3 PLACEMENT, 4 REUSE, 5 STYLE, 6 GENERATE, 7 VERIFY, 8 IMPACT.

| Step        | CREATE                                 | EXTEND                         | MODIFY                        |
| ----------- | -------------------------------------- | ------------------------------ | ----------------------------- |
| 1 STRATEGY  | area labels                            | container labels               | symbol's own labels           |
| 2 TEMPLATE  | run                                    | run                            | skip                          |
| 3 PLACEMENT | run                                    | fixed = container; guard fires | skip                          |
| 4 REUSE     | run                                    | run                            | run — for introduced logic    |
| 5 STYLE     | blame-owner (existing table)           | container file itself          | symbol itself; blame = review |
| 6 GENERATE  | strategy + style + manifest            | same                           | minimal diff per strategy     |
| 7 VERIFY    | identifiers + declaration + self-check | same                           | + tests-at-risk               |
| 8 IMPACT    | blastRadius of new code                | container fanIn                | `get_callers` — MANDATORY     |

The "Skipping Steps" section is absorbed: Hotfix = MODIFY with user-supplied
location (additionally skip STRATEGY and STYLE; REUSE still applies to any logic
the fix introduces; VERIFY stays mandatory). Greenfield = CREATE over an empty
area (TEMPLATE/STYLE degrade to empty naturally). REUSE is never skipped in any
mode — shared infra exists even when the feature is new.

### Step 4: REUSE (new; the core mechanism)

1. Enumerate general-purpose blocks in the about-to-be-written code (retry,
   validation, caching, parsing, error wrapping, logging, serialization…). Cap:
   ≤5 searches, all `metaOnly: true`.
2. For each block: `hybrid_search` / `find_symbol` for an existing helper.
3. **Gate — import the helper IF** it lives in L1/L2 of the target (locality
   levels as defined by `extract-project-patterns`) **OR** its file `fanIn`
   label is `popular`/`hub` (the project already imports it from many places —
   reuse is sanctioned by practice). **ELSE** follow its approach, do NOT import
   — no new cross-boundary coupling. The boundary is derived from the actual
   import graph, not from theory.
   - Codegraph off (no `codegraph.symbols` in prime `## Enrichment`): fall back
     to the `imports` structural signal plus locality-only (L1/L2 → reuse; L3 →
     copy approach), and note the gate ran on the import-proxy.
4. The template's own imports are pre-approved vocabulary — they pass the gate
   automatically (proven in context by the template's history).
5. **Extend-vs-new branch:** helper passes the gate but lacks a parameter/branch
   → prefer a minimal-diff extension of the existing helper over writing a
   sibling. Extending a shared helper (`popular`/`hub`) ALWAYS requires explicit
   user confirmation before editing — hub file, high cost of error. Blast radius
   of the extension is assessed by the existing IMPACT step; no new mechanics.

Output: a reuse manifest (helpers to call) consumed by GENERATE.

### Step 3: PLACEMENT (new) + god-module guard

Home for new code, in priority order: target file named by the user → the
template's path as a prior ("this kind of thing lives in X") → `semantic_search`
for the module with matching responsibility inside L1.

Guard: if the insertion candidate's `memberCount` / `moduleMethodCount` label is
god-module (thresholds already live in the prime digest) — do NOT grow it;
propose a sibling module or extraction and surface the choice to the user. In
EXTEND mode the guard fires on the container.

Placement convergence is the structural half of the N-th-way problem: a new file
created where a home module exists fragments the codebase the same way a
duplicated helper does.

### tests-as-context wiring (two recipes, two points)

- **GENERATE** (CREATE/EXTEND): recipe `fixture-lookup` — existing setup
  patterns instead of invented mocks; test idiom comes from the area's own
  tests, not the training median.
- **VERIFY** (MODIFY): recipe `tests-at-risk` — the scenarios that pin the
  modified symbol's behavior, visible before commit.

Both go through the recipe's own Step 0 preflight; on SKIP (no DSL test chunks)
the skill degrades silently to current behavior.

### find_similar self-check in VERIFY (the detective half)

`find_similar` with `positiveCode` = the just-generated code, excluding the
template chunk and the target file from hits. A top hit with near-duplicate
similarity in another module means "you just wrote the N-th way" → return to the
REUSE gate (import instead of duplicate) or surface to the user. One call;
closes the prevent→detect loop. No hardcoded score threshold in the skill text —
"near-duplicate" is qualitative, consistent with the skill's
no-hardcoded-thresholds stance.

### Frontmatter + intro

- `description`: add modification triggers ("modify function X", "change
  behavior of Y", "поправь метод") and the reuse core ("reuses existing shared
  helpers — never reinvents what the project already solved"). caveman `full`;
  all existing NOT-clauses preserved.
- Body intro thesis (caveman `ultra`): "Don't invent — find how it's solved
  HERE, repeat."

## Degradation paths

| Condition                            | Behavior                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Codegraph off                        | REUSE gate on `imports` proxy + locality; IMPACT already has its own fallback |
| No git enrichment                    | TEMPLATE already skips (recipe skip clause); REUSE gate → locality-only       |
| No DSL test chunks                   | tests-as-context recipes return SKIP; steps proceed without test enrichment   |
| Helper searches return empty         | No manifest entry; generate the block, self-check still runs                  |
| find_symbol probe ambiguous (Step 0) | Ask the user which mode — one question, only on genuine ambiguity             |

## Cost budget

Up to ~7 extra MCP calls per generation (1 mode probe + ≤5 reuse searches + 1
find_similar), all `metaOnly` except `find_similar` and `fixture-lookup`. MODIFY
mode is cheaper — no TEMPLATE/PLACEMENT.

## Validation

- `markdownlint` on the edited SKILL.md.
- `/optimize-skill data-driven-generation` eval cycle — the prose analog of TDD.
  Eval scenarios to cover: mode misclassification (MODIFY task routed through
  CREATE cascade), reuse gate decisions (import vs copy-approach on L3 + low
  fanIn), extend-vs-new escalation, self-check firing on a planted
  near-duplicate.

## Affected files

| File                                                             | Change                             |
| ---------------------------------------------------------------- | ---------------------------------- |
| `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md` | rewrite: MODE matrix + steps 0/3/4 |
| `.claude-plugin/tea-rags/.claude-plugin/plugin.json`             | patch bump                         |

`extract-project-patterns/SKILL.md` and `tests-as-context/SKILL.md` are consumed
as-is — no edits.

## Rejected alternatives

- **Separate skill for MODIFY** — the modes share ~80% of the mechanics (REUSE,
  VERIFY, IMPACT); a second trigger surface risks misrouting.
- **`sharedHelpers[]` in extract-project-patterns** — the recipe knows the
  task-level query, not the capability composition of the future code;
  capability enumeration belongs at generate time. Possible follow-up for
  dinopowers plan wrappers.
- **Discovery-only without a gate** — pushes the import-or-copy decision back to
  ad-hoc judgment, which is exactly the DDD reasoning the skill must not carry.
- **Negative examples (bugHunt anti-templates), deadCandidates check, taskId
  cross-linking, docs grounding** — value/cost below the bar for this iteration;
  DEFENSIVE strategy and the explore skill already cover parts.
