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

| Iter | Lines | With-rule | Baseline (primary / strict) | Delta (strict) | Changes |
| ---- | ----- | --------- | --------------------------- | -------------- | ------- |
| 1    | 285   | 100%      | 100% / 58%                  | +42pp          | Initial |

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
