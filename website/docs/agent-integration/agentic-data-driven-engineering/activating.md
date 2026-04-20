---
title: "Activating in Your Agent"
sidebar_position: 3
---

# Activating in Your Agent

## Claude Code (CLAUDE.md)

Add the strategy block to your project's `CLAUDE.md` file. Claude Code reads this file automatically and applies the instructions to every interaction.

```markdown
# CLAUDE.md

## Search & Generation Strategy

tea-rags is available as an MCP server. Use it for ALL code search.

### Before generating code:
1. Find a stable template: `search_code` with `rerank: "stable"`
   - Only use results with chunkBugFixRate < 25%, chunkCommitCount <= 5
2. Check target area: `semantic_search` with `rerank: "hotspots"`, `metaOnly: true`
   - chunkBugFixRate > 40% + chunkAgeDays > 60 → wrapper pattern + feature flag
   - chunkCommitCount > 8 → simplify, reduce complexity
   - chunkAgeDays > 180 → minimal changes only
3. Match domain owner: `semantic_search` with `rerank: "ownership"`, `metaOnly: true`

### After generating code:
4. Verify with ripgrep: confirm ALL referenced functions, imports, and types exist
   - Semantic search finds by meaning, not exact identifiers
   - 0 ripgrep matches for a referenced function = fix the reference before committing
5. Check blast radius: `semantic_search` with `rerank: "impactAnalysis"`, `metaOnly: true`

### Never:
- Copy code from results with chunkBugFixRate > 50%
- Modify single-owner code without flagging the owner
- Change code with relativeChurn > 5.0 without proposing a rewrite
- Trust generated identifiers without ripgrep verification
```

## Cursor (.cursorrules)

```markdown
# .cursorrules

## Code Search

Use tea-rags MCP server for code search. Before writing new code:

Search for stable templates:
- Use rerank="stable" to find low-churn, battle-tested implementations
- Reject results with chunkBugFixRate > 40% — find alternatives
- Prefer results with chunkCommitCount <= 3 and chunkAgeDays > 60

Assess risk before modifying existing code:
- Use rerank="hotspots" with metaOnly=true on the target area
- If chunkBugFixRate > 40% and code is older than 60 days, use wrapper pattern
- If single author owns > 85%, match their style exactly

Match coding style to domain owner:
- Use rerank="ownership" on the target directory
- Follow the dominant author's error handling, naming, and structure patterns

After generating code, verify with ripgrep:
- Confirm all referenced function names, imports, and types actually exist
- Semantic search finds by meaning, not exact identifiers — always verify
- 0 ripgrep matches = fix the reference before committing
```

## Custom Agents (system prompt)

For agents built with the Claude API or other LLM frameworks:

```text
You have access to a tea-rags MCP server for semantic code search with
git-derived quality signals.

TEMPLATE SELECTION:
Use search_code with rerank="stable" to find templates.
A good template has: chunkBugFixRate < 25%, chunkCommitCount <= 5, chunkAgeDays > 60.
Never base new code on results with chunkBugFixRate > 50%.

RISK ASSESSMENT:
Before modifying code, use semantic_search with rerank="hotspots"
and metaOnly=true on the target area.
Switch to defensive mode (wrapper pattern) if:
  chunkBugFixRate > 40% AND chunkAgeDays > 60.

STYLE MATCHING:
Use semantic_search with rerank="ownership" to find the domain owner.
If dominantAuthorPct > 70%, match their patterns exactly.
If ownership is distributed, use project-wide conventions.

POST-GENERATION VERIFICATION (MANDATORY):
After generating code, use ripgrep to verify ALL referenced identifiers:
  - Function names, import paths, type names must return > 0 matches
  - Semantic search finds by meaning, not exact tokens
  - 0 matches = hallucinated identifier, fix before committing
```

## The Transformation

| Aspect | Before (similarity-only RAG) | After (data-driven generation) |
|--------|------------------------------|-------------------------------|
| **Template selection** | First search hit | Lowest bug rate, proven in production |
| **Style guide** | Generic language conventions | Domain owner's actual patterns |
| **Anti-patterns** | Unknown, invisible | Explicitly identified and avoided |
| **Feature context** | Missing — code exists in a vacuum | taskIds reveal evolution and intent |
| **Risk assessment** | No signal — all code treated equally | Metrics-driven defensive strategies |
| **Generation mode** | One mode for everything | Dynamically adapted to target area context |
| **Verification** | Trust semantic results as-is | Ripgrep verification of all referenced identifiers |
| **Decision basis** | "Looks right" | Measurable evidence from version history |

This is the shift from "find similar code" to **context-aware engineering** — where the agent reasons about the quality, history, and ownership of every code decision it makes.

## See Also

- [Mental Model](/agent-integration/mental-model) — how trajectory-aware RAG changes agent reasoning
- [Search Strategies](/agent-integration/search-strategies) — reranking presets, custom weight strategies, multi-tool cascade
- [Deep Codebase Analysis](/agent-integration/deep-codebase-analysis) — metric interpretation, hotspot detection, threshold tables
- [Semantic Search — Criticism and Responses](/knowledge-base/semantic-search-criticism) — why verification is mandatory, "candidate zone generator" principle
- [Semantic Search (Core Concepts)](/introduction/core-concepts/semantic-search#not-grep-replacement) — verification workflow with Mermaid diagram
- [Git Enrichments](/usage/advanced/git-enrichments) — all 19 signals explained
- [Code Churn: Theory & Research](/knowledge-base/code-churn-research) — academic foundations, Nagappan & Ball, Tornhill
