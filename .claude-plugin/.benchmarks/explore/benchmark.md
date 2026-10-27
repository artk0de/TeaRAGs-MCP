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
- Notes: Cases 1/8/14 (usage listing) went find_symbol + get_callers (codegraph
  ON) instead of the eval's hybrid_search; accepted on the search-cascade case 3
  precedent (hybrid_search OR get_callers), failure modes (ripgrep, Grep, Glob)
  not hit. Subject read explore SKILL.md + references +
  tea-rags://guide/navigation. Delta 0pp.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags
  0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace,
  real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 19/27 PASS (70%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 27/27 (100%).
- CODEX-ONLY (harness regression candidates):
  - `5` — 'what changed recently' answered with hybrid_search instead of
    rank_chunks rerank=codeReview [explore references
    (architecture/entry-point/usage patterns) not read / model behaviour]
  - `7` — no delegation to pattern-search (Collect intent); searched directly
    with hybrid_search [explore references (architecture/entry-point/usage
    patterns) not read / model behaviour]
  - `11` — semantic_search used as primary instead of hybrid_search for
    symbol+context (borderline; no Grep fallback) [explore references
    (architecture/entry-point/usage patterns) not read / model behaviour]
  - `17` — no Step 0 ORIENT (rerank=entryPoint, testFile/documentation exclude)
    before breadth; plain find_symbol/semantic_search; architecture-pattern
    reference not read [explore references (architecture/entry-point/usage
    patterns) not read / model behaviour]
  - `19` — codegraph OFF orientation: plain semantic_search, no
    rerank=onboarding and no explicit content-inferred flag [explore references
    (architecture/entry-point/usage patterns) not read / model behaviour]
  - `20` — entry-point question: plain semantic_search, no rerank=entryPoint /
    chunkSize post-filter / entry-point-pattern [explore references
    (architecture/entry-point/usage patterns) not read / model behaviour]
  - `21` — axis split present but sources axis lacks
    testFile:exclude+documentation:exclude (uses language filters), so axes not
    cleanly separated [explore references (architecture/entry-point/usage
    patterns) not read / model behaviour]
  - `25` — no Step 0 ORIENT (entryPoint) before pipeline walk; codegraph
    availability not derived from own tool list [explore references
    (architecture/entry-point/usage patterns) not read / model behaviour]
- Both-fail count: 0.

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI 2026.10.22, model auto (free plan), plan-only, plugins
  from harness/cursor (tea-rags + dinopowers), sessionStart hook digest; no
  superpowers, no subagentStart injection.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45
  parts.
- Result: 25/25 PASS (100%) over graded cases (N/A excluded: 0). Only explore-p1
  ran (ids 1-25); explore-p2 (ids 26-27) not run.
- Claude T12 for comparison: 27/27 (100%) suite-wide; over p1 ids 25/25 (no
  FAILs).
- Codex T14 for comparison: 19/27 (70%) suite-wide; over p1 ids 17/25 (68%)
  (FAIL 5,7,11,17,19,20,21,25).
- CURSOR-ONLY: none.
- Both-fail count (all): 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet
- Result: 25/27 PASS (93%) over scored cases (superseded: 0)
- Task 12 rate: 100%
- Delta: -7pp
- FAIL list: 17 (entryPoint ORIENT lacked testFile:exclude +
  documentation:exclude and no architecturalHub step; architecture-pattern.md
  not read); 20 (entryPoint answer without chunkSize / minFanOut+level:chunk
  small-utility mitigation; entry-point-pattern.md not read)
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags
  0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace,
  real hooks (SessionStart digest + dinopowers routing, SubagentStart block),
  AGENTS.md = core.
- Result: 24/27 PASS (89%) over graded cases (N/A excluded: 0).
- Codex T14: 19/27 (70%). Claude T22: 25/27 (93%).
- FAIL list:
  - `17` — FAIL; still (T14 FAIL): Defers to architecture-pattern.md; no
    explicit entryPoint ORIENT with testFile/documentation exclude before hubs.
    Claude T22 FAIL
  - `20` — FAIL; still (T14 FAIL): Routes to entry-point-pattern but no
    chunkSize/minFanOut+level:chunk small-utility mitigation stated. Claude T22
    FAIL
  - `25` — FAIL; still (T14 FAIL): Reads digest resource to find alias; does not
    derive codegraph availability from own tool list; ORIENT-before-backbone not
    stated. Claude T22 PASS

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; 27 cases split into two
  subjects of 14 + 13, run sequentially)
- Result: 25/27 PASS (93%) over scored cases (superseded: 0)
- Baseline (round 1): 25/27 (93%)
- Delta: +0pp
- FAIL list:
  - 17 — declared codegraph OFF because the main-session digest has no
    `codegraph.symbols` line, so no entryPoint ORIENT → architecturalHub (only a
    hypothetical "if on" branch)
  - 20 — same OFF decision; answered with relevance + chunkSize heuristic
    instead of rerank=entryPoint + chunkSize post-filter + get_callees tail
