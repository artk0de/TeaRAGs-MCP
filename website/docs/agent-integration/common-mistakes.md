---
title: Common Mistakes
sidebar_position: 5
---

import AiQuery from '@site/src/components/AiQuery';

# Common Mistakes

Mistakes that developers and AI agents make when using semantic code search -- from naive RAG pitfalls that apply to any retrieval system, to TeaRAGs-specific errors that waste enrichment signals you already have.

## 1. Not Configuring Your Agent to Use TeaRAGs

**The mistake:** TeaRAGs is installed and indexing works, but the agent's system prompt (`CLAUDE.md`, `.cursorrules`, custom system prompt) doesn't mention it. The agent defaults to its built-in file exploration -- `grep`, `find`, reading files one by one -- and never calls the MCP tools.

**Why it matters:** Without explicit instructions, agents treat TeaRAGs as just another tool they *might* use. In practice, they almost never reach for it on their own. You're paying the cost of indexing and embedding without getting any of the benefits.

**The fix:** Add a search strategy section to your agent configuration:

```markdown
## Search Strategy

Use tea-rags MCP server for ALL code search. Do not grep through files manually.

Before generating code:
1. Find a stable template: search_code with rerank="stable"
   - Only use results with bugFixRate < 25%
2. Check target area risk: semantic_search with rerank="hotspots", metaOnly=true
3. Match domain owner: semantic_search with rerank="ownership", metaOnly=true
4. Verify identifiers: use ripgrep to confirm function names exist

Never:
- Copy code from results with bugFixRate > 50%
- Modify single-owner code without flagging the owner
```

See [Activating in Your Agent](/agent-integration/agentic-data-driven-engineering/activating) for complete configuration examples for Claude Code, Cursor, and custom agents.

:::warning
This is the single most common reason TeaRAGs delivers no value. The tool is available, the index is built, but the agent simply doesn't know to use it.
:::

## 2. Using TeaRAGs as Plain Semantic Search

**The mistake:** Treating TeaRAGs as a fancy grep -- searching with `rerank: "relevance"` every time and ignoring the 19 git-derived signals in results. The agent retrieves code, injects it into context, and generates -- without ever looking at `bugFixRate`, `commitCount`, `dominantAuthor`, or any other enrichment signal.

**Why it matters:** You get the same results you'd get from any vector search tool. The trajectory enrichment -- churn, stability, authorship, bug-fix rates -- is computed during indexing but never used. The agent copies the first match, which might be a prototype someone abandoned, a pattern that was reverted three times, or a function that breaks every sprint.

**What to do instead:**

| Task | Preset | Why |
|------|--------|-----|
| Finding templates to copy | `stable` | Low churn + old age = battle-tested |
| Investigating bugs | `recent` then `hotspots` | Recent changes first, then historically fragile code |
| Reviewing changes | `codeReview` | Boosts recent burst activity |
| Finding refactoring candidates | `refactoring` | Large + churny + high bug-fix rate |
| Understanding ownership | `ownership` | Surfaces knowledge silos |

See [Mental Model](/agent-integration/mental-model) for the thinking shift from similarity-only to trajectory-aware retrieval.

## 3. Copying the First Search Hit as a Template

**The mistake:** The agent finds code that's semantically similar to what it needs and immediately copies it as a template -- without checking whether that code is stable, well-owned, or has a history of bugs.

**Why it matters:** Similarity says nothing about quality. A function with 60% `bugFixRate` "looks right" semantically but is the worst possible example to copy. It will introduce the same structural problems that caused 60% of its commits to be bug fixes.

**Quality criteria for a good template:**

| Signal | Good | Mediocre | Avoid |
|--------|------|----------|-------|
| `chunkBugFixRate` | 0-15% | 15-35% | > 40% |
| `chunkCommitCount` | 1-3 | 4-7 | > 8 |
| `chunkAgeDays` | > 60 | 30-60 | < 14 |
| `churnVolatility` | < 5 | 5-15 | > 20 |

**The fix:** Always use `rerank: "stable"` when searching for templates. If the best match has `bugFixRate > 40%`, find an alternative.

