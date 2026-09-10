# Index Drift Program — Design

**Status:** approved (brainstorm 2026-09-10) **Kind:** program (four epics)
**Related:** `tea-rags-mcp-frwka` (language versions, closed),
`tea-rags-mcp-a2ddb` (codegraph payload staleness), `tea-rags-mcp-sz1y0`
(repair-leg hash drift), `tea-rags-mcp-svguf` (`--force-enrichments`),
`tea-rags-mcp-4ozbi` (architecture drift refactoring) **Worktree:**
`.claude/worktrees/drift-program` at main `78e6c40b2`

## Goal

Every claim an index makes about itself — which payload keys it carries, which
walker produced its edges, which env it was built under, which commit it saw,
which model embedded it — is a stamp written at index time. "Drift" is the
distance between a stamp and what the current build, environment, or working
tree would produce now. The program turns the five detectors that grew
independently into one subdomain with one report and one remedy, adds the
detectors that are missing, heals the one staleness defect that no detector can
see, and puts the version-bump discipline the detectors depend on under
mechanical enforcement.

Constraints fixed by the user:

- Advisory monitors move; guards, policies, and heals stay where their side
  effect lives.
- Every new axis ships with the rule that says when to bump it AND the guard
  that fails when the bump is forgotten. A rule without a gate is what produced
  the ruby numbers below.
- Live validation per epic on the tea-rags self-index and on taxdome; a bead
  closes on measured evidence, not on a green suite.
- Implementation runs in Opus subagents; the parent session diagnoses `sz1y0`
  itself and validates every subagent report.

## Ground truth

### What detects drift today

| #   | Class                     | Detector                                                                                                                             | Compares                                                                                                        | Surface                                                                               |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Payload-key schema drift  | `SchemaDriftMonitor` (`domains/maintenance/schema-drift-monitor.ts`) over `StatsCache.checkSchemaDrift` (`infra/stats-cache.ts:141`) | composition descriptor keys vs `payloadFieldKeys` in the stats cache                                            | `driftWarning` on search responses (`ExploreOps#checkDrift`), prime `## Schema drift` |
| 2   | Language tooling versions | `LanguageVersionDriftMonitor` (`domains/maintenance/language-version-drift-monitor.ts`)                                              | `grammar` / `chunking` / `walker` / `codegraphSchema` per language vs sticky `CollectionEntry.languageVersions` | prime `## Language versions` only                                                     |
| 3   | Embedding model name      | `EmbeddingModelGuard#ensureMatch` (`adapters/qdrant/embedding-model-guard.ts`)                                                       | model name in the `INDEXING_METADATA_ID` marker                                                                 | throws `EmbeddingModelMismatchError` (409)                                            |
| 4   | Persisted-store versions  | five migration pipelines (`.claude/rules/migrations.md`)                                                                             | declared or derived version vs latest                                                                           | healed on the reindex sweep / graph open                                              |
| 5   | Working-tree freshness    | `IndexFreshnessCheck` (`domains/maintenance/freshness/`) + merkle diff inside a reindex + prime `computeStaleness`                   | branch, debounce TTL; file hashes; wall clock                                                                   | auto-update spawn; prime banner                                                       |
| 6   | Enrichment coverage       | unenriched filter + `EnrichmentRecovery`; repair pass on `content_hash`                                                              | payload presence; DuckDB store vs disk                                                                          | prime `## Enrichment`                                                                 |
| 7   | Infra gates               | `checkExternalQdrantVersion`, `writerStoresAgreeingBackendPair`, `UpdateCheckService`                                                | versions, registry/backend pair                                                                                 | startup, prime                                                                        |

Two facts shape the architecture. The core of #1 (`SchemaDrift`,
`checkSchemaDrift`, `formatSchemaDriftWarning`, `DriftRemedy`,
`resolveDriftRemedy`) lives in `infra/stats-cache.ts` — domain logic in the
infra layer, the same misplacement that moved the registry and the migration
framework out of `core/infra/` (`.claude/rules/domain-boundaries.md`). And #1
and #2 each render their own remedy string: #1 may say
`--force-enrichments git`, #2 may say `--force`, and prime prints both sections
with no merge, although `LanguageVersionDriftMonitor.formatWarning` documents a
"one command for the whole report" doctrine. A third monitor makes the merge
mandatory.

