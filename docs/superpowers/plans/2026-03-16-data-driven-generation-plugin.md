# Data-Driven Generation Claude Plugin — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this plan.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Claude Code plugin that ships search cascade rule,
data-driven code generation skill with label-based strategies, and
bug-hunt skill.

**Architecture:** Plugin directory `plugin/` in tea-rags-mcp repo. Contains
`.claude-plugin/plugin.json`, one rule (always loaded), two skills with
supporting files. All files are markdown — no code, no tests.

**Tech Stack:** Claude Code plugin system (markdown + YAML frontmatter).

**Spec:**
`docs/superpowers/specs/2026-03-16-data-driven-generation-plugin-design.md`

---

## Chunk 1: Plugin Scaffold + Rule

### Task 1: Create plugin manifest

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p plugin/.claude-plugin
```

- [ ] **Step 2: Write plugin.json**

```json
{
  "name": "tea-rags",
  "description": "Data-driven code generation strategies powered by TeaRAGs git signals",
  "version": "0.1.0",
  "author": { "name": "TeaRAGs" },
  "keywords": ["code-generation", "git-signals", "strategies", "search"]
}
```

- [ ] **Step 3: Commit**

```bash
git add plugin/.claude-plugin/plugin.json
git commit -m "chore(plugin): create tea-rags Claude plugin manifest"
```

---

### Task 2: Create search-cascade rule

**Files:**
- Create: `plugin/rules/search-cascade.md`

**Reference:**
- Spec Section "Rule: search-cascade"
- `website/docs/agent-integration/search-strategies/multi-tool-cascade.md`
- `website/docs/knowledge-base/semantic-search-criticism.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p plugin/rules
```

- [ ] **Step 2: Write search-cascade.md**

Full content of the rule. This is always loaded into agent context.

Key sections:
1. **Three-Tool Cascade** — table: TeaRAGs (meaning) → tree-sitter
   (structure) → ripgrep (exact text). Include `rank_chunks` in TeaRAGs
   tools.
2. **Mandatory Verify** — every semantic search result is a candidate,
   not proof. After each TeaRAGs call: tree-sitter structural overview →
   ripgrep confirm call-sites/exports → discard 0-match candidates.
   Fallback: Grep/Glob if ripgrep/tree-sitter unavailable.
3. **Decision Shortcut** — meaning? → TeaRAGs. Structure? → tree-sitter.
   Exact text? → ripgrep. Read code? → filesystem.
4. **Anti-patterns** — ripgrep for architecture questions, TeaRAGs for
   exact method names, tree-sitter for text search, skipping verify.
5. **search_code prohibition** — agents use semantic_search/hybrid_search/
   find_similar for structured JSON with overlay labels. search_code is
   for human-readable output only.

Source the cascade table and anti-patterns from
`website/docs/agent-integration/search-strategies/multi-tool-cascade.md`.
Adapt to rule format (concise, imperative).

- [ ] **Step 3: Commit**

```bash
git add plugin/rules/search-cascade.md
git commit -m "feat(plugin): add search-cascade rule"
```

---

## Chunk 2: Data-Driven Generation Skill

### Task 3: Create main SKILL.md

**Files:**
- Create: `plugin/skills/data-driven-generation/SKILL.md`

**Reference:**
- Spec Section "Skill: data-driven-generation" (full workflow)
- `website/docs/agent-integration/agentic-data-driven-engineering/index.md`
  (5 strategies)
- `website/docs/agent-integration/agentic-data-driven-engineering/generation-modes.md`
  (4 modes + mode selection logic)

- [ ] **Step 1: Create directory**

```bash
mkdir -p plugin/skills/data-driven-generation/strategies
```

- [ ] **Step 2: Write SKILL.md**

Frontmatter:
```yaml
---
name: data-driven-generation
description: Use when generating or modifying code — selects generation
  strategy based on git signal labels from TeaRAGs
---
```

Content sections (from spec):

1. **Prerequisites** — call `get_index_metrics` once per session. Abort
   if MCP unavailable.
2. **Reading Overlay Labels** — explain `rankingOverlay.file.<signal>`
   and `rankingOverlay.chunk.<signal>` structure. List file-level and
   chunk-level signals.
3. **Step 1: DISCOVER + VERIFY** — semantic_search + cascade verify
4. **Step 2: DANGER CHECK (two-stage)** — file-level scan → chunk-level
   drill-down → hard rules table → judgment framework → autonomous
   judgment protocol with justification format
5. **Step 3: TEMPLATE** — find_similar + stable rerank + quality gate
   by labels
6. **Step 4: ANTI-CHECK** — hotspots search, reject critical bugFixRate
   and concentrated churnRatio
7. **Step 5: STYLE** — ownership search + author code reading +
   ownership profile table (silo/concentrated/mixed/shared)
8. **Step 6: GENERATE** — apply strategy + style
9. **Step 7: VERIFY GENERATED** — ripgrep/Grep fallback + tree-sitter,
   0 matches = fix
10. **Step 8: IMPACT** — impactAnalysis or custom weights fallback
11. **Skipping Steps** — hotfix/greenfield/small change rules.
    Step 7 NEVER skipped.
12. **Strategy Override** — scan `.claude/skills/strategy-*/SKILL.md`,
    read `## When` section, custom strategies evaluated before hard rules.
13. **Label Reference** — pointer to `tea-rags://schema/signal-labels`
    and `get_index_metrics`

