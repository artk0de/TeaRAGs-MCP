# Data-Driven Generation — Claude Plugin Design Spec

## Goal

Claude plugin for tea-rags that ships a search cascade rule and a
data-driven code generation skill with label-based strategy selection.
Users can override strategies via project-scoped skills.

Part of epic `tea-rags-mcp-0mz` (Claude Plugin: tea-rags orchestration layer).

## Plugin Structure

```
plugin/
  .claude-plugin/
    plugin.json
  rules/
    search-cascade.md
  skills/
    data-driven-generation/
      SKILL.md
      strategies/
        standard.md
        conservative.md
        stabilization.md
        defensive.md
    bug-hunt/
      SKILL.md
```

### plugin.json

```json
{
  "name": "tea-rags",
  "description": "Data-driven code generation strategies powered by TeaRAGs git signals",
  "version": "0.1.0",
  "author": { "name": "TeaRAGs" },
  "keywords": ["code-generation", "git-signals", "strategies"]
}
```

Plugin lives in `plugin/` subdirectory of tea-rags-mcp repo. Published
separately. Depends on tea-rags MCP server (skills call `get_index_metrics`,
`semantic_search`, `hybrid_search`, `find_similar`).

---

## Rule: search-cascade

**File:** `rules/search-cascade.md`

Always loaded into context. Defines the Three-Tool Cascade and mandatory
verification after every semantic search.

### Content

The cascade ordering: **TeaRAGs (meaning) → tree-sitter (structure) →
ripgrep (exact text)**.

| Axis | Tool | Use for |
|------|------|---------|
| Meaning / intent | TeaRAGs (semantic_search, hybrid_search, find_similar, rank_chunks) | "How does X work?", discovery, pattern finding, signal-based ranking |
| Structure / shape | tree-sitter | Classes, methods, signatures, hierarchy |
| Exact text / tokens | ripgrep | Call-sites, exports, identifiers, TODOs, config |

### Mandatory Verify

Every semantic search result is a **candidate**, not proof. After each
TeaRAGs call, the agent MUST verify:

1. **tree-sitter** — structural overview of found files (methods, signatures)
2. **ripgrep** — confirm call-sites, exports, actual identifiers exist
3. **Fallback** — if ripgrep/tree-sitter MCP unavailable, use built-in
   Grep/Glob tools

0 ripgrep matches for a referenced identifier = false candidate, discard.

### Anti-patterns

- ripgrep for "how does X work" → use TeaRAGs
- TeaRAGs for exact method name → use ripgrep
- tree-sitter for text search → use ripgrep
- Skipping verify → hallucinated identifiers in generated code

### search_code prohibition

`search_code` is a convenience tool for human-readable output. Agents MUST
use `semantic_search`, `hybrid_search`, or `find_similar` for structured
JSON with full metadata and overlay labels. `search_code` does not return
labels or structured signals.

---

## Skill: data-driven-generation

**File:** `skills/data-driven-generation/SKILL.md`

### Frontmatter

```yaml
---
name: data-driven-generation
description: Use when generating or modifying code — selects generation
  strategy based on git signal labels from TeaRAGs
---
```

### Prerequisites

1. Call `get_index_metrics` once per session to load signal thresholds and
   labelMap. If call fails (MCP unavailable) → abort with message
   "tea-rags MCP server required. Install and configure before using this skill."
2. This provides codebase-specific percentile boundaries for all labels.

### Reading Overlay Labels

Overlay labels live in `rankingOverlay.file.<signal>` and
`rankingOverlay.chunk.<signal>`. Each labeled value is
`{ value: N, label: "high" }`.

For danger assessment and strategy selection, read **file-level** labels:
`rankingOverlay.file.bugFixRate.label`, `rankingOverlay.file.ageDays.label`,
etc.

For anti-pattern and template evaluation, also read **chunk-level** labels:
`rankingOverlay.chunk.commitCount.label`, `rankingOverlay.chunk.churnRatio.label`.

File-level signals: `commitCount`, `ageDays`, `bugFixRate`, `dominantAuthorPct`,
`contributorCount`, `changeDensity`, `churnVolatility`, `relativeChurn`,
`recencyWeightedFreq`.

Chunk-level signals: `commitCount`, `ageDays`, `bugFixRate`, `churnRatio`,
`contributorCount`, `changeDensity`, `churnVolatility`, `relativeChurn`,
`recencyWeightedFreq`.

### Workflow (8 steps)

#### Step 1: DISCOVER + VERIFY

