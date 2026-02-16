---
title: Use Cases
sidebar_position: 7
---

import AiQuery from '@site/src/components/AiQuery';

# Semantic Search Use Cases

Semantic code search fundamentally changes how developers interact with large codebases. Instead of guessing names and grepping for exact strings, you describe what you're looking for in natural language — and the system finds implementations by meaning.

These use cases are drawn from real-world experience with an enterprise codebase (3.5M+ LOC, Ruby/Rails).

## Basic Use Cases

### 1. Intent-Based Code Discovery

**Problem:** Developers often know *what* the system does but not *how it's named* in code. In large codebases, naming can be non-obvious, historically accumulated, or inconsistent. Traditional search requires guessing identifiers.

**Solution:** Semantic search finds implementations by their meaning, not by function/class/file names. Results appear in seconds, consuming 2-3x fewer tokens than grep-based exploration.

**Example queries:**

<AiQuery>How does user authentication logic work?</AiQuery>
<AiQuery>How does the database handle connections?</AiQuery>
<AiQuery>How does error handling work for API requests?</AiQuery>

**Result:** The system returns code fragments implementing the functionality, even when they use different names, styles, or abstraction levels. Developers immediately see real implementation points without file-by-file navigation.

### 2. Investigation and Refactoring

**Problem:** When investigating issues or preparing for refactoring, developers need to find code that is *conceptually similar*, not just textually matching. In large codebases, the same pattern can be implemented differently with no shared naming — grep returns either too much noise or misses key locations.

**Solution:** Semantic search finds and groups code by conceptual similarity, revealing recurring architectural ideas and structures regardless of implementation style.

**Example queries:**

<AiQuery>Where is the singleton pattern used in this codebase?</AiQuery>
<AiQuery>How are middleware-like components implemented?</AiQuery>
<AiQuery>Are there multiple implementations of the same request processing logic?</AiQuery>

**Result:** The system returns fragments implementing the same pattern or architectural idea. Developers get a holistic view of where and how an approach is used — enabling informed refactoring decisions by revealing duplication and divergence.

### 3. Exploring Unfamiliar Codebases

**Problem:** During onboarding or working with inherited projects, developers don't know where to find key logic or how components are connected. Studying the repository structure and reading files sequentially takes significant time without providing quick architectural understanding.

**Solution:** Semantic search lets you start exploring a system by asking about its behavior and purpose, not by analyzing directory structure and naming conventions.

**Example queries:**

<AiQuery>How are core features implemented in this system?</AiQuery>
<AiQuery>How does background processing work here?</AiQuery>
<AiQuery>Where is the main business logic located?</AiQuery>

**Result:** Search returns key code fragments forming the architectural backbone of the system. Developers build a mental model faster, understand component roles and interactions — significantly accelerating codebase onboarding.

:::tip
Especially valuable for cross-domain development when the main domain experts are in a different timezone.
:::

### 4. Problem-Oriented Search

**Problem:** Developers formulate tasks in terms of problems and goals, but code rarely contains those formulations directly. Keyword search requires guessing the implementation and often returns irrelevant results.

**Solution:** Semantic search lets you find code by describing a problem or task in natural language, without being tied to specific implementations or entity names.

**Example queries:**

<AiQuery>How is rate limiting implemented in this application?</AiQuery>
<AiQuery>How does the system manage user profiles?</AiQuery>
<AiQuery>How does the application prevent abusive requests?</AiQuery>

**Result:** The system finds code fragments that solve the described problem, regardless of naming and structure. Developers immediately access relevant logic and can focus on solving the task rather than filtering search results.

:::tip
This approach has proven effective for diagnosing bugs — the author has fixed multiple production issues this way.
:::

### 5. Context for Code Generation

**Problem:** Before making changes or generating new code, it's crucial to understand which patterns and approaches are established in a specific codebase. Without this context, new changes often end up architecturally inconsistent with existing code.

**Solution:** Semantic search provides representative context from the entire codebase, extracting real examples and established patterns without additional analysis layers.

**Example queries:**

<AiQuery>How are similar features implemented in this codebase?</AiQuery>
<AiQuery>What validation patterns are commonly used here?</AiQuery>
<AiQuery>How does this project usually handle errors?</AiQuery>

**Result:** The system forms a coherent context of existing solutions and project practices. This improves the quality of subsequent changes — both manual and automated — and reduces the risk of introducing solutions that don't match the system's architecture and style.

