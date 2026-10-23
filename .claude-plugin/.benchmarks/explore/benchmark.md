# Explore Skill Benchmark

Date: 2026-03-30

## Summary

Optimized explore skill from 200-line monolith to 142-line focused skill with 15
covered intents. Fixed 2 MCP server bugs discovered during integration testing.
Evaluated tool selection accuracy across 16 unique test cases in 3 iterations +
8 integration tests with real MCP calls. Iteration 3 added 8 subagent-context
eval cases testing search injection enforcement and skill-conflict priority.

## Results by Iteration

| Iteration | Version                      | Evals | Pass Rate    | Key Change                                   |
| --------- | ---------------------------- | ----- | ------------ | -------------------------------------------- |
| 0         | baseline (no skill)          | 10    | 0% (0/10)    | Read after search, ripgrep for everything    |
| 1         | v1 (initial optimization)    | 10    | 100% (10/10) | Removed ~13% recall, fixed contrastive       |
| 2         | v2 (collision fixes)         | 8     | 100% (8/8)   | No ripgrep verification, stronger delegation |
| 3         | v3 (subagent injection eval) | 8     | 100% (8/8)   | Subagent contexts, skill-conflict priority   |

## Delta: with-skill vs without-skill

- Iteration 1-2: **+87.5pp** (12.5% → 100%)
- Iteration 3: **+75pp** (25% → 100%)

## Eval Results Detail

### Iteration 1 — Initial Optimization (tool-selection eval)

| #   | Task                     | With Skill                        | Baseline                 |
| --- | ------------------------ | --------------------------------- | ------------------------ |
| 1   | How does X work?         | ✅ semantic → find_symbol         | ❌ Read after search     |
| 2   | Where is X used?         | ✅ hybrid_search + pagination     | ❌ ripgrep               |
| 3   | Find all implementations | ✅ Collect → pattern-search       | ❌ ripgrep + Grep        |
| 4   | X vs Y differences       | ✅ ONE hybrid_search              | ❌ 2x find_symbol + Read |
| 5   | What to refactor         | ✅ Antipattern → refactoring-scan | ❌ unstructured 3-tool   |
| 6   | Best example             | ✅ Reference → pattern-search     | ❌ Glob + Read           |
| 7   | Error propagation        | ✅ semantic + find_symbol         | ❌ 2x Read               |
| 8   | Chunker hooks            | ✅ semantic + find_similar        | ❌ Glob + Read           |
| 9   | Subagent (migrations)    | ✅ MCP injection                  | ❌ no injection          |
| 10  | Russian query            | ✅ translate + semantic           | ❌ Read                  |

### Iteration 2 — Collision Fixes (skill-creator eval)

| #   | Task               | Failure Mode Tested     | Result                       |
| --- | ------------------ | ----------------------- | ---------------------------- |
| 1   | Where is X used?   | ripgrep-after-hybrid    | ✅ hybrid only               |
| 2   | How does X work?   | read-after-search       | ✅ no Read                   |
| 3   | Is X tested?       | glob-for-code           | ✅ find_symbol + pathPattern |
| 4   | TODO markers       | tea-rags-for-exact-text | ✅ ripgrep (correct!)        |
| 5   | Recent changes     | ripgrep-for-analytics   | ✅ rank_chunks + codeReview  |
| 6   | Error propagation  | cascade-collision       | ✅ no Read, no ripgrep       |
| 7   | Find all impls     | no-delegation           | ✅ STOP → pattern-search     |
| 8   | Call chain tracing | ripgrep-for-callers     | ✅ iterative hybrid_search   |

### Integration Tests (real MCP calls via subagents)

| #   | Test                              | Tools Used                   | Result                             |
| --- | --------------------------------- | ---------------------------- | ---------------------------------- |
| 1   | Code snippet → find_similar       | find_similar                 | ✅ Found Reranker.rerank + related |
| 2   | Recent changes in explore         | rank_chunks + codeReview     | ✅ 5 results with overlay          |
| 3   | Who owns chunker                  | rank_chunks + ownership      | ✅ 100% silo, full report          |
| 4   | Is EnrichmentCoordinator tested   | find_symbol → hybrid_search  | ✅ Found 49 tests                  |
| 5   | Call chain (backward)             | hybrid_search × 3 levels     | ✅ 5 complete chains               |
| 6   | Forward trace (Reranker.rerank)   | find_symbol × 8 calls        | ✅ Full dependency tree            |
| 7   | Backward trace (who calls rerank) | hybrid_search × 3 iterations | ✅ Full call chain                 |
| 8   | TODO markers                      | ripgrep                      | ✅ Correct: 0 TODOs in explore     |