Find target area: `semantic_search` by task query, limit=10.
Verify per search-cascade rule:
1. tree-sitter — structural overview of found files
2. ripgrep — confirm call-sites, exports
3. Discard unverified candidates

#### Step 2: DANGER CHECK (two-stage)

**Stage 1 — File-level scan:**

- `semantic_search` rerank=hotspots, metaOnly=true, pathPattern=\<area\>
- `hybrid_search` query="TODO FIXME HACK deprecated" pathPattern=\<area\>

Read file-level overlay labels for broad risk picture.

**Stage 2 — Chunk-level drill-down:**

For files with elevated signals (file.bugFixRate "concerning"/"critical",
file.commitCount "high"/"extreme"), drill into specific functions:

- `semantic_search` with custom weights
  `{ chunkChurn: 0.3, bugFix: 0.3, chunkRelativeChurn: 0.2, similarity: 0.2 }`,
  pathPattern=\<specific file\>

Read chunk-level overlay: chunk.bugFixRate, chunk.churnRatio,
chunk.commitCount. A file may be "concerning" overall but contain one
"critical" function and several "healthy" ones — target the specific
function, not the whole file.

**Strategy selection** — based on **chunk-level** labels of the target code:

| Condition (chunk-level labels of target) | Strategy |
|------------------------------------------|----------|
| chunk.bugFixRate "critical" + file.ageDays "old"/"legacy" | DEFENSIVE |
| chunk.commitCount "extreme" + file.churnVolatility "erratic" | STABILIZATION |
| file.ageDays "legacy" + chunk.commitCount "low" | CONSERVATIVE |
| No match | STANDARD |

Note: `rerank=hotspots` overlay mask includes `bugFixRate`,
`churnVolatility`, `recencyWeightedFreq`, `relativeChurn`, `ageDays` at
file level and `commitCount`, `churnRatio` at chunk level. For signals not
in mask, use custom weights to surface them.

When no hard rule matches, use **judgment framework**. Signal axes:

- **Risk** grows: bugFixRate healthy→concerning→critical,
  churnVolatility stable→erratic
- **Stability** grows: ageDays recent→legacy,
  commitCount low = less churn
- **Confidence** falls: commitCount "low" = few data points,
  ageDays "recent" = unproven

**Autonomous Judgment Protocol:**

When label combination does not match any hard rule or user-defined
strategy:

1. **Decide** — choose closest strategy or blend based on signal axes
2. **Justify** — explain to developer:
   - Which labels were observed
   - Which axes influenced the decision
   - What specific actions this means
3. **Ask if uncertain** — if signals conflict, present dilemma with
   options, let developer choose

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

High risk without hard match → escalate to user with signal summary.

Load strategy: check for project skill `strategy-<mode>`.
If found → use project strategy. If not → read `strategies/<mode>.md`.

#### Step 3: TEMPLATE

`find_similar` from best verified result + rerank=stable.
Fallback: `semantic_search` custom weights
`{ similarity: 0.3, stability: 0.4, age: 0.3 }`.

Quality gate by overlay labels:
- **Ideal**: commitCount "low"/"typical" + ageDays "old"/"legacy" +
  bugFixRate "healthy" + dominantAuthorPct "concentrated"/"silo"
- **Acceptable**: one non-ideal signal
- **Reject**: bugFixRate "critical" OR
  (ageDays "recent" + commitCount "low")

Verify template per search-cascade rule.

#### Step 4: ANTI-CHECK

`semantic_search` rerank=hotspots, same query.
Results with file.bugFixRate "critical" or chunk.churnRatio "concentrated"
= anti-patterns. Note: `churnRatio` is chunk-level only — read from
`rankingOverlay.chunk.churnRatio.label`. Read code, note specific problems
(nested ifs, mixed responsibilities, magic numbers). Do NOT copy these
patterns.

#### Step 5: STYLE

1. `semantic_search` rerank=ownership, metaOnly=true, pathPattern=\<area\>
   → identify dominantAuthor
2. `semantic_search` author=\<dominantAuthor\>, pathPattern=\<area\>,
   limit=5 → read code, analyze error handling, naming, structure

Adapt to ownership profile:

| file.dominantAuthorPct | file.contributorCount | Behavior |
|---|---|---|
| "silo" | "solo" | Match exactly. Don't refactor. Flag owner for review. |
| "concentrated" | "solo"/"team" | Follow dominant patterns, minor flexibility. |
| "mixed" | any | Follow dominant with awareness of alternatives. |
| "shared" | "team"/"crowd" | Project conventions. Opportunity to unify. |

Note: chunk-level `contributorCount` only has labels "solo" and "crowd"
(no "team"). Use file-level for ownership assessment.