### What nothing detects

| Gap                                                         | Evidence                                                                                                                                                                                                                                                                                                                    | Severity                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Codegraph payload for files that stopped changing (`a2ddb`) | derived tables recomputed wholesale, payload rewritten only for the run's `chunkMap`; `enrichedAt` present so the unenriched filter is blind; repair pass discards its own overlays (`coordinator.ts:354`)                                                                                                                  | silent, monotonic, hits every codegraph rerank preset |
| Env values (not keys)                                       | `buildRegistryEnvSnapshot` stores 40+ keys; `replayRegistryEnv` re-applies them in prime; nothing diffs stored vs current. `TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`, `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE`, `CODE_TEST_PATHS`, `INGEST_CHUNK_SIZE` change output with zero key change. Flag flips surface as phantom "schema drift" | silent semantic change                                |
| Shared resolution kernel                                    | 15 commits under `domains/language/kernel/**`, `resolver-chain.ts`, `resolution-runner.ts` since 2026-08-16; no axis names them                                                                                                                                                                                             | silent edge change across every language              |
| Global chunk set                                            | `chunker/utils/chunk-id.ts`, `infra/symbolid/**`, `chunker/{tree-sitter,base,markdown-chunker,symbol-id-disambiguator}.ts` sit outside `language/**`; no axis, no rule surfaces                                                                                                                                             | every point id moves silently                         |
| Content freshness at search time                            | the registry already records `indexedBranch` / `indexedCommit` / `indexedDirty` at finalize (`pipeline/base.ts:320-333`, `RegistryGitState`), but nothing reads them back at search or prime time; `computeStaleness` is wall-clock; merkle diff runs only inside a reindex                                                 | agent works on stale results with no signal           |
| Model identity beyond the name                              | same tag, different weights (`:latest`) passes the guard; dimension mismatch is caught only at upsert                                                                                                                                                                                                                       | rare, catastrophic when it happens                    |
| Repair-leg hash drift (`sz1y0`)                             | 482 unchanged files re-selected by `content_hash` mismatch, cause unknown; repair extraction has no Program admission                                                                                                                                                                                                       | perf + precision delta between live and repair paths  |
| Language-version drift on search responses                  | `ExploreOps#checkDrift` wires only the schema monitor                                                                                                                                                                                                                                                                       | MCP-only clients never see `walker 1→3`               |

### Version-bump discipline since `frwka` merged (2026-08-16)

| Language   | walker/resolver commits | without a `capability.ts` change | Reading                                                                                                                     |
| ---------- | ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| python     | 51                      | 48                               | bumped per wave in `chore` commits (`6cea81bf5`, `8a17b3cac`, `ebd09cf14`) — acceptable                                     |
| typescript | 11                      | 10                               | walker 3 (`2a7e774e4`) and 4 (`5c8c63914`) cover every behaviour commit of 2026-08-17; `10d272aa0` is a relocation          |
| ruby       | 7                       | 7                                | `walker: 1` after seven `refactor(language): relocate … to the kernel` commits; the byte-identical claim was never measured |
| kernel     | 15                      | —                                | no axis exists                                                                                                              |

The rule (`.claude/rules/language-capability-sync.md`) is correct and
path-scoped to `src/core/domains/language/**`. What it lacks is a gate: the only
version-bump enforcement in the repository is `check-plugin-version.sh` for
`plugin.json`, and `drift-guard.test.ts` reads no walker or resolver
(`domains/language/CLAUDE.md` names this as a gotcha).

## Decisions

1. **Subdomain boundary: compare vs side effect.** `maintenance/drift/` holds
   pure comparisons of a stamp against the current build or environment.
   `EmbeddingModelGuard` (throws, hits Qdrant), `freshness/` (decides whether to
   spawn), `migration/` (upgrades stores), and the enrichment repair / heal
   passes (write payload) stay where they are.
