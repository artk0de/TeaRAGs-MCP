# Using Reranking in Agentic Flows

How AI agents (Claude, GPT, Gemini, custom LLM agents) can leverage tea-rags reranking presets and custom weights to get **task-appropriate** code search results instead of generic similarity matches.

## The Problem

Default semantic search returns results ranked by vector similarity only. But an agent investigating a production bug needs different results than an agent onboarding a new developer, even for the same query. Reranking solves this by re-scoring results using git metadata signals (churn, age, ownership, etc.) combined with task-specific weight profiles.

## Available Tools and Their Presets

### search_code (practical development)

| Preset | Signals | Best for |
|--------|---------|----------|
| `relevance` | similarity only | General code lookup (default) |
| `recent` | similarity 0.7 + recency 0.3 | Sprint review, incident response |
| `stable` | similarity 0.7 + stability 0.3 | Finding reliable implementations |

### semantic_search / hybrid_search (analytics)

| Preset | Key signals | Best for |
|--------|-------------|----------|
| `relevance` | similarity only | General lookup (default) |
| `techDebt` | age + churn + bugFix + volatility | Legacy code assessment |
| `hotspots` | chunkChurn + chunkRelativeChurn + burstActivity + bugFix + volatility | Bug-prone areas, risk assessment |
| `codeReview` | recency + burstActivity + density + chunkChurn | Recent changes review |
| `onboarding` | documentation + stability | New developer entry points |
| `securityAudit` | age + ownership + bugFix + pathRisk + volatility | Old critical code, security review |
| `refactoring` | chunkChurn + relativeChurnNorm + chunkSize + volatility + bugFix + age | Refactor candidates |
| `ownership` | ownership + knowledgeSilo | Knowledge silos, bus factor |
| `impactAnalysis` | similarity + imports | Dependency chains, blast radius |

### Custom weights

Any signal can be combined with arbitrary weights:

```json
{
  "rerank": {
    "custom": {
      "similarity": 0.4,
      "burstActivity": 0.3,
      "bugFix": 0.2,
      "pathRisk": 0.1
    }
  }
}
```

Available weight keys: `similarity`, `recency`, `stability`, `churn`, `age`, `ownership`, `chunkSize`, `documentation`, `imports`, `bugFix`, `volatility`, `density`, `chunkChurn`, `relativeChurnNorm`, `burstActivity`, `pathRisk`, `knowledgeSilo`, `chunkRelativeChurn`.

## Agent Task to Preset Mapping

### 1. Bug Investigation

**Scenario:** Agent is investigating a production error.

**Step 1** — Find recently changed related code:
```json
search_code({
  "path": "/project",
  "query": "payment processing timeout",
  "rerank": "recent",
  "maxAgeDays": 14
})
```

**Step 2** — Find historically fragile code in the same area:
```json
semantic_search({
  "path": "/project",
  "query": "payment processing",
  "rerank": "hotspots",
  "pathPattern": "**/payment/**",
  "limit": 10
})
```

**Step 3** — Identify who to escalate to:
```json
semantic_search({
  "path": "/project",
  "query": "payment processing",
  "rerank": "ownership",
  "metaOnly": true
})
```

**Agent reasoning:** Recent changes are the most likely cause (`recent`), but if that doesn't find the bug, historically fragile code (`hotspots`) is the next suspect. `ownership` with `metaOnly` identifies the domain expert without downloading content.

---

### 2. Code Review

**Scenario:** Agent is reviewing a PR or recent changes.

**Step 1** — Find all recently changed code:
```json
semantic_search({
  "path": "/project",
  "query": "feature implementation",
  "rerank": "codeReview",
  "filter": { "must": [{ "key": "git.ageDays", "range": { "lte": 7 } }] },
  "limit": 20
})
```

**Step 2** — Check if changes touch risky areas:
```json
semantic_search({
  "path": "/project",
  "query": "authentication validation security",
  "rerank": "securityAudit",
  "filter": { "must": [{ "key": "git.ageDays", "range": { "lte": 7 } }] }
})
```

