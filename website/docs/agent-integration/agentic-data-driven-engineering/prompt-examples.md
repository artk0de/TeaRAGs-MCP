---
title: "Prompt Examples"
sidebar_position: 4
---

# Prompt Examples

All blocks below implement the same [Five Strategies](/agent-integration/agentic-data-driven-engineering#the-five-strategies) with different thresholds and emphasis. Each is self-contained — copy the one that matches your context, then append the [Generation Mode Auto-Switch](#generation-mode-auto-switch) block.

For where to place these blocks (CLAUDE.md, .cursorrules, system prompt), see [Activating in Your Agent](activating).

**Shared vocabulary across all strategies:**

| Step label   | Maps to strategy            | Tool                                            |
|--------------|-----------------------------|--------------------------------------------------|
| TEMPLATE     | 1. Template Selection       | `search_code` with `rerank: "stable"`            |
| RISK CHECK   | 5. Risk Assessment          | `semantic_search` with `rerank: "hotspots"`      |
| STYLE MATCH  | 3. Style Consistency        | `semantic_search` with `rerank: "ownership"`     |
| ANTI-PATTERN | 2. Anti-Pattern Detection   | `search_code` with `rerank: "hotspots"`          |
| CONTEXT      | 4. Historical Context       | check `taskIds` in search results                |
| VERIFY       | Post-generation validation  | ripgrep for every function, import, type         |
| BLAST RADIUS | Post-generation impact      | `semantic_search` with `rerank: "impactAnalysis"` |

**Signal names used in all blocks:**

| Level | Signals |
|-------|---------|
| Chunk (function/block) | `chunkBugFixRate`, `chunkCommitCount`, `chunkAgeDays`, `chunkChurnRatio` |
| File  | `bugFixRate`, `commitCount`, `ageDays`, `dominantAuthorPct`, `relativeChurn`, `churnVolatility`, `imports` |

Chunk-level signals are more granular — use them in threshold tables. File-level signals are used for ownership, blast radius, and filters.

## Balanced Strategy (Recommended)

All five strategies with sensible defaults. Recommended starting point for most projects.

````markdown
## Code Generation Strategy

tea-rags is available as an MCP server. Use it for ALL code search.

### Before generating code:

1. TEMPLATE: Find stable template — `search_code` with `rerank: "stable"`
   - Only use results with chunkBugFixRate < 25%, chunkCommitCount <= 5
2. RISK CHECK: Assess target area — `semantic_search` with `rerank: "hotspots"`, `metaOnly: true`
   - See threshold table → select generation mode
3. STYLE MATCH: Match domain owner — `semantic_search` with `rerank: "ownership"`, `metaOnly: true`

### After generating code:

4. VERIFY: Confirm identifiers with ripgrep — every function, import, type must exist
   - Semantic search finds by meaning, not exact names
   - 0 ripgrep matches = fix the reference before committing
5. BLAST RADIUS: Check impact — `semantic_search` with `rerank: "impactAnalysis"`, `metaOnly: true`

### Threshold Decision Table

| Signal              | Safe   | Caution  | Stop                            |
|---------------------|--------|----------|---------------------------------|
| chunkBugFixRate     | < 25%  | 25–40%   | > 40% (wrapper + feature flag)  |
| chunkCommitCount    | 1–5    | 6–8      | > 8 (simplify, reduce)          |
| chunkAgeDays        | < 90   | 90–180   | > 180 (minimal changes only)    |
| dominantAuthorPct   | < 70%  | 70–85%   | > 85% (flag owner for review)   |
| relativeChurn       | < 2.0  | 2.0–5.0  | > 5.0 (propose rewrite)         |

### Never:

- Copy code from results with chunkBugFixRate > 50%
- Modify single-owner code without flagging the owner
- Change code with relativeChurn > 5.0 without proposing a rewrite
- Trust generated identifiers without ripgrep verification
````

## Generation Mode Auto-Switch

Append after any strategy block. The agent auto-selects a generation mode based on the RISK CHECK step.

````markdown
## Generation Mode

After the RISK CHECK, auto-select the generation mode:

### Mode Decision Table

| Condition                                 | Mode          | Behavior                                    |
|-------------------------------------------|---------------|---------------------------------------------|
| chunkBugFixRate > 40% AND chunkAgeDays > 60       | Defensive     | Wrapper pattern, feature flag, keep old path |
| chunkCommitCount > 8 AND churnVolatility > 15     | Stabilization | Simplify branching, extract methods, log     |
| chunkAgeDays > 180 AND chunkCommitCount <= 2       | Conservative  | Minimal changes, preserve signatures         |
| otherwise                                 | Standard      | Clean idiomatic code, follow templates       |

Evaluate top-to-bottom. First match wins.
Multiple red flags → escalate to user before proceeding.

### Mode-Specific Rules

| Mode          | Do                                           | Don't                                    |
|---------------|----------------------------------------------|------------------------------------------|
| Defensive     | Wrap, flag, keep fallback, plan cleanup date | Delete old code, refactor inline          |
| Stabilization | Extract methods, reduce paths, add logging   | Add features on top, increase branching   |
| Conservative  | Add alongside, duplicate over abstract       | Move code, rename, change signatures      |
| Standard      | Follow template, match owner style           | Ignore metrics — still verify with ripgrep |
````

## Safety-First Strategy

Same five strategies, stricter thresholds. RISK CHECK runs first (mandatory danger zone gate before any generation). For legacy systems or regulated environments.

````markdown
## Code Generation Strategy: Safety-First

tea-rags is available as an MCP server. Use it for ALL code search.

### Before generating code:

1. RISK CHECK (mandatory first): Assess danger zone — `semantic_search` with `rerank: "hotspots"`, `metaOnly: true`
   - If any signal hits Stop → STOP and warn user before proceeding
   - If modifying auth/payment/crypto: also run `rerank: "securityAudit"`
2. TEMPLATE: Find stable template — `search_code` with `rerank: "stable"`
   - Only use results passing the quality gate
3. STYLE MATCH: Match domain owner — `semantic_search` with `rerank: "ownership"`, `metaOnly: true`
   - Default to wrapper pattern for any code with chunkAgeDays > 90

### After generating code:

4. VERIFY: Confirm identifiers with ripgrep — every function, import, type must exist
   - 0 ripgrep matches = fix the reference
5. BLAST RADIUS: Check impact — `semantic_search` with `rerank: "impactAnalysis"`, `metaOnly: true`

### Threshold Decision Table

| Signal              | Safe   | Caution  | Stop                     |
|---------------------|--------|----------|--------------------------|
| chunkBugFixRate     | < 15%  | 15–30%   | > 30% (stop, warn user)  |
| chunkCommitCount    | 1–3    | 4–5      | > 5                      |
| dominantAuthorPct   | < 80%  | 80–90%   | > 90% (knowledge silo)   |
| imports             | < 5    | 5–10     | > 10 (blast radius risk) |

### Template Quality Gate

| Signal           | Required             |
|------------------|----------------------|
| chunkBugFixRate  | < 15%                |
| chunkCommitCount | <= 3                 |
| chunkAgeDays     | > 60 (battle-tested) |

### Never:

- Copy code from results with chunkBugFixRate > 50%
- Modify code with chunkBugFixRate > 50% directly — propose rewrite plan
- Trust generated identifiers without ripgrep verification
````

## Incident Response Strategy

Speed over thoroughness. TEMPLATE step is skipped — recent changes are checked first as the most likely cause. For emergency patches during production incidents.

````markdown
## Incident Response Strategy

tea-rags is available as an MCP server. Use it for ALL code search.

When fixing a production issue:
1. FIND RECENT: Search recent changes — `search_code` with `rerank: "recent"`, `maxAgeDays: 7`
   - Recent changes are the most likely cause
2. RISK CHECK (fallback): If no recent results — `search_code` with `rerank: "hotspots"`
   - Historically fragile code is the next suspect
3. STYLE MATCH: Identify owner — `semantic_search` with `rerank: "ownership"`, `metaOnly: true`
4. Generate: Fix minimally — smallest possible change, no refactoring
5. VERIFY: Confirm identifiers with ripgrep — every function, import, type must exist
6. Add regression test for the specific failure

### Escalation Decision Table

| Recent changes found? | Hotspot? | Action                          |
|-----------------------|----------|---------------------------------|
| Yes                   | —        | Revert or patch the recent code |
| No                    | Yes      | Focus on historically fragile   |
| No                    | No       | Widen search, check logs        |
````

## New Feature Strategy

No legacy constraints — TEMPLATE step emphasized, ANTI-PATTERN step added to learn from mistakes in adjacent code. For greenfield development.

````markdown
## New Feature Strategy

tea-rags is available as an MCP server. Use it for ALL code search.

When creating new features:
1. TEMPLATE: Find proven patterns — `search_code` with `rerank: "stable"` in similar features
   - See quality gate below
2. STYLE MATCH: Check directory owner — `semantic_search` with `rerank: "ownership"`, `metaOnly: true`
   - Match their error handling, naming, and structure
3. ANTI-PATTERN: Identify what to avoid — `search_code` with `rerank: "hotspots"` in the same area
   - Note: complex branching, nested flags, mixed responsibilities
4. CONTEXT: Check related taskIds for feature history
5. Generate: Clean code following the best template found
6. VERIFY: Confirm identifiers with ripgrep — every function, import, type must exist

### Template Quality Gate

| Signal           | Ideal  | Acceptable | Reject              |
|------------------|--------|------------|---------------------|
| chunkBugFixRate  | 0%     | < 20%      | > 20%               |
| chunkAgeDays     | > 60   | > 30       | < 30 (too fresh)    |
| chunkCommitCount | 1–2    | 3–5        | > 5 (too volatile)  |
````

:::tip
Start with **Balanced + Mode Auto-Switch** and customize from there. For Cursor and custom agent formats, see [Activating in Your Agent](activating).
:::
