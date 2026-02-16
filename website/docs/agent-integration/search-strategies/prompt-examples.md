---
title: Prompt Examples
sidebar_position: 5
---

# Prompt Examples

Copy these blocks directly into your `CLAUDE.md`, `.cursorrules`, or equivalent agent configuration. Each block is self-contained.

## Ready-to-Paste: Search Strategy

````markdown
## Search Strategy

### Tool Selection

| Question type                            | Tool                                 | When                                |
|------------------------------------------|--------------------------------------|-------------------------------------|
| Meaning, behavior, "how does X work?"    | `search_code`                        | Don't know exact names              |
| Git metrics, churn, ownership, analytics | `semantic_search`                    | Need commitCount/bugFixRate/authors |
| Metadata only (no code content)          | `semantic_search` + `metaOnly: true` | Risk assessment, reports            |
| Class/method structure, signatures       | tree-sitter                          | Know the file, need its shape       |
| Exact strings, TODOs, config keys        | ripgrep                              | Know the exact token                |
| Verify generated code                    | ripgrep                              | After code generation               |

Cascade: tea-rags → tree-sitter → ripgrep (intent → structure → exact match).

NEVER:
- use ripgrep for "how does X work?" — use tea-rags
- use tea-rags for exact string matching — use ripgrep
- use tree-sitter for text search — use ripgrep

### Mode Selection

| You need...                 | Tool              | Key parameter          |
|-----------------------------|-------------------|------------------------|
| Quick code lookup           | `search_code`     | `rerank: "preset"`     |
| Structured git metadata     | `semantic_search` | Full JSON with signals |
| Metadata without code       | `semantic_search` | `metaOnly: true`       |
| Keyword + semantic combined | `hybrid_search`   | Combined ranking       |

### Preset Selection

| Task              | Preset                   | Fallback                         |
|-------------------|--------------------------|----------------------------------|
| Bug investigation | `recent` → `hotspots`   | `ownership` for escalation       |
| Code review       | `codeReview`             | `securityAudit` for auth paths   |
| Finding templates | `stable`                 | Reject if chunkBugFixRate > 40%  |
| Refactoring       | `refactoring`            | `impactAnalysis` for blast       |
| Onboarding        | `onboarding`             | `stable` for reference code      |
| Security audit    | `securityAudit`          | `ownership` for silo detection   |
| Tech debt         | `techDebt`               | `hotspots` for active problems   |
| Incident response | `recent` (maxAgeDays: 3) | `hotspots` if nothing recent     |
| Blast radius      | `impactAnalysis`         | `hotspots` for risk overlay      |

### Before Generating Code

1. Find template: `search_code` with `rerank: "stable"`
   - Only use results with chunkBugFixRate < 25%
2. Check risk: `semantic_search` with `rerank: "hotspots"`, `metaOnly: true`
3. Check ownership: `semantic_search` with `rerank: "ownership"`, `metaOnly: true`
   - Flag if dominantAuthorPct > 85%
4. Verify identifiers: ripgrep to confirm function names, imports, types exist
````

## Ready-to-Paste: Custom Reranking

````markdown
## Custom Reranking

When no preset fits, use `rerank: { "custom": { ... } }` with orthogonal signals.

### Signal Groups (pick ONE per group)

| Group           | Pick one of                                          |
|-----------------|------------------------------------------------------|
| Churn frequency | churn · chunkChurn · density · burstActivity         |
| Churn magnitude | relativeChurnNorm · chunkRelativeChurn               |
| Age / freshness | age · recency                                        |
| Ownership       | ownership · knowledgeSilo                            |
| Independent     | similarity · stability · bugFix · volatility         |
| Independent     | chunkSize · documentation · imports · pathRisk       |

Rules:
1. Use 3–5 signals, weights summing to ~1.0
2. Never combine signals from the same group
3. Include `similarity: 0.2–0.4` unless pure metadata analysis
4. Test with `metaOnly: true` first

### Examples

Risk scoring — "what needs more tests?"
  rerank: { "custom": { "chunkChurn": 0.25, "bugFix": 0.3, "imports": 0.25, "volatility": 0.2 } }

Safe templates — "stable code to copy from"
  rerank: { "custom": { "stability": 0.3, "age": 0.2, "similarity": 0.3, "ownership": 0.2 } }

Dangerous silos — "single-owner hotspots in security paths"
  rerank: { "custom": { "knowledgeSilo": 0.3, "chunkChurn": 0.25, "bugFix": 0.25, "pathRisk": 0.2 } }

Activity pulse — "who's touching what right now"
  rerank: { "custom": { "burstActivity": 0.3, "recency": 0.3, "similarity": 0.2, "chunkSize": 0.2 } }
````

:::tip
These prompts are battle-tested on a 3.5M+ LOC Ruby/Rails codebase with Claude Code, tree-sitter MCP, and ripgrep MCP as complementary tools.
:::
