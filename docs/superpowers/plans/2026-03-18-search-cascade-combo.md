# Search Cascade Combo Strategy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite search-cascade rules and bug-hunt skill to use combo strategy
(tea-rags + LSP), capability profiles, decision tree, and fallback chains.

**Architecture:** Two files changed: `plugin/rules/search-cascade.md` (full
rewrite) and `plugin/skills/bug-hunt/SKILL.md` (updated flow). SessionStart hook
(`plugin/scripts/inject-rules.sh`) unchanged — it already `cat`s the cascade
file. New content in search-cascade includes capability profile detection
instructions, decision tree, resource loading, and combo rules.

**Tech Stack:** Markdown (plugin rules and skills), shell (existing hook script)

**Spec:** `docs/superpowers/specs/2026-03-18-search-cascade-combo-design.md`

---

### Task 1: Rewrite search-cascade.md

**Files:**

- Modify: `plugin/rules/search-cascade.md` (full rewrite)

The new file replaces the entire content. Structure:

1. Header + mandatory note
2. Session Start — profile detection + resource loading
3. Decision Tree — single tool selection point
4. Rerank Decision — preset vs custom
5. Pagination and Reformulation — two independent mechanisms
6. Combo Strategy Rules — 5 key principles
7. Use Cases — organized by agent task
8. Fallback Chains — by profile (Full / No-LSP)
9. Prohibited Patterns — with rule references
10. Trust the Index — kept from original

- [ ] **Step 1: Write the new search-cascade.md**

Replace full content of `plugin/rules/search-cascade.md` with:

````markdown
# Search Cascade

**MANDATORY:** ALWAYS prefer TeaRAGs and ripgrep MCP over built-in Search/Grep.

## Session Start (EXECUTE IMMEDIATELY)

**BEFORE responding to the user's first message**, run these tools:

**1. Check and update index:**

- Call `get_index_status` for the current project path.
- If indexed → call `reindex_changes` (always, picks up recent changes).
- If not indexed → call `index_codebase`.

**2. Memorize label thresholds:**

- `get_index_metrics` → remember label values. Example: commitCount
  `{ low: 1, typical: 3, high: 8, extreme: 20 }` means 8 commits = "high" in
  THIS codebase.

**3. Load resource references:**

- Read `tea-rags://schema/overview` → navigation hub for presets, signals,
  filters, search-guide.
- Read `tea-rags://schema/search-guide` → concrete query examples for each tool.
- Keep in context. Consult linked resources (`presets`, `signals`, `filters`)
  when making rerank/filter decisions.

**4. Detect available tools and assign profile:**

- Check tool prefixes in available tools list:
  - `LSP` or `mcp__*-lsp__*` or `mcp__ide__*` → LSP available
  - `mcp__tree-sitter__*` → tree-sitter available
  - `mcp__ripgrep__*` → ripgrep available
- Assign profile:
  - LSP available → **Full** (combo: tea-rags discovery + LSP navigation)
  - LSP not available → **No-LSP** (tea-rags discovery + fallbacks)
- Remember: `Profile: Full | LSP ✓ | tree-sitter ✗ | ripgrep ✓`

## Decision Tree

Single point of tool selection. Follow top-to-bottom, take the first matching
branch.

```text
Has query?
├─ No → rank_chunks
│       + pathPattern if directory known
│       + rerank preset for analytics
│
└─ Yes
   ├─ Have code/chunk as example? → find_similar (code or chunk ID)
   │
   ├─ Have a symbol name? → hybrid_search
   │   (symbol + semantic context around it)
   │   Example: "PaymentService validate card expiration"
   │   BM25 catches PaymentService, semantic catches validation logic
   │   Fallback: if hybrid_search unavailable (enableHybrid=false) → semantic_search
   │
   ├─ Pure exploration, human-readable output? → search_code
   │   Quick lookup, no structured metadata needed
   │   Used by /tea-rags:explore skill
   │
   └─ Describing behavior/intent → semantic_search
       Example: "retry logic after failure" → finds retryWithBackoff
       even though the word "retry" may not appear in method name

   All except find_similar and search_code: + rerank preset if analytics needed
   Choosing rerank: preset or custom — consult tea-rags://schema/presets
   If no preset fits → custom weights via tea-rags://schema/signals
```
````

