# vtuu4 — closure-batched TypeScript Programs (2 GB heap target)

Status: approved by the owner 2026-09-26. Bead: tea-rags-mcp-vtuu4.

## Problem

The TypeScript codegraph pass-2 worker OOMs on taxdome
(`ERR_WORKER_OUT_OF_MEMORY`). `TSProgramCache` builds ONE Program over the whole
project (the 6aytq design, `buildWholeProgram`, rotated every 5,000 files by
`rotateSegmentWhenFull`). On taxdome that Program is 24,772 files and 117.6 MB
of source text (project 89.9, deps 24.3, lib 3.5). A sampling heap profile at
the OOM shows ~5.4 GB: parsed ASTs 2.3 GB, binder 1.2 GB, checker ~1 GB,
pipeline ~50 MB. The same profile holds on three builds (pre-merge main,
`492c6e22b`, `20182a7ad`), so this is not a code regression: the corpus grew
(+4,692 TS files since 08-15) past what a whole-project Program fits.

The owner's target is a worker heap peak of at most 2 GB. 1 GB was measured and
rejected (below).

## Measured facts (spike, `$J/vtuu4-spike/`)

- Heap scales with source TEXT, not file count: AST ≈ 22 MB per MB of text,
  AST + bind ≈ 28–31 MB per MB. Checker ≈ 110 MB fixed + 17–34 KB per resolved
  call site (mean ≈ 25–30 KB).
- A bound `ts.SourceFile` is reusable across Programs through a shared compiler
  host: the binder skips a file whose `locals` is set, so a cache hit comes back
  already bound. Consecutive batches hit 80–95%.
- No leak: a Program + checker confined to a function frame is fully released
  after a macrotask (+13 MB over three rounds). The checker writes only `jsDoc`,
  `lineMap`, `packageJsonScope/Locations` onto shared nodes, none of which
  retains it.
- Forward import closure per file on taxdome: p50 315 files, p90 3,625, p99
  4,313, max 12,417.
- Sequential run of the planned configuration (40 MB text / 15k calls, 33
  Programs, shared LRU + shared `ModuleResolutionCache`): **max live heap 1,881
  MB**, retained between batches ≤ 1,445 MB, peak RSS 2,419 MB, 418,216 of
  418,367 call sites covered.
- Parity against the whole Program on 3,814 sampled calls: **99.53%**, zero lost
  edges. All 18 differences are overload picks between global declarations
  (`lib.webworker.d.ts` vs `lib.dom.d.ts`; `@types/node` timers vs DOM
  `setTimeout`), fixed by the prelude below.

## Design

### 1. Batch planner (new, TypeScript resolver)

`TSProgramBatchPlanner` — owned by `domains/language/typescript/resolver/`.

- Input: the roots the whole Program uses today (tsconfig `fileNames` ∪ corpus
  TS/JS), the import graph (`ts.preProcessFile` + `resolveModuleName` over the
  shared resolution cache), each file's text size and call-site count.
- Output: an ordered list of batches. Each batch = a set of roots whose closure
  union stays under a TEXT budget (default 40 MB) and a CALL cap (default 15k).
  Roots are packed in DFS postorder from entry roots (measured 5–30% less cold
  parse than directory order).
- Every batch carries the prelude (section 2).
- A root whose own closure exceeds the text budget is an OVERSIZE root. It is
  not packed; it is returned separately (section 5).
- Budgets are options with the defaults above, sized so the admission formula
  (section 4) lands under the worker heap limit.

### 2. Prelude (every batch)

- TypeScript lib files the whole Program would load, including every lib pulled
  by `/// <reference lib="…">` anywhere in the project closure.
- Project ambient / global files: `.d.ts` files with top-level `declare global`,
  ambient `declare module`, or no import/export, and the tsconfig
  `files`/`types` entries (on taxdome: 21 files, 85-file closure, 1.16 MB).
- Dependency declarations that change GLOBAL overload resolution: those whose
  declarations the whole Program would see as globals (on taxdome `@types/node`
  globals, ≈ 2.5 MB). Not the full ambient dependency set (97 files / 13.5 MB):
  only what affects globals.

The prelude parses once and stays pinned in the SourceFile cache.

### 3. `TSProgramCache`: sequential batch builder

- One shared `ts.CompilerHost` for the run, holding:
  - an LRU of bound `ts.SourceFile`s budgeted in source-text BYTES (default 40
    MB of text, ≈ 1.2–1.45 GB retained), prelude pinned;
  - a shared `ts.ModuleResolutionCache`;
  - the existing memo probes.
- `rememberParse` / `evictParsedOverflow` / `maxRetainedSourceTextBytes` keep
  their names and move to this semantics; the whole-Program path
  (`buildWholeProgram`, `rotateSegmentWhenFull`, the file-count segment) is
  removed rather than kept behind a flag.
- `findCovering` answers from the CURRENT batch Program only.

### 4. `ts-program-heap-admission`

Admission estimates a batch as `≈ 30 MB × textMB + ≈ 30 KB × calls + 110 MB`
plus the retained LRU, and compares that to the worker heap budget, instead of
counting files. The constants live in one place with the spike numbers as their
rationale.

### 5. Pass-2 order (`CallEdgeResolutionRunner`)

- Pass-2 visits files in BATCH order: build batch k's Program, resolve every
  call site of the files it covers, drop the Program and checker, yield a
  macrotask, build batch k+1.
- Oversize roots run LAST: clear the SourceFile LRU (keep the prelude), then one
  Program per oversize root over its FULL closure. On taxdome that is 4 roots /
  151 calls, ≈ 42 MB of text → ≈ 1.3 GB by the formula, under the budget without
  depth limits. If an oversize root's estimate still exceeds the budget, it is
  resolved without the checker-backed strategies (the tree-sitter chain still
  runs) and counted in a run-stats field, never silently dropped.

### 6. Rejected: 1 GB target

20 MB / 8k budgets → 149 Programs, 3.7× cold parse, 857 oversize roots holding
80.8k calls (19%) that would need depth-3 closures (98.6% parity), wall clock ≈
500 s. The owner chose 2 GB with no depth limit.

## Parity and versions

- Resolution output must match the whole Program except for the global overload
  picks the prelude fixes. The implementation is validated by the spike's parity
  harness on taxdome and by the existing TS resolver suites.
- The walker does not change, and resolver OUTPUT is claimed identical, so no
  version bump: re-pin with `npm run pin:lang-versions` and record
  `Versions: unchanged — …` with the parity numbers as evidence
  (`.claude/rules/language-capability-sync.md`).

## Testing

- Planner: packing respects both budgets, DFS postorder, oversize roots
  separated, prelude on every batch, deterministic output.
- Cache: LRU evicts by text bytes, pinned prelude survives eviction, a hit is
  returned bound (no re-bind).
- Admission: formula and constants.
- Runner: pass-2 visits files batch by batch; each file is resolved by the
  Program that covers it; oversize roots run last after the cache clear.
- Parity fixture: a small multi-root project resolved whole vs batched gives
  identical edges, including a global-overload case covered by the prelude.

## Live validation (after the merge to main, with the batch)

`DEBUG=1 node build/cli/index.js index-codebase --project taxdome --force-enrichments codegraph --languages typescript --json`
with the worker heap profiler on (`ENRICHMENT_WORKER_HEAP_PROFILE_DIR`): outcome
clean, peak heap ≤ 2 GB, TS `resolveSuccessRate` from `prime` equal to the last
good run (0.99), wall clock recorded with `uptime`.
