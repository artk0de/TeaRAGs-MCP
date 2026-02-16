---
title: Preset Mapping
sidebar_position: 2
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';
import AiQuery from '@site/src/components/AiQuery';

# Agent Task to Preset Mapping

## 1. Bug Investigation

**Scenario:** Agent is investigating a production error.

<AiQuery>Why is the payment API returning 500 errors?</AiQuery>
<AiQuery>Find the root cause of the login timeout issue</AiQuery>
<AiQuery>What recently changed code could cause this NullPointerException?</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[🔍 Recent Changes<br/><small>search_code · recent</small>]
    S2[🔥 Hotspots<br/><small>semantic_search · hotspots</small>]
    S3[👤 Ownership<br/><small>semantic_search · ownership</small>]
    S1 --> S2 --> S3
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find recently changed related code</summary>

```json
search_code({
  "path": "/project",
  "query": "payment processing timeout",
  "rerank": "recent",
  "maxAgeDays": 14
})
```

</details>

<details>
<summary>Step 2 — Find historically fragile code in the same area</summary>

```json
semantic_search({
  "path": "/project",
  "query": "payment processing",
  "rerank": "hotspots",
  "pathPattern": "**/payment/**",
  "limit": 10
})
```

</details>

<details>
<summary>Step 3 — Identify who to escalate to</summary>

```json
semantic_search({
  "path": "/project",
  "query": "payment processing",
  "rerank": "ownership",
  "metaOnly": true
})
```

</details>

**Agent reasoning:** Recent changes are the most likely cause (`recent`), but if that doesn't find the bug, historically fragile code (`hotspots`) is the next suspect. `ownership` with `metaOnly` identifies the domain expert without downloading content.

---

## 2. Code Review

**Scenario:** Agent is reviewing a PR or recent changes.

<AiQuery>Review the recent changes to the user service</AiQuery>
<AiQuery>What was modified in the last sprint?</AiQuery>
<AiQuery>Do any recent changes touch security-sensitive code?</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[📝 Recent Changes<br/><small>semantic_search · codeReview</small>]
    S2[🔒 Security Check<br/><small>semantic_search · securityAudit</small>]
    S3[💥 Blast Radius<br/><small>semantic_search · impactAnalysis</small>]
    S1 --> S2 --> S3
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find all recently changed code</summary>

```json
semantic_search({
  "path": "/project",
  "query": "feature implementation",
  "rerank": "codeReview",
  "filter": { "must": [{ "key": "git.ageDays", "range": { "lte": 7 } }] },
  "limit": 20
})
```

</details>

<details>
<summary>Step 2 — Check if changes touch risky areas</summary>

```json
semantic_search({
  "path": "/project",
  "query": "authentication validation security",
  "rerank": "securityAudit",
  "filter": { "must": [{ "key": "git.ageDays", "range": { "lte": 7 } }] }
})
```

</details>

<details>
<summary>Step 3 — Assess blast radius of the changed code</summary>

```json
semantic_search({
  "path": "/project",
  "query": "imports from changed module",
  "rerank": "impactAnalysis",
  "metaOnly": true,
  "limit": 20
})
```

</details>

**Agent reasoning:** `codeReview` boosts recent burst activity and change density -- showing what's actively being worked on. `securityAudit` cross-checks if any recent changes touch security-sensitive paths (auth, crypto, tokens). `impactAnalysis` reveals how many other modules depend on the changed code.

---

## 3. Refactoring Planning

**Scenario:** Agent is identifying refactoring candidates and estimating effort.

<AiQuery>What are the best refactoring candidates in our codebase?</AiQuery>
<AiQuery>Find large functions that keep breaking</AiQuery>
<AiQuery>Which modules have the highest churn and bug-fix rates?</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[🔧 Candidates<br/><small>semantic_search · refactoring</small>]
    S2[💥 Blast Radius<br/><small>semantic_search · impactAnalysis</small>]
    S3[👤 Reviewers<br/><small>semantic_search · ownership</small>]
    S1 --> S2 --> S3
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find refactoring candidates</summary>

```json
semantic_search({
  "path": "/project",
  "query": "business logic processing",
  "rerank": "refactoring",
  "metaOnly": true,
  "limit": 20
})
```

</details>

<details>
<summary>Step 2 — For each candidate, measure blast radius</summary>

```json
semantic_search({
  "path": "/project",
  "query": "imports from candidate module",
  "rerank": "impactAnalysis",
  "pathPattern": "!**/test/**",
  "metaOnly": true
})
```

</details>

<details>
<summary>Step 3 — Check who should review</summary>

```json
semantic_search({
  "path": "/project",
  "query": "candidate module area",
  "rerank": "ownership",
  "metaOnly": true
})
```

</details>

**Agent reasoning:** `refactoring` surfaces large, churny, volatile chunks with high bug-fix rates -- the best candidates for improvement. `impactAnalysis` measures how many dependents each candidate has (high imports = high blast radius = refactor carefully). `ownership` identifies reviewers and potential knowledge silos.

**Decision matrix for the agent:**

