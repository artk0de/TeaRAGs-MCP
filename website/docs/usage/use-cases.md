---
title: Use Cases
sidebar_position: 1
---

import AiQuery from '@site/src/components/AiQuery';

# Semantic Search Use Cases

Semantic code search fundamentally changes how developers interact with large
codebases. Instead of guessing names and grepping for exact strings, you
describe what you're looking for in natural language — and the system finds
implementations by meaning.

These use cases are drawn from real-world experience with an enterprise codebase
(3.5M+ LOC, Ruby/Rails).

## Basic Use Cases

### 1. Intent-Based Code Discovery

**Problem:** Developers often know _what_ the system does but not _how it's
named_ in code. In large codebases, naming can be non-obvious, historically
accumulated, or inconsistent. Traditional search requires guessing identifiers.

**Solution:** Semantic search finds implementations by their meaning, not by
function/class/file names. Results appear in seconds, consuming 2-3x fewer
tokens than grep-based exploration.

**Skill:** `/tea-rags:explore [your question]` — breadth-first discovery by intent.

**Example queries:**

<AiQuery>/tea-rags:explore how does user authentication logic work?</AiQuery>
<AiQuery>/tea-rags:explore how does the database handle connections?</AiQuery>
<AiQuery>/tea-rags:explore how does error handling work for API requests?</AiQuery>

**Result:** The system returns code fragments implementing the functionality,
even when they use different names, styles, or abstraction levels. Developers
immediately see real implementation points without file-by-file navigation.

### 2. Investigation and Refactoring

**Problem:** When investigating issues or preparing for refactoring, developers
need to find code that is _conceptually similar_, not just textually matching.
In large codebases, the same pattern can be implemented differently with no
shared naming — grep returns either too much noise or misses key locations.

**Solution:** Semantic search finds and groups code by conceptual similarity,
revealing recurring architectural ideas and structures regardless of
implementation style.

**Skill:** `/tea-rags:explore [pattern or concept]` — `pattern-search` is invoked automatically for "find all" intent.

**Example queries:**

<AiQuery>/tea-rags:explore where is the singleton pattern used in this codebase?</AiQuery>
<AiQuery>/tea-rags:explore how are middleware-like components implemented?</AiQuery>
<AiQuery>/tea-rags:explore are there multiple implementations of the same request processing logic?</AiQuery>

**Result:** The system returns fragments implementing the same pattern or
architectural idea. Developers get a holistic view of where and how an approach
is used — enabling informed refactoring decisions by revealing duplication and
divergence.

### 3. Exploring Unfamiliar Codebases

**Problem:** During onboarding or working with inherited projects, developers
don't know where to find key logic or how components are connected. Studying the
repository structure and reading files sequentially takes significant time
without providing quick architectural understanding.

**Solution:** Semantic search lets you start exploring a system by asking about
its behavior and purpose, not by analyzing directory structure and naming
conventions.

**Skill:** `/tea-rags:explore [feature or area]` — builds a mental model of the system.

**Example queries:**

<AiQuery>/tea-rags:explore how are core features implemented in this system?</AiQuery>
<AiQuery>/tea-rags:explore how does background processing work here?</AiQuery>
<AiQuery>/tea-rags:explore where is the main business logic located?</AiQuery>

**Result:** Search returns key code fragments forming the architectural backbone
of the system. Developers build a mental model faster, understand component
roles and interactions — significantly accelerating codebase onboarding.

:::tip

Especially valuable for cross-domain development when the main domain
experts are in a different timezone.

:::

### 4. Problem-Oriented Search

**Problem:** Developers formulate tasks in terms of problems and goals, but code
rarely contains those formulations directly. Keyword search requires guessing
the implementation and often returns irrelevant results.

**Solution:** Semantic search lets you find code by describing a problem or task
in natural language, without being tied to specific implementations or entity
names.

**Skill:** `/tea-rags:explore [goal]` for discovery · `/tea-rags:bug-hunt [symptom]` when diagnosing an active bug.

**Example queries:**

<AiQuery>/tea-rags:explore how is rate limiting implemented in this application?</AiQuery>
<AiQuery>/tea-rags:explore how does the system manage user profiles?</AiQuery>
<AiQuery>/tea-rags:bug-hunt users report duplicate requests are not blocked</AiQuery>

