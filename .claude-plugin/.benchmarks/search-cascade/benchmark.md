# Search Cascade Benchmark

Last updated: 2026-04-03 (chunk-grouping iteration) Original: 2026-03-29

## Summary

Optimized search-cascade rule from 502-line monolith to 227-line core + 3
reference files (382 total). Evaluated tool selection accuracy across 20 unique
test cases in 3 iterations.

## Results by Iteration

| Iteration | Version                                | Evals | Pass Rate  | Key Change                       |
| --------- | -------------------------------------- | ----- | ---------- | -------------------------------- |
| 1         | baseline (no rule)                     | 9     | 22% (2/9)  | Grep/Glob dominate               |
| 1         | v1 (original 502-line)                 | 9     | 89% (8/9)  | eval-10 fail: subagent injection |
| 2         | v2 (modularized, LSP removed)          | 9     | 100% (9/9) | Subagent injection fixed         |
| 3         | v3 (skills-first, search_code blocked) | 9     | 100% (9/9) | Skills routing + new patterns    |

## Delta: with-rule vs without-rule

**+78 percentage points** (22% → 100%)

## Eval Results Detail

### Iteration 1 — Baseline

| #   | Task                    | With Rule                      | Without Rule                       |
| --- | ----------------------- | ------------------------------ | ---------------------------------- |
| 1   | find_symbol definition  | ✅ find_symbol                 | ✅ find_symbol + unnecessary Read  |
| 2   | exhaustive usage        | ✅ hybrid → ripgrep            | ❌ ripgrep only                    |
| 3   | semantic intent         | ✅ semantic_search             | ⚠️ search_code (weaker)            |
| 4   | test existence          | ✅ find_symbol+metaOnly        | ❌ Glob+Grep cascade (3 steps)     |
| 7   | symbol + context        | ✅ hybrid_search               | ❌ find_symbol+semantic separately |
| 8   | explore subagent        | ✅ semantic cascade            | ❌ 6-phase Glob/Grep               |
| 9   | explore subagent symbol | ✅ find_symbol                 | ✅ find_symbol + Grep fallback     |
| 10  | task subagent usage     | ❌ ripgrep only                | ❌ ripgrep only                    |
| 11  | plan subagent refactor  | ✅ semantic+find_symbol+hybrid | ❌ 23 Grep+Read+Glob calls         |

### Iteration 2 — Modularized + Enhanced Subagent Injection

| #   | Task                    | Result                                 | vs Iter-1 |
| --- | ----------------------- | -------------------------------------- | --------- |
| 1   | find_symbol definition  | ✅ find_symbol, no Read                | cleaner   |
| 2   | exhaustive usage        | ✅ hybrid → ripgrep                    | =         |
| 3   | semantic intent         | ✅ semantic_search                     | =         |
| 4   | test existence          | ✅ find_symbol+metaOnly                | =         |
| 7   | symbol + context        | ✅ hybrid_search                       | =         |
| 8   | explore subagent        | ✅ find_symbol+hybrid+ripgrep          | richer    |
| 9   | explore subagent symbol | ✅ find_symbol                         | =         |
| 10  | task subagent usage     | ✅ hybrid → ripgrep                    | **FIXED** |
| 11  | plan subagent refactor  | ✅ semantic+find_symbol+hybrid+ripgrep | richer    |

### Iteration 3 — Skills Routing + New Patterns

| #   | Task                           | Result                                         |
| --- | ------------------------------ | ---------------------------------------------- |
| 12  | Skill routing: explore         | ✅ /tea-rags:explore                           |
| 13  | Skill routing: research        | ✅ /tea-rags:research                          |
| 14  | Skill routing: bug-hunt        | ✅ /tea-rags:bug-hunt                          |
| 15  | Skill routing: risk-assessment | ✅ /tea-rags:risk-assessment                   |
| 16  | find_similar (pattern search)  | ✅ /tea-rags:explore (internal pattern-search) |
| 17  | rank_chunks (analytics)        | ✅ rank_chunks + custom weights                |
| 18  | No Read after search           | ✅ find_symbol, no Read                        |
| 19  | search_code blocked            | ✅ hybrid_search (not search_code)             |
| 20  | Offset pagination              | ✅ offset=0→15→30, default limit               |

## Changes Made

### Files Modified

- `.claude-plugin/tea-rags/rules/search-cascade.md` — rewritten (502 → 227
  lines)
- `~/.claude/rules/mcp-safety.md` — removed "always read files" rule
- `.gitignore` — added plugin-workspaces/

### Files Deleted

- `~/.claude/rules/tea-rags-triggers.md` — duplicated search-cascade
- `~/.claude/rules/tea-rags-api-reference.md` — conflicting "search_code FIRST"
  rule

### Files Created

- `.claude-plugin/tea-rags/rules/references/use-cases.md` (59 lines)
- `.claude-plugin/tea-rags/rules/references/polyglot-rule.md` (42 lines)
- `.claude-plugin/tea-rags/rules/references/pagination.md` (74 lines)

### Key Design Changes

1. **"Semantic First"** — first principle, tea-rags before ripgrep
2. **"Chunk is source of truth"** — no Read to verify search results
3. **LSP removed** — profiles, branches, fallback chains
4. **Skills-first routing** — 5 skills integrated into Decision Tree
5. **search_code blocked** — only through /tea-rags:explore
6. **Subagent injection** — mini decision tree, not just tool list
7. **Offset pagination** — instead of inflated limits
8. **ripgrep scoped** — only for exact text patterns or fallback when hybrid
   unavailable

