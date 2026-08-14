# domains/language — per-language verticals: walker, resolver chain, chunking hooks, capability descriptor

## Invariants

- **Strategy INDEX in a `SymbolResolutionStrategy[]` is a correctness
  argument.** TS `sameFile` (8) takes only what `globalShortName` (9) drops as
  ambiguous; Java `importReceiver` (4) is terminal only because
  `enclosingBareCall` (5) returns `CONTINUE` on receiver-present calls; Ruby
  `receiverSetDrop` (13) emits the parks left by `constant` (8) /
  `explicitRequire` (9); per-site rationale is in the docblocks. Why:
  `resolveViaChain` is order-is-precedence — a reorder retargets edges and no
  test asserts order.
- **`localBindings` is position-aware — never index
  `ctx.localBindings?.[receiver]`.** `Record<string, LocalBinding[]>`, 1-based
  `line` per binding; read via
  `resolveLocalBindingType(bindings, receiver, call.startLine)`
  (`cone-dispatch.ts` plus five per-language strategies) or
  `resolveLocalBinding` when `valueKind` is needed (Ruby `localType`); greatest
  `line <= atLine` wins. Why: direct indexing loses flow sensitivity — the first
  binding of a reassigned variable types every later call.
- **`DefaultSymbolIdComposer.compose` (`kernel/symbol-id.ts`) yields the BASE
  id; `#partN` is chunker-only** — appended by `enforceMaxChunkSize`
  (`chunker/tree-sitter.ts`), never seen by the walker. Doc languages diverge
  too: `markdown/index.ts` has `chunkerHooks`, no `walker`/`resolver`,
  `doc:<hash>` ids. Why: id divergence yields edges pointing at ids no chunk
  carries — `find_symbol` / `get_callers` return nothing, no error.

## Mechanics

- **Resolver A/B measurement needs no reindex and no DuckDB.**
  `scripts/taxdome-codegraph-recall-forensics.ts` re-resolves a corpus in
  process, read-only; `scripts/codegraph-chain-tally.ts --defer <passName>` runs
  production and modified chains in ONE process over ONE symbol table, diffing
  per call site (valid only at `chain drift 0`). Reindex is only for index-level
  metrics (`resolveSuccessRate` via `DEBUG=1 tea-rags prime`). Why:
  `epic-completion-gate.md` routes this at a user-gated reindex, costing days
  for a 90-second in-process delta.
- **Dispatch narrowing terminates FOUR ways** (`kernel/dispatch-narrowing.ts`):
  0 survivors → no edges; 1 → one `dynamic` edge at `confidence: 1.0`
  (evidence-unique, NOT type-proven); over the corpus-adaptive cap from
  `dispatchFanoutPolicyFor` → `ambiguous` with NO edges (f2jsb); else the fan at
  `discount/m`. Sub-1 edges reach analytics confidence-WEIGHTED
  (`SUM(confidence)` fanIn/fanOut, PageRank split across the fan); navigation
  hides them via `isNavigationVisibleEdge`. Why: over the cap a multi-survivor
  site emits nothing, and fanIn read unweighted over-counts a fan m-fold.
- **`TSProgramCache` lives on `TSCallResolver`, refreshed by an mtime re-stat
  per `acquire`; `reset()` has NO caller in `src`.** Why: auditing for a
  run-boundary discard finds nothing and invites a spurious `reset()`.
- **By default it builds ONE whole-project Program, not one per entry file, and
  that Program answers to NEITHER retention bound.**
  `CODEGRAPH_TS_PROGRAM_STRATEGY` = `coverage` | `whole` | `auto` (default).
  `auto` primes from `loadTsConfigFileNames` — the tsconfig's own
  include/exclude expansion, i.e. the set `tsc` compiles — once the run has
  touched `CODEGRAPH_TS_PROGRAM_WHOLE_MIN_ENTRIES` distinct files (200) and the
  root set fits `CODEGRAPH_TS_PROGRAM_WHOLE_ROOT_MAX` (20,000). It is held
  OUTSIDE `entries`, so `evictOverflow` cannot reach it, and its text is
  excluded from `retainedSourceTextBytes`. Do NOT "unify" it into the LRU, and
  do NOT derive the root set by accumulating acquired files. Why: measured on
  taxdome (bd 6aytq), per-entry cost 86.1 ms/file and RISES with corpus position
  (14.6 → 71.6 over 2,200-file segments) while the union of those Programs
  parses 12,798 project files — the run rebuilds the whole project in slices.
  One Program costs 10.1 s and then serves everything: at shipping defaults the
  full corpus resolves in 58.8 s, 5.39 ms/file, 16x, with resolution parity
  (92,253 of 167,182 against 92,269). Putting it in the LRU evicts the one
  Program every remaining file is about to be served off; a growing root set
  rebuilds it repeatedly; and without the warm-up gate a three-file incremental
  reindex pays the 10.1 s build and ~4 GB of heap to resolve three files.