**Step 3** — Assess blast radius of the changed code:
```json
semantic_search({
  "path": "/project",
  "query": "imports from changed module",
  "rerank": "impactAnalysis",
  "metaOnly": true,
  "limit": 20
})
```

**Agent reasoning:** `codeReview` boosts recent burst activity and change density — showing what's actively being worked on. `securityAudit` cross-checks if any recent changes touch security-sensitive paths (auth, crypto, tokens). `impactAnalysis` reveals how many other modules depend on the changed code.

---

### 3. Refactoring Planning

**Scenario:** Agent is identifying refactoring candidates and estimating effort.

**Step 1** — Find refactoring candidates:
```json
semantic_search({
  "path": "/project",
  "query": "business logic processing",
  "rerank": "refactoring",
  "metaOnly": true,
  "limit": 20
})
```

**Step 2** — For each candidate, measure blast radius:
```json
semantic_search({
  "path": "/project",
  "query": "imports from candidate module",
  "rerank": "impactAnalysis",
  "pathPattern": "!**/test/**",
  "metaOnly": true
})
```

**Step 3** — Check who should review:
```json
semantic_search({
  "path": "/project",
  "query": "candidate module area",
  "rerank": "ownership",
  "metaOnly": true
})
```

**Agent reasoning:** `refactoring` surfaces large, churny, volatile chunks with high bug-fix rates — the best candidates for improvement. `impactAnalysis` measures how many dependents each candidate has (high imports = high blast radius = refactor carefully). `ownership` identifies reviewers and potential knowledge silos.

**Decision matrix for the agent:**

| Candidate | Churn | Bug Fix Rate | Dependents | Owner Count | Priority |
|-----------|-------|-------------|------------|-------------|----------|
| Module A | High | 60% | 15 imports | 1 (silo!) | HIGH — risky but high value |
| Module B | High | 40% | 3 imports | 4 | MEDIUM — safe to refactor |
| Module C | Medium | 80% | 20 imports | 2 | HIGH — many bugs, many dependents |

---

### 4. New Developer Onboarding

**Scenario:** Agent is guiding a new team member through the codebase.

```json
semantic_search({
  "path": "/project",
  "query": "main application entry point",
  "rerank": "onboarding",
  "limit": 10
})
```

```json
search_code({
  "path": "/project",
  "query": "getting started setup configuration",
  "rerank": "stable"
})
```

**Agent reasoning:** `onboarding` boosts documentation files and stable (low-churn) code — exactly what a newcomer needs. Avoid pointing newcomers at `hotspots` or `techDebt` results, which are confusing and unrepresentative. `stable` preset finds implementations that haven't changed much — reliable reference code.

---

### 5. Security Audit

**Scenario:** Agent is auditing security-sensitive code.

**Step 1** — Find old code in critical paths:
```json
semantic_search({
  "path": "/project",
  "query": "authentication password encryption token",
  "rerank": "securityAudit",
  "limit": 20
})
```

**Step 2** — Check for knowledge silos in security code:
```json
semantic_search({
  "path": "/project",
  "query": "security authentication",
  "rerank": "ownership",
  "pathPattern": "**/auth/**",
  "metaOnly": true
})
```

**Step 3** — Find recently patched security code (might indicate ongoing issues):
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

**Agent reasoning:** `securityAudit` boosts old code in auth/crypto/token paths that has high bug-fix rates — the most likely places for vulnerabilities. `ownership` reveals if security-critical code is a knowledge silo (bus factor = 1). Custom weights in step 3 combine bug-fix history with recent activity to find areas under active security patching.

---

### 6. Tech Debt Assessment

**Scenario:** Agent is producing a tech debt report.

**Step 1** — Find legacy hotspots:
```json
semantic_search({
  "path": "/project",
  "query": "core business logic",
  "rerank": "techDebt",
  "metaOnly": true,
  "limit": 30
})
```