| Candidate | Churn | Bug Fix Rate | Dependents | Owner Count | Priority |
|-----------|-------|-------------|------------|-------------|----------|
| Module A | High | 60% | 15 imports | 1 (silo!) | HIGH -- risky but high value |
| Module B | High | 40% | 3 imports | 4 | MEDIUM -- safe to refactor |
| Module C | Medium | 80% | 20 imports | 2 | HIGH -- many bugs, many dependents |

---

## 4. New Developer Onboarding

**Scenario:** Agent is guiding a new team member through the codebase.

<AiQuery>Where should I start reading to understand this project?</AiQuery>
<AiQuery>Show me the main entry points of the application</AiQuery>
<AiQuery>Find well-documented, stable code to learn from</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[📚 Entry Points<br/><small>semantic_search · onboarding</small>]
    S2[🏗️ Stable Code<br/><small>search_code · stable</small>]
    S1 --> S2
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find documented entry points</summary>

```json
semantic_search({
  "path": "/project",
  "query": "main application entry point",
  "rerank": "onboarding",
  "limit": 10
})
```

</details>

<details>
<summary>Step 2 — Find stable reference implementations</summary>

```json
search_code({
  "path": "/project",
  "query": "getting started setup configuration",
  "rerank": "stable"
})
```

</details>

**Agent reasoning:** `onboarding` boosts documentation files and stable (low-churn) code -- exactly what a newcomer needs. Avoid pointing newcomers at `hotspots` or `techDebt` results, which are confusing and unrepresentative. `stable` preset finds implementations that haven't changed much -- reliable reference code.

---

## 5. Security Audit

**Scenario:** Agent is auditing security-sensitive code.

<AiQuery>Find old authentication code that needs security review</AiQuery>
<AiQuery>Which security-critical code has only one contributor?</AiQuery>
<AiQuery>Show me recently patched code in auth and crypto paths</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[🔒 Critical Paths<br/><small>semantic_search · securityAudit</small>]
    S2[👤 Knowledge Silos<br/><small>semantic_search · ownership</small>]
    S3[🐛 Active Patches<br/><small>semantic_search · custom</small>]
    S1 --> S2 --> S3
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find old code in critical paths</summary>

```json
semantic_search({
  "path": "/project",
  "query": "authentication password encryption token",
  "rerank": "securityAudit",
  "limit": 20
})
```

</details>

<details>
<summary>Step 2 — Check for knowledge silos in security code</summary>

```json
semantic_search({
  "path": "/project",
  "query": "security authentication",
  "rerank": "ownership",
  "pathPattern": "**/auth/**",
  "metaOnly": true
})
```

</details>

<details>
<summary>Step 3 — Find recently patched security code</summary>

```json
semantic_search({
  "path": "/project",
  "query": "security fix patch vulnerability",
  "rerank": {
    "custom": {
      "similarity": 0.3,
      "bugFix": 0.3,
      "burstActivity": 0.2,
      "pathRisk": 0.2
    }
  }
})
```

</details>

**Agent reasoning:** `securityAudit` boosts old code in auth/crypto/token paths that has high bug-fix rates -- the most likely places for vulnerabilities. `ownership` reveals if security-critical code is a knowledge silo (bus factor = 1). Custom weights in step 3 combine bug-fix history with recent activity to find areas under active security patching.

---

## 6. Tech Debt Assessment

**Scenario:** Agent is producing a tech debt report.

<AiQuery>Find legacy code with high bug-fix rates</AiQuery>
<AiQuery>Which old code keeps getting patched?</AiQuery>
<AiQuery>Show me the worst tech debt in the core business logic</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[📦 Legacy Code<br/><small>semantic_search · techDebt</small>]
    S2[🔥 Bug Density<br/><small>semantic_search · hotspots</small>]
    S1 --> S2
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find legacy hotspots</summary>

```json
semantic_search({
  "path": "/project",
  "query": "core business logic",
  "rerank": "techDebt",
  "metaOnly": true,
  "limit": 30
})
```

</details>

<details>
<summary>Step 2 — Cross-reference with bug density</summary>

```json
semantic_search({
  "path": "/project",
  "query": "error handling exception",
  "rerank": "hotspots",
  "filter": { "must": [{ "key": "git.ageDays", "range": { "gte": 90 } }] },
  "metaOnly": true
})
```

</details>

**Agent reasoning:** `techDebt` finds old code that keeps getting modified (high age + high churn + bugs). Step 2 narrows to code that's both old AND a hotspot -- the worst tech debt: legacy code that keeps breaking.

---

## 7. Incident Response

**Scenario:** Production is down, agent needs to find the root cause fast.

<AiQuery>Production is down — what changed in the last 3 days?</AiQuery>
<AiQuery>Find recently modified database connection code</AiQuery>
<AiQuery>What are the usual suspects for timeout errors?</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[⚡ Recent Changes<br/><small>search_code · recent</small>]
    S2[🔥 Usual Suspects<br/><small>semantic_search · hotspots</small>]
    S1 -. no results .-> S2
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find recent changes near the error</summary>

```json
search_code({
  "path": "/project",
  "query": "database connection timeout error",
  "rerank": "recent",
  "maxAgeDays": 3
})
```

