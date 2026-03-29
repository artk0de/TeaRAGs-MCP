---
name: data-driven-generation
description:
  Use when generating or modifying code — selects generation strategy based on
  git signal labels from TeaRAGs
---

# Data-Driven Generation

Selects code generation strategy based on git signal labels. Uses overlay labels
from TeaRAGs search results — not hardcoded thresholds — so strategies adapt to
each codebase automatically.

## Prerequisites

**Area context required:** files, pathPattern, and overlay labels from
risk-assessment must be present in conversation. If missing, invoke
`/tea-rags:explore` for the target area — explore will detect pre-generation
intent and gather the context automatically. If explore output already exists
from this conversation, use it.

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

Follow search-cascade: pass best verified result as code/chunk example (cascade
→ find_similar) + custom "proven" rerank:
`{ similarity: 0.2, stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05 }`.
This finds battle-tested code: long-lived, low-churn, low-bug, multi-author.
Fallback: follow search-cascade with behavior query + same custom weights.

Quality gate by labels:

- **Ideal:** commitCount "low"/"typical" + ageDays "old"/"legacy" + bugFixRate
  "healthy"
- **Reject:** bugFixRate "critical" OR (ageDays "recent" + commitCount "low")

### Step 3: STYLE

Use dominantAuthor from explore pre-gen output.

| file.dominantAuthorPct | Behavior                                        |
| ---------------------- | ----------------------------------------------- |
| "silo"                 | Match exactly. Flag owner for review.           |
| "concentrated"         | Follow dominant patterns, minor flexibility.    |
| "mixed"                | Follow dominant with awareness of alternatives. |
| "shared"               | Project conventions. Opportunity to unify.      |

### Step 4: GENERATE

Apply selected strategy + style. Generate code.

### Step 5: VERIFY GENERATED

Verify ALL referenced identifiers:

1. find_symbol(metaOnly=true) for every function name, type name. ripgrep for
   import paths (find_symbol doesn't cover imports).
2. 0 results = hallucinated identifier → fix before committing.

### Step 6: IMPACT

Follow search-cascade with impact analysis query + custom weights
`{ imports: 0.5, churn: 0.3, ownership: 0.2 }`, metaOnly=true.

Warn on high-import modules. Flag shared taskIds → coordinated change.

---

## Skipping Steps

- **Hotfix** → user provides exact location, skip to Step 4. Step 5 MANDATORY.
- **Greenfield** → skip Steps 2, 3
- **Step 5 is NEVER skipped**