- **The run is SEGMENTED, and admission decides whether the whole Program is
  built at all.** `CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES` (5,000) counts
  DISTINCT files acquired since the segment began — `segmentFiles`, a run-wide
  Set, never the acquire count and never the whole Program's own `derived.size`
  — and the file that overflows it drops EVERY retained Program (`entries`
  cleared as well as `wholeEntry`) and rebuilds the whole one from the same
  roots, old dropped BEFORE `buildFrom` so the two generations are never live
  together. Measured on taxdome: the whole Program answers only ~145 distinct
  acquires before the per-entry LRU serves the rest (the tsconfig's world and
  the indexed corpus are different sets), so a counter keyed on `derived.size`
  stalls at 145 and never rotates, and retiring only the whole Program would
  leave eight growing checkers behind. Separately, `TSProgramCache` reads
  `v8.getHeapStatistics().heap_size_limit` in its own isolate and projects the
  peak (`ts-program-heap-admission.ts`): above the whole requirement → whole,
  between the two → coverage, below coverage's floor → `typecheckerOff`, which
  latches `acquire()` to `null` for the run and emits one `[enrichment-worker]`
  line. Admission overrides an explicit `whole`, unlike `wholeRootFilesMax`.
  Why: checker state is monotonic (+1.69 GB over taxdome's 10,912 files, 2.6 GB
  build → 4.31 GB live set), so an unsegmented 4096-declared worker dies at
  ~file 6,500; and a V8 heap OOM kills the ISOLATE — `buildFrom`'s try/catch
  never runs, the dispatch rejects `ERR_WORKER_OUT_OF_MEMORY`, and the run loses
  every codegraph signal with no retry. Counting acquires instead of distinct
  files would rebuild every ~116 files (production acquires ~43x per file);
  keeping the old entry alive across the rebuild would put the boundary at the
  peak the segmentation exists to remove. Validated offline at declared 4096 (V8
  reports 4288) over the full 10,912-file corpus: completes, 6.97 ms/file, one
  rotation at ~file 5,900, sampled peak 3,995 MB dropping to 2,885 MB across the
  boundary, 92,269 of 167,182 calls resolved — the same resolution the
  unsegmented run produced.
- **A BULK pass skips the warm-up and primes up front, from a count pass-1
  already has.** `CallEdgeResolutionRunner#prepareResolvePass` — pass-2's first
  act, before the spill is read — hands each language a
  `SymbolResolutionPassPlan { expectedFileCount, projectRoot }` off
  `CodegraphRunState#extractedFilesByLanguage`, and
  `TSProgramCache#primeForExpectedEntries` builds immediately when that count
  clears the SAME `wholeMinEntries` threshold. A count BELOW it returns without
  recording an attempt, so the per-acquire gate still governs an incremental run
  — keep it that way, and keep the count per LANGUAGE. Why: the gate can only
  learn a run is bulk by resolving 200 distinct files first, and on taxdome
  reaching them costs 66 per-entry `ts.createProgram` builds, 9–13 s of a 58.8 s
  pass, spent constructing slices of the Program about to replace them; while a
  run-wide count would build a whole TS Program for a Ruby-dominated run that
  happens to touch 40 `.ts` files.
- **Its shared parse cache holds THREE populations, each with its own rule:**
  project sources capped by `maxParsedFiles`, dependency `.d.ts` capped by
  `maxDependencyFiles`, and the default lib capped by neither. `populationOf`
  MUST test lib membership before dependency membership — with the compiler
  installed under the indexed root the lib lives inside `node_modules` and would
  otherwise read as an ordinary dependency. Why: exempting dependencies
  wholesale alongside the lib (the bd qb2s3 shape) is what made a real run climb
  ~1.8 MB per resolved file with the Program LRU and project-source count both
  already pinned at their caps — `node_modules` is discovered one import at a
  time, so it bounds the map only in a limit the run never reaches (bd 8qf86).