**Step 2** — Cross-reference with bug density:
```json
semantic_search({
  "path": "/project",
  "query": "error handling exception",
  "rerank": "hotspots",
  "filter": { "must": [{ "key": "git.ageDays", "range": { "gte": 90 } }] },
  "metaOnly": true
})
```

**Agent reasoning:** `techDebt` finds old code that keeps getting modified (high age + high churn + bugs). Step 2 narrows to code that's both old AND a hotspot — the worst tech debt: legacy code that keeps breaking.

---

### 7. Incident Response

**Scenario:** Production is down, agent needs to find the root cause fast.

```json
search_code({
  "path": "/project",
  "query": "database connection timeout error",
  "rerank": "recent",
  "maxAgeDays": 3
})
```

If no results, widen with hotspots:
```json
semantic_search({
  "path": "/project",
  "query": "database connection pool",
  "rerank": "hotspots"
})
```

**Agent reasoning:** Most incidents are caused by recent changes. `recent` preset with a tight `maxAgeDays` filter finds what changed in the last 72 hours. If that fails, `hotspots` finds historically fragile code — the usual suspects.

---

### 8. Change Blast Radius Analysis

**Scenario:** "If I change module X, what breaks?"

**Step 1** — Find the module and its exports:
```json
search_code({
  "path": "/project",
  "query": "module X public API exports"
})
```

**Step 2** — Find everything that imports from it:
```json
semantic_search({
  "path": "/project",
  "query": "module X",
  "rerank": "impactAnalysis",
  "metaOnly": true,
  "limit": 30
})
```

**Step 3** — Assess risk of affected dependents:
```json
semantic_search({
  "path": "/project",
  "query": "code using module X",
  "rerank": "hotspots",
  "metaOnly": true
})
```

**Agent output format:**
```
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

```
1. DISCOVER  — search_code(query, rerank=relevance)
                Find the target code area

2. ANALYZE   — semantic_search(query, rerank=<task-preset>, metaOnly=true)
                Get structured metadata for analysis

3. ASSESS    — semantic_search(query, rerank=hotspots|ownership|impactAnalysis)
                Evaluate risk, ownership, blast radius

4. ACT       — Read specific files from results, make changes

5. VERIFY    — semantic_search(query, rerank=impactAnalysis)
                Confirm blast radius of your changes
```

Not all steps are needed for every task. An incident response agent might only do steps 1-2. A refactoring agent needs all 5.

## Related Documentation

- [GIT_CHURN.md](./GIT_CHURN.md) — Detailed reference for all churn metrics (file-level and chunk-level), architecture, filtering examples, and research context.
- [BLAST_RADIUS.md](./BLAST_RADIUS.md) — Theoretical foundations for blast radius metrics: fan-in/fan-out, Martin's instability, graph centrality, hotspot model, CRAP metric, and implementation roadmap.

## Known Limitations

1. **Schema gap:** The `ScoringWeightsSchema` in the MCP tool definitions does not yet expose the newer weight keys (`relativeChurnNorm`, `burstActivity`, `pathRisk`, `knowledgeSilo`, `chunkRelativeChurn`). Agents using preset strings are unaffected; agents constructing custom weights for these signals will need the schema updated.

2. **No cross-search chaining:** Each search is independent. The agent must manually chain results from one search into filters for the next. There is no built-in "find all files that import results from my previous search."

3. **Git metadata required:** All reranking presets except `relevance` require `CODE_ENABLE_GIT_METADATA=true` during indexing. Without git enrichment, non-relevance presets silently degrade to similarity-only scoring.

4. **Chunk-level data is partial:** Chunk-level metrics (chunkCommitCount, chunkBugFixRate, etc.) are only available for files with multiple chunks and recent commits within the `GIT_CHUNK_MAX_AGE_MONTHS` window. Single-chunk files and old-only commits fall back to file-level metrics.

5. **No fan-in (importedBy) data yet:** The current `impactAnalysis` preset uses only fan-out (imports count). Fan-in metrics and the `blastRadius` preset are planned — see [BLAST_RADIUS.md](./BLAST_RADIUS.md).