## Rerank Decision

When the user asks an analytical question:

```text
Existing preset fits?
├─ Yes → use it (consult tea-rags://schema/presets for full list)
│
└─ No → build custom rerank (consult tea-rags://schema/signals for weight keys)

    Example: "most dangerous code in payments"
    - hotspots: churn + recency (no bugFix)
    - bugHunt: burstActivity + volatility + bugFix (closer)
    - But "dangerous" = bugs + instability + single owner →
      custom: { bugFix: 0.4, volatility: 0.3, knowledgeSilo: 0.3 }
```

## Pagination and Reformulation

Two independent mechanisms with separate counters.

**Pagination** — results are relevant, need more:

```text
offset=0 → offset=15 → offset=30 → ... (no iteration limit)
```

Same query, same filters, increasing offset.

**Reformulation** — results are NOT relevant:

```text
Max 3 attempts: different query / different filters / different rerank
After 3: report "could not find, here's the best match"
```

Can paginate indefinitely. Can reformulate max 3 times.

## Combo Strategy Rules

**Rule 1: tea-rags for discovery, LSP for navigation.** One semantic_search
returns subsystem slice. LSP navigates within it. Never use multiple
semantic_search calls when LSP can navigate from the first result.

**Rule 2: semantic_search for breadth, not findReferences.** findReferences
returns direct callers (backward in call chain). semantic_search returns
everything conceptually related (any direction). Use findReferences only for
exhaustive refactoring impact, not for discovery.

**Rule 3: metaOnly=false returns code — Read often unnecessary.** Search results
contain content. Read only when you need context beyond the chunk boundaries.

**Rule 4: Cross-layer via semantic_search + language filter.** Not grep chains
(controller → route → grep frontend). One call:
`semantic_search("batch create jobs", language="typescript")`.

**Rule 5: Resources on demand.** `tea-rags://schema/overview` and
`tea-rags://schema/search-guide` loaded at session start. Other resources
(`presets`, `signals`, `filters`) — read when making rerank/filter decisions.

## Use Cases

Organized by agent task. Each references a decision tree branch.