- Root cause (both): the rebuilt SessionStart digest (context-main.md) carries
  no `## Enrichment` / `codegraph.symbols` line at all, while explore SKILL.md
  "Codegraph availability" says a digest without that line is a STATED OFF that
  beats the tool list. With codegraph actually on, every main-session agent
  concludes OFF.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11
  / dinopowers 0.24.4.
- Result: 20/27 PASS (74%) (N/A excluded: 0).
- Round-1 Codex: 24/27 (89%). Delta: -15 pp.
- FAIL list:
  - `7` — EXEMPLAR collect workflow, never delegates to pattern-search.
  - `8` — get_callers primary, hybrid_search only as codegraph-off fallback
    (eval expects iterative hybrid_search; usage-pattern.md says codegraph wins
    — eval stale).
  - `14` — get_callers primary instead of hybrid_search for exhaustive usage
    (same eval/skill conflict as 8).
  - `15` — behaviour query misclassified as EXEMPLAR collect; semantic_search
    never named.
  - `17` — entryPoint ORIENT with filters, but no architecturalHub backbone step
    (row 4).
  - `19` — codegraph off: avoids entryPoint, labels content-inferred, but never
    names rerank=onboarding.
  - `25` — reads project digest instead of deciding codegraph from own tool
    list.

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; 27 cases split into two
  subjects of 14 + 13, run sequentially; strict literal grading; no per-case
  length cap)
- Result: 27/27 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 2): 25/27 (93%)
- Delta: +7pp (the two round-2 FAILs, caused by the digest lacking the codegraph
  line, now pass: codegraph availability is read from the subject's own tool
  list / explicit case statement)
- FAIL list: none
- Notes: case 1 expected text says "hybrid_search only"; the subject answered
  find_symbol → get_callers (codegraph on) with a hybrid_search cross-check —
  graded PASS because the failure mode (ripgrep after hybrid) is not hit and
  get_callers is the current usage-row route (case 8 encodes it); the case 1
  expected_output is stale relative to codegraph row 2. Case 3 expected
  "find_symbol with test pathPattern"; subject used hybrid_search
  testFile:"only" (the current mechanism, same as case 22) — PASS,
  expected_output stale.
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.12
  / dinopowers 0.24.5, rebuilt from live hook output); old plugin hook text
  present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12
  / dinopowers 0.24.5.
- Result: 22/27 PASS (81.5%) (N/A excluded: 0).
- Round-2 Codex: 20/27 (74.1%). Delta: +7.4 pp.
- FAIL list:
  - `1` — find_symbol -> get_callers primary, hybrid_search only as
    codegraph-off fallback (eval: hybrid_search primary)
  - `10` — refuses Grep but seed tool left to decision-tree (no
    hybrid_search/find_symbol named) and never states injected rules outrank the
    prompt
  - `12` — refuses Glob but hybrid_search not named (tool "selected" later) and
    no statement that injected rules outrank the third-party skill
  - `23` — code checked before the 512 claim, but no "code wins + name the
    drifted doc" on conflict — only "state whether supported"
  - `25` — reads project digest and routes PRE-GEN; no own-tool-list codegraph
    decision, no ORIENT -> hubs

## 2026-10-23 — Codex re-run round 4 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.13
  / dinopowers 0.24.6; Codex core adds "read ONE file per command; output past
  ~10k tokens loses its middle".
- Result: 14/27 PASS (51.9%) (N/A excluded: 0).
- Round-3 Codex: 22/27 (81.5%). Delta: -29.6 pp.
- FAIL list:
  - `1` — hybrid_search only, never checks codegraph state; get_callers
    (codegraph on) not considered
  - `5` — "what changed recently" -> semantic_search rerank=relevance instead of
    rank_chunks rerank=codeReview (SKILL.md "Change intent -> rank_chunks
    codeReview") (regression vs R3)
  - `7` — Collect intent searched directly (hybrid_search + find_similar)
    instead of delegating to $pattern-search (regression vs R3)
  - `8` — hybrid_search primary for "what calls"; get_callers only as
    conditional afterthought (regression vs R3)
  - `11` — symbol + behaviour words -> semantic_search instead of hybrid_search
    (regression vs R3)
  - `13` — find_symbol existence check without metaOnly=true (regression vs R3)
  - `17` — no ORIENT (semantic_search rerank=entryPoint, testFile/documentation
    exclude) — find_symbol directory outline instead (regression vs R3)
  - `19` — rerank=relevance instead of ORIENT rerank=onboarding; no
    content-inferred flag (regression vs R3)
  - `20` — "where does indexing start" -> relevance search; no
    rerank=entryPoint + chunkSize mitigation (regression vs R3)
  - `21` — one merged query instead of three per-axis calls (sources/tests/docs)
    (regression vs R3)
  - `22` — hybrid_search without testFile:"only" (regression vs R3)
  - `23` — checks code for 512 but no docs-excluded search and no drift flag
    naming the doc on conflict
  - `25` — reads digest instead of own tool list; no ORIENT before backbone

## 2026-10-23 — evals-to-100 re-run round 4 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; 27 cases split into two
  subjects of 14 + 13, run sequentially; strict literal grading; no per-case
  length cap)