</details>

<details>
<summary>Step 2 — If no results, widen with hotspots</summary>

```json
semantic_search({
  "path": "/project",
  "query": "database connection pool",
  "rerank": "hotspots"
})
```

</details>

**Agent reasoning:** Most incidents are caused by recent changes. `recent` preset with a tight `maxAgeDays` filter finds what changed in the last 72 hours. If that fails, `hotspots` finds historically fragile code -- the usual suspects.

---

## 8. Change Blast Radius Analysis

**Scenario:** "If I change module X, what breaks?"

<AiQuery>If I refactor the PaymentProcessor, what else breaks?</AiQuery>
<AiQuery>Show me everything that depends on the auth module</AiQuery>
<AiQuery>What is the blast radius of changing the database adapter?</AiQuery>

<MermaidTeaRAGs>
{`
flowchart LR
    S1[📁 Module API<br/><small>search_code · relevance</small>]
    S2[🔗 Dependents<br/><small>semantic_search · impactAnalysis</small>]
    S3[🔥 Risk Assessment<br/><small>semantic_search · hotspots</small>]
    S1 --> S2 --> S3
`}
</MermaidTeaRAGs>

<details>
<summary>Step 1 — Find the module and its exports</summary>

```json
search_code({
  "path": "/project",
  "query": "module X public API exports"
})
```

</details>

<details>
<summary>Step 2 — Find everything that imports from it</summary>

```json
semantic_search({
  "path": "/project",
  "query": "module X",
  "rerank": "impactAnalysis",
  "metaOnly": true,
  "limit": 30
})
```

</details>

<details>
<summary>Step 3 — Assess risk of affected dependents</summary>

```json
semantic_search({
  "path": "/project",
  "query": "code using module X",
  "rerank": "hotspots",
  "metaOnly": true
})
```

</details>

<details>
<summary>Agent output format</summary>

```text
Blast radius for changing ModuleX:

Direct dependents: 12 files (15 chunks)
  - HIGH RISK: src/payment/processor.ts (hotspot, 45 commits, 3 bug fixes)
  - HIGH RISK: src/auth/validator.ts (security path, single owner)
  - MEDIUM: src/api/routes.ts (8 commits, stable recently)
  - LOW: src/utils/helpers.ts (2 commits, 4 contributors)
  ...

Recommended reviewers: @alice (payment), @bob (auth)
Estimated test scope: payment/**, auth/**, api/**
```

</details>

## Combining Filters with Reranking

Filters (Qdrant conditions) **narrow** the candidate set. Reranking **re-orders** the filtered results. Use both:

| Goal | Filter | Rerank |
|------|--------|--------|
| Recent bugs in auth | `git.ageDays <= 14` + `pathPattern: **/auth/**` | `hotspots` |
| Old single-owner code | `git.ageDays >= 90` + `git.commitCount >= 5` | `ownership` |
| Recently active TypeScript | `language: typescript` + `git.ageDays <= 30` | `codeReview` |
| Large stable functions | `chunkType: function` + `git.commitCount <= 3` | `onboarding` |
| High-churn security code | `git.commitCount >= 10` + security path pattern | `securityAudit` |

## When to Use Which Tool

| Agent task | Tool | Why |
|-----------|------|-----|
| Quick code lookup | `search_code` | Simpler API, human-readable output |
| Analytics/reporting | `semantic_search` | Structured JSON, full git metadata, `metaOnly` |
| Multi-signal queries | `semantic_search` | Custom weights, Qdrant filters |
| Hybrid (keyword + semantic) | `hybrid_search` | Best recall for mixed queries |
| Lightweight discovery | `semantic_search` + `metaOnly: true` | Metadata without content (fast, small) |

## Anti-Patterns

| Anti-pattern | Why it's wrong | Correct approach |
|-------------|---------------|-----------------|
| Using `hotspots` for onboarding | Hotspots are confusing, unstable code | Use `onboarding` preset |
| Using `relevance` for everything | Ignores valuable git signals | Match preset to task |
| Custom weights that sum to != 1.0 | Weights are normalized internally, but intent is clearer at 1.0 | Keep weights summing to ~1.0 |
| Skipping `metaOnly` for reports | Downloads full code content unnecessarily | Use `metaOnly: true` for analytics |
| Hardcoding preset in agent system prompt | Different subtasks need different presets | Select preset based on current step |

## Agentic Flow Template

General pattern for multi-step agent workflows:

```text
1. DISCOVER  -- search_code(query, rerank=relevance)
                Find the target code area

2. ANALYZE   -- semantic_search(query, rerank=<task-preset>, metaOnly=true)
                Get structured metadata for analysis

3. ASSESS    -- semantic_search(query, rerank=hotspots|ownership|impactAnalysis)
                Evaluate risk, ownership, blast radius

4. ACT       -- Read specific files from results, make changes

5. VERIFY    -- semantic_search(query, rerank=impactAnalysis)
                Confirm blast radius of your changes
```

Not all steps are needed for every task. An incident response agent might only do steps 1-2. A refactoring agent needs all 5.
