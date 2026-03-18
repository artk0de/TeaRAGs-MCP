# Search Cascade Combo Strategy & Bug-Hunt Optimization

## Problem

Current search-cascade treats tools as isolated choices. Real-world debugging
and code exploration requires **combo strategies** — tea-rags for discovery, LSP
for navigation, ripgrep for exact text. Without explicit combo rules:

- Agent calls `findReferences` N times for breadth-first traversal when one
  `semantic_search` returns the whole subsystem slice
- Agent uses `metaOnly=true` then `Read` when `metaOnly=false` returns code
  directly
- Agent uses grep chains for cross-layer search (backend → controller → route →
  grep frontend) when `semantic_search` with `language` filter finds frontend in
  one call
- Agent doesn't know how to degrade gracefully when LSP/tree-sitter/ripgrep
  unavailable
- Bug-hunt skill has rigid limits (max 3 reads) instead of adaptive strategy

## Scope

Two artifacts:

1. **search-cascade** (`plugin/rules/search-cascade.md`) — rewrite with combo
   strategy, capability profiles, decision tree, fallback chains
2. **bug-hunt skill** (`plugin/skills/bug-hunt/SKILL.md`) — updated flow using
   cascade rules, adaptive checkpoint, no rigid read limits

## Design

### 1. Capability Profiles

SessionStart hook detects available tools and assigns a profile.

**Two profiles:**

| Profile    | Requirements   | Strategy                                                |
| ---------- | -------------- | ------------------------------------------------------- |
| **Full**   | tea-rags + LSP | tea-rags discovery + LSP navigation (combo)             |
| **No-LSP** | tea-rags only  | tea-rags discovery + tree-sitter/ripgrep/Read fallbacks |

tea-rags is always present (plugin prerequisite). Everything else is optional.

**Detection:** SessionStart hook checks tool prefixes in available tools list:

- `LSP` or `mcp__*-lsp__*` or `mcp__ide__*` → LSP available
- `mcp__tree-sitter__*` → tree-sitter available
- `mcp__ripgrep__*` → ripgrep available

Output in system-reminder:

```
Profile: Full | LSP ✓ | tree-sitter ✗ | ripgrep ✓
```

### 2. SessionStart Hook Changes

Current hook does:

1. `get_index_status` → `reindex_changes`
2. `get_index_metrics` → remember label thresholds
3. Detect available tools

New hook adds:

4. Read `tea-rags://schema/overview` → into context (navigation hub for presets,
   signals, filters, search-guide)
5. Read `tea-rags://schema/search-guide` → into context (concrete query examples
   for each tool)
6. Output capability profile line

### 3. Decision Tree

Replaces the current "TeaRAGs Tool Selection" table. Single point of instrument
selection:

```
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

### 4. Rerank Decision

When the user asks an analytical question:

```
Analytical question?
├─ Existing preset fits → use it
│   (consult tea-rags://schema/presets for full list)
│
└─ No preset is precise enough → build custom rerank
    (consult tea-rags://schema/signals for available weight keys)

    Example: "most dangerous code in payments"
    - hotspots: churn + recency (no bugFix)
    - bugHunt: burstActivity + volatility + bugFix (closer)
    - But "dangerous" = bugs + instability + single owner →
      custom: { bugFix: 0.4, volatility: 0.3, knowledgeSilo: 0.3 }
```

### 5. Pagination and Reformulation

Two independent mechanisms:

**Pagination** — results are relevant, need more:

```
offset=0 → offset=15 → offset=30 → ... (no iteration limit)
```

Same query, same filters, increasing offset.

**Reformulation** — results are not relevant:

```
Max 3 attempts: different query / different filters / different rerank
After 3: report "could not find, here's the best match"
```

Independent counters. Can paginate indefinitely, but reformulate max 3 times.

### 6. Use Cases Table

Organized by agent task, not by tool. Each row references a decision tree
branch.

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

### 7. Fallback Chains by Profile

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

Each fallback column activates when the tool to its left is unavailable. If
tree-sitter is absent, "File structure" falls directly to Read. If ripgrep MCP
is absent, "Exact text" falls directly to built-in Grep.

### 8. Combo Strategy Rules

Key principles that replace the flat tool tables:

**Rule 1: tea-rags for discovery, LSP for navigation.** One semantic_search
returns subsystem slice. LSP navigates within it. Never use multiple
semantic_search calls when LSP can navigate from the first result.

**Rule 2: semantic_search for breadth, not findReferences.** findReferences
returns direct callers (backward in call chain). semantic_search returns
everything conceptually related (any direction). Use findReferences only for
exhaustive refactoring impact, not for discovery.

**Rule 3: metaOnly=false returns code — Read often unnecessary.** search results
contain content. Read only when you need context beyond the chunk boundaries.

**Rule 4: Cross-layer via semantic_search + language filter.** Not grep chains
(controller → route → grep frontend). One call:
`semantic_search("batch create jobs", language="typescript")`.

**Rule 5: Resources on demand.** `tea-rags://schema/overview` and
`tea-rags://schema/search-guide` loaded at session start. Other resources
(`presets`, `signals`, `filters`) read when making rerank/filter decisions.

### 9. Bug-Hunt Skill Updates

**Updated flow:**

```
1. Choose tool via search-cascade decision tree
   (semantic_search or hybrid_search based on user input)
   Parameters: metaOnly=false, limit=15
   + rerank="bugHunt" unless a more precise preset fits

   CHECKPOINT: fill three fields:
   - suspect file(s)
   - buggy line/method
   - why it breaks

   All filled? → step 3
   Not all? → step 2 (max 3 reformulation attempts)

2. Refinement search (uses cascade pagination/reformulation rules):
   - Know symbol → hybrid_search
   - Need similar pattern → find_similar
   - Need analytics → rank_chunks + rerank
   - Results relevant but insufficient → offset pagination (no limit)
   - Results not relevant → reformulate (max 3 attempts per cascade rules)
   → back to CHECKPOINT

3. Verification:
   Full:    LSP goToDefinition/documentSymbol + partial Read
   No-LSP:  tree-sitter/ripgrep + partial Read

   Read only when context beyond chunk boundaries needed

4. Cross-layer (if bug spans layers):
   semantic_search + language filter — one call
```

**Removed:**

- "Max 3 file reads" limit — replaced by "Read only beyond chunk boundaries"
- Hard-coded tool selection — delegated to cascade decision tree
- `git log/diff/blame` prohibition kept — overlay has git signals

**Kept:**

- Checkpoint loop (adapted — exit immediately when all fields filled)
- Triage by signals (bugFixRate critical = prime suspect)
- "Execute yourself, no subagents" rule

### 10. Prohibited Patterns (updated)

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

## Files Changed

| File                              | Change                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `plugin/rules/search-cascade.md`  | Rewrite: profiles, decision tree, fallback chains, combo rules, use cases, pagination/reformulation |
| `plugin/skills/bug-hunt/SKILL.md` | Update: new flow, remove read limit, delegate tool selection to cascade, adaptive checkpoint        |

## Testing

- Manual verification: run bug-hunt on a known bug, compare tool calls
  before/after
- Verify SessionStart hook outputs profile line
- Verify overview + search-guide loaded at session start
