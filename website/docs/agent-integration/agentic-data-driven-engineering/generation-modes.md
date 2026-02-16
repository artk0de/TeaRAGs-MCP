---
title: "Generation Modes"
sidebar_position: 2
---

import AiQuery from '@site/src/components/AiQuery';

# Generation Mode Switching

The five strategies tell the agent *what to use as input*. Generation modes tell it *how to write the output*. The agent should dynamically switch its generation mode based on the churn context of the target area.

## Standard Mode

**When:** Normal metrics — no red flags in the target area.

**Behavior:**
- Follow the dominant author's patterns (Strategy 3)
- Use the best template found (Strategy 1)
- Generate clean, idiomatic code
- Standard test coverage

## Conservative Mode

**When:** `chunkAgeDays > 180` + `chunkCommitCount <= 2` — old, untouched code.

**Behavior:**
- Minimal changes — don't refactor, don't optimize
- Preserve signatures and return types exactly
- Don't move code between files
- Add new functionality alongside, not instead of, existing code
- Err on the side of duplication over abstraction

**Why:** Code that hasn't been touched in 6+ months may have undocumented assumptions. Callers depend on its exact behavior, including edge cases. Minimal change = minimal risk.

## Stabilization Mode

**When:** `chunkCommitCount > 8` + `churnVolatility > 15` — high-churn, volatile code.

**Behavior:**
- Simplify branching — reduce cyclomatic complexity
- Extract nested conditionals into named methods
- Reduce the number of code paths through the function
- Add explicit logging at decision points
- Design for testability — pure functions where possible
- Consider splitting large functions (if `chunkChurnRatio > 0.6`)

**Why:** High-churn volatile code usually has accumulated complexity from sequential patches. Each patch added a condition, a fallback, a special case. The function needs simplification, not more features layered on top.

## Defensive Mode

**When:** `chunkBugFixRate > 40%` + `chunkAgeDays > 60` — legacy code with history of bugs.

**Behavior:**
- Never delete old code — use a wrapper pattern
- Add feature flags for instant rollback
- Keep old code path entirely intact as a fallback
- Write comprehensive tests covering existing edge cases (from bug-fix commits)
- Plan gradual rollout: per-user, per-tenant, or percentage-based
- Document cleanup date (remove wrapper after 30 days stable in production)

**Why:** This code has proven that straightforward modifications break it. The defensive wrapper pattern provides a rollback mechanism that direct editing does not.

## Mode selection logic

```text
Assess target area metrics (via hotspots preset + metaOnly)
  │
  ├─ chunkBugFixRate > 40% AND chunkAgeDays > 60
  │   → DEFENSIVE MODE
  │
  ├─ chunkCommitCount > 8 AND churnVolatility > 15
  │   → STABILIZATION MODE
  │
  ├─ chunkAgeDays > 180 AND chunkCommitCount <= 2
  │   → CONSERVATIVE MODE
  │
  └─ otherwise
      → STANDARD MODE
```

## The Complete Generation Flow

The flow integrates all five strategies, danger zone verification, and exact-match validation into a single workflow. Not all steps are required for every task — an incident hotfix may skip to step 6, a greenfield feature may skip step 2.

```text
1. DISCOVER     — Find target area (search_code, rerank=relevance)
2. DANGER CHECK — Assess target risk (semantic_search, rerank=hotspots, metaOnly)
                  ↳ Select generation mode (standard / conservative / stabilization / defensive)
3. TEMPLATE     — Find quality templates (search_code, rerank=stable)
4. ANTI-CHECK   — Identify anti-patterns to avoid (semantic_search, rerank=hotspots)
5. STYLE        — Match domain owner (semantic_search, rerank=ownership, metaOnly)
6. GENERATE     — Write code in the selected mode
7. VERIFY EXACT — Validate with ripgrep (grep, tree-sitter)
                  ↳ Confirm referenced functions, imports, and types actually exist
8. IMPACT       — Check blast radius (semantic_search, rerank=impactAnalysis)
```

### Danger Zone Check (Step 2)

Before generating code, the agent runs a quick risk assessment on the target area. This turns codebase analysis into a **safety gate** — not just a reporting tool but a verification step before every code change.

Without this check, the agent will:
- Copy patterns from the first search hit — which might be a 60% bug-fix-rate function
- Modify a knowledge silo without notifying the owner
- Touch a high-blast-radius module without assessing downstream impact
- Introduce changes into an area with pathological churn, adding to the problem

<AiQuery>Show me git churn signals for the payment processing module using the hotspots preset</AiQuery>

<details>
<summary>Tool parameters</summary>