> **Real-world note:** This was instrumental for migrating existing async operations to a new `BatchOperationWorker`. After manually rewriting one large batch operation, the author used semantic search to analyze the pattern — and the AI completed 95% of the next migration, leaving only minor manual corrections in complex business logic.

### 6. Cross-Language Pattern Discovery

**Problem:** In polyglot codebases (TypeScript + Python + Go, or Ruby + JavaScript), the same concept — rate limiting, caching, authentication — is implemented differently in each language. Grep can't find patterns across languages because naming, syntax, and idioms differ. Developers end up searching each language separately.

**Solution:** Semantic search matches by meaning, not syntax. A single query returns implementations from all indexed languages — revealing how different parts of the stack solve the same problem.

**Example queries:**

<AiQuery>How is caching implemented across all languages in this project?</AiQuery>
<AiQuery>Find all retry logic regardless of language</AiQuery>
<AiQuery>Show me validation patterns in both backend and frontend</AiQuery>

**Result:** The system returns conceptually matching code from TypeScript services, Python workers, Go microservices — whatever is in the index. Developers see how the same concern is handled across the stack, enabling consistent cross-language refactoring and pattern alignment.

:::tip
Especially powerful for full-stack projects where backend and frontend handle the same domain concepts with completely different naming.
:::

## Git Enrichment Use Cases {#git-enrichment-use-cases}

These use cases require `CODE_ENABLE_GIT_METADATA=true` during indexing. They leverage [19 git-derived signals](/usage/git-enrichments) — churn, stability, authorship, bug-fix rates — at function-level granularity.

### 7. Hotspot Detection

**Problem:** Not all frequently-changed code is problematic, but code that changes often *and* has a high bug-fix rate is a strong defect signal. Without git metadata, you can't distinguish stable evolution from churny trouble spots.

**Solution:** Use the `hotspots` rerank preset to surface code with high churn, high bug-fix rate, and recent burst activity — at chunk (function) level.

<AiQuery>Find bug-prone areas in the payment processing code</AiQuery>
<AiQuery>Show me high-churn functions with many bug fixes</AiQuery>

### 8. Knowledge Silo Detection

**Problem:** When a single developer owns a critical area of code (bus factor = 1), the team faces risk. Traditional tools require manual `git shortlog` analysis across hundreds of files.

**Solution:** Use the `ownership` rerank preset or filter by `git.dominantAuthorPct >= 90` to instantly surface single-owner code.

<AiQuery>Find code with a single dominant author</AiQuery>
<AiQuery>Which critical code has only one contributor?</AiQuery>

### 9. Tech Debt Assessment

**Problem:** Legacy code that keeps accumulating bug fixes is a prime candidate for redesign. Identifying these files manually requires cross-referencing git history with code structure.

**Solution:** Use the `techDebt` rerank preset to find old, high-churn code with elevated bug-fix rates.

<AiQuery>Show me legacy code with high bug-fix rates</AiQuery>
<AiQuery>Find tech debt candidates in the core business logic</AiQuery>

### 10. Code Review Preparation

**Problem:** Before a code review, you need to understand what changed recently, how actively an area is being developed, and whether the changes touch stable or volatile code.

**Solution:** Use the `codeReview` rerank preset to surface recent changes with activity intensity and churn context.

<AiQuery>Show me code changed in the last week</AiQuery>
<AiQuery>What recent changes touched authentication?</AiQuery>

### 11. Incident-Driven Search

**Problem:** During incidents, you need to quickly find recently changed code near the bug, assess blast radius, and identify what else might be affected.

**Solution:** Filter by `git.ageDays <= 7` to find recent changes, combine with semantic search to find related logic.

<AiQuery>Find recently changed code in the payment flow</AiQuery>
<AiQuery>What changed near the database connection logic this week?</AiQuery>

### 12. Security Audit

**Problem:** Old code in security-sensitive paths (auth, crypto, permissions) that has low contributor count and irregular change patterns is a high-risk area.

**Solution:** Use the `securityAudit` rerank preset to surface old critical code in sensitive paths.

<AiQuery>Find old authentication code that needs review</AiQuery>
<AiQuery>Show me security-critical code with high volatility</AiQuery>

### 13. Engineering Archaeology

**Problem:** Understanding *why* code evolved the way it did — tracing decisions through commit history, finding patterns of change, and identifying which tickets drove modifications.

**Solution:** Use `git.taskIds` to trace code back to tickets, and churn signals to understand evolution patterns.

<AiQuery>What changes were made for ticket PROJ-123?</AiQuery>
<AiQuery>Show me how the retry logic evolved over time</AiQuery>

### 14. Data-Driven Template Selection

