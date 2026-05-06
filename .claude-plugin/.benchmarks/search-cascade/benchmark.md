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

## Iteration 6 — Ripgrep Overreach (2026-05-07)

Context: production transcript showed subagent in foreign repo using ripgrep for
class/constant/method-name searches with `Foo|Bar|Baz` regex alternation. Iter-5
evals (10/10 PASS) did not catch the regression because they tested rule wording
in isolation, not the production injection path (enforce-tearags-search.sh
SUFFIX, which is the ONLY thing real subagents see).

Evals: `evals/2026-05-07-ripgrep-overreach-evals.json`

### Audit Findings (4 candidate, 1 confirmed)

| #       | Finding                                                                                                                      | Status                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| FM1     | "regex" in ripgrep allowlist causes false positives for `\|`-joined identifiers (search-cascade + enforce-tearags-search.sh) | Not reproduced; proactive fix                                                                                  |
| FM2     | No negative prohibitions for ripgrep on class/method/constant names                                                          | Not reproduced; proactive fix                                                                                  |
| FM3     | enforce-tearags-search.sh SUFFIX missing single-file find_symbol branch — agent picks ripgrep for in-file constant lookup    | **Confirmed (Case 3 FAIL)**                                                                                    |
| FM4     | BM25 exact-match capability of hybrid_search not surfaced strongly enough                                                    | Not reproduced; phrasing already adequate                                                                      |
| ~~FM5~~ | Session Start protocol non-firing in Opus 4.7                                                                                | **Out of scope** — already delivered via SessionStart hook (inject-rules.sh); compliance issue, not text issue |

### Three-way eval methodology (NEW — addresses iter-5 measurement gap)

This iteration uses three eval configurations to separate optimistic
self-evaluation from realistic production behavior:

| Config                    | Context injected                                            | Role                                                   |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `baseline_no_rules`       | None (only MCP tool list)                                   | Floor — natural intuition                              |
| `before_fix_full_cascade` | Full search-cascade.md + post-search-validation.md + SUFFIX | Over-optimistic — main agent's view                    |
| `before_fix_suffix_only`  | Only enforce-tearags-search.sh SUFFIX                       | **Production-realistic** — what subagents actually see |
| `after_fix_suffix_only`   | New SUFFIX after fix                                        | Verification                                           |

The full-cascade config gives a misleading 100% — the rule appears to work, but
real subagents never see search-cascade.md (only the hook-injected SUFFIX). The
suffix-only config exposed FM3.

### Results

| Config                      | Pass Rate      | Delta vs Baseline  |
| --------------------------- | -------------- | ------------------ |
| Baseline (no rules)         | 4/9 (44%)      | —                  |
| Before fix — full cascade   | 9/9 (100%)     | +56pp (misleading) |
| Before fix — SUFFIX only    | 8/9 (89%)      | +45pp              |
| **After fix — SUFFIX only** | **9/9 (100%)** | **+56pp**          |

### Per-Eval Detail

| #   | Task                                     | Baseline                    | Before (SUFFIX)    | After (SUFFIX)                    |
| --- | ---------------------------------------- | --------------------------- | ------------------ | --------------------------------- |
| 1   | Class rename — find callers of old + new | ❌ search_code with `\|`    | ✅ hybrid_search   | ✅ hybrid_search                  |
| 2   | Multi-name constants + method            | ❌ ripgrep with `\|`        | ✅ hybrid_search   | ✅ hybrid_search                  |
| 3   | Single-file constant scope               | ❌ built-in Grep            | **❌ ripgrep**     | **✅ find_symbol(relativePath:)** |
| 4   | BM25 awareness — class callers           | ❌ find_symbol (wrong tool) | ✅ hybrid_search   | ✅ hybrid_search                  |
| 5   | Two class identifiers with `\|` syntax   | ❌ ripgrep `\|` literal     | ✅ hybrid_search   | ✅ hybrid_search                  |
| 6   | Control — TODO/FIXME markers             | ✅ ripgrep                  | ✅ ripgrep         | ✅ ripgrep                        |
| 7   | Control — literal import path            | ✅ ripgrep                  | ✅ ripgrep         | ✅ ripgrep                        |
| 8   | Control — known symbol definition        | ✅ find_symbol              | ✅ find_symbol     | ✅ find_symbol                    |
| 9   | Control — behavioral intent              | ✅ semantic_search          | ✅ semantic_search | ✅ semantic_search                |

### Changes Made

#### `.claude-plugin/tea-rags/scripts/enforce-tearags-search.sh` (49 → 70 lines)

Real subagent injection point. SUFFIX rewrite:

- **Added** "Single-file scope" branch as FIRST matching rule — closes FM3
- **Replaced** "Known symbol definition" with broader "Study a specific known
  symbol — its definition, body, or implementation" with new keywords
  (examine/inspect) per user feedback that routing must be explicit for
  symbol-study intent
- **Added** "ripgrep anti-patterns" section: explicit prohibition for class /
  method / constant / variable names with `|` alternation
- **Replaced** "Exact text patterns (TODO, FIXME, import paths, regex)" with
  "Literal text markers (TODO, FIXME, HACK, NOTE) or literal import path
  strings" — removes "regex" trigger word that caused FM1 false positives
- **Strengthened** BM25 description: "exact-name match (score up to 1.0) —
  strictly better than ripgrep for class/method/constant names"
- **Added** rule: "Your QUERY containing `|` does not mean you want regex —
  check INTENT first"

#### `.claude-plugin/tea-rags/rules/search-cascade.md` (355 → 377 lines)

Mirrors SUFFIX changes for parent-agent reference. Three sections updated:

1. **Principles** — reformulated "Semantic First, Exact Second" to remove
   "regex" trigger and add explicit "code identifiers are SYMBOL searches" rule
2. **Subagent Search Injection block** — synced with new SUFFIX content; both
   files now share the same canonical rule text
3. **Single-file scope branch** — new first matching branch in tool-selection
   list

#### `.claude-plugin/tea-rags/.claude-plugin/plugin.json`

Version bump 0.15.1 → 0.15.2 (patch — text changes to existing rules per
plugin-versioning rule).

### Key Design Decisions

1. **Three-way eval over two-way** — iter-5 used `with-rule + baseline`. That
   measures wording quality but misses the production gap: real subagents only
   see the SUFFIX, not full search-cascade.md. Three configs (baseline +
   full-cascade + SUFFIX-only) make the gap visible.

2. **Strict triage discipline** — eval said only FM3 reproduced. FM1/2/4 still
   patched proactively because production transcript provided independent
   evidence; eval prompts were too clean to reproduce reasoning-chain pollution
   that triggered FM1 in production.

3. **Lockstep fix between hook script and rule doc** — hook script is the
   authoritative subagent context; rule doc must mirror it 1:1 or parent agents
   will reason from out-of-sync rules. Both files share the same canonical rule
   text now.

4. **FM5 declared out-of-scope** — Session Start protocol non-firing in Opus 4.7
   is a compliance issue (agent ignores delivered rule), not a text issue.
   inject-rules.sh hook already delivers the rule. Separate concern, separate
   fix path (potentially: stronger imperative phrasing, or rule restructure to
   reduce competition with other system reminders).

### Lessons for Future Iterations

- Always eval the **production injection path**, not just the documented rule.
  The hook script SUFFIX is the source of truth for subagent behavior.
- "PASS in eval" doesn't mean "won't fail in production" — clean eval prompts
  may not reproduce reasoning-chain pollution. Use independent evidence (real
  transcripts) as a sanity check before declaring findings closed.
- When two files (hook script + rule doc) share text content, fix them in
  lockstep or document which is authoritative.

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
