# facade-discipline — Benchmark

New path-scoped rule at `.claude/rules/facade-discipline.md`. Triggers when
agent edits `ExploreFacade` / `IngestFacade`, `api/public/app.ts`, or
`domains/explore/strategies/` / `domains/explore/queries/` /
`api/internal/ops/`. Purpose: prevent facade drift that ballooned
`ExploreFacade` from a designed-for-150-lines thin orchestrator to a 635-line
container for inline search/aggregation/branching logic.

## Summary

- **Lines:** 285
- **Eval cases:** 12 (50% drift scenarios, 25% controls, 25% edges incl.
  subagent routing + non-English + code review)
- **With-rule pass rate:** 12/12 (100%)
- **Without-rule primary (drift-prevention only):** 12/12 (100%)
- **Without-rule strict (category precision):** 7/12 (58%)
- **Delta (primary):** +0pp — baseline agent already had strong SE intuition
  because eval prompts explicitly telegraphed "N lines of inline work" (extract
  action was obvious).
- **Delta (strict):** +42pp — rule teaches category distinctions that baseline
  conflates: `queries/` (aggregate without vector search) vs `strategies/`
  (search+rerank) vs `ops/` (indexing/CRUD branching).

## Where the rule adds value

The baseline agent, given a prompt like "95 lines of per-language aggregation in
the facade, refactor plan?", correctly proposes extraction. But it defaults to
calling every extraction target a "strategy" because that's the only pattern it
sees in the existing codebase. This produces strategy soup — a `MetricsStrategy`
that does no search, a `CommitHistogramStrategy` that does no rerank, a
`CollectionHealthStrategy` that never touches a vector.

The rule introduces three distinctions that the baseline cannot invent:

1. **`queries/` as a category.** For scroll + aggregate without vector search, a
   dedicated query class (`IndexMetricsQuery`, `CollectionHealthQuery`) keeps
   the strategy surface clean.
2. **`ops/` for ingestion branching.** `IndexingOps` holds reindex vs full vs
   dry-run branching; facade stays a dispatcher even as modes multiply.
3. **Project-specific conventions**: validators in `api/errors.ts`, filter
   building via `registry.buildMergedFilter()` (not inline, not a generic
   `FilterBuilder` utility).

## Iterations

| Iter | Lines | With-rule     | Baseline (primary / strict)   | Delta (strict) | Changes                                                               |
| ---- | ----- | ------------- | ----------------------------- | -------------- | --------------------------------------------------------------------- |
| 1    | 285   | 12/12         | 100% / 58%                    | +42pp          | Initial                                                               |
| 2    | 382   | 16/16\*       | — / 75% (new cases 13–16)     | +25pp\*\*      | Gap-closing additions (see below)                                     |
| 3    | 489   | 3/3 new cases | 100% / 100% (new cases 17–19) | +0pp           | Loophole closure: private async pipeline helpers explicitly forbidden |

### Iteration-3 — the cosmetic-thinning loophole

**Failure observed:** when asked to refactor `ExploreFacade` under iter-2, the
agent initially collapsed the 4 search methods into one-line dispatchers by
extracting a `private async embedAndDispatch`, a `private async executeExplore`,
a `private buildFilter`, and 4 ctx-builder helpers — _all as private members of
ExploreFacade_. Every public method ≤ 10 lines, every size-budget check
satisfied, yet the pipeline lived in the facade class all the same. Total file
size went _up_ (464 → 478) because the private helpers stayed in the facade
file.

**Root cause:** iter-2 said "facade is thin dispatcher" and gave a 5-step
pipeline, but didn't forbid re-packaging that pipeline as private async methods
on the facade. "Thin" was measured by method body length, not by class
responsibility.

**Rule changes in iter-3:**

1. **"What a facade does" rewritten** — explicit statement that the facade does
   two things (validate + delegate), and that the pipeline lives in Ops.
   Responsibility table moved "path resolution / model guard / ensureStats /
   embedding / filter merge / ctx assembly / drift warning" into the Ops column.
