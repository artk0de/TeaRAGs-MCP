# vtuu4 — closure-batched TypeScript Programs: implementation plan

Spec:
`docs/superpowers/specs/2026-09-26-vtuu4-closure-batched-ts-programs-design.md`.
Bead: tea-rags-mcp-vtuu4. Spike reference: `$J/vtuu4-spike/` (`pack.mjs`,
`seq.mjs`, `parity.mjs`).

Every commit touching `ts-program-cache.ts` or `resolution-runner.ts` carries a
`Why:` line (silo-pairing). Resolver output is claimed identical, so no version
bump: the last task re-pins and records `Versions: unchanged — …`.

## Decisions taken while planning

- **The per-entry `coverage` strategy stays.** The spec removes the
  whole-Program path; it does not mention coverage. Coverage keeps serving an
  incremental run below the warm-up gate, an explicit
  `CODEGRAPH_TS_PROGRAM_STRATEGY=coverage`, and any file no batch plan names.
  `whole` / `auto` above the gate now mean the batched strategy. The strategy
  names and the public observables (`wholeProgramFileCount`,
  `wholeProgramBuildCount`) keep their names: they name the whole-PROJECT
  strategy, not one Program.
- **`maxRetainedSourceTextBytes` keeps bounding the coverage LRU.** The shared
  SourceFile LRU gets its own text budget, `maxParsedSourceTextBytes`
  (`CODEGRAPH_TS_PROGRAM_PARSED_TEXT_MB`, default 40). `rememberParse` and
  `evictParsedOverflow` keep their names and gain the byte semantics.
  Repurposing `maxRetainedSourceTextBytes` would silently change what an
  existing env knob bounds.
- **Batches pack the run's corpus roots only.** tsconfig-only roots carry no
  call site this run resolves; their one effect on a corpus file is a global
  declaration, which the prelude carries. They still feed prelude discovery.
- **Per-file call counts ride the pass plan** (`expectedCallSites`), counted in
  pass-1 by `CodegraphRunState#absorb`.
- **Pass-2 order is a resolver hook the runner reads.** `CallResolver` gains
  `planResolveVisits()` and `endResolveVisitGroup()`; the runner exposes them
  per language; `GraphBuildFinalizer` indexes the spill by byte offset and
  visits the ordered groups, yielding a macrotask at each group end. With no
  language asking for an order the finalizer streams exactly as before.

## Task 1 — `TSProgramBatchPlanner` (pure packing) + import graph

Files:

- `src/core/domains/language/typescript/resolver/ts-program-batch-planner.ts`
- `src/core/domains/language/typescript/resolver/ts-program-import-graph.ts`
- `tests/core/domains/language/typescript/resolver/ts-program-batch-planner.test.ts`
- `tests/core/domains/language/typescript/resolver/ts-program-import-graph.test.ts`

Planner tests (graph literals, no I/O):

- `keeps every batch under the text budget and the call cap`
- `packs roots in DFS postorder from the entry roots`
- `separates a root whose own closure exceeds the text budget as oversize`
- `carries the prelude on every batch and charges its text to each`
- `assigns every root to exactly one batch or to oversize`
- `places a root that alone exceeds the call cap in a batch of its own`
- `produces the same plan for the same graph`

Graph tests (temp-dir fixtures through the real compiler resolution):

- `follows imports, export-from, require in JS, reference paths and type references`
- `records each file's text size`
- `marks global scripts, declare-global files and ambient module declarations`
- `collects lib reference directives as prelude libs`
- `selects dependency global scripts for the prelude but not dependency modules`

Commit:
`feat(trajectory): TSProgramBatchPlanner packs closure batches (tea-rags-mcp-vtuu4)`.

## Task 2 — shared host: text-byte LRU, pinned prelude, shared resolution cache

Files: `ts-program-cache.ts`, new test
`tests/core/domains/language/typescript/resolver/ts-program-cache-parse-lru.test.ts`.

