# Search Cascade Benchmark

Last updated: 2026-09-15 (outline / TOC drill-down) Original: 2026-03-29

## Summary

Optimized search-cascade rule from 502-line monolith through multiple iterations
to a 245-line slim core + 6 reference files + 2 agent-only invocable skills
(`filter-building`, `analytics-rerank`). Evaluated tool selection accuracy
across 42 unique test cases over 5 iterations.

## Results by Iteration

| Iteration | Version                                       | Evals | Pass Rate    | Key Change                                                                                                                     |
| --------- | --------------------------------------------- | ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1         | baseline (no rule)                            | 9     | 22% (2/9)    | Grep/Glob dominate                                                                                                             |
| 1         | v1 (original 502-line)                        | 9     | 89% (8/9)    | eval-10 fail: subagent injection                                                                                               |
| 2         | v2 (modularized, LSP removed)                 | 9     | 100% (9/9)   | Subagent injection fixed                                                                                                       |
| 3         | v3 (skills-first, search_code blocked)        | 9     | 100% (9/9)   | Skills routing + new patterns                                                                                                  |
| 4         | baseline 2026-05-15 (no rule, Sonnet)         | 10    | 70% (7/10)   | Misses reindex-after-edit; raw filters when typed exists                                                                       |
| 4         | v4 pre-fix (skill text v3)                    | 10    | 100% (10/10) | All PASS but raw filters in 3 cases, wrong testFile=true                                                                       |
| 4         | v4 post-fix (added ## Filters section)        | 10    | 100% (10/10) | Typed filters everywhere, correct enums, taskId discovered                                                                     |
| 5         | v5 post-split (526 → 245 lines, 2 new skills) | 12    | 100% (12/12) | Filter and rerank deep guidance moved into invocable skills; routing branches verified unchanged                               |
| 6         | v5 + Phase 8 integration (live MCP)           | 2     | 100% (2/2)   | infraHealth + labelMap shapes verified against live tea-rags; references/runtime-introspection.md claims operationally correct |

## Delta: with-rule vs without-rule

- Iterations 1–3: **+78 percentage points** (22% → 100%)
- Iteration 4 (filters/MCP-resources slice): **+30 pp pass rate** + qualitative
  wins (typed filters, enum syntax, taskId surfaced).
- Iteration 5 (post-split): **no without-rule baseline** — search-cascade is
  always-loaded, the absence test is meaningless. Iteration 5 is a routing
  regression test only: 12/12 routing branches preserved after extracting
  filter-building and analytics-rerank into agent-only skills. Always-loaded
  text down from 526 → 245 lines (-54%).

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

---

## Iteration 7 — Post-Search Navigation (2026-05-13)

Context: user report on Opus 4.7 — "agent should navigate via
semantic/hybrid_search, then use find_symbol, but Opus 4.7 does not do this.
Also: agent should understand find_symbol can show doc TOC." Target model:
claude-opus-4-7.

Evals: `evals/2026-05-13-post-search-navigation-evals.json` (22 cases across 4
groups: post-search-navigation, doc-toc, regression controls,
implicit-real-user).

### Audit Findings (6 candidate)

| #       | Finding                                                                                                                                       | Status                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| AUDIT-1 | Decision Tree has `Already have search results → NAVIGATE → find_symbol` branch but without explicit triggers                                 | Hoist-fixed proactively (Wave 2 < line 150 visibility)                                            |
| AUDIT-2 | "Chunk is the source of truth" reads as "don't touch the result" — no distinction between bad Read-to-verify and good find_symbol-to-navigate | Fixed via explicit After-Search Navigation table                                                  |
| AUDIT-3 | Chunk Navigation example (line 270+) at bottom of file — Opus 4.7 reliably skips this depth                                                   | Fixed via hoist                                                                                   |
| AUDIT-4 | `enforce-tearags-search.sh` SUFFIX (the ONLY thing real subagents see) had no post-search navigation hint AND no doc TOC branch               | **Critical fix** — hook is the production-impacting gap, not search-cascade.md text               |
| AUDIT-5 | `navigation.prevSymbolId`/`nextSymbolId` documented in isolated section, not connected to Decision Tree                                       | Surfaced in hoisted table                                                                         |
| AUDIT-6 | Rerank Decision (line 199-207) prescribed `hybrid_search → Read → semantic_search` for docs — contradicts doc TOC pattern                     | Fixed — replaced with `find_symbol(relativePath:) → find_symbol(symbol: doc:<hash>) → Read` chain |

### Methodology

Two eval waves to test instruction visibility, not just text correctness:

1. **Explicit cases (1-14)** — user clearly states intent ("the chunk is
   truncated, I need full body"). Tests whether rule branches map intent → tool.
2. **Implicit cases (15-22)** — user phrases naturally ("How does X work?").
   Tests whether agent _autonomously_ triggers post-search navigation when no
   explicit signal is given.

Each wave run against four configurations:

- **baseline_no_rules** — only MCP tool descriptions
- **old_suffix** — what real subagents got BEFORE fix (pre-Iter-7 SUFFIX)
- **fixed_suffix** — what real subagents get AFTER fix
- **full_fixed_skill** — full search-cascade.md (main-agent view)

### Results

| Configuration               | Pass Rate                                                     | Notes                                                                                 |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| baseline_no_rules           | 18/22 (82%)                                                   | Fails: Case 10 (intent→hybrid), 12 (callers→ripgrep), 17/21 (doc Read instead of TOC) |
| old_suffix (pre-fix)        | ~22/22 with minor `metaOnly=true` misuse on outline/TOC cases | Existing branches transferred well; no explicit post-search rule                      |
| **fixed_suffix (post-fix)** | **22/22 — clean**                                             | Explicit doc TOC branch + After-Search Navigation block                               |
| full_fixed_skill            | 22/22                                                         | After-Search Navigation hoisted in top 50 lines                                       |

**Delta baseline→fixed_suffix: +18pp.** Real-world impact is larger than this
synthetic number because:

- Eval prompts are _short and focused_; real subagent prompts are _long_, with
  SUFFIX competing for attention against task-specific instructions. Wave 2
  confirmed Opus 4.7 reliably skips content past line ~150.
- Old SUFFIX leaned on adjacent branches ("Single-file scope", "Study a specific
  known symbol") for outline/TOC needs. New SUFFIX has _direct, dedicated_
  branches.
- Old SUFFIX had zero text about _what to do AFTER a search returns a chunk_.
  New SUFFIX has an explicit block with 5 typical patterns + 2 anti-patterns
  ("NEVER Read after find_symbol", "NEVER re-run semantic_search").

### Per-Eval Detail (selected)

| #   | Group      | Task                                        | Baseline                           | Old SUFFIX               | Fixed SUFFIX                    |
| --- | ---------- | ------------------------------------------- | ---------------------------------- | ------------------------ | ------------------------------- |
| 7   | doc-toc    | doc-toc-from-search-result (parentSymbolId) | ⚠️ relativePath fallback           | ⚠️ relativePath fallback | ✅ uses parentSymbolId directly |
| 10  | regression | behavioral intent → semantic_search         | ❌ chose hybrid_search             | ✅                       | ✅                              |
| 12  | regression | all callers → hybrid_search                 | ❌ chose ripgrep with `*.ts` glob  | ✅                       | ✅                              |
| 17  | implicit   | summarize doc                               | ❌ adds Read on top of find_symbol | ✅                       | ✅ pure TOC-then-section        |
| 21  | implicit   | doc section deep-dive                       | ⚠️ Read(offset/limit) for section  | ✅                       | ✅                              |

### Changes Made

**1. `.claude-plugin/tea-rags/rules/search-cascade.md`**

- Added `## After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)` block
  right after `## Principles` (line ~20, well within Wave 2 visibility budget).
  Contains a 7-row decision table mapping search-result shapes → next
  `find_symbol` call.
- Rewrote `## Rerank Decision` → `Documentation search` flow: TOC-first via
  `find_symbol(relativePath:)`, then section drill via
  `find_symbol(symbol: doc:<hash>)`. `Read` is only for continuous prose
  summarization.
- Net file size: 384 → 425 lines (+41 lines, +11%). Hoisted content is the only
  addition; no existing sections removed.

**2. `.claude-plugin/tea-rags/scripts/enforce-tearags-search.sh` (THE CRITICAL
FIX)**

- Added two new branches to Tool selection block:
  `File structure / outline → find_symbol(relativePath:)` and
  `Documentation table of contents → find_symbol(relativePath:) → find_symbol(symbol: doc:<hash>)`.
- Added a top-level paragraph + 5-bullet decision block:
  `**After ANY search returns a chunk — your work is rarely done.** ... your next call is find_symbol — NOT another search, NOT Read.`
  Covers truncated chunks, file structure, navigation neighbors, doc
  parentSymbolId, helper deep-dive.
- Added explicit anti-patterns: `NEVER Read after find_symbol`,
  `NEVER re-run semantic_search on an area you already searched; navigate instead.`
- bash syntax verified with `bash -n`.

### Why eval pass-rate doesn't capture the real impact

Phase 2 baseline already showed `old_suffix` at parity with `fixed_suffix` on
these synthetic prompts. The fix's value lies in **discoverability under
attention pressure**:

- In production, the subagent prompt = parent's task description + SUFFIX. When
  the task description is 200+ lines (typical for plan-executor or explore
  subagents), the SUFFIX sits past Opus 4.7's reliable-attention budget.
- Without an explicit post-search rule, the agent falls back on a heuristic ("I
  got a chunk, I'll synthesize an answer"). With the explicit rule, the rule
  survives the attention drop because it is the _only_ prescriptive content
  matching the post-search intent — agents pattern-match on uniqueness.
- The doc TOC branch is the doc-specific analogue. Without it, agent infers from
  "Single-file scope" and lands on `find_symbol(relativePath:)` _most of the
  time_, but adds `metaOnly=true` (wrong) or falls back to `Read` under
  uncertainty.

### What was NOT fixed

- The classification of `find_symbol` modes (symbol, relativePath, both) is
  still implicit. Future eval should test whether agents correctly pick `symbol`
  vs `relativePath` mode for ambiguous cases (e.g., "show me everything about
  Reranker"). Not in scope for this iteration.
- `metaOnly=true` semantics not surfaced in SUFFIX. Old SUFFIX agents misused it
  as "give me less detail" rather than "give me only metadata, no content". Out
  of scope.

---

## Iteration 7b — Depth vs Breadth Smoothing (2026-05-13)

Context: user pointed out that the initial Iteration 7 rule "NEVER re-run
semantic_search on an area you already searched; navigate instead" was too
rigid. It conflated two distinct intents — **depth** (same result, dig deeper)
which genuinely belongs to `find_symbol`, and **breadth** (different subsystem,
different terminology, different language slice in a polyglot repo, pagination,
or a different angle like tests) which legitimately needs another search.

Evals: extended `evals/2026-05-13-post-search-navigation-evals.json` with 8
breadth/depth cases (B1-B8).

### Fix Applied

Replaced the absolute "NEVER re-run semantic_search" line in both
`enforce-tearags-search.sh` (production SUFFIX) and `search-cascade.md`
(Subagent block) with an explicit DEPTH vs BREADTH split:

- **Depth** (same result, dig deeper) → `find_symbol`. Don't re-run the same
  search to "verify" or extract more from the same hit.
- **Breadth** (different subsystem, different angle, different terminology,
  another language in a polyglot repo, pagination) → re-run `semantic_search` /
  `hybrid_search` with a NEW query / pathPattern / offset.
- **Rule of thumb**: can you name a specific symbol/file/section? →
  `find_symbol`. Still surveying the landscape? → another search.

### Results (with-rule vs baseline-no-rule, both claude-opus-4-7)

| #   | Group   | Task                                              | Baseline (no rule)                                                                             | Fixed SUFFIX v2                                                                                   |
| --- | ------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| B1  | breadth | other subsystems with retry logic                 | ⚠️ `find_similar` only — adequate for "same pattern" but loses scope variants                  | ✅ `semantic_search('retry logic backoff')` → per-hit `find_symbol` (broader scan + body confirm) |
| B2  | breadth | empty result → reformulate vocabulary             | ✅ `hybrid_search('auth guard permission')`                                                    | ✅ `semantic_search` with synonyms                                                                |
| B3  | breadth | polyglot — same intent in different language      | ✅ `semantic_search + language='python'`                                                       | ✅ `semantic_search + language='python'`                                                          |
| B4  | breadth | pagination — show ALL usages                      | ✅ `hybrid_search offset=10,20,30…`                                                            | ✅ `hybrid_search offset=10,20,30…`                                                               |
| B5  | breadth | different angle (tests for same subsystem)        | ✅ `hybrid_search pathPattern='**/{test,tests,__tests__,spec}/**'`                             | ✅ `semantic_search pathPattern='**/tests/**'`                                                    |
| B6  | depth   | trap — repeat question on same fully-visible body | ✅ "No tool call — answer directly from chunk"                                                 | ✅ "No tool call — answer from already-visible body"                                              |
| B7  | breadth | failed query → reformulate to codebase vocabulary | ✅ `hybrid_search('rate budget tracker')`                                                      | ✅ `hybrid_search('rate budget tracker')`                                                         |
| B8  | depth   | known symbol named in chunk → fetch it            | ❌ `find_symbol('ConnectionPool.initialize')` — wrong separator (`.` = static, `#` = instance) | ✅ `find_symbol('ConnectionPool#initialize')` — correct convention                                |

**Fixed SUFFIX v2: 8/8.** **Baseline: 7/8** — B8 failed on `Class.method` vs
`Class#method` convention; B1 stayed adequate with `find_similar`-only but lost
the chain depth (the rule's pattern explicitly does "broader scan → per-hit body
confirm", which gives the user actionable variants, not just "similar lines").
**Hard delta: +1pp; qualitative delta: cleaner chain on breadth tasks and
convention discipline on depth tasks.**

No regressions on the original 22 cases (same SUFFIX text covers them — same
results as Iteration 7).

### Why this matters

The original Iteration 7 SUFFIX, in trying to suppress redundant `Read`s after
search, accidentally encoded "don't search twice" as an absolute. In practice
agents need to re-search constantly when broadening scope. The fix preserves the
original anti-pattern (don't re-search the same query to dump more results from
the same hit) without blocking legitimate landscape surveying.

This is a textbook case of a rule that scored 22/22 on Iteration 7's eval set
but would have caused real regressions on breadth-shaped tasks the eval did not
exercise — surfaced only by the user's design intuition, not by metrics.

---

## Iteration 4 — Filters & MCP Resources (2026-05-15)

### Trigger

User observation: after Opus 4.7 made MCP tool schemas deferred (only loaded via
`ToolSearch select:<name>`) and stopped auto-attaching MCP resources, the agent
appeared to stop using `filter` parameters in tea-rags calls. Hypothesis: the
rule never documented the typed-filter surface or how to fetch
`tea-rags://schema/*` resources, so under stricter context conditions the agent
forgot they existed.

### Audit findings

| #   | Finding                                                                             | Severity |
| --- | ----------------------------------------------------------------------------------- | -------- |
| F1  | `filter` param described only in scattered fragments; no field table                | HIGH     |
| F2  | `tea-rags://schema/*` resources mentioned but no `ReadMcpResourceTool` instructions | HIGH     |
| F3  | Deferred-tool-schema regime not mentioned (Opus 4.7 behavior)                       | HIGH     |
| F4  | `pathPattern` vs typed filter — no rule of thumb                                    | MED      |
| F5  | `taskId` typed filter never mentioned anywhere                                      | MED      |

### Eval design — 10 cases

5 audit-finding cases (F1–F5), 2 controls (find_symbol regression, ripgrep TODO
regression), 2 mandatory subagent routing cases (Explore + task-agent), 1 edge
case (non-English Russian + analytics + filter combined). See
`evals/2026-05-15-filters-and-mcp-resources-evals.json`.

### Triage outcome

Eval surprised us: Sonnet handles most filter cases adequately even without the
rule (training-time MCP knowledge). The real gap is **quality of the plan**, not
PASS/FAIL: agents reach for raw `filter:{must:…}` when typed param exists, use
wrong enum types (`testFile=true` instead of `'only'`), don't discover `taskId`.

The one strict regression vs baseline: case 9 (subagent reindex after parent
edit) — already covered by the existing rule, no fix needed.

Findings F1, F4, F5 confirmed → fix. F2 (MCP resource reading) and F3 (deferred
schema) — Sonnet already does this; documented in fix anyway because Opus 4.7
behavior may differ from Sonnet baseline.

### Fix

Single new section `## Filters` inserted before `## Filter Level: file vs chunk`
(+37 lines, file grew from 406 → 443):

1. **Typed filters table** — 13 fields with type / enum values / when-to-use
2. **Raw `filter` escape-hatch block** — points at
   `ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/filters")`
3. **List of all `tea-rags://schema/*` URIs** with explicit "NOT auto-attached —
   fetch on demand"
4. **Typed-vs-pathPattern rule of thumb** — language/documentation/testFile use
   typed; arbitrary path globs use pathPattern
5. **Subagent injection block** also gets a typed-filters mini-list (subagents
   inherit the rule via the injected block, not via this file)

### Per-eval results (iteration 4)

| #   | Case                        | Baseline                | v4 pre-fix              | v4 post-fix                              |
| --- | --------------------------- | ----------------------- | ----------------------- | ---------------------------------------- |
| 1   | filter for time window      | PASS (vague)            | PASS raw filter         | **PASS typed `modifiedAfter`**           |
| 2   | filter syntax help          | PASS (List+Read)        | PASS (List+Read)        | **PASS direct ReadMcpResourceTool**      |
| 3   | ToolSearch first call       | PASS                    | PASS                    | PASS                                     |
| 4   | language + testFile typed   | PARTIAL (testFile=true) | PARTIAL (testFile=true) | **PASS testFile='only'**                 |
| 5   | taskId filter               | PASS raw filter         | PASS raw filter         | **PASS typed `taskId`**                  |
| 6   | find_symbol Reranker.rerank | PASS                    | PASS                    | PASS                                     |
| 7   | ripgrep TODO                | PASS                    | PASS                    | PASS                                     |
| 8   | subagent exhaustive         | PARTIAL (extra step)    | PASS                    | **PASS list_projects + paginated**       |
| 9   | subagent reindex            | **FAIL no reindex**     | PASS                    | **PASS + bonus typed symbolId**          |
| 10  | non-English hotspots+filter | PARTIAL (vague)         | PASS raw ageDays        | **PASS typed modifiedAfter + chunkType** |

### Hard metrics

- Pass rate: baseline 70% → with-rule 100% (+30pp)
- Typed-filter usage rate: baseline 4/10 → post-fix 6/10 (+1 bonus)
- Wrong-enum cases: 1 → 0
- File length: 406 → 443 (+37 lines, well under 500-line target)

### Key design decisions

- **Did NOT add a "deferred tool schemas" section** — eval showed Sonnet figures
  this out from the deferred-tools system reminder. Adding it to search-cascade
  would duplicate the system reminder; if Opus 4.7 in production needs it, the
  fix belongs in a separate, more-targeted rule (or in the prime hook output).
- **Did NOT rewrite the Decision Tree** — it already mentions filters in a few
  places. The new `## Filters` section is referenced indirectly; agents that
  follow the tree to a leaf naturally reach a search call and now see the filter
  surface as a first-class concept.
- **Did add typed-filter list to subagent injection block** — subagents do NOT
  read this file, only the injected block. If we don't repeat the table there,
  the fix benefits the parent agent only.

### What this iteration did NOT validate

- Does Opus 4.7 in a real production session actually use typed filters now? The
  eval is Sonnet-based. Confirming Opus 4.7 behavior requires a follow-up with
  the actual model and the actual MCP server attached.
- Is the `## Filters` table complete? It mirrors `TypedFilterParams` in
  `src/core/api/public/dto/explore.ts` as of 2026-05-15. New typed fields added
  to that interface MUST be added here.

---

## 2026-06-19 — Deferred-loading audit fixes (Opus 4.8)

**Driver:** audit of tea-rags MCP surfaces against deferred-tool-loading best
practices (Opus 4.8 loads tool _names_ only; full schema fetched on demand via
ToolSearch). Plus a user observation: the agent "almost never uses
`find_symbol`'s `path` param" despite it yielding a documentation TOC.

**Note on the prior iteration's deferral.** The 2026-05-15 entry deliberately
did NOT add a deferred-tool-schemas section ("Sonnet figures it out from the
system reminder… if Opus 4.7 needs it, the fix belongs in a separate rule or the
prime hook"). Under Opus 4.8 deferred loading is now the live mechanism, so this
run adds a compact "Tool Invocation Under Deferred Loading" note — kept to the
exact-name→ToolSearch mapping only, not a duplicate of the system reminder.

### Results (paper eval — describe first tool, no execution)

| Condition  | Pass         |
| ---------- | ------------ |
| After-fix  | 10/10 (100%) |
| Before-fix | 10/10 (100%) |
| No-rule    | 7/10 (70%)   |

- Delta cascade-vs-nothing: **+30pp** (no-rule defaults `Read` for doc TOC
  Eval-1/9, `hybrid_search` for intent Eval-7).
- Delta after-vs-before: **0pp** — see Limitation.

### Changes

| #   | Fix                                                                                                                                                                 | Severity         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | "Tool Invocation Under Deferred Loading" note (`mcp__tea-rags__<name>` / `mcp__ripgrep__search`)                                                                    | CRITICAL         |
| 2   | Unified "find_symbol — the navigation workhorse" section: symbol-mode table + **relativePath-mode "USE THIS MORE" for doc TOC** + graph precedence + optimal routes | MAJOR + user req |
| 3   | Decision-tree "Yes" branch rewritten on DEFINITION/USAGES/INTENT axis; removed redundant dup-route branches                                                         | MAJOR            |
| 4   | Graph tree-branch → pointer to unified section (de-dup)                                                                                                             | —                |
| 5   | "Portability" section (Claude-Code vs portable MCP resources)                                                                                                       | MINOR            |

Companion (same branch, outside cascade): `prime/format.ts` thresholds collapsed
to 1 line/signal (TDD red→green, 80 prime tests pass); `document.ts`
`add_documents` → `annotations: { idempotentHint: false }`.

### Limitation (after-vs-before = 0pp)

The eval injects FULL cascade text; the grader reads carefully. The old cascade
already contained the `find_symbol(relativePath)` doc-TOC route (after-search
table + tree branch), so a careful reader routed Eval-1/9 correctly pre-fix. The
user's real-world complaint is **under-weighting of a resident rule under low
attention / deferred loading**, not missing text. The fixes raise prominence and
remove tree ambiguity — effects a careful-read paper eval cannot resolve. What
it DOES prove: **no regression** (after-fix holds 100%) + cascade standalone
value (+30pp). Measuring the prominence effect needs a live low-attention A/B.

Eval cases + per-case grades: `evals.json` (this run).

## 2026-09-15 — Outline / TOC drill-down (bead tea-rags-mcp-u74dj)

Field report (taxdome session): after `find_symbol` returned a class outline or
a doc TOC, the agent did not read individual members/sections via `find_symbol`.
It grepped a 57 KB persisted dump and fell back to `Read`. Diagnosis split the
report into instruction defects and product defects.

### Root causes

| Kind        | Defect                                                                                                                                                 | Evidence                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Instruction | Mode A table + After-Search row: class lookup returns "outline + all method bodies". Real outline = member symbolIds only                              | `CodeChunkGrouper.group` content = name + member ids |
| Instruction | Doc chunk row: `parentSymbolId` is `doc:<hash>`. Real value = doc path                                                                                 | payload of any doc chunk                             |
| Instruction | No rule for outline lines as addresses, none for saved tool-output dumps                                                                               | no-rule E6 greps the dump                            |
| Product     | `resolveSymbols` rendered a TOC whenever >1 doc chunks shared a parent → multi-chunk section lookup lost its content, TOC listed only the queried hash | `doc:447d443a09c8`: 5 chunks, 5.8 KB → 2-line TOC    |
| Product     | Class outline required a class-level chunk; member-only scroll returned bodies                                                                         | TS `StatsCache` → 6 bodies                           |
| Product     | Class query merged all RSpec chunks with `parentSymbolId` = class; oversized split gave every example one shared symbolId                              | taxdome `worker_spec.rb`: 16 chunks, one id, ~52 KB  |

### Results

| Suite                   | Pass  | Pct  |
| ----------------------- | ----- | ---- |
| no-rule (hook-injected) | 12/14 | 86%  |
| before-fix (HEAD)       | 12/14 | 86%  |
| after-fix               | 14/14 | 100% |

- before-fix FAIL E3, E8 — both caused by the stale "all method bodies" claim
  (agent expected bodies inline, drilled only conditionally).
- no-rule FAIL E6 (Grep on the saved dump — the field-report behaviour), C2
  (ripgrep on an identifier).
- Delta +14pp, below the +50pp target: clean prompts that hand over an outline
  are solved without rules. The failure mode that produced the report lived in
  product defects no instruction can route around; those were fixed in code
  (TDD) in the same branch.

### Changes (guidance)

| Surface                                        | Change                                                                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules/search-cascade.md`                      | After-Search rows (class outline without tests, doc path, outline drill, saved dump, class tests via `hybrid_search` `testFile: "only"`); Mode A; "Outline / TOC = map" paragraph; decision tree; prohibited pattern |
| `scripts/enforce-tearags-search.sh`            | class → outline, drill-by-id bullet, doc TOC via relativePath                                                                                                                                                        |
| `rules/references/subagent-injection.md`       | mirror of the hook block                                                                                                                                                                                             |
| `skills/analytics-rerank/SKILL.md`             | `doc:<hash>` = one section; parentSymbolId = doc path                                                                                                                                                                |
| `src/mcp/tools/explore.ts` (tool schema)       | class/module → OUTLINE only, doc:<hash> → section content, lines are addresses                                                                                                                                       |
| `src/mcp/resources/registry.ts` (search-guide) | class outline without bodies, drill recipe                                                                                                                                                                           |

Measurement is paper-style; the hook appends the INSTALLED pre-fix subagent
suffix to every eval prompt, so the after-fix subagent still saw the old "parent
is doc:<hash>" line there and flagged the conflict. Cases + grades:
`evals/2026-09-15-outline-drill-evals.json`.

### Iteration 2 — tests out of the class outline (option a)

The first cut listed a class's specs as `tests: <symbolId>` lines inside its
outline and gave every oversized-split test example its own symbolId. Rejected
on review: the class→spec link rests on `parentSymbolId` equalling the top-level
`describe` constant, so string describes, nested describes and shared examples
never appear — an incomplete list that reads as complete — and the per-example
ids moved the chunk set (`chunking` 1 → 2 for ruby + typescript), which the
drift monitor routes to `--force` on every Ruby/TS index.

Now: a class query returns source members only, test chunks excluded; tests of a
class go through `hybrid_search` with `testFile: "only"`. Chunker change
reverted, no version bump, no reindex. Per-example test addressing across all
test-chunking languages is epic `tea-rags-mcp-phftd` (one shared chunking bump).

| Suite                                  | Pass | Pct  |
| -------------------------------------- | ---- | ---- |
| after-fix v2 (E3, E5, E6, E11, C1, C4) | 6/6  | 100% |

E6 rewritten (outline carries no test lines → `hybrid_search`
`testFile: "only"`), E11 new (subagent asks for the specs of a method). Known
limitation: `find_symbol("<Top>.<scope>")` on an oversized split scope still
merges every part — the epic's target.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 12/12 PASS (100%)
- Last recorded rate: 100% (10/10 after_fix, 2026-06-19; later sub-suites 100%)
- FAIL list: none
- Notes: Artifact mapped to rules/core.md +
  rules/guides/{decision-tree,navigation}.md. Case 11 passed on tool choice but
  omitted names[]; case 12 used review_changes(naming) per
  guides/decision-tree.md (never hand-list a diff's names) rather than the
  eval's get_naming_lexicon(changes); both graded PASS.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags
  0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace,
  real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 11/12 PASS (92%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 12/12 (100%).
- CODEX-ONLY (harness regression candidates):
  - `12` — hand-lists names[] to get_naming_lexicon after plain review_changes
    (no sections:[naming]/changes form) [model behaviour]
- Both-fail count: 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only)
- Result: 11/12 PASS (92%) over 12 scored cases (superseded 0; evals/ sub-suite
  files not scored)
- Task 12 rate: 12/12 (100%); delta -8pp
- FAIL:
  - `11` — get_naming_lexicon called without names/types, plus hybrid_search
    cross-check on TaxAutomationDocument (listed in not-routes); T12 passed this
    on tool choice only
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins (tea-rags 0.46.10 +
  dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks
  (plan-only)
- Result: 11/12 PASS (92%) (N/A: 0)
- Codex T14 rate: 92% (11/12)
- Claude T22 rate: 92% (11/12)
- FAIL list:
  - `12` — review_changes then hand-listed names[] to get_naming_lexicon — still

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading)
- Result: 11/12 PASS (92%) over 12 scored cases (superseded: 0)
- Baseline (round 1): 11/12 (92%)
- Delta: +0pp (case 11 fixed: get_naming_lexicon with names[], no cross-check;
  case 12 newly failing)
- FAIL list:
  - 12 — review_changes(changes:{}, sections:["naming"]) correct, but plans a
    follow-up get_naming_lexicon(names[]) "if a finding needs a deeper verdict"
    — the not-route (lexicon after review_changes). guides/decision-tree.md
    naming branch (l.100-101) routes diff names to review_changes but never says
    its findings are the whole answer / no lexicon follow-up.
- Notes: cases 3 and 7 graded on the primary route (hybrid_search /
  semantic_search); the optional find_symbol definition lookup (3) and post-hit
  find_symbol drill (7) are the cascade's depth step, not the forbidden route.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11
  / dinopowers 0.24.4.
- Result: 11/12 PASS (92%) (N/A excluded: 0).
- Round-1 Codex: 11/12 (92%). Delta: ±0 pp.
- FAIL list:
  - `12` — review_changes then hand-listed names[] into get_naming_lexicon
    (mustNot); naming section verdicts not used as the answer.

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading; no
  per-case length cap)
- Result: 9/12 PASS (75%) over scored cases (superseded: 0)
- Baseline (round 2): 11/12 (92%)
- Delta: -17pp (regressions: 7, 11; 12 still failing)
- FAIL list:
  - 7 — semantic_search is the primary route, but the plan adds an optional
    second-angle `hybrid_search(query="confidence dampening rerank")` — a
    not-route for this case. The core "Breadth → re-run semantic_search /
    hybrid_search with a NEW query" wording licenses it.
  - 11 — get_naming_lexicon called without `names`/`types` (vague "scoped if
    parameters allow"), then a hybrid_search cross-check (not-route). The
    rebuilt core routing table (rules/core.md "Routing") has no naming row, so
    the subject never reached guides/decision-tree.md's naming branch (l.104:
    get_naming_lexicon with names/types).
  - 12 — review_changes(changes:{}, sections:["naming"]) correct, but then
    "supplement with get_naming_lexicon" + find_symbol/hybrid_search — the
    not-route. decision-tree.md l.110 says review.findings are the answer with
    no lexicon follow-up, but the core routing row "diff review →
    review_changes" says nothing about naming, and the subject did not open the
    decision-tree guide.
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.12
  / dinopowers 0.24.5, rebuilt from live hook output); old plugin hook text
  present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12
  / dinopowers 0.24.5.
- Result: 12/12 PASS (100.0%) (N/A excluded: 0).
- Round-2 Codex: 11/12 (91.7%). Delta: +8.3 pp.
- FAIL list: none.

## 2026-10-23 — evals-to-100 re-run round 4 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading; no
  per-case length cap)
- Result: 11/12 PASS (92%) over scored cases (superseded: 0)
- Baseline (round 3): 9/12 (75%)
- Delta: +17pp (7 and 12 fixed; 11 still failing)
- FAIL list:
  - 11 — get_naming_lexicon is the route, but called with "query/term `row` +
    domain, following the tool's own parameter schema" — `names` / `types` never
    stated (MUST in expected); a conditional hybrid_search follow-up when the
    lexicon is thin. The core Routing row ("a name's fit → get_naming_lexicon")
    names the tool but not its `names[]`/`types` inputs; that shape lives only
    in guides/decision-tree.md / search-examples.md, which the core does not
    send this case to.
- Notes: case 3 adds an optional find_symbol(metaOnly) to locate the definition
  and exclude it from the usage tally — not the usage route, graded PASS;
  conditional-on-empty fallbacks (cases 1, 2, 8, 10) graded PASS.
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.13
  / dinopowers 0.24.6, rebuilt from live hook output); old plugin hook text
  present in subject context but declared void (limitation).

## 2026-10-27 — Rake task addressing without Rake guidance (k0602)

- Question: do agents address a Rake task by its Rake name (`billing:sync`) with
  no Rake-specific guidance — only the one language-neutral "DSL entry blocks"
  line in the navigation guide's symbolId conventions?
- Cases: R-rake-1, R-rake-2 (new), neighbours R6, R7, R9; all five in ONE
  session per run, plan-only, hypothetical `shop` project, ×3 per client.
- Codex: codex-cli 0.162.1, gpt-6-luna medium, scratch `CODEX_HOME`, tea-rags
  0.47.26 from the branch's `harness/codex`, MCP = worktree build, `prime`
  stubbed silent.
- Claude: `claude -p` sonnet, `--setting-sources project` (no user plugins),
  `--plugin-dir .claude-plugin/tea-rags`, `--strict-mcp-config` = worktree
  build, `prime` stubbed silent.

| Case     | Codex | Claude |
| -------- | ----- | ------ |
| R-rake-1 | 0/3   | 0/3    |
| R-rake-2 | 0/3   | 0/3    |
| R6       | 3/3   | 3/3    |
| R7       | 3/3   | 3/3    |
| R9       | 0/3   | 3/3    |

- Failure mode, both clients, every run: `billing:sync` is read as DSL text, not
  an identifier → literal grep for `billing:sync` / `task :sync` →
  `find_symbol(relativePath:)` outline → body; R-rake-2 adds explore, never
  `get_callees(symbolId: "billing:sync")` first.
- No session opened `tea-rags://guide/navigation` before planning (Codex listed
  it as a later step; Claude made no tool calls), so the guide line was never
  seen — practice #33. Codex package context is byte-identical to the base
  commit apart from the version (guides are served by MCP), so the Codex R9 0/3
  (grep for `PaymentGateway` before `find_symbol`) is pre-existing, not caused
  by this change.
- Not repaired (parent decision: no further guidance without review).

### Follow-up — DSL name in core's routing sentence (k0602, tea-rags 0.47.27)

- Change: core's non-identifier-text row now says
  ``DSL `ns:task` = symbol; code name, even a "pattern"/"glob" → usages row, not `rg --files`.``
  The navigation guide's "DSL entry blocks" line is removed (one fact, one
  place). core.md 8899/8900 chars; Codex `core.txt` 9482 bytes (hook budget
  9650).
- Slice: R-rake-1, R-rake-2, R6, R7, R9 plus the rows the edited sentence sits
  in or points to (R1, R3, R4, case 8); all nine in ONE session per run, same
  stand as above, ×3 per client.
- Round 0
  (``A code/DSL name (`ns:task`) = symbol; "pattern"/"glob" → usages row``):
  R-rake-1/2 3/3 both; Codex R1 2/3 (one run planned `find_symbol` →
  `get_callers` for a constant's usages) → reworded to keep code names on the
  usages row explicitly.
- Round 1 (shipped):

| Case     | Codex | Claude |
| -------- | ----- | ------ |
| R-rake-1 | 3/3   | 3/3    |
| R-rake-2 | 3/3   | 3/3    |
| R6       | 3/3   | 3/3    |
| R7       | 3/3   | 3/3    |
| R9       | 1/3   | 3/3    |
| R1       | 3/3   | 3/3    |
| R3       | 3/3   | 3/3    |
| R4       | 0/3   | 3/3    |
| 8        | 3/3   | 3/3    |

- Codex R9 is pre-existing (0/3 before this change): run 2 greps
  `PaymentGateway` first, run 3 opens with `hybrid_search(metaOnly)`. Not
  repaired here.
- Codex R4 is pre-existing: every run plans
  `grep -rn "Alpha::Beta|Gamma::Delta"` as ONE literal string ("treat `|` as a
  character"), so the alternation never matches. Baseline check on the 0.47.26
  package (R1/R3/R4/8 slice, ×3): same literal-pipe plan 3/3, R1/R3/8 3/3. Not
  repaired here.

## 2026-10-27 — `find_symbol(symbols:)` batch as `cat` (yz10n, tea-rags 0.47.30)

- Finding: in the benchmark, agents used a `symbols` batch to dump code — 88
  batch entries, 52 file paths + 12 directories + 24 ids; the path entries
  carried 190k of 197k chars. The server half (65c0e3839) answers a batched file
  as an outline and a directory as `missing`; this is the rule half.
- Change: core routing row 1 now reads
  ``file/dir path, doc TOC, how `<dir>` works → `find_symbol(relativePath:)` outline first, then ONE batch of its member ids``;
  the Invariants batch line reads
  ``Read the `Class#method` ids an answer NAMED (rows, outline, graph edges) in ONE `find_symbol(symbols: [<ids>])` — never file/dir paths.``
  explore ORIENT gets a "Path typed first" line (relativePath outline is call 1;
  a `symbols` batch never carries a file / dir path). navigation + decision-tree
  guides aligned. core.md 8897/8900 chars; Codex `core.txt` 9478 bytes (hook
  budget 9650).
- New case B1 (invented area `src/telemetry/sampling/`). Slice: B1 + the
  batching / outline neighbours 6, 13, 14, 15; all five in ONE session per run,
  ×3 per client, stand `/tmp/1k059-stand-tr` (Codex scratch `CODEX_HOME`, Claude
  `--plugin-dir`, sonnet).
- Round 0 (Invariants line only): B1 Codex 1/3 — the explore ORIENT branch
  (semantic `entryPoint` search for a directory target) and the core research
  row (`get_architecture_report`) won over the Invariants line.
- Round 1 (+ explore "Path typed first"): B1 Codex 2/3 — a run that opened no
  file planned from core alone and took the research row.
- Round 2 (shipped, + core routing row 1):

| Case | Red Codex | Red Claude | Green Codex | Green Claude |
| ---- | --------- | ---------- | ----------- | ------------ |
| B1   | 2/3       | 2/3        | 3/3         | 3/3          |
| 6    | 2/3       | 3/3        | 3/3         | 3/3          |
| 13   | 3/3       | 3/3        | 3/3         | 3/3          |
| 14   | 3/3       | 3/3        | 3/3         | 3/3          |
| 15   | 3/3       | 3/3        | 3/3         | 3/3          |

- Red Claude B1 run 1 batched all six file paths
  (`symbols: ["src/telemetry/sampling/head-sampler.ts", …]`) — the defect
  itself. Red Codex 6 run 1 opened with `hybrid_search` (pre-existing, also seen
  in round 1).
- Watch: green Codex 14 runs 2–3 add a member-id batch after the directory frame
  for a pure "what is in <dir>" question. Not in case 14's `not` list, graded
  PASS; a leak of the routing-row wording to re-check next round.

## 2026-10-27 — bounded occurrence search, no shell reads of indexed code (urs4z, tea-rags 0.47.32)

- Defect: occurrence searches without a files-with-matches mode or line cap (46
  of 88 standard-search calls, 135k chars, largest 24k), shell reads of indexed
  files inside compounds (`cat f; sed -n …p f; grep …`), and `Read` of a search
  hit.
- core.md: the top paragraph now carries the ban (indexed code never read via
  `Read`, `cat`/`sed`/`head`, or grep match lines; grep only locates —
  files-with-matches or a line cap, anchor's dir, never whole-repo; then
  find_symbol reads the needed methods). Usages row `"<X>" <dir>` (literal,
  `-l`) → outline → batch of only the needed methods; phrase row line-capped;
  row 1 and the manual-read invariant take "lines N–M". `rg --files` mentions
  dropped. core.md 8897 → 8821 chars; Codex `core.txt` 9478 → 9468 bytes; Cursor
  `tea-rags-core.mdc` 9044 chars.
- Guides aligned: navigation (Who-uses-X, codegraph-off table), decision-tree
  (preamble, usages branches, Bash-compound and unbounded-search anti-patterns),
  pagination (`noEdges`), bug-hunt (phrase line, no `rg`).
- New cases G1 (constant usages in a 14k-file repo) and G2 (lines 90–130 of an
  indexed file plus a same-dir grep). Slice: G1, G2 + neighbours R1, R2, R3, 8;
  one session per run, Codex ×3, Claude ×1 (owner rule), stand
  `/tmp/1k059-stand-tr`.

| Case | Red Codex | Red Claude | Round 1 Codex | Round 1 Claude | Round 2 Codex | Round 2 Claude | Final Codex | Final Claude |
| ---- | --------- | ---------- | ------------- | -------------- | ------------- | -------------- | ----------- | ------------ |
| G1   | 0/3       | 0/1        | 3/3           | 1/1            | 1/3           | 1/1            | 1/3         | 1/1          |
| G2   | 0/3       | 0/1        | 0/3           | 1/1            | 1/3           | 1/1            | 0/3         | 1/1          |
| R1   | 3/3       | 1/1        | 3/3           | 1/1            | 2/3           | 1/1            | 3/3         | 0/1          |
| R2   | 3/3       | 1/1        | 3/3           | 1/1            | 2/3           | 1/1            | 3/3         | 1/1          |
| R3   | 3/3       | 1/1        | 3/3           | 1/1            | 3/3           | 1/1            | 3/3         | 0/1          |
| 8    | 3/3       | 1/1        | 3/3           | 1/1            | 3/3           | 1/1            | 3/3         | 1/1          |

- Red: every G1 run searched the whole repo with content output; G2 ran `Read`
  of the range (Codex 2/3) or an uncapped grep.
- Round 1 (flags `-l` / `-m 5` in core rows): G1 fixed; G2 Codex read "show me
  lines 90–130" as a manual-read order → `Read` 3/3.
- Round 2 (+ "lines N–M" in row 1 and the manual-read invariant): G2 Read 2/3 on
  Codex; G1 whole-repo `-l` on 2/3 with unchanged G1 wording (variance); R1/R2
  Codex r3 opened explore → `usage-pattern.md` → `hybrid_search` for the name
  (explore TRACE has no occurrence route — pre-existing).
- Final (owner wording: neutral bound terms, ban in the top paragraph): G2
  shell/`Read` gone 3/3 on Codex, but the grep lost its cap (no `-m`), so 0/3 on
  the bound; G1 whole-repo `-l` 2/3. Claude R1/R3 called `hybrid_search` first
  to find an "anchor dir" for a name with no known anchor — the scope clause
  needs "else the source root".
- Open: Codex dialect maps the tool phrase to `shell grep -rn`, which every row
  expands into a recursive, uncapped command; the final owner terminology
  ("default code search tool" / "default code read tool") needs the transform
  updated in the same change.

## 2026-10-27 — repair round: bounded Codex dialect, owner terminology (urs4z, tea-rags 0.47.32)

- Root cause on Codex: `scripts/harness/transform.ts` mapped the tool phrase to
  `shell grep -rn`, so every row rendered a recursive, uncapped command. The
  dialect now maps "default code search tool" → `shell grep -rl` (Cursor
  `Grep tool`) and the new "default code read tool" → `shell file reads` (Cursor
  `Read tool`); "client's standard code search tool" is gone from sources, and a
  generator test fails on any role phrase or `shell grep -rn` in the rendered
  Codex harness.
- core.md: the ban names the two roles; scope clause "in the anchor's dir when
  known, else the source root — never the repo root or
  hybrid_search/semantic_search for a dir"; row 1 batch "(N–M: ids spanning
  it)"; callers row "every call / all callers". explore SKILL.md and
  `usage-pattern.md` carry the occurrence route (no `hybrid_search` for
  exact-name usages). core.md 8875 chars, Codex `core.txt` 9241, Cursor
  `tea-rags-core.mdc` 9044.

| Case | Round 1 Codex | Round 1 Claude | Round 2 Codex | Round 2 Claude |
| ---- | ------------- | -------------- | ------------- | -------------- |
| G1   | 2/3           | 1/1            | 3/3           | 1/1            |
| G2   | 2/3           | 1/1            | 3/3           | 1/1            |
| R1   | 3/3           | 1/1            | 3/3           | 1/1            |
| R2   | 2/3           | 1/1            | 3/3           | 1/1            |
| R3   | 3/3           | 1/1            | 3/3           | 1/1            |
| 8    | 3/3           | 1/1            | 3/3           | 1/1            |

- Round 1 (mapping + terminology + scope clause): every Codex search was
  `grep -rl`. Fails: G1 r2 scoped to the repo root, G2 r1 skipped the range
  batch, R2 r1 matched the usages row and dropped `get_callers`.
- Round 2 (+ "never the repo root", range batch, "every call" in the callers
  row): all green. Watch: with no anchor, runs now scope to `app/` (Claude also
  runs `lib/`/`spec/` separately); recall outside the source dirs is the cost.