**Result:** The system finds code fragments that solve the described problem,
regardless of naming and structure. Developers immediately access relevant logic
and can focus on solving the task rather than filtering search results.

:::tip

This approach has proven effective for diagnosing bugs — the author has
fixed multiple production issues this way.

:::

### 5. Context for Code Generation

**Problem:** Before making changes or generating new code, it's crucial to
understand which patterns and approaches are established in a specific codebase.
Without this context, new changes often end up architecturally inconsistent with
existing code.

**Solution:** Semantic search provides representative context from the entire
codebase, extracting real examples and established patterns without additional
analysis layers.

**Skill:** `/tea-rags:data-driven-generation` — selects a generation strategy based on area signals. Invoke `/tea-rags:explore [area]` first if context isn't already gathered.

**Example queries:**

<AiQuery>/tea-rags:explore before I add a new validation rule — how does validation work in the API module?</AiQuery>
<AiQuery>/tea-rags:data-driven-generation</AiQuery>

**Result:** The system forms a coherent context of existing solutions and
project practices. This improves the quality of subsequent changes — both manual
and automated — and reduces the risk of introducing solutions that don't match
the system's architecture and style.

> **Real-world note:** This was instrumental for migrating existing async
> operations to a new `BatchOperationWorker`. After manually rewriting one large
> batch operation, the author used semantic search to analyze the pattern — and
> the AI completed 95% of the next migration, leaving only minor manual
> corrections in complex business logic.

### 6. Cross-Language Pattern Discovery

**Problem:** In polyglot codebases (TypeScript + Python + Go, or Ruby +
JavaScript), the same concept — rate limiting, caching, authentication — is
implemented differently in each language. Grep can't find patterns across
languages because naming, syntax, and idioms differ. Developers end up searching
each language separately.

**Solution:** Semantic search matches by meaning, not syntax. A single query
returns implementations from all indexed languages — revealing how different
parts of the stack solve the same problem.

**Skill:** `/tea-rags:explore [concept]` — `pattern-search` is invoked automatically when intent is "find all".

**Example queries:**

<AiQuery>/tea-rags:explore how is caching implemented across all languages in this project?</AiQuery>
<AiQuery>/tea-rags:explore find all retry logic regardless of language</AiQuery>
<AiQuery>/tea-rags:explore show me validation patterns in both backend and frontend</AiQuery>

**Result:** The system returns conceptually matching code from TypeScript
services, Python workers, Go microservices — whatever is in the index.
Developers see how the same concern is handled across the stack, enabling
consistent cross-language refactoring and pattern alignment.

:::tip

Especially powerful for full-stack projects where backend and frontend
handle the same domain concepts with completely different naming.

:::

## Git Enrichment Use Cases {#git-enrichment-use-cases}

These use cases require `TRAJECTORY_GIT_ENABLED=true` during indexing. They
leverage [20+ git-derived signals](/usage/advanced/git-enrichments) — churn,
stability, authorship, bug-fix rates — at function-level granularity.

### 7. Hotspot Detection

**Problem:** Not all frequently-changed code is problematic, but code that
changes often _and_ has a high bug-fix rate is a strong defect signal. Without
git metadata, you can't distinguish stable evolution from churny trouble spots.

**Solution:** Use the `hotspots` rerank preset to surface code with high churn,
high bug-fix rate, and recent burst activity — at chunk (function) level.

**Skill:** `/tea-rags:risk-assessment [scope]` — runs a 4-preset scan that includes `hotspots`.

<AiQuery>/tea-rags:risk-assessment payment processing code</AiQuery>
<AiQuery>/tea-rags:risk-assessment src/api</AiQuery>

### 8. Knowledge Silo Detection

**Problem:** When a single developer owns a critical area of code (bus factor =
1), the team faces risk. Traditional tools require manual `git shortlog`
analysis across hundreds of files.

**Solution:** Use the `ownership` rerank preset or filter by
`git.dominantAuthorPct >= 90` to instantly surface single-owner code.

**Skill:** `/tea-rags:explore [area] — who owns this` · overlay shows `dominantAuthor`, `dominantAuthorPct`, `knowledgeSilo`.