- `evicts parses least-recently-used by source text bytes`
- `never evicts a pinned prelude parse however far the budget overflows`
- `hands a later Program the same bound SourceFile on a hit`
- `resolves every Program's imports through one shared ModuleResolutionCache`
- `reads the parse text budget from CODEGRAPH_TS_PROGRAM_PARSED_TEXT_MB`

Commit:
`perf(trajectory): bound the TS parse cache by text bytes (tea-rags-mcp-vtuu4)`.

## Task 3 — admission formula

Files: `ts-program-heap-admission.ts`, `ts-resolver.ts`
(`resolveProgramHeapBudget`), `ts-program-heap-admission.test.ts` rewritten
red-first (intentional invariant change: the projection now reads text and call
sites, not roots and served files).

- `projects a batch as base + text + call sites`
- `charges the retained parse cache beyond the batch's own text`
- `admits the planned 40 MB / 15k configuration on a 2 GB-peak budget`
- `refuses the batched strategy when its largest batch does not fit`
- `projects one oversize unit on its full closure`
- `keeps the coverage floor as base + roots`
- downgrade message and env-knob cases

Commit:
`perf(trajectory): admit TS batches on text and call sites (tea-rags-mcp-vtuu4)`.

## Task 4 — `TSProgramCache` switched to batches

Files: `ts-program-cache.ts`, `ts-resolver.ts`, `index.ts` barrel; new
`tests/core/domains/language/typescript/resolver/ts-program-cache-batches.test.ts`;
`ts-program-cache-segmentation.test.ts` deleted, its invariants re-stated in the
batch test; `ts-program-cache-whole-strategy.test.ts` keeps every example except
the two that pin segment rotation and the `segmentFiles` diagnostic key.

- `serves every file of a batch off that batch's Program`
- `builds the next batch only after releasing the current one`
- `releases the current batch Program so it becomes collectable`
- `reuses bound parses across batches rather than re-reading them`
- `runs oversize roots after clearing the parse cache, prelude kept`
- `resolves an oversize root over budget without the checker and counts it`
- `serves a file no batch names through the per-entry path`
- `builds nothing past the plan when the batched projection does not fit`

Commit: `perf(trajectory)!`-free:
`perf(trajectory): replace the whole TS Program with closure batches (tea-rags-mcp-vtuu4)`.

## Task 5 — pass-2 visits files in batch order

Files: `contracts/types/codegraph-resolution.ts`, `contracts/types/language.ts`,
`typescript/index.ts`, `ts-resolver.ts`, `run-state.ts`,
`run-global-map-registry.ts`, `resolution-runner.ts`, `graph-finalizer.ts`;
tests in `resolution-runner.test.ts`, `graph-finalizer.test.ts`.

- runner: `hands each language's visit plan to pass-2 and forwards group ends`
- runner: `passes pass-1 call-site counts on the resolve plan`
- finalizer: `visits a language's files batch by batch, oversize roots last`
- finalizer: `yields a macrotask and ends the group between batches`
- finalizer: `streams the spill unchanged when no resolver asks for an order`
- finalizer: `keeps a repeated relPath's spill lines in their original order`

Commit:
`perf(trajectory): resolve TS files in closure-batch order (tea-rags-mcp-vtuu4)`.

## Task 6 — parity fixture

File:
`tests/core/domains/language/typescript/resolver/ts-program-batch-parity.test.ts`.

- `resolves a multi-root project to the same edges whole and batched`
- `keeps a global overload pick the prelude carries`

Commit:
`test(trajectory): whole vs batched TS edge parity (tea-rags-mcp-vtuu4)`.

## Task 7 — navigators, re-pin, offline evidence

- `src/core/domains/language/CLAUDE.md`: replace the whole-Program and
  segmentation bullets with the batch facts.
- `npm run pin:lang-versions`; `Versions: unchanged — …` with the parity number.
- `scripts/spikes/ts-batched-program-parity.ts`: taxdome, ≥3,000 sampled calls,
  whole vs the production batch path; peak heap of the planned config. Heavy
  lock + `uptime` beside every timing. No reindex.

Commit:
`docs(trajectory): batch navigator + taxdome parity harness (tea-rags-mcp-vtuu4)`.