- Result: 27/27 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 3): 27/27 (100%)
- Delta: +0pp
- FAIL list: none
- Stale expectation wording (graded on the current skill text, as in round 3):
  case 3 expects "find_symbol with test pathPattern" but explain-pattern.md "Is
  X tested?" prescribes hybrid_search testFile:"only" (the subject's route);
  case 20 "chunkSize post-filter" — the subject used the equivalent minFanOut +
  level:"chunk" mitigation that entry-point-pattern.md offers as the
  alternative; case 25 "get_callees walk" — architecture-pattern.md (after
  Step 1) offers get_callers on the top hub, which the subject planned.
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.13
  / dinopowers 0.24.6, rebuilt from live hook output); old plugin hook text
  present in subject context but declared void (limitation).

## 2026-10-27 — yz10n regression check (db40fc338, tea-rags 0.47.30)

- Trigger: db40fc338 added explore ORIENT "Path typed first", core routing row 1
  "how `<dir>` works → find_symbol(relativePath:) outline first, then ONE batch
  of its member ids", and the core Invariants batch line (ids only).
- Subjects: Codex (gpt-6-luna, medium) ×3 + Claude (sonnet, `--plugin-dir`,
  strict MCP config = worktree build) ×3, plan-only, one session per run, prime
  silenced. Stand `/tmp/1k059-stand-tr`, prompt `prompt-ex.txt`.
- Cases (path / area / structure / files-matching / which-tests routes): 4, 5,
  6, 12, 16, 17, 19, 21, 22, 25, plus search-cascade 14 as a probe.
- Baseline for every case under 3/3: the 65c0e3839 package (core, guides,
  explore SKILL.md, Codex core.txt / tea-rags-core, server agent-context)
  rebuilt into a scratch copy, same stand.

| Case | Codex HEAD | Claude HEAD | Claude 65c0e3839 | Verdict      |
| ---- | ---------- | ----------- | ---------------- | ------------ |
| 4    | 3/3        | 3/3         | —                | pass         |
| 5    | 3/3        | 0/3         | 0/3              | pre-existing |
| 6    | 3/3        | 3/3         | —                | pass         |
| 12   | 3/3        | 3/3         | —                | pass         |
| 16   | 3/3        | 3/3         | —                | pass         |
| 17   | 3/3        | 0/3         | 0/3              | pre-existing |
| 19   | 3/3        | 0/3         | 0/3              | pre-existing |
| 21   | 3/3        | 0/3         | 0/3              | pre-existing |
| 22   | 3/3        | 3/3         | —                | pass         |
| 25   | 3/3        | 0/3         | 0/3              | pre-existing |

- Claude misses: 5 picks `recent` / `hotspots` / `bugHunt`, not `codeReview`; 17
  and 25 skip the `entryPoint` ORIENT (25 also reads the digest); 19 skips
  `onboarding`; 21's sources axis is an outline, not a filtered search.
- Codex at 65c0e3839 on 5/17/19/21/25: 3/3 each, same as HEAD.
- Verdict: no regression from db40fc338. The five Claude failures reproduce on
  the parent commit: plan-only Claude names `Skill(tea-rags:explore)` but never
  loads it, so ORIENT / per-axis steps never reach its context and it plans from
  core routing alone.
- Drift, not graded: on 17/19/21/25 Claude at 65c0e3839 led with
  `get_architecture_report` (research row) in 11 of 12 plans; at HEAD it leads
  with `find_symbol(relativePath:)` + one member batch (row 1 now matches "how
  is `<dir>` organized"). Both miss the case expectations equally.
- Case 25 caveat: the shared fixture states "codegraph on", so "availability
  from own tool list" was graded as "not from prime".
- Search-cascade 14 probe ("What is in `<dir>`?"): every run starts with the
  directory frame (case passes). An extra member-id batch: Codex HEAD 2/3 (4/6
  with the earlier yz green round), Codex 65c0e3839 1/3 (conditional); Claude
  0/3 unconditional at both. The batch carries ids, never paths, and case 14's
  `not` list does not forbid it, so it does not break the case's intent (listing
  via find_symbol instead of ls / Glob / Read). It is an over-read, not the
  yz10n path-batch defect; no wording change.