<AiQuery>/tea-rags:explore who owns the payment processing code?</AiQuery>
<AiQuery>/tea-rags:explore which critical code has only one contributor?</AiQuery>

### 9. Tech Debt Assessment

**Problem:** Legacy code that keeps accumulating bug fixes is a prime candidate
for redesign. Identifying these files manually requires cross-referencing git
history with code structure.

**Solution:** Use the `techDebt` rerank preset to find old, high-churn code with
elevated bug-fix rates.

**Skill:** `/tea-rags:risk-assessment [scope]` — `techDebt` is one of its 4 presets.

<AiQuery>/tea-rags:risk-assessment core business logic</AiQuery>
<AiQuery>/tea-rags:risk-assessment src/legacy</AiQuery>

### 10. Code Review Preparation

**Problem:** Before a code review, you need to understand what changed recently,
how actively an area is being developed, and whether the changes touch stable or
volatile code.

**Solution:** Use the `codeReview` rerank preset to surface recent changes with
activity intensity and churn context.

**Skill:** `/tea-rags:explore [area] — what changed recently` — `explore` uses `rank_chunks` with `codeReview` preset for recent-change intent.

<AiQuery>/tea-rags:explore what changed recently in authentication?</AiQuery>
<AiQuery>/tea-rags:explore what was touched in the payment flow this sprint?</AiQuery>

### 11. Incident-Driven Search

**Problem:** During incidents, you need to quickly find recently changed code
near the bug, assess blast radius, and identify what else might be affected.

**Solution:** Filter by `git.ageDays <= 7` to find recent changes, combine with
semantic search to find related logic.

**Skill:** `/tea-rags:bug-hunt [symptom]` — directs search toward historically buggy + recently touched code.

<AiQuery>/tea-rags:bug-hunt payments fail intermittently since yesterday's deploy</AiQuery>
<AiQuery>/tea-rags:bug-hunt database connections drop under load</AiQuery>

### 12. Security Audit

**Problem:** Old code in security-sensitive paths (auth, crypto, permissions)
that has low contributor count and irregular change patterns is a high-risk
area.

**Solution:** Use the `securityAudit` rerank preset to surface old critical code
in sensitive paths.

**Skill:** `/tea-rags:risk-assessment [scope]` — `securityAudit` is one of its 4 presets.

<AiQuery>/tea-rags:risk-assessment authentication and authorization</AiQuery>
<AiQuery>/tea-rags:risk-assessment src/auth src/crypto</AiQuery>

### 13. Engineering Archaeology

**Problem:** Understanding _why_ code evolved the way it did — tracing decisions
through commit history, finding patterns of change, and identifying which
tickets drove modifications.

**Solution:** Use `git.taskIds` to trace code back to tickets, and churn signals
to understand evolution patterns.

**Skill:** `/tea-rags:explore [symbol or concept]` — overlay surfaces `taskIds`, `ageDays`, `commitCount`, `dominantAuthor`.

<AiQuery>/tea-rags:explore what changes were made for ticket PROJ-123?</AiQuery>
<AiQuery>/tea-rags:explore how did the retry logic evolve over time?</AiQuery>

### 14. Data-Driven Template Selection

**Problem:** When generating new code or copying an existing pattern, agents and
developers grab the first search hit. But the first result might be a prototype,
a reverted approach, or code with a 60% bug-fix rate. Similarity alone says
nothing about code quality.

**Solution:** Use the `stable` rerank preset to find battle-tested, low-bug
implementations as templates. The system ranks results by low churn and low
bug-fix rate — code that has survived production without constant patching.

**Skill:** `/tea-rags:data-driven-generation` — selects `proven` or `stable` strategy automatically based on area signals.

<AiQuery>/tea-rags:explore before I add a new validator — show me stable validation patterns</AiQuery>
<AiQuery>/tea-rags:data-driven-generation</AiQuery>

**What to look for in results:**

- `commitCount: 1-3` — not rewritten many times
- `bugFixRate < 20%` — few bug fixes needed
- `ageDays > 60` — code has survived in production

:::tip

Combine with the `ownership` preset to also match the domain expert's
coding style — producing code that is both stable _and_ stylistically consistent
with the area you're working in.