**Discovery (don't know the naming)**

| Task                              | Tool (via tree)            | Example                                                |
| --------------------------------- | -------------------------- | ------------------------------------------------------ |
| Find subsystem by description     | semantic_search            | "retry logic after failure" → retryWithBackoff         |
| Find frontend for backend concept | semantic_search + language | "batch create jobs", language="typescript"             |
| Find similar pattern              | find_similar               | Found retry in cohere → find_similar → retry in ollama |

**Analytics (rerank-driven)**

| Task                         | Tool + rerank                         | Example                                                |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Where bugs hide              | semantic_search/rank_chunks + bugHunt | "error handling in payments domain"                    |
| What to refactor first       | rank_chunks + refactoring             | pathPattern="\*\*/payments/\*\*"                       |
| Bus factor risk              | rank_chunks + ownership               | Single dominant author areas                           |
| Hotspots                     | semantic_search + hotspots            | "payment processing", pathPattern="\*\*/payments/\*\*" |
| Most unstable code in domain | semantic_search + hotspots or custom  | pathPattern for domain scope                           |
| Recent changes for review    | semantic_search + codeReview          | maxAgeDays=7                                           |

**Exact symbol search**

| Task                         | Tool (via tree)          | Example                                        |
| ---------------------------- | ------------------------ | ---------------------------------------------- |
| Class/method definition      | hybrid_search            | "def automations_disabled_reasons"             |
| TODO/FIXME markers + context | hybrid_search + techDebt | BM25 catches markers, semantic catches context |
| Symbol + semantic context    | hybrid_search            | "PaymentService validate card expiration"      |

**Code context for generation**

| Task                 | Tool + rerank                    | Example                        |
| -------------------- | -------------------------------- | ------------------------------ |
| Find stable template | semantic_search + stable         | Low churn = proven pattern     |
| Find fresh example   | semantic_search + recent         | Latest changes = current style |
| Assess change impact | semantic_search + impactAnalysis | Files with most imports        |

## Fallback Chains by Profile

**Full profile (LSP available):**

| Task             | Primary                           | Fallback                         |
| ---------------- | --------------------------------- | -------------------------------- |
| File structure   | LSP documentSymbol                | tree-sitter → Read               |
| Navigate to call | LSP goToDefinition                | hybrid_search (symbol) → ripgrep |
| All usages       | LSP findReferences                | ripgrep (class/method name)      |
| Cross-layer      | semantic_search + language filter | same                             |
| Exact text       | ripgrep MCP                       | built-in Grep                    |

**No-LSP profile:**

| Task             | Primary                            | Fallback 1        | Fallback 2 |
| ---------------- | ---------------------------------- | ----------------- | ---------- |
| File structure   | tree-sitter analyze_code_structure | Read (whole file) | —          |
| Navigate to call | hybrid_search (symbol)             | ripgrep           | Read       |
| All usages       | ripgrep (class/method name)        | built-in Grep     | —          |
| Cross-layer      | semantic_search + language filter  | same              | —          |
| Exact text       | ripgrep MCP                        | built-in Grep     | —          |

Each fallback activates when the tool to its left is unavailable. If tree-sitter
is absent, "File structure" falls directly to Read. If ripgrep MCP is absent,
"Exact text" falls directly to built-in Grep.

## When to Use External Tools Directly

- **Call-sites, imports, exact patterns** → ripgrep MCP (not tea-rags)
- **File structure (methods, classes)** → LSP documentSymbol or tree-sitter
- **Read specific lines** → Read with offset + limit (not whole file)

These complement tea-rags. See Fallback Chains for profile-specific guidance.

## Prohibited Patterns

- **Built-in Grep for code discovery** — use tea-rags or ripgrep MCP
- **Multiple semantic_search for same area** — one call + LSP navigation
  (Rule 1)
- **findReferences for discovery** — use semantic_search for breadth (Rule 2),
  reserve findReferences for exhaustive refactoring impact only
- **Read whole file when search returned code** — content is in search results
  (Rule 3)
- **Grep chains for cross-layer** — use semantic_search + language filter
  (Rule 4)
- **git log/diff for code history** — overlay already has git signals
- **10+ ripgrep calls instead of reading a file** — just read it
- **search_code in generation/bug-hunt/research context** — use semantic_search
  (needs overlay labels + structured metadata). search_code is for pure
  exploration only (/tea-rags:explore)

## Trust the Index

Search results are real code. Don't ripgrep to "verify" every result. Use
ripgrep when you **need** it (call-sites, imports), not as ritual.

If results seem stale → check `driftWarning` in response → `reindex_changes`.

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to
`semantic_search`.

````

- [ ] **Step 2: Review the rewritten file**

Read the file back. Verify:
- Decision tree is complete (all 5 branches)
- Fallback chains cover both profiles
- No references to removed sections (old "TeaRAGs Tool Selection" table)
- Resources section references `tea-rags://schema/overview` and `tea-rags://schema/search-guide`

- [ ] **Step 3: Commit**

```bash
git add plugin/rules/search-cascade.md
git commit -m "improve(plugin): rewrite search-cascade with combo strategy and profiles

Replace flat tool selection table with decision tree, capability profiles
(Full/No-LSP), fallback chains, combo rules, pagination/reformulation,
and resource loading at session start."
````

---

### Task 2: Update bug-hunt SKILL.md

**Files:**

- Modify: `plugin/skills/bug-hunt/SKILL.md`

Key changes:

- Remove "Max 3 file reads" and "Budget: max 3 search calls"
- Delegate tool selection to search-cascade decision tree
- Update flow to use cascade pagination/reformulation rules
- Add profile-aware verification step
- Keep checkpoint loop (adapted), signal triage, no-subagents rule

- [ ] **Step 1: Write the updated bug-hunt SKILL.md**

Replace full content of `plugin/skills/bug-hunt/SKILL.md` with:

````markdown
---
name: bug-hunt
description:
  Use when debugging a specific bug or unexpected behavior — developer describes
  the symptom, skill directs search toward historically buggy code
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root cause investigation using TeaRAGs git signals.

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
3. **No built-in Search/Grep for code discovery** — only TeaRAGs tools + ripgrep
   MCP.
4. **Labels are triage.** bugFixRate "healthy" → SKIP. Trust it.
5. **Tool selection via search-cascade decision tree** — do not hard-code tool
   choice. Follow the tree: symbol name → hybrid_search, behavior description →
   semantic_search.

## Flow

```text
1. SEARCH — choose tool via search-cascade decision tree
   Parameters: metaOnly=false, limit=15
   + rerank="bugHunt" unless a more precise preset fits

   CHECKPOINT: fill three fields:
   - Suspect file(s): ___
   - Buggy line/method: ___
   - Why it breaks: ___

   All filled? → step 3 (VERIFY)
   Not all? → step 2 (REFINE)

2. REFINE — uses cascade pagination/reformulation rules:
   - Know symbol → hybrid_search
   - Need similar pattern → find_similar (code or chunk ID)
   - Need analytics → rank_chunks + rerank
   - Results relevant but insufficient → offset pagination (no limit)
   - Results not relevant → reformulate (max 3 attempts per cascade rules)
   → back to CHECKPOINT

3. VERIFY — confirm root cause:
   Full profile:   LSP goToDefinition/documentSymbol + partial Read
   No-LSP profile: tree-sitter/ripgrep + partial Read

   Read only when context beyond chunk boundaries needed.
   Use LSP partial read (documentSymbol → offset + limit) over whole-file Read.

4. CROSS-LAYER — if bug spans layers:
   semantic_search + language filter — one call, not grep chains.

5. PRESENT — ranked list with signals + observation per suspect.
```
````

**CHECKPOINT after EVERY tool call.** Fill the three fields above.

All three filled → **PRESENT immediately.** Don't confirm, don't validate, don't
search for "how the other flow works".

One or more empty → **state which field is missing**, then pick the next tool to
fill it.

**"Not sure" ≠ "don't know."** If you have a candidate but aren't 100% confident
— present it with a confidence note. Confirmatory searches almost never change
the answer.

## pathPattern rules

Use exact `relativePath` values from search results joined with braces. Do NOT
hand-craft globs.

- GOOD:
  `{app/services/workflow/pipelines/stage_clients/batch_create.rb,app/services/workflow/pipelines/jobs/create.rb}`
- BAD: `**/workflow/pipelines/{stage_clients/batch_create,jobs/create}**`
  (slashes inside braces = broken glob → empty results)

## Triage by signals

When rank_chunks returns overlay labels:

- file.bugFixRate "critical" → **prime suspect**
- file.bugFixRate "concerning" + relativeChurn high → **secondary suspect**
- file.bugFixRate "healthy" → **SKIP**

## After root cause found

If root cause pattern found → `find_similar` from code/chunk ID for copy-paste
bugs.

If fix needed → `/tea-rags:data-driven-generation`.

````

- [ ] **Step 2: Review the updated file**

Read the file back. Verify:
- No "max 3 file reads" or "max 3 search calls" limits
- Tool selection references cascade decision tree, not hard-coded
- Checkpoint loop present with 3 fields
- Profile-aware verification (Full vs No-LSP)
- find_similar accepts code or chunk ID (not just chunk ID)

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/bug-hunt/SKILL.md
git commit -m "improve(plugin): update bug-hunt skill with combo strategy

Delegate tool selection to search-cascade decision tree. Remove rigid
limits (max 3 reads, max 3 searches). Add profile-aware verification
(Full/No-LSP). Use cascade pagination/reformulation rules."
````

---

### Task 3: Bump plugin version

**Files:**

- Modify: `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Bump minor version**

Change `"version": "0.2.1"` → `"version": "0.3.0"` (new feature: combo
strategy + profiles).

- [ ] **Step 2: Commit**

```bash
git add plugin/.claude-plugin/plugin.json
git commit -m "chore(plugin): bump version to 0.3.0"
```

---

### Task 4: Verify end-to-end

- [ ] **Step 1: Verify search-cascade loads correctly**

The SessionStart hook runs `cat plugin/rules/search-cascade.md`. Verify the file
is valid markdown and renders correctly by reading it back.

- [ ] **Step 2: Verify bug-hunt skill loads**

Read `plugin/skills/bug-hunt/SKILL.md` and verify frontmatter is valid YAML.

- [ ] **Step 3: Check for broken cross-references**

Verify that skills referencing search-cascade still work:

- `plugin/skills/explore/SKILL.md` — references `search_code` (still in tree)
- `plugin/skills/research/SKILL.md` — references `semantic_search` (still in
  tree)
- `plugin/skills/data-driven-generation/SKILL.md` — references research skill
  (unchanged)
