---
name: data-driven-generation
description: Use when generating or modifying code — selects generation strategy based on git signal labels from TeaRAGs
---

# Data-Driven Generation

Selects code generation strategy based on git signal labels. Uses overlay labels from TeaRAGs search results — not hardcoded thresholds — so strategies adapt to each codebase automatically.

## Prerequisites

1. Call `get_index_metrics` once per session to load signal thresholds and labelMap. If call fails → abort: "tea-rags MCP server required."
2. Verify search-cascade rule is loaded (TeaRAGs → tree-sitter → ripgrep).

## Reading Overlay Labels

Labels live in `rankingOverlay.file.<signal>` and `rankingOverlay.chunk.<signal>`. Each labeled value: `{ value: N, label: "high" }`.

**File-level signals:** commitCount, ageDays, bugFixRate, dominantAuthorPct, contributorCount, changeDensity, churnVolatility, relativeChurn, recencyWeightedFreq.

**Chunk-level signals:** commitCount, ageDays, bugFixRate, churnRatio, contributorCount, changeDensity, churnVolatility, relativeChurn, recencyWeightedFreq.

For label definitions: `tea-rags://schema/signal-labels`. For threshold values in your codebase: `get_index_metrics`.

---

## Workflow

### Step 1: DISCOVER + VERIFY

Find target area: `semantic_search` by task query, limit=10.
Verify per search-cascade rule (tree-sitter → ripgrep). Discard unverified candidates.

### Step 2: DANGER CHECK (two-stage)

**Stage 1 — File-level scan:**
- `semantic_search` rerank=hotspots, metaOnly=true, pathPattern=<area>
- `hybrid_search` query="TODO FIXME HACK deprecated" pathPattern=<area>
  (fallback: `semantic_search` with same query if hybrid_search unavailable — hybrid requires index with enableHybrid=true)

Read file-level overlay labels for broad risk picture.

**Stage 2 — Chunk-level drill-down:**

For files with elevated signals (file.bugFixRate "concerning"/"critical", file.commitCount "high"/"extreme"):
- `semantic_search` custom weights `{ chunkChurn: 0.3, bugFix: 0.3, chunkRelativeChurn: 0.2, similarity: 0.2 }`, pathPattern=<specific file>

Read chunk-level overlay. A file may be "concerning" overall but contain one "critical" function and several "healthy" ones — target the specific function.

**Strategy selection** — based on chunk-level labels of the target code:

| Condition | Strategy |
|-----------|----------|
| chunk.bugFixRate "critical" + file.ageDays "old"/"legacy" | DEFENSIVE |
| chunk.commitCount "extreme" + file.churnVolatility "erratic" | STABILIZATION |
| file.ageDays "legacy" + chunk.commitCount "low" | CONSERVATIVE |
| No match | STANDARD |

**Autonomous Judgment Protocol:**

When no hard rule or user-defined strategy matches:

1. **Decide** — choose closest strategy or blend based on signal axes
2. **Justify** — show the developer which labels were observed, which axes influenced the decision, what actions this means
3. **Ask if uncertain** — if signals conflict, present dilemma with options

Signal axes for judgment:
- **Risk** grows: bugFixRate healthy→concerning→critical, churnVolatility stable→erratic
- **Stability** grows: ageDays recent→legacy, commitCount low = less churn
- **Confidence** falls: commitCount "low" = few data points, ageDays "recent" = unproven

Format:
```
No exact strategy match. Based on signals:
  - bugFixRate: "concerning" (elevated but not critical)
  - commitCount: "high" (active area)
  - churnVolatility: "stable" (regular changes)

Decision: STANDARD with extra test coverage.
Rationale: bug rate elevated but churn is predictable —
active development, not pathological maintenance.
Proceeding unless you disagree.
```

Developer can override by saying "use defensive" or "proceed".

**Load strategy:** Check for project skill `strategy-<mode>` in `.claude/skills/`. If found → use project strategy. If not → read `strategies/<mode>.md` from this directory.

**Custom strategy discovery:**
1. Scan `.claude/skills/` for `strategy-*` skills (Glob)
2. Read each SKILL.md — look for `## When` section in markdown body
3. Custom strategies with `## When` conditions evaluated before hard rules
4. If custom matches → use it. If not → hard rules → base strategy.

### Step 3: TEMPLATE

`find_similar` from best verified result + rerank=stable.
Fallback: `semantic_search` custom weights `{ similarity: 0.3, stability: 0.4, age: 0.3 }`.

Quality gate by overlay labels:
- **Ideal:** commitCount "low"/"typical" + ageDays "old"/"legacy" + bugFixRate "healthy" + dominantAuthorPct "concentrated"/"silo"
- **Acceptable:** one non-ideal signal
- **Reject:** bugFixRate "critical" OR (ageDays "recent" + commitCount "low")

Verify template per search-cascade rule.

### Step 4: ANTI-CHECK

`semantic_search` rerank=hotspots, same query.

Results with file.bugFixRate "critical" or chunk.churnRatio "concentrated" = anti-patterns. Note: churnRatio is chunk-level only — read from `rankingOverlay.chunk.churnRatio.label`.

Read code, note specific problems (nested ifs, mixed responsibilities, magic numbers). Do NOT copy these patterns.

### Step 5: STYLE

1. `semantic_search` rerank=ownership, metaOnly=true, pathPattern=<area> → identify dominantAuthor
2. `semantic_search` author=<dominantAuthor>, pathPattern=<area>, limit=5 → read code, analyze error handling, naming, structure

Adapt to ownership profile:

| file.dominantAuthorPct | file.contributorCount | Behavior |
|---|---|---|
| "silo" | "solo" | Match exactly. Don't refactor. Flag owner for review. |
| "concentrated" | "solo"/"team" | Follow dominant patterns, minor flexibility. |
| "mixed" | any | Follow dominant with awareness of alternatives. |
| "shared" | "team"/"crowd" | Project conventions. Opportunity to unify patterns. |

Note: chunk-level contributorCount only has "solo" and "crowd" (no "team"). Use file-level for ownership assessment.

### Step 6: GENERATE

Apply selected strategy + style. Generate code.

### Step 7: VERIFY GENERATED

Verify ALL referenced identifiers per search-cascade rule:
1. ripgrep every function name, import path, type name
2. Fallback: Grep tool if ripgrep unavailable
3. tree-sitter: confirm structural patterns (signatures, hierarchies)
4. 0 matches = hallucinated identifier → fix before committing

### Step 8: IMPACT

`semantic_search` rerank with custom weights `{ imports: 0.5, churn: 0.3, ownership: 0.2 }`, metaOnly=true. (Use impactAnalysis preset if available.)

Warn on high-import modules. Flag shared taskIds → coordinated change requirement.

---

## Skipping Steps

- **Hotfix** → user provides exact file/location, skip to Step 6. Step 7 MANDATORY.
- **Greenfield** (no existing code) → skip Steps 2, 4, 5
- **Small known change** → skip Step 3
- **Step 7 is NEVER skipped**