#### Step 6: GENERATE

Apply selected strategy + style. Generate code.

#### Step 7: VERIFY GENERATED

Verify all referenced identifiers per search-cascade rule:
1. ripgrep every function name, import path, type name
2. Fallback: Grep tool if ripgrep unavailable
3. tree-sitter: confirm structural patterns (signatures, hierarchies)
4. 0 matches = hallucinated identifier → fix before committing

#### Step 8: IMPACT

`semantic_search` rerank with custom weights
`{ imports: 0.5, churn: 0.3, ownership: 0.2 }`, metaOnly=true.
Warn on high-import modules.
Flag shared taskIds → coordinated change requirement.

Note: `impactAnalysis` preset is available for `semantic_search` and
`hybrid_search`. If unavailable, use custom weights above as fallback.

### Skipping Steps

- Hotfix → user provides exact file/location, skip to Step 6, Step 7 MANDATORY
- Greenfield (no existing code) → skip Steps 2, 4, 5
- Small known change → skip Step 3
- **Step 7 is NEVER skipped**

---

## Base Strategies (supporting files)

### strategies/standard.md

**When:** No red flags in target area. Default mode.

**Approach:**
- Find stable template (Step 3) and follow it
- Match domain owner's patterns (Step 5)
- Generate clean, idiomatic code
- Standard test coverage
- Standard code review process

### strategies/conservative.md

**When:** ageDays "legacy" + commitCount "low" — old, untouched code.

**Approach:**
- Minimal changes — don't refactor, don't optimize
- Preserve signatures and return types exactly
- Don't move code between files
- Add new functionality alongside, not instead of, existing code
- Err on the side of duplication over abstraction
- Do not introduce new patterns into this area

**Why:** Code untouched for 6+ months has undocumented assumptions.
Callers depend on exact behavior including edge cases.

### strategies/stabilization.md

**When:** commitCount "extreme" + churnVolatility "erratic" — high-churn,
volatile code.

**Approach:**
- Simplify branching — reduce cyclomatic complexity
- Extract nested conditionals into named methods
- Reduce code paths through the function
- Add explicit logging at decision points
- Design for testability — pure functions where possible
- If churnRatio "concentrated" — consider splitting the function
- Do not add new features on top — simplify first

**Why:** High-churn volatile code has accumulated complexity from sequential
patches. Each patch added a condition, a fallback, a special case. Needs
simplification, not more layers.

### strategies/defensive.md

**When:** bugFixRate "critical" + ageDays "old" or "legacy" — legacy code
with history of bugs.

**Approach:**
- Never delete old code — use wrapper pattern
- Add feature flags for instant rollback
- Keep old code path entirely intact as fallback
- Write comprehensive tests covering existing edge cases
- Plan gradual rollout: per-user, per-tenant, or percentage-based
- Document cleanup date (remove wrapper after 30 days stable)
- If dominantAuthorPct "silo" — request review from the owner

**Why:** This code has proven that straightforward modifications break it.
Wrapper pattern provides rollback that direct editing does not.

---

## User Override Convention

### How it works

Users create project-scoped skills named `strategy-<mode>` in
`.claude/skills/strategy-<mode>/SKILL.md`.

Plugin skill `data-driven-generation` checks for project skill by name
before loading base strategy. Project skills override plugin by Claude Code
priority rules (Project > Plugin).

### User override format

```markdown
---
name: strategy-defensive
description: Project-specific defensive strategy override
disable-model-invocation: true
---

Always use wrapper pattern. No feature flags — we use LaunchDarkly.
Require review from @security-team before merging.
All defensive changes need JIRA ticket with label "defensive-change".
```

### Custom strategies

Users can create entirely new strategies with custom names and conditions:

```markdown
---
name: strategy-compliance
description: Compliance strategy for billing code
disable-model-invocation: true
---

## When

path matches **/billing/** AND ageDays "old" or "legacy"

## Approach

Requires legal review before modification.
No direct DB queries — use approved BillingAPI only.
Create JIRA ticket with label "compliance-review".
All changes require two approvals.
```

Custom strategies are discovered by the `strategy-` prefix convention.
The `data-driven-generation` skill scans `.claude/skills/strategy-*/SKILL.md`
at runtime.

### Discovery order

1. Scan `.claude/skills/` for `strategy-*` skills (Glob)
2. Read each SKILL.md — look for `## When` section in markdown body
   (conditions are in body, not frontmatter)
3. Custom strategies with explicit `## When` conditions are evaluated
   **before** hard rules