See [Template Selection](/agent-integration/agentic-data-driven-engineering#1-template-selection--what-to-copy) for the complete workflow.

## 4. Context Stuffing -- Retrieving Too Many Results

**The mistake:** Setting `limit: 50` or higher on every search, dumping all results into the LLM context hoping "more is better." The agent's context fills with marginally relevant code chunks.

**Why it matters:** Research confirms that LLM performance degrades significantly when processing inputs beyond ~50% of context length ([Stanford, 2023](https://arxiv.org/abs/2307.03172)). A 2024 study by Chroma found that accuracy drops from 70-75% to 55-60% with just 20 retrieved documents. This is called **context rot** -- progressive decay in accuracy as prompts grow longer.

The problem is compounded by the **lost-in-the-middle** effect: relevant information buried in the middle of many chunks gets lower attention from the LLM than information at the beginning or end, creating a U-shaped performance curve.

**The fix:**

- Use `limit: 5-10` for code generation tasks
- Use `limit: 15-20` with `metaOnly: true` for analytics and reporting (no code content, just metadata)
- Use `limit: 20-30` only for broad discovery where you'll filter results programmatically
- Prefer tight `pathPattern` filters to narrow the candidate set *before* retrieval

:::tip
`metaOnly: true` returns file paths, git metrics, and chunk metadata *without* the code content. This gives you 10-50x less context while still providing the signals you need for analytical queries.
:::

## 5. Using the Wrong Tool for the Job

**The mistake:** Using TeaRAGs for everything -- exact string matching, finding TODOs, listing class methods, verifying function signatures. Or the inverse: using only ripgrep and ignoring semantic search entirely.

**Why it matters:** Each tool has a specific strength:

| Tool | Strength | Weakness |
|------|----------|----------|
| **TeaRAGs** | Finding code by meaning/intent | Can't find exact strings or analyze structure |
| **tree-sitter** | Classes, methods, signatures, inheritance | Can't search by meaning or find text |
| **ripgrep** | Exact strings, TODOs, flags, config keys | Can't understand intent or code structure |

**Common anti-patterns:**

| What you're doing | Wrong tool | Right tool |
|-------------------|-----------|------------|
| "How does authentication work?" | ripgrep | TeaRAGs `search_code` |
| "Find all callers of `processPayment()`" | TeaRAGs | ripgrep |
| "What methods does this class have?" | TeaRAGs | tree-sitter |
| "Where are TODOs in the codebase?" | TeaRAGs | ripgrep |
| "Understanding unfamiliar code" | ripgrep | TeaRAGs then tree-sitter |

**The fix:** Follow the cascade: **intent** (TeaRAGs) -> **structure** (tree-sitter) -> **exact match** (ripgrep). See [Combining with Other Search Tools](/agent-integration/search-strategies/multi-tool-cascade).

## 6. Not Verifying Search Results with Exact-Match Tools

**The mistake:** The agent generates code based on semantic search results without verifying that the function names, imports, and types it references actually exist in the codebase.

**Why it matters:** Semantic search returns code by *meaning*, not by *literals*. A search for "authentication logic" returns code about login, sessions, and tokens -- but the actual export might be named `validateCredentials()`, not `authenticateUser()`. The agent generates an import for a non-existent function, and the code fails to compile.

**Example failure:**

```text
1. Semantic search: "authentication logic"
   -> Returns src/auth/middleware.ts (high similarity)

2. Agent generates: import { authenticateUser } from './auth/middleware'

3. Reality: The export is named validateCredentials(), not authenticateUser()

4. Result: Compilation error from non-existent import
```

**The fix:** After generating code, verify every referenced identifier:

1. **Function names** -- ripgrep for each function used in generated code
2. **Imports** -- ripgrep for actual module paths and export names
3. **Types** -- ripgrep for interfaces and class names referenced
4. **Structure** -- tree-sitter to confirm method signatures match

See [Exact-Match Verification](/agent-integration/agentic-data-driven-engineering/generation-modes#exact-match-verification) for the complete verification workflow.

## 7. Using Only File-Level Metrics

**The mistake:** Looking at file-level `commitCount` and `bugFixRate` to assess code quality, missing the function-level granularity that chunk metrics provide.

**Why it matters:** A 500-line file with `commitCount = 30` and `bugFixRate = 35%` looks like a hotspot. But inside it:

- `processPayment()` -- `chunkCommitCount = 22`, `chunkBugFixRate = 55%` -- **the actual hotspot**
- `validateCard()` -- `chunkCommitCount = 4`, `chunkBugFixRate = 25%` -- normal
- `formatReceipt()` -- `chunkCommitCount = 1`, `chunkBugFixRate = 0%` -- **stable, good template**

Without chunk-level metrics, the agent either avoids the whole file (missing the stable `formatReceipt`) or treats the whole file as equally risky (missing the concentrated problem in `processPayment`).

**The fix:** All reranking presets automatically prefer chunk-level data when available. For custom weights, use `chunkChurn` and `chunkRelativeChurn` instead of `churn` and `relativeChurnNorm`. See [File-Level vs Chunk-Level](/agent-integration/deep-codebase-analysis#file-level-vs-chunk-level-metrics-when-to-use-each).

## 8. Overlapping Signals in Custom Reranks

**The mistake:** Building custom rerank weights with signals that measure the same underlying thing:

```json
{
  "custom": {
    "churn": 0.25,
    "chunkChurn": 0.25,
    "density": 0.25,
    "burstActivity": 0.25
  }
}
```

**Why it matters:** `churn`, `chunkChurn`, `density`, and `burstActivity` are all churn variants. This custom rerank is effectively 100% churn with no other signal -- the four weights don't add unique information, they just triple-count the same thing.

**Signal overlap reference:**

| Signal group | Members | Pick one |
|-------------|---------|----------|
| **Churn frequency** | `churn`, `chunkChurn`, `density`, `burstActivity` | `chunkChurn` for function-level |
| **Churn magnitude** | `relativeChurnNorm`, `chunkRelativeChurn` | `chunkRelativeChurn` for function-level |
| **Age/freshness** | `age`, `recency` | `recency` for recent code, `age` for old |
| **Ownership** | `ownership`, `knowledgeSilo` | `knowledgeSilo` for binary silo detection |

**The fix:** Use 3-5 *orthogonal* signals that each add unique information:

```json
{
  "custom": {
    "chunkChurn": 0.25,
    "bugFix": 0.3,
    "imports": 0.25,
    "volatility": 0.2
  }
}
```

See [Custom Rerank Strategies](/agent-integration/search-strategies/custom-reranking).

## 9. Disabling Git Enrichment

**The mistake:** Running TeaRAGs with `TRAJECTORY_GIT_ENABLED=false` and never re-enabling it.

**Why it matters:** Git enrichment is **enabled by default** since v0.14. But if you have a non-git project, or explicitly disabled it, all reranking presets except `relevance` silently degrade to similarity-only scoring. The agent asks for `hotspots` or `techDebt` or `ownership`, but gets plain cosine similarity results. There's no error message -- the presets just don't work.

This also means:

- No `bugFixRate` -- can't identify code that keeps breaking
- No `commitCount` -- can't distinguish stable from churny code
- No `dominantAuthor` -- can't identify knowledge silos
- No `ageDays` -- can't find legacy code
- No `taskIds` -- can't trace code to tickets

**The fix:** Git enrichment is on by default. If you see degraded reranking, verify it wasn't explicitly disabled:

```bash
# Remove TRAJECTORY_GIT_ENABLED=false from your env or set it to true:
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e TRAJECTORY_GIT_ENABLED=true
```

Then reindex. Git enrichment runs concurrently with embedding and doesn't increase indexing time.

## 10. Single-Shot Search Instead of Iterative Refinement

**The mistake:** Running one search, taking the results, and moving on. If the first search doesn't find what the agent needs, it gives up or starts reading files randomly.

**Why it matters:** Semantic search is a discovery tool, not an answer engine. The first search narrows the candidate zone. Subsequent searches with different presets, tighter filters, or refined queries progressively focus the results.

**What iterative refinement looks like:**

| Step | Action | Purpose |
|------|--------|---------|
| 1 | `search_code` with `rerank: "relevance"` | **Discover** -- find the target area |
| 2 | `semantic_search` with `rerank: "hotspots"`, `metaOnly: true` | **Analyze** -- assess risk of the area |
| 3 | `semantic_search` with `rerank: "ownership"`, `metaOnly: true` | **Assess** -- identify who owns the code |
| 4 | Read specific files from results | **Act** -- make informed changes |
| 5 | `semantic_search` with `rerank: { custom: { imports: 0.7, similarity: 0.3 } }` | **Verify** -- confirm blast radius via `imports` fan-out |

See [Agentic Flow Template](/agent-integration/search-strategies/preset-mapping#agentic-flow-template) for the general pattern.

## 11. Hardcoding a Single Preset

**The mistake:** Setting `rerank: "hotspots"` (or any single preset) in the agent configuration and using it for every search, regardless of the task.

**Why it matters:** Different subtasks need different presets. Using `hotspots` for onboarding points newcomers at the most confusing, unstable code. Using `relevance` for everything ignores the valuable git signals. Using `stable` for bug investigation hides the recently changed code that likely caused the issue.

**Preset selection guide:**

| Task | Correct preset | Wrong preset |
|------|---------------|--------------|
| Bug investigation | `recent` then `hotspots` | `stable` (hides recent changes) |
| Finding templates | `stable` | `hotspots` (returns worst code) |
| Onboarding | `onboarding` | `hotspots` (confusing, unrepresentative) |
| Security audit | `securityAudit` | `relevance` (ignores age and path risk) |
| Code review | `codeReview` | `ownership` (wrong signal for reviewing changes) |

**The fix:** Select preset based on the current step of the workflow, not the overall task. See [Agent Task to Preset Mapping](/agent-integration/search-strategies/preset-mapping).

## 12. Modifying Legacy Code Without Risk Assessment

**The mistake:** The agent finds the code it needs to modify, makes the change, and moves on -- without checking churn history, bug-fix rate, or ownership.

**Why it matters:** Code with `ageDays > 90` and `bugFixRate > 50%` has been rewritten multiple times and keeps breaking. Any new patch has a high probability of introducing another bug. Code with `dominantAuthorPct > 90%` is a knowledge silo -- modifying it without consulting the owner risks breaking undocumented assumptions.

**Risk indicators:**

| Signal | Threshold | Risk |
|--------|-----------|------|
| `bugFixRate > 40%` + `ageDays > 60` | Legacy fragile | Use wrapper pattern + feature flag |
| `dominantAuthorPct > 85%` | Knowledge silo | Request review from the owner |
| `relativeChurn > 5.0` | Rewritten multiple times | Propose a rewrite, don't patch |
| `churnVolatility > 30` + `bugFixRate > 40%` | Pathological churn | Needs redesign, not more patches |

**The fix:** Run a danger zone check before any modification:

```json
semantic_search({
  "query": "target area",
  "rerank": "hotspots",
  "metaOnly": true,
  "limit": 10
})
```

See [Danger Zone Check](/agent-integration/agentic-data-driven-engineering/generation-modes#danger-zone-check-step-2) and [Generation Mode Switching](/agent-integration/agentic-data-driven-engineering/generation-modes).

## Naive RAG vs TeaRAGs

Many of the mistakes above stem from patterns that work for document-oriented RAG but fail for code search. Here's why:

| Naive RAG assumption | Why it fails for code | TeaRAGs approach |
|---------------------|----------------------|-----------------|
| "Similar = relevant" | A prototype and a production implementation look similar but differ in quality | Trajectory signals distinguish stable from volatile code |
| "More context = better" | LLM performance degrades with 20+ chunks ([context rot](https://arxiv.org/abs/2307.03172)) | `metaOnly`, tight `limit`, focused `pathPattern` |
| "Any match will do" | First hit might have 60% bug-fix rate | `stable` preset finds battle-tested code |
| "Flat ranked list" | Position 1 isn't always the best template | Reranking by quality signals, not just similarity |
| "Code is text" | Code has structure, ownership, evolution history | 19 git-derived signals at chunk level |
| "Search once, done" | Real engineering requires iterative refinement | Multi-step workflows with preset switching |
| "Retrieval = answers" | Semantic search is a candidate zone generator | Verification step with ripgrep and tree-sitter |

For the academic critique and established counter-arguments, see [Semantic Search: Criticism and Responses](/knowledge-base/semantic-search-criticism).

## Quick Checklist

Before shipping an agent workflow that uses TeaRAGs:

- [ ] Agent configuration (`CLAUDE.md` / `.cursorrules`) explicitly instructs the agent to use TeaRAGs
- [ ] Git enrichment is enabled (default — verify `TRAJECTORY_GIT_ENABLED` isn't overridden to `false`)
- [ ] Agent uses different rerank presets for different subtasks (not hardcoded)
- [ ] Templates are selected by quality signals, not just similarity
- [ ] Generated code is verified with ripgrep / tree-sitter before completion
- [ ] `metaOnly: true` is used for analytics queries
- [ ] `limit` is set to 5-10 for code generation, 15-20 for analytics
- [ ] Agent checks risk signals before modifying existing code

## See Also

- [Mental Model](/agent-integration/mental-model) -- the thinking shift from similarity-only to trajectory-aware retrieval
- [Search Strategies](/agent-integration/search-strategies) -- multi-step workflows with preset selection
- [Deep Codebase Analysis](/agent-integration/deep-codebase-analysis) -- metric interpretation, custom reranks
- [Agentic Data-Driven Engineering](/agent-integration/agentic-data-driven-engineering) -- generation modes, danger zone checks, verification
- [Semantic Search: Criticism and Responses](/knowledge-base/semantic-search-criticism) -- academic critique and counter-arguments