2. **"Zero private async pipeline methods on the facade"** — hard structural
   check added as the new first gate of the Size Budget section.
   Method-body-length check demoted to second check; file-total demoted to
   informational.
3. **New anti-pattern** with a side-by-side BAD/GOOD for "public method thin but
   private async helpers do the pipeline" vs. "pure delegation to Ops".
4. **Decision tree reframed** — every new facade method delegates to Ops. The
   three-question tree now classifies the _inner_ work (strategy / query /
   nested ops), not the method's home.

**Post-fix application:** rule iter-3 applied to `ExploreFacade` → extracted
`ExploreOps` with the entire pipeline (126 + 404 lines = 530 total, vs. 478
inside one file before). Facade now holds only the Ops reference and two
synchronous input validators; every public method is 1–3 lines. Check 1 passes
(no private async methods on the facade).

The iter-3 fix was evidence-driven: the agent's own shortcut under iter-2 became
the rule's new counter-example.

**Eval on iter-3 additions (cases 17, 18, 19):** with-rule 3/3, baseline 3/3 —
+0pp delta. Honest reading: the bad pattern ("private async methods doing
pipeline work on the facade class") is telegraphed clearly enough in the prompts
that a reader with the current project layout (which mentions the
IngestFacade→IndexingOps convention) recognizes it without the rule. The rule's
value on these cases is **documentary**:

- A concrete clause to cite in PR review ("Check 1: zero private async pipeline
  methods")
- A counter-example that prevents over-literal reading of the iter-2 ≤20-line
  clause (easy to mistake "methods are short" for "facade is thin")
- Precedent for future sessions starting without full project context

Zero eval delta here does not mean the rule is inert — the loophole DID trip the
agent (me) in a live refactor under iter-2, and iter-3 is what made that failure
explicit in a form that survives across sessions.

\* 12 original cases remain 100% (instructions not weakened); 4 new cases added
for gaps surfaced during the 4 real-world extractions that ran against iter-1.

\*\* Delta measured on new cases only. Baseline strong on eval-14 (validator
colocation by precedent) and eval-15 (TypeScript discriminated-union knowledge);
rule uniquely wins eval-13 (multi-filter constructor-input pattern vs.
ExploreContext extension).

### Iteration-2 additions

1. **Size budget — method body is primary, file total is secondary.** The
   original "≤ 250 lines per file" caught multi-method facades that were already
   fine. Relaxed to ≤ 250 lines for 3–4 methods, ≤ 350 lines for 5–7. The
   per-method ≤ 20 rule is the forcing function.
2. **Multi-filter strategies — constructor-input pattern.** When a strategy
   needs two or more filters, pass a typed Input via constructor (mirror
   `SimilarSearchStrategy`). Do not wedge extra filters into `ExploreContext`.
   Do not build filters in the facade.
3. **Adding a new strategy — checklist.** Extend the `type` union in
   `strategies/types.ts`. Reject `as unknown as` casts to sidestep the union —
   that's silent widening that defeats exhaustiveness checks.
4. **Validator location crispness.** Bottom of the same facade file (not
   `api/errors.ts`, not a premature `validators/` subdirectory until 5+
   validators exist). Export for direct unit-test import.
5. **Test anti-pattern note.** `(facade as any).qdrant = ...` post-construction
   mutation silently exercises the wrong code path after ops/strategy
   extraction. Prefer constructor-time DI; if a test insists on swap, redirect
   to the extracted class: `(facade as any).indexingOps.indexing = ...`.

### Source of the additions

Each addition corresponds to a concrete friction point observed when applying
iter-1 to four real extractions (commits `cc9cb8d`, `c0cc189`, `846a52e`,
`38c9412`). `ExploreFacade` stayed at 464 lines after extraction — not drift,
just 7 dispatcher methods — which surfaced that the ≤ 250 budget was too strict.
The `SymbolSearchStrategy` needed two filters — surfaced the multi-filter gap.
Adding the new strategy class required an ugly `as unknown as` cast — surfaced
the type-union gap. Two tests with post-construction mutation broke — surfaced
the test anti-pattern. All five changes are evidence-driven, not speculative.

## Per-eval detail

| ID      | Category                    | With-rule | Baseline-primary | Baseline-strict |
| ------- | --------------------------- | :-------: | :--------------: | :-------------: |
| eval-1  | new-search-tool             |    ✅     |        ✅        |       ✅        |
| eval-2  | aggregation                 |    ✅     |        ✅        |       ❌        |
| eval-3  | ingest-branching            |    ✅     |        ✅        |       ✅        |
| eval-4  | refactor-drift (findSymbol) |    ✅     |        ✅        |       ✅        |
| eval-5  | control-keep-in-facade      |    ✅     |        ✅        |       ✅        |
| eval-6  | validation-extraction       |    ✅     |        ✅        |       ❌        |
| eval-7  | filter-building-antipattern |    ✅     |        ✅        |       ❌        |
| eval-8  | refactor-drift (metrics)    |    ✅     |        ✅        |       ❌        |
| eval-9  | subagent-explore            |    ✅     |        ✅        |       ❌        |
| eval-10 | subagent-task-agent         |    ✅     |        ✅        |       ✅        |
| eval-11 | edge-russian                |    ✅     |        ✅        |       ❌        |
| eval-12 | edge-code-review            |    ✅     |        ✅        |       ✅        |

## Key design decisions

1. **Path-scoped frontmatter over always-on skill.** The rule fires only when
   agent touches the relevant files, keeping the global context budget lean.
   Matches convention of `derived-signals.md`, `rerank-presets.md`,
   `payload-signals.md`.
2. **Size budgets over soft guidance.** "≤ 20 lines per facade method, ≤ 250
   lines per facade file" is enforceable at review time, unlike "keep it thin".
   The numbers come from the actual drift — 635 lines is 2.5× the budget that
   would have forced extraction earlier.
3. **Three-question decision tree.** Strategy / Query / Ops / pure dispatch —
   first "yes" wins. Keeps placement deterministic; removes the "I'll just put
   it here for now" escape.
4. **Explicit anti-pattern examples.** The `findSymbol` and `getIndexMetrics`
   code shapes are shown as BAD, with the correct dispatcher form as GOOD — so
   the rule catches pattern replication, not just new additions.
5. **Subagent-routing cases in the eval.** Both eval-9 (explore subagent told
   "edit this file") and eval-10 (task-agent with truncated target list) verify
   the rule overrides naive instruction following.

## Followups

Rule is deployed. Next work in this thread:

1. Extract `findSymbol` + `findByRelativePath` → `SymbolSearchStrategy`
2. Extract `getIndexMetrics` → `IndexMetricsQuery` (creates
   `domains/explore/queries/` as first citizen)
3. Extract `findSimilar` 12-line validation → `validateFindSimilarRequest`
4. Extract `IngestFacade.indexCodebase` branching → `IndexingOps` in
   `api/internal/ops/`
5. Update `add-mcp-endpoint` skill section 1.3 to reference
   `facade-discipline.md` and correct the "Search/query orchestration →
   explore-facade.ts" line to point at strategies/queries
6. Close beads `yjhu` / `vg9e` / `h711` by factual completion; open new task
   "Facade drift cleanup" under epic `dq9u`

## Files

- `.claude/rules/facade-discipline.md` — the rule (committed)
- `.claude-plugin/.benchmarks/facade-discipline/benchmark.md` — this file
- `.claude-plugin/.benchmarks/facade-discipline/evals.json` — eval cases and
  grading (committed)
- `.claude-plugin/.benchmarks/facade-discipline/workspace/` — gitignored
  iteration data (skill-snapshot + iteration-1)

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 11/12 PASS (92%)
- Last recorded rate: 100% (12/12 with-rule, iteration 1)
- FAIL list: eval-5 (control: keep a pure 4-line dispatch in the facade; subject moved resolve + model-guard invalidation into CollectionOps citing the responsibility table). Note: eval-6 (validator location) graded PASS because the current rule text itself puts validators at the bottom of the facade file, contradicting the eval's api/errors.ts expectation (stale eval).
- Notes: Rule artifact .claude/rules/facade-discipline.md was NOT changed by this epic, so eval-5 reflects a rule/eval tension (iteration-3 'every facade method delegates to Ops' wording vs the control), not a regression from the context change. Subject sonnet.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
- Result: not graded - 12/12 N/A (the subject is the repo-local rule .claude/rules/facade-discipline.md, not shipped to Codex: no AGENTS.md in the repo, not in any Codex package). Strict reading would be 0/12 with cause "rule not delivered".
- Claude T12 rate for comparison: 11/12 (92%)
- CODEX-ONLY: none (N/A)
- Both-fail count: 0

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only); scored all 19 cases (eval-1..12 + iteration cases 13..19); Task 12 scored 12
- Result: 16/19 PASS (84%) over 19 scored cases (superseded 0)
- Task 12 rate: 11/12 (92%); delta -8pp (case set widened; eval-5 now PASS)
- FAIL:
  - `eval-6` — validator placed at bottom of explore-facade.ts per current rule; eval expects api/errors.ts (STALE eval, contradicts eval-14; graded PASS in T12)
  - `eval-12` — review flags inline filter and Map grouping but omits registry.buildMergedFilter and the driftWarning:null / checkDrift item
  - `eval-16` — eval expects the <=350-line clause for 5-7 methods; rule no longer has it (200-line smoke alarm), subject answers conditionally (STALE eval)
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (plan-only)
- Result: not graded — 12/12 N/A (repo-local rule not shipped to Codex; no AGENTS.md). Strict reading would be 0/12: rule not delivered, no placement answers
- Codex T14 rate: N/A (12/12)
- Claude T22 rate: 84% (16/19)
- FAIL list: none

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only; graded strict-literal); scored all 19 cases (eval-1..12 + iteration cases 13..19)
- Result: 16/19 PASS (84%) over 19 scored cases (superseded 0)
- Baseline (round 1, Task 22): 16/19 (84%)
- Delta: +0pp (eval-6, eval-16 now PASS; eval-1, eval-5 newly FAIL)
- FAIL list:
  - `eval-1` — new strategy planned (strategies/, union extended, barrel export, Ops dispatch) but no registration step is stated; expected names `createExploreStrategy` registration (rule §3 allows createExploreStrategy OR per-request instantiation — the eval is narrower than the rule)
  - `eval-5` — extracts resolve/guard into `CollectionOps.clearIndex` ("add or reuse"); expected the existing ingest Ops method (`IngestFacade#clearIndex = this.indexingOps.clear(path)`); the prompt describes the old body (`status.clearIndex`), so the subject never looked at the current code
  - `eval-12` — flags inline filter, Map grouping and hard-coded `driftWarning: null` (Ops finalize), but does not name `registry.buildMergedFilter` as the Ops-side filter merge
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; no per-case length cap; graded strict-literal against the current evals.json)
- Result: 19/19 PASS (100%) over 19 scored cases (eval-1..12 + iteration 13..19; superseded 0)
- Baseline (round 2, Task 22): 84% (16/19)
- Delta: +16pp
- FAIL list: none
- Note: eval-1 (per-request instantiation in the Ops method stated as the registration choice), eval-5 (existing IndexingOps#clear, no new Ops class) and eval-12 (registry.buildMergedFilter + driftWarning as Ops finalize) now pass.
- Context: new SessionStart core+digest / SubagentStart block (rebuilt from live hook output); plugins tea-rags 0.46.12 / dinopowers 0.24.5; old plugin hook text present in subject context but declared void (limitation).