## Token Efficiency

Without-rule agents consume significantly more tokens:

- Eval 8 (explore): with-rule 40k tokens vs without-rule 43k tokens
- Eval 11 (plan): with-rule 43k tokens vs without-rule 53k tokens (+23%)

The difference comes from fewer tool calls (semantic search returns relevant
results in 1-3 calls vs 6+ Grep/Glob phases) and no unnecessary file reads.

---

## Iteration 4 — Chunk Grouping (2026-04-03)

Context: chunk-grouping epic added `find_symbol(relativePath:)`, `#`/`.`
separator, ChunkGrouper outlines, Doc TOC. search-cascade needed updates.

Evals: `evals/chunk-grouping-evals.json`

### Audit Findings (6 confirmed)

| #   | Finding                                             | Status  |
| --- | --------------------------------------------------- | ------- |
| F1  | Stale parentName refs + members[] + old doc outline | Fixed   |
| F2  | Missing relativePath in decision tree               | Fixed   |
| F3  | Stale Class.method convention (now #/.)             | Fixed   |
| F4  | Missing navigation chain (search → outline → code)  | Fixed   |
| F5  | tree-sitter as primary for file structure           | Removed |
| F6  | Subagent block missing relativePath + # convention  | Fixed   |

### Results

| Version                 | Pass Rate  | Delta |
| ----------------------- | ---------- | ----- |
| Baseline (no rule)      | 22% (2/9)  | —     |
| Before fix (stale rule) | 33% (3/9)  | +11pp |
| After fix               | 100% (9/9) | +78pp |

### Per-Eval Detail

| #   | Task                    | Before                           | After                             |
| --- | ----------------------- | -------------------------------- | --------------------------------- |
| 1   | File structure          | ❌ tree-sitter                   | ✅ find_symbol(relativePath:)     |
| 2   | Class methods           | ✅ find_symbol                   | ✅ find_symbol                    |
| 3   | Doc TOC                 | ❌ old symbol style              | ✅ find_symbol(relativePath:)     |
| 4   | Navigation chain        | ❌ tree-sitter + wrong separator | ✅ relativePath → Reranker#rerank |
| 5   | Instance method #       | ❌ uses .                        | ✅ uses #                         |
| 6   | All usages (control)    | ✅ hybrid_search                 | ✅ hybrid_search                  |
| 7   | Intent (control)        | ✅ semantic_search               | ✅ semantic_search                |
| 8   | Subagent file structure | ❌ tree-sitter                   | ✅ find_symbol(relativePath:)     |
| 9   | Subagent # symbol       | ❌ uses .                        | ✅ uses #                         |

### Changes Made

- Decision tree: added relativePath branches for file outline + doc TOC
- Decision tree: added #/. symbolId convention to find_symbol section
- Chunk Navigation: rewrote with symbolId conventions, file outline, navigation
  chain
- Fallback table: find_symbol(relativePath:) replaces tree-sitter
- Subagent injection: added relativePath, doc TOC, # convention
- Removed all tree-sitter references

---

## Iteration 5 — Mid-Session Reindex (2026-04-05)

Context: Agent modifies code (Write/Edit), then searches with tea-rags for a new
task without reindexing — gets stale results. Missing rule for mid-session index
freshness.

Evals: `evals/mid-session-reindex-evals.json`

### Audit Finding

| #   | Finding                                               | Status    |
| --- | ----------------------------------------------------- | --------- |
| F1  | No rule for reindexing after code changes mid-session | Confirmed |

### Results

| Version            | Pass Rate    | Delta |
| ------------------ | ------------ | ----- |
| Baseline (no rule) | 30% (3/10)   | —     |
| After fix          | 100% (10/10) | +70pp |

### Per-Eval Detail

| #   | Task                            | Baseline | After Fix                                |
| --- | ------------------------------- | -------- | ---------------------------------------- |
| 1   | Edit 3 files + exact search     | ❌       | ✅ ripgrep only, skips reindex correctly |
| 2   | Write + find_symbol/semantic    | ❌       | ✅ index_codebase → tea-rags             |
| 3   | Write + explore presets         | ❌       | ✅ index_codebase → semantic             |
| 4   | No changes + semantic (control) | ✅       | ✅ no reindex                            |
| 5   | Edit + ripgrep TODO             | ❌       | ✅ ripgrep only, skips reindex correctly |
| 6   | Write + semantic validation     | ❌       | ✅ index_codebase → semantic             |
| 7   | Subagent after parent Edit      | ❌       | ✅ subagent calls index_codebase first   |
| 8   | Subagent after parent Write     | ❌       | ✅ subagent calls index_codebase first   |
| 9   | Edit 5 files + explore module   | ⚠️       | ✅ index_codebase → semantic             |
| 10  | No changes + hybrid (control)   | ✅       | ✅ no reindex                            |

### Bonus: "When NOT to reindex" precision

Before-fix eval (with deprecated `reindex_changes`) called reindex even before
ripgrep-only searches (evals 1, 5). After fix, "When NOT to reindex" rule
correctly prevents unnecessary reindex when only ripgrep is used.

### Changes Made

- Added "After Code Changes (mid-session reindex)" section between Session Start
  and Decision Tree
- Covers: when to reindex, when NOT to, how (index_codebase), subagent note