Copy the full workflow from spec. Keep it under 500 lines — use concise
imperative style. Reference supporting strategy files for approach details.

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/data-driven-generation/SKILL.md
git commit -m "feat(plugin): add data-driven-generation skill"
```

---

### Task 4: Create base strategy files

**Files:**
- Create: `plugin/skills/data-driven-generation/strategies/standard.md`
- Create: `plugin/skills/data-driven-generation/strategies/conservative.md`
- Create: `plugin/skills/data-driven-generation/strategies/stabilization.md`
- Create: `plugin/skills/data-driven-generation/strategies/defensive.md`

**Reference:**
- Spec Section "Base Strategies (supporting files)"
- `website/docs/agent-integration/agentic-data-driven-engineering/generation-modes.md`

- [ ] **Step 1: Write standard.md**

Default mode. No red flags. Content:
- Find stable template and follow it
- Match domain owner's patterns
- Generate clean, idiomatic code
- Standard test coverage and code review

- [ ] **Step 2: Write conservative.md**

When: ageDays "legacy" + commitCount "low". Content:
- Minimal changes, don't refactor/optimize
- Preserve signatures and return types
- Don't move code between files
- Add new alongside, not instead of
- Duplication over abstraction
- Why section explaining undocumented assumptions

- [ ] **Step 3: Write stabilization.md**

When: commitCount "extreme" + churnVolatility "erratic". Content:
- Simplify branching, reduce cyclomatic complexity
- Extract nested conditionals into named methods
- Add logging at decision points
- Pure functions where possible
- If chunk.churnRatio "concentrated" — consider split
- Don't add features on top — simplify first
- Why section explaining accumulated complexity

- [ ] **Step 4: Write defensive.md**

When: bugFixRate "critical" + ageDays "old"/"legacy". Content:
- Never delete old code — wrapper pattern
- Feature flags for rollback
- Old code path as fallback
- Comprehensive tests for edge cases
- Gradual rollout plan
- Document cleanup date
- If dominantAuthorPct "silo" — flag owner
- Why section explaining wrapper rationale

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/data-driven-generation/strategies/
git commit -m "feat(plugin): add 4 base generation strategies"
```

---

## Chunk 3: Bug-Hunt Skill

### Task 5: Create bug-hunt SKILL.md

**Files:**
- Create: `plugin/skills/bug-hunt/SKILL.md`

**Reference:**
- Spec Section "Skill: bug-hunt"

- [ ] **Step 1: Create directory**

```bash
mkdir -p plugin/skills/bug-hunt
```

- [ ] **Step 2: Write SKILL.md**

Frontmatter:
```yaml
---
name: bug-hunt
description: Use when debugging a specific bug — finds probable root cause
  locations using git signal analysis and symptom-driven search
argument-hint: [bug description or symptom]
---
```

Content sections (from spec):

1. **Step 1: SEMANTIC DISCOVER** — semantic_search query=$ARGUMENTS,
   verify per cascade rule
2. **Step 2: SIGNAL-RANKED CANDIDATES** — rank_chunks rerank=bugHunt,
   pathPattern=discovered area. bugHunt ranks by burst + volatility +
   bugFix
3. **Step 3: MARKER SEARCH** — hybrid_search query=$ARGUMENTS +
   error markers
4. **Step 4: CHUNK-LEVEL TRIAGE** — read chunk overlay labels:
   - chunk.bugFixRate "critical" + chunk.churnRatio "concentrated" =
     prime suspect
   - chunk.bugFixRate "concerning" + chunk.commitCount "high" =
     secondary suspect
   - chunk.bugFixRate "healthy" = deprioritize
5. **Step 5: ROOT CAUSE ANALYSIS** — read code of suspects, analyze
   patterns, present prioritized list with signals and observations
6. **Step 6: VERIFY + FIX** — cascade verify. If fix needed → invoke
   data-driven-generation for target function

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/bug-hunt/SKILL.md
git commit -m "feat(plugin): add bug-hunt skill"
```

---

## Chunk 4: Final Verification

### Task 6: Verify plugin structure and push

- [ ] **Step 1: Verify directory structure**

```bash
find plugin/ -type f | sort
```

Expected:
```
plugin/.claude-plugin/plugin.json
plugin/rules/search-cascade.md
plugin/skills/bug-hunt/SKILL.md
plugin/skills/data-driven-generation/SKILL.md
plugin/skills/data-driven-generation/strategies/conservative.md
plugin/skills/data-driven-generation/strategies/defensive.md
plugin/skills/data-driven-generation/strategies/stabilization.md
plugin/skills/data-driven-generation/strategies/standard.md
```

- [ ] **Step 2: Verify frontmatter**

Read each SKILL.md — confirm `name` and `description` fields present.
Confirm `argument-hint` on bug-hunt.

- [ ] **Step 3: Final commit if any fixes needed**

- [ ] **Step 4: Push**

```bash
git pull --rebase && git push
```

---

## Dependency Graph

```
Task 1 (manifest) — no dependencies
Task 2 (search-cascade rule) — no dependencies
Task 3 (data-driven-generation SKILL.md) — after Task 1
Task 4 (strategy files) — after Task 3
Task 5 (bug-hunt SKILL.md) — after Task 1
Task 6 (verify + push) — after all
```

**Parallelizable:**
- Tasks 1, 2 — independent
- Tasks 3, 5 — independent (both depend on Task 1)
- Task 4 — after Task 3
- Task 6 — after all