- **Capacity eviction reads through to retained Programs (`pinnedParseOf`)
  before re-parsing, and the Programs answer to `maxRetainedSourceTextBytes` — a
  union-counted non-lib text budget, newest build always kept.** Do NOT
  "simplify" the read-through away or make the budget evict the newest. Why:
  once the reachable dependency surface exceeds `maxDependencyFiles`, eviction
  frees nothing (the Program pins the AST) while the next build re-parses a
  PRIVATE copy — measured 4.6 MB → 153 MB heap per build (33x), a live run past
  3.9 GB RSS (bd 5je8t, the 4m2vb node_modules regression); and dropping the
  newest re-runs `createProgram` per file of its closure, the bd 4m2vb cost. The
  budget's floor is one full closure — the compiler's own resolution walk sets
  Program size, no cache policy shrinks it. Weight counts files OUTSIDE the repo
  root too: resolution realpaths its targets, so a symlinked layout (pnpm store,
  macOS `/tmp`) parks the dependency surface out-of-root and an in-root weight
  is blind to exactly the population that grew unbounded.
- **The host's `fileExists` / `directoryExists` / `realpath` memos are
  deliberately UNBOUNDED, unlike the parse cache beside them.** Module
  resolution probes the filesystem before any parse and re-runs per
  `ts.createProgram`, so these carry the syscall load: on this repo's `src`,
  2,634,551 calls → 8,691 over 900 entry files. Do not "fix" the missing
  eviction by copying `evictParsedOverflow`. Why: the distinct probe set
  SATURATES against the repo's directory tree — 300→900 entry files moved it by
  three paths (8,688→8,691) with retained keys flat at 1.05 MiB — so an LRU
  would evict live entries and thrash hardest on `directoryExists`, whose 1604x
  repeat rate comes from re-walking the same ~1,468 `node_modules` ancestors (bd
  e6yad). Same idiom as `createProjectFileProbe` (bd f3zcy) — an unbounded
  per-path existence memo on the same resolver — and the resolver instance, one
  per `repoRoot`, is what bounds both lifetimes, NOT `reset()`.

## Gotchas

- **`defaultImportFileEdges` asks the CALL chain a MODULE question.**
  `trajectory/codegraph/symbols/resolution-runner.ts` synthesises
  `{ receiver: basename, member: basename }` per import — `member` is a
  FILENAME, so a member-keyed pass answering it points `import './bar'` at
  whichever file declares `Other.bar`. TS and Ruby override `resolveFileEdges`
  via their real specifier→file mapper (`mapImportToFile` / Zeitwerk). Why: a
  new language on the default emits wrong file-level import edges, surfacing as
  an unstable `provider.test.ts` count, not as anything naming the resolver.
- **The capability drift-guard is one-sided.**
  `tests/core/domains/language/capability/drift-guard.test.ts` only checks
  renders of `LanguageFactory#capabilities` against the committed artefacts — it
  reads no resolver, walker or hook. Why: a stale tier or `tech` string in
  `<lang>/capability.ts` passes CI, so step 1 of `language-capability-sync.md`
  is the real control, not the guard.

## Boundaries

- **Deferral (`deferred(...)`) pays only where a LATER pass holds evidence the
  parking pass lacks.** Five park sites: TS
  `namedImport`/`importBasename`/`receiverSymbol`, Ruby
  `constant`/`explicitRequire`. Three others look identical, were MEASURED as bd
  86qfb (`codegraph-chain-tally.ts --defer <pass>`) and REJECTED, each verdict
  in its own docblock: java `importReceiver` (599 fabricated in-project edges),
  python `localBinding` (the yrs0 `serializer.is_valid()` false positive, 68×),
  python `importMatch`. Do NOT cite the pre-merge TS numbers: after 4kx9f and
  hzsxy the delta is ONE upgraded edge, a supersession living only in the spec.
  Why: converting a rejected site "for symmetry" reintroduces a measured
  regression.
- **Test-file SUFFIX patterns deliberately do NOT live here** — they are
  `TEST_PATTERNS_BY_LANGUAGE` in `core/infra/file-classification/patterns.ts`.
  The per-language `testFilePatterns` / `configureTestPatterns()` design was
  abandoned: it needs a module-global configured in every process context (main
  and both workers). Infra wins by sitting BELOW every consumer — not by
  importing nothing (`infra → contracts` type-only is allowed). Why: an
  unconfigured context silently misclassifies test files in whichever worker
  skipped the call.
- **`javascript/resolver/javascript-resolver.ts` staying a fall-through
  if-ladder is a blocked migration.** Only resolver not on `resolveViaChain`;
  its file-only import edge preempts the global short-name fallback through
  CONTROL FLOW. The chain move is a prerequisite for deferring that edge, and
  its chain tail is itself a global short-name fallback — the shape the
  Python/Java measurement showed loses precision. Why: converting the last
  un-migrated resolver for consistency reproduces a measured regression.

## See also

- `ruby/CLAUDE.md` — Ruby verdicts, gem gating, measurement denominators.
- `.claude/rules/resolver-architecture.md`,
  `.claude/rules/codegraph-walkers.md`, `.claude/rules/domains-language.md`