```json
{
  "query": "payment processing",
  "rerank": "hotspots",
  "pathPattern": "**/payment/**",
  "metaOnly": true,
  "limit": 10
}
```

</details>

**Decision logic based on results:**

| Signal | Threshold | Agent action |
|--------|-----------|-------------|
| `chunkBugFixRate > 50%` | High bug density | Warn: "This function has a 55% bug-fix rate. Consider redesigning instead of patching." |
| `dominantAuthorPct > 90%` | Knowledge silo | Warn: "This area is owned by @alice (92%). Request review before merging." |
| `chunkChurnRatio > 0.7` | Concentrated churn | Warn: "This function absorbs 70%+ of the file's churn. Consider splitting it." |
| `relativeChurn > 5.0` | Rewritten multiple times | Warn: "This code has been substantially rewritten. Deeper architectural review needed." |
| `imports count > 10` | High blast radius | Warn: "This module has 12 downstream importers. Changes here affect the entire system." |

The danger check determines the **generation mode** ([Standard](#standard-mode), [Conservative](#conservative-mode), [Stabilization](#stabilization-mode), or [Defensive](#defensive-mode) above). If multiple red flags fire, escalate to the user before proceeding.

### Exact-Match Verification (Step 7) {#exact-match-verification}

:::warning[Critical: Semantic search requires verification]
Semantic search is a **candidate zone generator**, not proof. After finding templates and generating code, the agent must verify that referenced identifiers actually exist. Without this step, generated code compiles against hallucinated function names.
:::

This principle comes from a fundamental property of semantic search: embeddings capture *meaning*, not *literals*. A search for "authentication logic" returns code about login, sessions, and tokens — but doesn't guarantee presence of exact strings like `authenticateUser()`, `loginUser()`, or `verifySession()`. See [Semantic Search — Criticism and Responses](/knowledge-base/semantic-search-criticism) for the research context.

**The verification workflow:**

After generating code (step 6), before considering the task done:

1. **Verify function references** — ripgrep for every function name used in generated code
2. **Verify imports** — ripgrep for the actual module paths and export names
3. **Verify type names** — ripgrep for interfaces, types, and class names referenced
4. **Verify patterns** — tree-sitter to confirm the structural patterns (method signatures, class hierarchies) match what was found in the template

**Example failure without verification:**

```text
Semantic search: "authentication logic"
  → Returns src/auth/middleware.ts (high similarity)
  → Agent generates: import { authenticateUser } from './auth/middleware'

Reality: The file contains authentication concepts but the actual export
is named validateCredentials(), not authenticateUser().

Result: Compilation error from non-existent import.
```

**Correct workflow:**

```text
1. Semantic search: "authentication logic"
   → Returns src/auth/middleware.ts (high similarity, stable template)

2. Agent generates code referencing authenticateUser()

3. Ripgrep verification:
   ripgrep search: "authenticateUser" path=src/ → 0 matches
   ripgrep search: "export.*function.*auth" path=src/auth/ → validateCredentials

4. Agent corrects: import { validateCredentials } from './auth/middleware'
```

**Rule of thumb:** use semantic search to *find where to look*, then use ripgrep to *confirm what's actually there*, then generate code using **verified identifiers only**.

**Integration into agent configuration:**

The verification step should be explicit in the agent's instructions. See the [activation blocks](activating) — all include a mandatory verification step after code generation.

## Template Quality Score

When evaluating search results as potential templates, use this scoring framework:

| Signal | Weight | Score range | Scoring |
|--------|--------|------------|---------|
| `chunkBugFixRate` | High | 0-100 | < 15% = excellent, 15-30% = acceptable, > 40% = reject |
| `chunkAgeDays` | Medium | 0-∞ | > 90 = excellent, 30-90 = acceptable, < 14 = unproven |
| `chunkCommitCount` | Medium | 0-∞ | 1-3 = excellent, 4-7 = acceptable, > 8 = unstable |
| `dominantAuthorPct` | Low | 0-100 | > 70% = consistent style, < 40% = mixed styles |
| `churnVolatility` | Low | 0-∞ | < 5 = stable, 5-15 = normal, > 20 = erratic |
| `contributorCount` | Low | 0-∞ | 2-3 = well-reviewed, 1 = silo risk, > 5 = too many cooks |

**Quick decision:**

| Score | Action |
|-------|--------|
| All green (low bugs, old, few commits, clear owner) | Use as primary template |
| Mostly green, one yellow | Use with awareness |
| Any red flag (chunkBugFixRate > 40% or relativeChurn > 5.0) | Find a better alternative |
| Multiple red flags | Mark as anti-pattern — study what went wrong, don't copy |
