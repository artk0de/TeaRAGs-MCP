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