## Bugs Found During Integration Testing

| Bug                                               | Location                    | Fix                                 |
| ------------------------------------------------- | --------------------------- | ----------------------------------- |
| find_symbol ignores pathPattern for member chunks | `explore-facade.ts:326-331` | Applied pathPattern to parentFilter |
| codeReview unavailable for rank_chunks            | `code-review.ts:18`         | Added "rank_chunks" to tools[]      |

## Changes Made

### Skill Changes

- **Removed ripgrep fallback** — search-cascade governs, explore doesn't
  duplicate
- **Added "no ripgrep verification" rule** — tea-rags results are complete
- **Strengthened delegation** — "STOP and delegate", "Do NOT search yourself"
- **EXPLAIN > Collect priority** — specific patterns override generic keywords
- **5 new use cases:** code snippet input, recent changes, ownership, test
  discovery, call chain (backward + forward with imports[])
- **Removed ~13% recall stat** — was about semantic_search, not hybrid_search
- **Fixed contrastive decomposition** — ONE hybrid_search, not semantic + 2x
  ripgrep
- **Removed legacy ripgrep supplement** — trust chunks

### Code Changes

- `explore-facade.ts` — pathPattern applied to both symbol and member scrolls
- `code-review.ts` — rank_chunks added to tools[]
- `explore-facade-find-symbol.test.ts` — new test for pathPattern propagation

### Iteration 3 — Subagent Injection + Skill-Conflict Priority

| #   | Task                                      | With Skill                      | Baseline                           |
| --- | ----------------------------------------- | ------------------------------- | ---------------------------------- |
| 9   | [task-agent] research provider lifecycle  | ✅ semantic_search, no Grep     | ✅ semantic_search + tree-sitter   |
| 10  | [plan-executor] prompt says "use Grep"    | ✅ hybrid_search, Grep rejected | ⚠️ hybrid + ripgrep + **Glob**     |
| 11  | [explore] symbol+context query            | ✅ hybrid_search only           | ⚠️ semantic + hybrid + **ripgrep** |
| 12  | [other] third-party skill says "use Glob" | ✅ hybrid_search, Glob rejected | ❌ **Glob** as primary tool        |
| 13  | [task-agent] class existence check        | ✅ find_symbol metaOnly=true    | ❌ hybrid + **ripgrep**            |
| 14  | [plan-executor] prompt says "use ripgrep" | ✅ hybrid_search for callers    | ⚠️ hybrid + ripgrep equal weight   |
| 15  | [task-agent] behavior/intent search       | ✅ semantic_search only         | ⚠️ semantic + hybrid + **ripgrep** |
| 16  | [explore] TODO/FIXME markers (control)    | ✅ ripgrep (correct)            | ✅ ripgrep (correct)               |

**Key findings:**

- Skill-conflict priority works: cases 10, 12, 14 correctly override explicit
  Grep/Glob/ripgrep requests from prompts and skills
- find_symbol metaOnly=true for existence checks unknown without injection
- Without rules, agent adds unnecessary ripgrep "for completeness" (cases
  11, 15)
- Glob used for "find files matching pattern" without injection (case 12)

### Key Design Decisions

1. **search-cascade governs** — explore prescribes tools for specific intents,
   defers to cascade for unmatched intents
2. **Two-direction tracing** — backward (hybrid_search) + forward (find_symbol +
   imports[])
3. **ripgrep only for exact text** — TODO, FIXME, import paths per cascade rules
4. **Delegation is hard stop** — Collect/Spread/Antipattern/Reference →
   delegate, don't search before or after
5. **Injection overrides skills** — subagent search injection takes priority
   over any skill-specific or prompt-specific search instructions

## Iteration 4 — ORIENT + axis-splitting + docs-hypothesis (2026-08-08)

Feature eval (not standalone optimization): new ORIENT phase (entry-point
orientation for broad targets, codegraph-gated with onboarding degradation),
axis-splitting rule (sources/tests/docs), "code is evidence, docs are
hypothesis" principle. Cases 17-26 in evals.json.