2. **One report, one remedy.** `IndexDriftReport` aggregates findings from every
   monitor; `resolveIndexDriftRemedy` folds them over the lattice
   `none < incremental < recompute(trajectories, languages?) < force`. Language
   narrowing survives only when every recompute finding is language-scoped; a
   finding without a language (shared kernel, env) widens the recompute to the
   whole collection.
3. **Naming.** New types are `IndexDrift*` (`IndexDriftMonitor`,
   `IndexDriftFinding`, `IndexDriftReport`, `IndexDriftRemedy`). The two
   existing monitor classes keep their names; `DriftRemedy` becomes
   `IndexDriftRemedy` when it leaves `stats-cache.ts`.
4. **Shared axes reuse the language monitor.** The pseudo-language `*` carries
   `{ chunking, walker, codegraphSchema }` declared in
   `domains/language/kernel/capability.ts` as `sharedVersions`, stamped by the
   same `stampLanguageVersions` scopes, compared unconditionally (not gated by
   the index's language distribution), and routed: `*.chunking` → `--force`;
   `*.walker` / `*.codegraphSchema` → `--force-enrichments codegraph` with no
   `--languages`. No grammar axis for `*`.
5. **Enforcement is a digest-pin test, not a hook.**
   `tests/core/domains/language/capability/version-pins.test.ts` hashes the
   source globs behind each `(language, axis)` — per-language `walker/**`,
   `resolver/**`, `dsl/**` for `walker`; `chunking/**` plus the language's
   chunker hooks for `chunking`; the shared globs of decision 4 for `*` — and
   compares against a generated `version-pins.json`. Sources changed while
   neither the declared version nor the pin moved → red, naming the axis to bump
   or `npm run pin:lang-versions` to re-pin. A re-pin without a bump is the
   byte-identical claim, recorded in git. Same idiom as `drift-guard.test.ts`
   plus `gen:lang-compat`, and it runs on the merge result in CI, which a
   staged-file hook cannot.
6. **Env drift compares snapshots built by the same builder.** Each
   `REGISTRY_ENV_GROUPS` entry gains a consequence class — `chunk-set`,
   `enrichment:<trajectory>`, or `runtime` (no drift) — and `EnvDriftMonitor`
   diffs the stored `CollectionEntry.env` against `buildRegistryEnvSnapshot` of
   the current config. A flip of `CODEGRAPH_ENABLED` / `TRAJECTORY_GIT_ENABLED`
   is reported as env drift that explains the payload-key delta, so the reader
   fixes the env instead of rebuilding.
7. **Commit drift is informational, and the stamp already exists.** Every index
   run records `RegistryGitState` (`indexedBranch`, `indexedCommit`,
   `indexedDirty`; not sticky — each run rewrites it) through
   `BaseIndexingPipeline#buildRegistryGitState`. The missing half is the reader:
   `CommitDriftMonitor` compares the stamp against `readRepoGitState` and
   reports `index @abc123, HEAD @def456` with the `incremental` remedy. No `git`
   process at search time — `repo-git-state.ts` reads refs from disk; the dirty
   probe stays at finalize.
8. **Canary vector, not a hash.** At index time the guard embeds a fixed
   sentence and stores the vector in the `INDEXING_METADATA_ID` marker; on
   `ensureMatch` it re-embeds and requires cosine ≥ 0.999. A hash would break on
   the float noise between devices; the threshold is a constant until a
   measurement says otherwise. The guard stays in `adapters/qdrant/`.
9. **The `a2ddb` heal is the payload twin of the repair pass.** Migration 023
   (`021`/`022` are taken by pass-1 aggregates and the run-stats template) keeps
   `cg_symbols_metrics_prev`; after the finalizer recomputes metrics the changed
   symbol set is `EXCEPT` both ways plus the per-file aggregate diff; symbols
   outside this run's `chunkMap` map to Qdrant points through a `relativePath` +
   `symbolId` scroll (both indexed), and the applier rewrites
   `codegraph.symbols.{chunk,file}.*` for exactly those points. Bounded by the
   number of symbols whose metrics moved, not by the corpus.
10. **`sz1y0` is a diagnosis before a design.** A spike with hash logging on a
    controlled re-run settles why unchanged files mismatch; only then is the
    Program-admission question decided, and if the answer is "no", the precision
    delta of the repair leg is written down as accepted.
11. **Language-version drift joins `driftWarning`.** Decision 2 delivers it —
    the aggregator, not a second call in `ExploreOps#checkDrift`.
12. **Rules ship with the code they govern.** The `*` axes land with
    `.claude/rules/index-format-versions.md`; the subdomain lands with
    `.claude/rules/index-drift.md`; `migrations.md` gains the creation-site
    paths in the same epic as the invariant test that makes them checkable.

## Architecture

### `maintenance/drift/`

```text
src/core/domains/maintenance/drift/
  index.ts                         # barrel
  monitor.ts                       # IndexDriftMonitor, IndexDriftFinding, IndexDriftAxis
  remedy.ts                        # IndexDriftRemedy lattice + resolveIndexDriftRemedy
  report.ts                        # IndexDriftReport + formatIndexDriftReport
  schema-drift.ts                  # SchemaDrift, checkSchemaDrift (from infra/stats-cache.ts)
  schema-drift-monitor.ts          # moved
  language-version-drift-monitor.ts# moved; `*` handling added in epic C
  env-drift-monitor.ts             # epic C
  commit-drift-monitor.ts          # epic C
```

`IndexDriftMonitor { readonly axis: IndexDriftAxis; check(collectionName): IndexDriftFinding[] }`.
A finding is `{ axis, subject, indexed, current, remedy }` where `subject` is
the language, env key, or payload key the finding is about. `IndexDriftReport`
is the ordered list of findings plus the folded remedy; `formatIndexDriftReport`
renders one block with one `Run:` line. `StatsCache` keeps only the persistence
of `payloadFieldKeys`.

Consumers: `App#checkIndexDrift` replaces `checkSchemaDrift` and
`checkLanguageVersionDrift`; `ExploreOps#checkDrift` attaches the report as
`driftWarning` (field name unchanged, consumed once per collection per process
as today); prime renders one `## Drift` section; `get_index_status` appends the
same block.

### Remedy lattice

| Remedy        | Command                                                                    | Produced by                                                                  |
| ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `none`        | —                                                                          | removed payload keys; env `runtime` class                                    |
| `incremental` | `tea-rags index-codebase --project <alias>`                                | commit drift                                                                 |
| `recompute`   | `tea-rags index-codebase --force-enrichments <traj,…> [--languages <l,…>]` | enrichment-owned keys; `walker` / `codegraphSchema`; env `enrichment:<traj>` |
| `force`       | `tea-rags index-codebase --force`                                          | chunker-owned keys; `grammar` / `chunking`; env `chunk-set`; `*.chunking`    |

Fold: take the maximum; for `recompute` union the trajectories and keep
`--languages` only if every contributing finding named a language.

### Stamps (write side)

| Stamp                           | Where                         | Written by                           | Sticky |
| ------------------------------- | ----------------------------- | ------------------------------------ | ------ |
| `payloadFieldKeys`              | stats cache                   | every run                            | no     |
| `languageVersions[lang]`        | registry                      | `stampLanguageVersions` by run scope | yes    |
| `languageVersions["*"]`         | registry                      | same scopes                          | yes    |
| `env`                           | registry                      | every run                            | no     |
| `indexedCommit`, `indexedDirty` | registry                      | every run                            | no     |
| canary vector                   | `INDEXING_METADATA_ID` marker | full index / guard backfill          | yes    |

### Epics

| Epic                                     | Scope                                                                                                                                                                                                      | Depends on                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **A — Drift rules and gates**            | docs↔code fixes, `.sql` twin test, version-pins guard, `migrations.md` creation-site paths + `initializeSchema` ⟺ migrations invariant test, `language-capability-sync.md` wave/trailer rules, stats paths | —                                        |
| **B — `maintenance/drift/` unification** | core extraction from `stats-cache.ts`, monitor relocation, report + remedy lattice, wiring (App / explore / prime / status), navigator + `index-drift.md`                                                  | —                                        |
| **C — Remaining drift mechanisms**       | shared `*` axes + `index-format-versions.md`, `EnvDriftMonitor`, `CommitDriftMonitor`, canary vector                                                                                                       | B (C1–C3), A3 (C1 extends the pin globs) |
| **D — Staleness defects**                | `a2ddb` payload heal + migration 021, `sz1y0` spike → fix, ruby walker measurement                                                                                                                         | — (ingest domain; parallel to B/C)       |

### Pull order

A first — it is the gate the rest is measured against and has no code
dependency. B next, C on top of B. D runs in a second worktree in parallel with
B and C; its only touchpoint with the drift subdomain is that `a2ddb` heal
removes the last reason to reach for `--force-enrichments codegraph` on an
unchanged corpus. The ruby measurement (D3) is user-gated and can run at any
point; its outcome is either `ruby.walker: 2` or a recorded byte-identical
re-pin.

## Measurement policy

| Epic | Evidence a bead may close on                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | suite green; the pins test is red on a deliberate walker edit without a bump and green after `pin:lang-versions`; the invariant test is red when an index is added to `initializeSchema` without a migration                                                                                                   |
| B    | `npm run test:coverage` green; prime on `code_8b243ffe` renders one `## Drift` section; a search response carries both a schema and a language finding in one `driftWarning`                                                                                                                                   |
| C    | flipping `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE` in the server env produces an attributed env finding on the self-index with no reindex; a commit without reindex produces a commit finding; a `*` bump produces a finding with no `--languages`; the canary rejects a second model under the same tag on a fixture |
| D    | taxdome: baseline `--force-enrichments codegraph`, edit one hub file, incremental run, then the count of points whose `codegraph.symbols.chunk.fanIn` differs from `cg_symbols_metrics` is 0 (was > 0 before the heal); `sz1y0` re-run selects 0 unchanged files                                               |

Live runs are user-gated (`epic-completion-gate.md`); `--force-enrichments`,
never `--force`, except where the chunk set itself is under test.

## Non-goals

- Relocating `EmbeddingModelGuard`, `freshness/`, or `migration/` into the
  subdomain (decision 1).
- A `teaRagsVersion` axis — every release would flag drift; the `*` axes cover
  the producers a package version would have stood in for.
- Plugin ↔ server compatibility (skills written against tool schemas). Separate
  bead; owner is `cli/prime` and the plugin, not maintenance.
- Worktree-clone drift against its source — clones are throwaway by design.
- Quantization-mode drift — a storage setting `updateCollectionQuantization` can
  change in place; it does not corrupt results.

## Forecast

Anchor: codegraph DuckDB daemon (30–40 commits, 2 weeks) and streaming
enrichment (~20 commits, 1.5 weeks). Substrate exists for every epic: the
monitor shape, the stamp mechanism, the migration framework, the repair pass.

| Epic | Commits | Focused burst days                                                            |
| ---- | ------- | ----------------------------------------------------------------------------- |
| A    | 6–8     | 1                                                                             |
| B    | 10–13   | 2 (relocation is mechanical; the aggregator is the design half)               |
| C    | 12–16   | 3.5                                                                           |
| D    | 8–12    | 4, including one live iteration on taxdome (×1.2 for the heal's mapping step) |

Critical path A → B → C ≈ 6.5 burst days; D ≈ 5 in parallel. At 2.5–3.5 burst
days per week with two epics in flight: **P25 2.5 weeks / P50 3 weeks / P75 3.5
weeks**, ±15% at focused execution.

## Beads

Program epic and four child epics are created with the implementation plan
(`docs/superpowers/plans/2026-09-10-index-drift-program.md`); ids are recorded
there and in the epic titles.

## Follow-up specs

- Plugin ↔ server compatibility check (prime `--plugin-version`).
- Language-version drift for Ruby type-source axes once RBS/Sorbet increments
  land (`tea-rags-mcp-4gwnw`).