4. If custom strategy matches → use it
5. If no custom match → apply hard rules → load base strategy

### Condition format in custom strategies

Conditions use label names from overlay, readable as natural language:

```markdown
## When

bugFixRate "critical"
path matches **/payments/**
```

The agent parses these as: overlay label match + optional path glob.
No code, no YAML — human-readable markdown.

---

## Dependencies

- **tea-rags MCP server** — provides `get_index_metrics`,
  `semantic_search`, `hybrid_search`, `find_similar`, `rank_chunks`
- **tree-sitter MCP** (optional) — structural analysis for verify steps
- **ripgrep MCP** (optional) — exact text search for verify steps
- **Grep/Glob tools** (built-in) — fallback when MCP tools unavailable

Plugin degrades gracefully: without tree-sitter/ripgrep, verify steps use
built-in Grep/Glob. Without tea-rags MCP, the skill cannot function.

---

## Skill: bug-hunt

**File:** `skills/bug-hunt/SKILL.md`

### Frontmatter

```yaml
---
name: bug-hunt
description: Use when debugging a specific bug — finds probable root cause
  locations using git signal analysis and symptom-driven search
argument-hint: [bug description or symptom]
---
```

### Invocation

```
/bug-hunt "при повторном вызове processPayment дублируются записи"
/bug-hunt "timeout errors in webhook delivery after deploy"
```

Developer passes the symptom as `$ARGUMENTS`. The skill directs the search
toward historically buggy code in the relevant area.

### Workflow

#### Step 1: SEMANTIC DISCOVER

`semantic_search` query=$ARGUMENTS — find area by symptom meaning.
Verify per search-cascade rule.

#### Step 2: SIGNAL-RANKED CANDIDATES

`rank_chunks` rerank=bugHunt, pathPattern=\<discovered area\>.
bugHunt preset ranks by burst activity + volatility + bugFix history.
Top-N results = functions that historically broke in this area.

#### Step 3: MARKER SEARCH

`hybrid_search` query=$ARGUMENTS + "error exception retry duplicate fail",
pathPattern=\<area\>.
Catches both semantic relevance and exact error markers.

#### Step 4: CHUNK-LEVEL TRIAGE

For top candidates from Steps 2+3, read chunk-level overlay:
- chunk.bugFixRate "critical" + chunk.churnRatio "concentrated" →
  **prime suspect** — this function absorbs most bugs in the file
- chunk.bugFixRate "concerning" + chunk.commitCount "high" →
  **secondary suspect** — active area with elevated fix rate
- chunk.bugFixRate "healthy" → unlikely root cause, deprioritize

#### Step 5: ROOT CAUSE ANALYSIS

Read code of prime suspects. Analyze:
- What patterns correlate with the symptom
- Edge cases in control flow
- Missing validation or error handling
- Race conditions, duplicate processing, stale state

Present findings as prioritized list:
```
Root cause candidates (ranked by signal confidence):

1. processPayment() [src/payment/processor.ts:45-89]
   chunk.bugFixRate: "critical", chunk.churnRatio: "concentrated"
   Observation: no idempotency check, retry logic re-enters without guard

2. handleWebhook() [src/webhook/handler.ts:12-34]
   chunk.bugFixRate: "concerning", chunk.commitCount: "high"
   Observation: async callback may fire twice on timeout
```

#### Step 6: VERIFY + FIX

Apply search-cascade verify to confirm analysis.
If fix needed → invoke `data-driven-generation` for the target function
(which will run its own danger check and select appropriate strategy).

---

## Files Affected

| File | What |
|------|------|
| `plugin/.claude-plugin/plugin.json` | Plugin manifest |
| `plugin/rules/search-cascade.md` | Three-tool cascade + mandatory verify rule |
| `plugin/skills/data-driven-generation/SKILL.md` | Main workflow skill |
| `plugin/skills/data-driven-generation/strategies/standard.md` | Default strategy |
| `plugin/skills/data-driven-generation/strategies/conservative.md` | Old untouched code strategy |
| `plugin/skills/data-driven-generation/strategies/stabilization.md` | High-churn code strategy |
| `plugin/skills/data-driven-generation/strategies/defensive.md` | Bug-prone legacy code strategy |
| `plugin/skills/bug-hunt/SKILL.md` | Bug investigation skill |

## Not in Scope

- MCP Prompts system (`tea-rags-mcp-iwk`)
- CLAUDE.md config generator (`tea-rags-mcp-wf4`)
- Publishing pipeline for the plugin
- Testing framework for skills (pure markdown, no unit tests)
- Chunk drill-down preset (future — use custom weights for now)