**Results:**

| Run                  | Score | Notes                                              |
| -------------------- | ----- | -------------------------------------------------- |
| Baseline (no skill)  | 7/10  | strong: preset names + typed filters self-describe |
| With-rule (pre-fix)  | 8/10  | failed 17, 25 — Defect A                           |
| With-rule (post-fix) | 10/10 | re-run: 2 failed + 2 controls, all PASS            |
| Delta                | +30pp |                                                    |

**Defect A (confirmed by eval, fixed):** ORIENT gate cited "how is X organized"
/ "architecture of X" as its own trigger examples, but codegraph intent row 4
intercepts those phrases BEFORE the Explore Flow — ORIENT was dead code for 2 of
its 3 examples. Fix: architecture-pattern.md absorbed ORIENT as Step 0 (entry
points BEFORE hubs); SKILL gate examples replaced with non-intercepted
phrasing + explicit cross-reference.

**Other eval-confirmed fixes:** (B) BREADTH known-symbol line contradicted
cascade — now find_symbol for DEFINITION, hybrid_search for USAGES; (C)
explain-pattern "Is X tested?" prescribed prohibited built-in Glob — replaced
with testFile:"only"; (D) subagent codegraph availability signal added
(get_callers in own tool list); (E) codegraph sub-patterns now carry
sources-axis filters; (F) entry-point-pattern unscoped-search failure path.

**Baseline observations:** Opus without the skill already splits axes when a
question names them (case 21) and treats doc claims as hypotheses (case 23) —
the skill's marginal value there is determinism, not capability. Baseline hard
failures: no entry-point orientation on broad targets (17, 25) and calling a
codegraph-gated preset with codegraph off (19).

**Follow-up candidates (pre-existing, out of feature scope):** addressing param
(`project:`) not mentioned in SKILL for subagent contexts; scope extraction
names no allowed tool; "pick deepest" scope rule inverts on end-to-end phrasing;
docs-as-subject route lives only in cascade, not in the SKILL intent table.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 27/27 PASS (100%)
- Last recorded rate: 100% (10/10 iteration 4 post-fix; iterations 1-3 100%)
- FAIL list: none
- Notes: Cases 1/8/14 (usage listing) went find_symbol + get_callers (codegraph ON) instead of the eval's hybrid_search; accepted on the search-cascade case 3 precedent (hybrid_search OR get_callers), failure modes (ripgrep, Grep, Glob) not hit. Subject read explore SKILL.md + references + tea-rags://guide/navigation. Delta 0pp.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 19/27 PASS (70%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 27/27 (100%).
- CODEX-ONLY (harness regression candidates):
  - `5` — 'what changed recently' answered with hybrid_search instead of rank_chunks rerank=codeReview [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
  - `7` — no delegation to pattern-search (Collect intent); searched directly with hybrid_search [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
  - `11` — semantic_search used as primary instead of hybrid_search for symbol+context (borderline; no Grep fallback) [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
  - `17` — no Step 0 ORIENT (rerank=entryPoint, testFile/documentation exclude) before breadth; plain find_symbol/semantic_search; architecture-pattern reference not read [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
  - `19` — codegraph OFF orientation: plain semantic_search, no rerank=onboarding and no explicit content-inferred flag [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
  - `20` — entry-point question: plain semantic_search, no rerank=entryPoint / chunkSize post-filter / entry-point-pattern [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
  - `21` — axis split present but sources axis lacks testFile:exclude+documentation:exclude (uses language filters), so axes not cleanly separated [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
  - `25` — no Step 0 ORIENT (entryPoint) before pipeline walk; codegraph availability not derived from own tool list [explore references (architecture/entry-point/usage patterns) not read / model behaviour]
- Both-fail count: 0.

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI 2026.10.22, model auto (free plan), plan-only, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest; no superpowers, no subagentStart injection.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 25/25 PASS (100%) over graded cases (N/A excluded: 0). Only explore-p1 ran (ids 1-25); explore-p2 (ids 26-27) not run.
- Claude T12 for comparison: 27/27 (100%) suite-wide; over p1 ids 25/25 (no FAILs).
- Codex T14 for comparison: 19/27 (70%) suite-wide; over p1 ids 17/25 (68%) (FAIL 5,7,11,17,19,20,21,25).
- CURSOR-ONLY: none.
- Both-fail count (all): 0.
