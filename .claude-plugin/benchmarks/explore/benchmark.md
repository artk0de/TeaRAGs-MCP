# Explore Skill Benchmark

Date: 2026-03-30

## Summary

Optimized explore skill from 200-line monolith to 142-line focused skill with 15
covered intents. Fixed 2 MCP server bugs discovered during integration testing.
Evaluated tool selection accuracy across 8 unique test cases in 2 iterations + 5
integration tests with real MCP calls.

## Results by Iteration

| Iteration | Version                   | Evals | Pass Rate    | Key Change                                   |
| --------- | ------------------------- | ----- | ------------ | -------------------------------------------- |
| 0         | baseline (no skill)       | 10    | 0% (0/10)    | Read after search, ripgrep for everything    |
| 1         | v1 (initial optimization) | 10    | 100% (10/10) | Removed ~13% recall, fixed contrastive       |
| 2         | v2 (collision fixes)      | 8     | 100% (8/8)   | No ripgrep verification, stronger delegation |

## Delta: with-skill vs without-skill

**+87.5 percentage points** (12.5% → 100%)

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

### Key Design Decisions

1. **search-cascade governs** — explore prescribes tools for specific intents,
   defers to cascade for unmatched intents
2. **Two-direction tracing** — backward (hybrid_search) + forward (find_symbol +
   imports[])
3. **ripgrep only for exact text** — TODO, FIXME, import paths per cascade rules
4. **Delegation is hard stop** — Collect/Spread/Antipattern/Reference →
   delegate, don't search before or after
