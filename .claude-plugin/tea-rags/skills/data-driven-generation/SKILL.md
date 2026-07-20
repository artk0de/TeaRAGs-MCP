---
name: data-driven-generation
description:
  Decide HOW to write new code by inspecting git signals on neighbors — pulls
  strategy and templates from proven, low-churn nearby implementations rather
  than guessing from training data. Triggers on "implement function X", "add
  method to class Y", "write a helper for Z", "напиши функцию", "добавь метод".
  NOT for discovery or exploration — use tea-rags:explore for that. This skill
  activates ONCE the agent is about to write code.
---

# Data-Driven Generation

Select codegen strategy from git signal labels. Uses overlay labels from TeaRAGs
results — not hardcoded thresholds — strategies adapt per codebase
automatically.

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

## Workflow

### Step 1: STRATEGY SELECTION

Use overlay labels from research output. Apply **hard rules** first:

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

### Step 2: TEMPLATE

Delegate to `tea-rags:extract-project-patterns` with:

- `positiveIds` | `positiveCode` = best verified result from Step 1 cascade (or
  set `behaviorQuery` if no chunk/code available)
- `pathPatternL1` = pathPattern from explore PG-OUTPUT
- `limit` = 10

Read `templates[0]` as reference for Step 4 (GENERATE). Recipe owns the locality
cascade (L1 = subdomain, L2 = first semantic segment with infra prefixes
skipped, L3 = project) and the quality gate (commitCount low/typical + ageDays
old/legacy + bugFixRate healthy; lone ideal on hub file also accepts; reject if
bugFixRate critical or ageDays recent + commitCount low).

Read `locality` to inform Step 3 (STYLE):

- `L1` → use template's `blameDominantAuthor` for style + review routing.
- `L2` → `blameDominantAuthor` reviews technique, not exact code.
- `L3` → `blameDominantAuthor` reviews technique only; verify architectural fit
  before adopting verbatim.
- `none` → no template; generate from scratch, surface to user so they
  scrutinize result.

### Step 3: STYLE

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

### Step 4: GENERATE

Apply selected strategy + style. Generate code.

### Step 5: VERIFY GENERATED

Verify ALL referenced identifiers:

1. find_symbol(metaOnly=true) for every function name, type name. ripgrep for
   import paths (find_symbol doesn't cover imports).
2. 0 results = hallucinated identifier → fix before committing.

### Step 6: IMPACT

Assess blast radius of change you just generated.

- **Codegraph on** (prime `## Enrichment` lists `codegraph.symbols`): use the
  `blastRadius` preset (`rerank="blastRadius"`, metaOnly=true) — real `fanIn` +
  churn + bugFix, ranking reflects actual call/import edges, not raw-import
  proxy. Warn on high-`fanIn` / `isHub` dependents.
- **Codegraph off** (no `codegraph.symbols` in prime → `fanIn` signal absent):
  fall back to custom weights `{ imports: 0.5, churn: 0.3, ownership: 0.2 }`,
  metaOnly=true, note blast radius is approximate (import-proxy, not edge
  truth). See search-cascade "Graph navigation".

Warn on high-impact modules. Flag shared taskIds → coordinated change.

---

## Skipping Steps

- **Hotfix** → user provides exact location, skip to Step 4. Step 5 MANDATORY.
- **Greenfield** → skip Steps 2, 3
- **Step 5 is NEVER skipped**
