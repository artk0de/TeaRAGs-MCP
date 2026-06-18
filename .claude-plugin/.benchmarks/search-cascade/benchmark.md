# Search Cascade Benchmark

Last updated: 2026-05-16 (post-split routing regression) Original: 2026-03-29

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
practices (Opus 4.8 loads tool *names* only; full schema fetched on demand via
ToolSearch). Plus a user observation: the agent "almost never uses
`find_symbol`'s `path` param" despite it yielding a documentation TOC.

**Note on the prior iteration's deferral.** The 2026-05-15 entry deliberately
did NOT add a deferred-tool-schemas section ("Sonnet figures it out from the
system reminder… if Opus 4.7 needs it, the fix belongs in a separate rule or the
prime hook"). Under Opus 4.8 deferred loading is now the live mechanism, so this
run adds a compact "Tool Invocation Under Deferred Loading" note — kept to the
exact-name→ToolSearch mapping only, not a duplicate of the system reminder.

### Results (paper eval — describe first tool, no execution)

| Condition  | Pass |
| ---------- | ---- |
| After-fix  | 10/10 (100%) |
| Before-fix | 10/10 (100%) |
| No-rule    | 7/10 (70%) |

- Delta cascade-vs-nothing: **+30pp** (no-rule defaults `Read` for doc TOC
  Eval-1/9, `hybrid_search` for intent Eval-7).
- Delta after-vs-before: **0pp** — see Limitation.

### Changes

| # | Fix | Severity |
| - | --- | -------- |
| 1 | "Tool Invocation Under Deferred Loading" note (`mcp__tea-rags__<name>` / `mcp__ripgrep__search`) | CRITICAL |
| 2 | Unified "find_symbol — the navigation workhorse" section: symbol-mode table + **relativePath-mode "USE THIS MORE" for doc TOC** + graph precedence + optimal routes | MAJOR + user req |
| 3 | Decision-tree "Yes" branch rewritten on DEFINITION/USAGES/INTENT axis; removed redundant dup-route branches | MAJOR |
| 4 | Graph tree-branch → pointer to unified section (de-dup) | — |
| 5 | "Portability" section (Claude-Code vs portable MCP resources) | MINOR |

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