**Problem:** When generating new code or copying an existing pattern, agents and developers grab the first search hit. But the first result might be a prototype, a reverted approach, or code with a 60% bug-fix rate. Similarity alone says nothing about code quality.

**Solution:** Use the `stable` rerank preset to find battle-tested, low-bug implementations as templates. The system ranks results by low churn and low bug-fix rate — code that has survived production without constant patching.

<AiQuery>Find stable implementations of request validation to use as a template</AiQuery>
<AiQuery>Show me low-churn examples of background job processing</AiQuery>

**What to look for in results:**

- `commitCount: 1-3` — not rewritten many times
- `bugFixRate < 20%` — few bug fixes needed
- `ageDays > 60` — code has survived in production

:::tip
Combine with the `ownership` preset to also match the domain expert's coding style — producing code that is both stable *and* stylistically consistent with the area you're working in.
:::

### 15. Onboarding Map

**Problem:** When a new developer joins the team, they need to find entry points into the codebase — documented, stable code that explains how the system works. Pointing newcomers at hotspots or tech debt candidates is confusing and unrepresentative.

**Solution:** Use the `onboarding` rerank preset to surface well-documented, stable code — the safest starting points for understanding the system.

<AiQuery>Find documented entry points for understanding this system</AiQuery>
<AiQuery>Show me stable, well-documented code in the core business logic</AiQuery>

**How it differs from general exploration ([Use Case 3](#3-exploring-unfamiliar-codebases)):** Exploration finds code by *concept*. Onboarding prioritizes code by *teachability* — documentation quality and low churn. The `onboarding` preset actively avoids volatile, frequently-patched code that would confuse a newcomer.

### 16. Refactoring Prioritization

**Problem:** Developers know "we need to refactor" but struggle to identify *what* to refactor first. Not all high-churn code is worth refactoring — some changes frequently because the domain is complex. The best refactoring candidates are large, volatile functions with high bug-fix rates.

**Solution:** Use the `refactoring` rerank preset to find large, churny, volatile chunks with high bug-fix rates — the functions that would benefit most from being split or redesigned.

<AiQuery>Find the best refactoring candidates in the codebase</AiQuery>
<AiQuery>Show me large functions that keep breaking</AiQuery>

**What makes a good refactoring candidate:**

- High `chunkChurnRatio` — this function is responsible for most of the file's churn
- Large `chunkSize` — many lines of code in one function
- High `bugFixRate` — a large share of commits are fixes
- High `churnVolatility` — irregular bursts of patching

**How it differs from Tech Debt ([Use Case 9](#9-tech-debt-assessment)):** Tech debt focuses on *age* — old code that keeps accumulating patches. Refactoring focuses on *size and structure* — large functions that should be split, regardless of age. A 2-month-old 200-line function with 8 bug fixes is a refactoring candidate, not tech debt.

## More Use Cases

Beyond the categories above, semantic search with git enrichments enables:

- **Implicit business rule discovery** — find rules scattered across the codebase by describing the business concept, not the implementation
- **Engineering guideline extraction** — generate guidelines from real code patterns by finding stable, well-owned implementations across the codebase
- **Audit and certification prep** — find personal data handling, access checks, logging patterns using semantic queries + path filtering

## Semantic Search vs Explore Mode

Empirical comparison (searching for async workflow implementation):

| Metric | Without RAG (Explore) | With RAG (TeaRAGs) |
|--------|----------------------|-------------------|
| **Discovery time** | Baseline | **~2x faster** |
| **Token consumption** | Baseline | **~2x less** |
| **Result quality** | Good | Comparable |

The main value is not in result quality alone — it's in **speed and efficiency** of getting to the right code. The dinosaur finds what you need before your tea gets cold.

## Building Agent Workflows with TeaRAGs

Ready to integrate these use cases into your AI agent? Start with the mental model — understanding *how* agents should reason about code signals — then configure multi-tool search strategies for your workflow.

- [Mental Model](/agent-integration/mental-model) — how trajectory-aware RAG changes the way agents reason about code quality and trust
- [Search Strategies](/agent-integration/search-strategies) — multi-step agent workflows, reranking presets, and combining TeaRAGs with tree-sitter and ripgrep

## Next Steps

- [Query Modes](/usage/query-modes) — semantic, hybrid, filtered, and code search
- [Core Concepts: Code Vectorization](/introduction/core-concepts/code-vectorization) — how the indexing pipeline works
- [Semantic Search Criticism](/knowledge-base/semantic-search-criticism) — limitations, failure modes, and how TeaRAGs addresses them