:::

### 15. Onboarding Map

**Problem:** When a new developer joins the team, they need to find entry points
into the codebase — documented, stable code that explains how the system works.
Pointing newcomers at hotspots or tech debt candidates is confusing and
unrepresentative.

**Solution:** Use the `onboarding` rerank preset to surface well-documented,
stable code — the safest starting points for understanding the system.

**Skill:** `/tea-rags:explore [area] — entry points` — `onboarding` preset prioritizes docs + stability.

<AiQuery>/tea-rags:explore entry points for understanding this system</AiQuery>
<AiQuery>/tea-rags:explore stable, well-documented code in the core business logic</AiQuery>

**How it differs from general exploration
([Use Case 3](#3-exploring-unfamiliar-codebases)):** Exploration finds code by
_concept_. Onboarding prioritizes code by _teachability_ — documentation quality
and low churn. The `onboarding` preset actively avoids volatile,
frequently-patched code that would confuse a newcomer.

### 16. Refactoring Prioritization

**Problem:** Developers know "we need to refactor" but struggle to identify
_what_ to refactor first. Not all high-churn code is worth refactoring — some
changes frequently because the domain is complex. The best refactoring
candidates are large, volatile functions with high bug-fix rates.

**Solution:** Use the `refactoring` rerank preset to find large, churny,
volatile chunks with high bug-fix rates — the functions that would benefit most
from being split or redesigned.

**Skill:** `/tea-rags:explore [broad scope] — what to refactor` — `refactoring-scan` is invoked automatically for broad antipattern/refactor intent.

<AiQuery>/tea-rags:explore what to refactor in the ingest domain</AiQuery>
<AiQuery>/tea-rags:explore cleanup candidates in src/core</AiQuery>

**What makes a good refactoring candidate:**

- High `chunkChurnRatio` — this function is responsible for most of the file's
  churn
- Large `chunkSize` — many lines of code in one function
- High `bugFixRate` — a large share of commits are fixes
- High `churnVolatility` — irregular bursts of patching

**How it differs from Tech Debt ([Use Case 9](#9-tech-debt-assessment)):** Tech
debt focuses on _age_ — old code that keeps accumulating patches. Refactoring
focuses on _size and structure_ — large functions that should be split,
regardless of age. A 2-month-old 200-line function with 8 bug fixes is a
refactoring candidate, not tech debt.

## More Use Cases

Beyond the categories above, semantic search with git enrichments enables:

- **Implicit business rule discovery** — find rules scattered across the
  codebase by describing the business concept, not the implementation
- **Engineering guideline extraction** — generate guidelines from real code
  patterns by finding stable, well-owned implementations across the codebase
- **Audit and certification prep** — find personal data handling, access checks,
  logging patterns using semantic queries + path filtering

## Semantic Search vs Explore Mode

Empirical comparison (searching for async workflow implementation):

| Metric                | Without RAG (Explore) | With RAG (TeaRAGs) |
| --------------------- | --------------------- | ------------------ |
| **Discovery time**    | Baseline              | **~2x faster**     |
| **Token consumption** | Baseline              | **~2x less**       |
| **Result quality**    | Good                  | Comparable         |

The main value is not in result quality alone — it's in **speed and efficiency**
of getting to the right code. The dinosaur finds what you need before your tea
gets cold.

## Building Agent Workflows with TeaRAGs

Ready to integrate these use cases into your AI agent? Start with the mental
model — understanding _how_ agents should reason about code signals — then
configure multi-tool search strategies for your workflow.

- [Mental Model](/agent-integration/mental-model) — how trajectory-aware RAG
  changes the way agents reason about code quality and trust
- [Search Strategies](/agent-integration/search-strategies) — multi-step agent
  workflows, reranking presets, and combining TeaRAGs with tree-sitter and
  ripgrep

## Next Steps

- [Query Modes](/usage/advanced/query-modes) — semantic, hybrid, filtered, and
  code search
- [Core Concepts: Code Vectorization](/introduction/core-concepts/code-vectorization)
  — how the indexing pipeline works
- [Semantic Search Criticism](/knowledge-base/semantic-search-criticism) —
  limitations, failure modes, and how TeaRAGs addresses them
