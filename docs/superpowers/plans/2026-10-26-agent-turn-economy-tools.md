# Agent Turn Economy — Tools (Phase 1) Implementation Plan

Spec: `docs/superpowers/specs/2026-10-26-agent-turn-economy-tools-design.md`.
Beads epic: `tea-rags-mcp-q1g6s`. Integration branch:
`worktree-agent-turn-economy`.

**Goal:** five tool changes that cut agent turns and tool-result tokens: N6,
N4 + N5, N1 + N2, plus the cross-cutting rule that every emitted call addresses
the tree that answered. Rules, skills and the plugin come in phase 2.

**Already landed on the integration branch:**

- `2b93f0a13` adds the shared contract: `EmptyAnswerReason` /
  `EmptyAnswerExplanation` (`contracts/types/empty-answer.ts`),
  `SuggestedToolCall` / `ToolCallAddress`
  (`contracts/types/suggested-tool-call.ts`), and
  `toolCallAddressFromWorkingTree` (`domains/explore/tool-call-address.ts`,
  exported from the explore barrel).
- `36b469034` adds optional `ExploreResponse.empty` and `ExploreResponse.next`.

Three agents work in parallel, one per Task. Edits to the shared files
(`explore-ops.ts`, `schemas.ts`, `dto/explore.ts`) stay additive, so the merges
reduce to resolving adjacent hunks.

## Impact signals (blastRadius, 2026-10-26)

| File                                      | Signal                                      |
| ----------------------------------------- | ------------------------------------------- |
| `api/public/dto/explore.ts`               | transitiveImpact 125 regional, fanIn 6      |
| `domains/explore/chunk-grouping/types.ts` | hub, fanIn 16 (Task 3 avoids changing it)   |
| `api/internal/ops/explore-ops.ts`         | fanOut 28 unstable, 49 commits; all 3 Tasks |
| `api/tools/schemas.ts`                    | 58 commits, chunk bugFixRate 67 concerning  |
| `domains/explore/strategies/symbol.ts`    | postProcess bugFixRate 50 concerning        |

Every file is a deep silo owned by the repo owner, so reviewer routing is not an
issue.

## Task 1 — N6 empty answers (`tea-rags-mcp-wrosj`)

Spec section "N6". Covers `get_callers` / `get_callees` (`unknownSymbol` with
the `#`↔`.` swap resolved through `resolvedSymbolId`, `noEdges` with the resolve
rate, `unknownFile`), `hybrid_search` / `semantic_search`
(`pathPatternMatchesNothing`, `filteredOut`, `noMatch`, with diagnostic counts
only on empty), and `find_co_changed` (`notBuilt`, `noHistory`). Graph DTOs get
an optional `empty`. Every emitted suggestion carries
`toolCallAddressFromWorkingTree` where it is a call.

## Task 2 — N4 lean payload + N5 next (`tea-rags-mcp-r4rl1`)

Spec sections "N4" and "N5". The default projection per mode lives in
`projectSearchResultPayloads`, with `signature` taken before metaOnly strips the
content. `fields: ["git"]` projects the subtree. `next` is assembled in
`ExploreOps` after ranking, gated on codegraph, and its `args` come from
`toolCallAddressFromWorkingTree`. Task 2 also collects, but does not apply, the
list of skill and rule consumers of raw `metaOnly` payload, for phase 2.
BREAKING CHANGE footer.

## Task 3 — N1 batch drill + N2 directory outline (`tea-rags-mcp-nmeba`)

Spec sections "N1" and "N2". It adds `symbols[]` to `FindSymbolSchema` and a
batch branch in `ExploreOps#buildFindSymbolStrategy`, which reuses
`SymbolSearchStrategy` per address with the working-tree overlay. The batch
response carries a lean projection, `resolvedAs`, and an ambiguity cap. The
directory fallback goes in `FileOutlineStrategy#executeExplore` and uses the
overlay; `nearest` comes back as `empty: unknownPath`. The grouper loses the
blank lines it prints for unnamed blocks and collapses `#partN` windows into one
member.

## Task 4 — integration (`tea-rags-mcp-lnmgq`)

The orchestrator merges the three branches into `worktree-agent-turn-economy`,
then runs `tsc`, `eslint`, the targeted suites and the full `npm test` once,
followed by live validation through `node build/cli/index.js call` against the
`tea-rags` alias: the empty-answer cases from the spec, the batch drill, the
directory outline, `next`, and row size before and after.
`npm run test:coverage` runs once, on `main`, after the merge.
