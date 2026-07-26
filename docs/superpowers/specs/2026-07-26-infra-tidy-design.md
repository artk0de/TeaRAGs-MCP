# Infra Tidy — Design

`src/core/infra/` was meant to hold generic helpers usable by every layer. It
now holds 4194 LOC, of which 2865 (68%) is product logic: the project registry,
the whole migration framework, drift detection, a git-diff memo. Thirteen files
import upward into `api`, `domains`, and `adapters`, which the layer matrix
forbids — and the eslint zone that should have blocked them has never fired.

This spec relocates the product logic to its owning module, cuts every upward
edge, repairs the guard, and pins the result with a fixture test.

**Outcome, recorded after the last wave landed.** `src/core/infra/` is 17 files
and 1189 LOC with zero imports of `domains`, `adapters` or `api`; the guard that
allows none of those is live and a fixture test proves it fires. Two placements
changed during execution against what this spec first assumed — the embedding
guard went to `adapters/qdrant/` (see the revised W4) and `commit-diff-memo.ts`
stayed in the foundation, because BOTH the ingest chunk phase and the git
churn-walk worker construct it, so either domain would have been a
`domains <-> domains` edge. Planned task T8 was dropped for that reason.

## Problem

Three independent defects, all confirmed against `f56e611c`:

**1. The infra guard is a dead rule.** `eslint.config.js:443-465` forbids
`src/core/infra/**` from importing `**/core/contracts/**`,
`**/core/adapters/**`, `**/core/domains/**`, `**/core/api/**`. Import specifiers
inside `core` are relative (`../../../domains/ingest/constants.js`) and never
contain the `core/` segment, so no glob matches. Verified empirically:
`npx eslint` on three violating files exits clean. The `contracts` (`:393-419`)
and `adapters` (`:420-441`) zones have the same prefix bug. The domain zones are
prefix-free (`**/ingest/**`, `**/domains/language/**`) and do fire — which is
why only foundation drift went unnoticed.

**2. Thirteen files import upward** (17 edges).

| From `src/core/infra/`                                                                             | To                                                                                                                                      | Kind           |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `collection-name.ts`                                                                               | `api/errors.ts`                                                                                                                         | runtime        |
| `embedding-model-guard.ts`                                                                         | `adapters/embeddings/errors.ts`, `adapters/qdrant/client.ts`, `domains/ingest/constants.ts`, `domains/ingest/pipeline/infra/runtime.ts` | runtime + type |
| `migration/adapters/enrichment-store-adapter.ts`                                                   | `adapters/qdrant/client.ts`, `domains/ingest/constants.ts`                                                                              | runtime        |
| `migration/adapters/index-store-adapter.ts`                                                        | `adapters/qdrant/client.ts`                                                                                                             | runtime        |
| `migration/adapters/snapshot-store-adapter.ts`                                                     | `domains/ingest/sync/snapshot/sharded-snapshot.ts`                                                                                      | runtime        |
| `migration/adapters/sparse-store-adapter.ts`                                                       | `adapters/qdrant/client.ts`                                                                                                             | runtime        |
| `registry/collection-registry.ts`, `registry/registry-file.ts`                                     | `adapters/registry/errors.ts`                                                                                                           | runtime        |
| `errors.ts`, `stats-cache.ts`, `materialize.ts`, `symbolid/classify.ts`, `graph/hierarchy-view.ts` | `contracts/**`                                                                                                                          | type-only      |

`adapters/registry/errors.ts:6-10` documents its own half of this as a "KNOWN
LAYERING CAVEAT": the error classes were parked in `adapters` to avoid an
`infra -> adapters` import, and `infra/registry/` reaches up to them anyway.

**3. The zero-dependency rule caused type duplication.** Because `infra` may not
import `contracts`, three structural duplicates exist:

- `infra/file-classification/classify.ts:6-11` redeclares `FileClassification`
  from `contracts/types/file-classification.ts`, with a comment saying why.
- `contracts/types/provider.ts:134` redeclares the shape of `CommitDiffMemo` by
  value.
- `trajectory/git/infra/walk-commits.ts:39` declares `WalkCommitDiffMemo`, a
  third copy of the same shape.

A rule that produces three copies of two types costs more than the edge it
prevents.

## Goal

- `src/core/infra/` holds only generic primitives; outbound edges reduce to
  type-only imports of `contracts`.
- Product logic sits with its owner, reachable by its consumers without any
  `domains <-> domains` edge.
- The eslint foundation zones actually fire, and a fixture test proves it.
- The three type duplicates collapse to one declaration each.

## Placement criterion

A module belongs in `infra` when **its reason to change is technology, not
product policy**, and at least two layers need it. Consumer count alone does not
qualify a module: `EmbeddingModelGuard` has eight consumers and is still policy;
`semaphore.ts` has two and is still a primitive.

Where the criterion and the layer matrix disagree, the matrix wins — a module
whose natural owner would create a `domains <-> domains` edge stays where its
consumers can legally reach it. Two modules land in `infra` for exactly that
reason (see `symbolid/**` and `scope-detection.ts` below); both carry the
constraint in a comment so the next reader does not "fix" them.

## Foundation layer order (rule change)

The foundation row gains a total order:

```text
contracts  <  infra  <  adapters
```

- `contracts` imports nothing (unchanged).
- `infra` may `import type` from `contracts`. Runtime imports stay forbidden —
  `contracts` holds types and pure utilities, and a runtime edge would signal
  that logic, not a type, was placed wrong.
- `adapters` may import `contracts` and `infra`.

A cycle cannot form: the guard already keeps `contracts` free of every `core/`
import, and no `contracts -> infra` edge exists today (checked; only comments
mention `infra`).

This amends
`docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`, which
put `core/infra/**` at "nothing but external packages" and rejected type-only
escape hatches. The amendment is narrow — one direction, one kind of import,
inside the foundation row — and its justification is the duplication above,
evidence the original matrix did not have.

## Placement decisions

### Stays in infra — 1329 LOC

| Module                                                        | LOC | Fix required                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors.ts`                                                   | 110 | none for the file itself; receives two error classes from above (see W1, W4)                                                                                                                                                                                |
| `runtime.ts`                                                  | 13  | none; the deprecated shim `domains/ingest/pipeline/infra/runtime.ts` is deleted and its 23 importers re-pointed here                                                                                                                                        |
| `semaphore.ts`                                                | 42  | none                                                                                                                                                                                                                                                        |
| `graph/page-rank.ts`, `graph/tarjan-scc.ts`, `graph/index.ts` | 261 | `index.ts` stops re-exporting `hierarchy-view`                                                                                                                                                                                                              |
| `materialize.ts`                                              | 85  | none — the `AstNode` type edge is now legal                                                                                                                                                                                                                 |
| `symbolid/**`                                                 | 139 | none. Cannot move to `domains/language`: `eslint.config.js:333-341` forbids `ingest -> language` ("reach language via injected LanguageFactory") and `ingest/pipeline/chunker/tree-sitter.ts:21` uses `isStaticMethodNode`. Add the constraint as a comment |
| `file-classification/**`                                      | 243 | delete the local `FileClassification` duplicate; `import type` from `contracts`                                                                                                                                                                             |
| `scope-detection.ts`                                          | 60  | none. Shared by `ingest` (2) and `explore` (1), so neither can own it. Add the constraint as a comment                                                                                                                                                      |
| `stats-cache.ts`                                              | 148 | none — the `SignalStats` type edge is now legal                                                                                                                                                                                                             |
| `collection-name.ts`                                          | 102 | see W1                                                                                                                                                                                                                                                      |
| ~~`embedding-model-guard.ts`~~                                | 126 | RELOCATED during execution to `adapters/qdrant/` — see the revised W4                                                                                                                                                                                       |

### Relocates — 2865 LOC

| Module                    | LOC  | New home                              | Rationale                                                                                                                                                                                                                                               |
| ------------------------- | ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry/**` (6 files)   | 662  | `domains/maintenance/registry/`       | Alias catalogue, worktree provenance, env-group replay — product state. `maintenance` already owns both current domain-side consumers (`footprint/`, `worktree/`). The error classes come back from `adapters/registry/`, closing the documented caveat |
| `migration/**` (30 files) | 1957 | `domains/maintenance/migration/`      | Index-lifecycle upgrades, including the DuckDB DDL steps. Whole subtree, no split                                                                                                                                                                       |
| `schema-drift-monitor.ts` | 65   | `domains/maintenance/`                | Detects "index is stale versus code" — same family as footprint and quarantine                                                                                                                                                                          |
| `commit-diff-memo.ts`     | 64   | `domains/ingest/pipeline/enrichment/` | Run-scoped memo whose only constructor is `chunk-phase.ts:550`                                                                                                                                                                                          |
| `graph/hierarchy-view.ts` | 61   | `domains/trajectory/codegraph/`       | Codegraph-specific (`contracts/types/codegraph.ts`), single consumer                                                                                                                                                                                    |
| `qdrant-version.ts`       | 56   | `adapters/qdrant/`                    | Reads `.qdrant-required-version` — pin for one external system; consumers are `adapters` (3) and `bootstrap` (1)                                                                                                                                        |

## Wirings

Four relocations need more than a file move. Everything else is a move plus an
import rewrite.

### W1 — Registry reachable without a domain-to-domain edge

Current consumers: `api` (13), `bootstrap` (1 runtime construction at
`bootstrap/factory.ts:45`), `domains/ingest` (1, type-only at
`pipeline/base.ts:19`), `domains/maintenance` (1, type-only at
`worktree/worktree-provisioner.ts:6`).

- `bootstrap` may not import `domains`. The class is already re-exported at
  `api/public/index.ts:73`; `bootstrap` switches to that import.
- `ingest` keeps its type-only dependency through a new `CollectionRegistryPort`
  in `contracts` — it receives the instance by DI and only needs the shape.
  `maintenance` imports the class directly (own domain).
- `collection-name.ts` stays in `infra` and drops two edges: its
  `import type { CollectionRegistry }` becomes the contracts port, and the error
  class it throws from `api/errors.ts` moves down to `infra/errors.ts`
  (re-exported through `api/public` so external behaviour is unchanged).

### W2 — Migrator composed above both domains

`ingest` drives migrations today: `operations/reindexing.ts:219-240` runs
snapshot, schema and sparse pipelines, and `factory.ts:52-59` builds
`SchemaManager` from `schemaMigrator.latestVersion` +
`sparseMigrator.latestVersion`. After the move `ingest` may not import
`maintenance`.

- The `createMigrator` DI slot in `ingest/factory.ts:69-86` stays, retyped by a
  `MigratorPort` in `contracts` that also exposes `latestVersion` for the two
  pipelines `SchemaManager` needs.
- `api/internal` composes the concrete `Migrator` from `maintenance` pipelines
  and supplies it through that slot. `api` may import both domains; this is the
  composition root's job.
- `SnapshotStoreAdapter` needs `ingest`'s sharded-snapshot format
  (`domains/ingest/sync/snapshot/sharded-snapshot.ts`, 360 LOC). It receives a
  store through a `contracts` port instead, extending the precedent already in
  `contracts/types/footprint.ts:12` (`SnapshotArtifactStore`), with `api` wiring
  the `ingest` implementation.
- `EnrichmentStoreAdapter` needs `INDEXING_METADATA_ID` from
  `domains/ingest/constants.ts` — a two-line file whose only export is that
  constant. The constant moves to `contracts`; the file disappears.

### W3 — DuckDB DDL delivered to the daemon

`adapters/duckdb/pool.ts:530` dynamically imports the DDL runner and migration
list while opening a collection. After the move, `adapters -> domains` is
forbidden, and the daemon is a separate process that holds the single RW
connection and creates fresh databases (`daemon/entry.ts:220`), so it cannot
skip migrating.

- `GraphDbClientPoolOptions` gains `applyMigrations: (db) => Promise<void>`,
  typed in `contracts`. `pool.ts` calls the injected function instead of
  importing anything.
- The three in-process construction sites — `bootstrap/factory.ts:420`,
  `bootstrap/factory.ts:718`, `domains/trajectory/codegraph/factory.ts:165` —
  receive the applier by DI. `bootstrap` and the `codegraph` domain may not
  import `maintenance`, so `api` builds the applier and passes it down, the same
  route W2 uses.
- The daemon receives `migrationsModulePath` in its spawn options and imports
  the module in-process. This is the module-path DI pattern the project already
  uses for worker threads (`.claude/rules/domains-language.md`), and it keeps
  `adapters` free of any literal domain path: the path is supplied by the
  composition root that requests the daemon.

W3 is the only part of this spec that changes runtime behaviour. It gets its own
acceptance gate.

### W4 — Guard moves to `adapters/qdrant/` (revised during execution)

Two of the guard's four edges were mechanical and are gone:
`INDEXING_METADATA_ID` moved to `contracts/constants.ts`, and the `isDebug`
import turned out to point at a deprecated re-export of `infra/runtime.ts`.

The other two forced a placement rethink. The guard calls five `QdrantManager`
methods — `getPoint`, `setPayload`, `getCollectionInfo`, `addPoints`,
`addPointsWithSparse` — so a `CollectionPointStore` port would have had to
mirror a third of the Qdrant client and drag the `CollectionInfo` and
`SparseVector` types into `contracts`: the duplication this spec exists to
remove. The guard is a Qdrant marker-point manager, not a foundation primitive,
and its consumers (`api` ×7, `bootstrap`) may import `adapters` directly.

So `embedding-model-guard.ts` moves to `adapters/qdrant/` and needs no port at
all. `EmbeddingModelMismatchError` and the `InfraError` base stay where
`.claude/rules/typed-errors.md` puts them — the only reason to move them down
was the guard sitting in the foundation.

## Type duplications removed

| Duplicate                                                         | Canonical home                           | Consumers to re-point                    |
| ----------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `FileClassification` (`infra/file-classification/classify.ts:11`) | `contracts/types/file-classification.ts` | 1 (the infra file itself)                |
| `CommitDiffMemo` shape (`contracts/types/provider.ts:134`)        | `CommitDiffMemoPort` in `contracts`      | provider types + `ingest` implementation |
| `WalkCommitDiffMemo` (`trajectory/git/infra/walk-commits.ts:39`)  | same port                                | `walk-commits.ts`, `chunk-reader.ts`     |

## Guard repair

`eslint.config.js` — the three foundation zones are rewritten:

- Globs become prefix-free (`**/domains/**`, `**/adapters/**`, `**/api/**`,
  `**/bootstrap/**`, `**/mcp/**`, `**/cli/**`), matching the working domain
  zones, so relative intra-`core` specifiers are caught.
- The `infra` zone drops `**/core/contracts/**` from its deny list and keeps the
  rest, per the new foundation order.
- The `adapters` zone keeps `contracts` allowed (already true in the matrix) and
  gains working globs for `api` and the outer layers.

**Correction, recorded after wave 1 landed.** This section originally assumed
the `contracts` and `adapters` zones had nothing to catch. They did — the
pre-plan check covered only the `infra` zone, and the assumption was carried
over without testing it. Enabling the fixed globs surfaced four real violations:
`contracts/types/app.ts` re-exporting three `api/public/dto/*` modules (dead
code, since deleted along with its `contracts/index.ts` barrel line), and
`adapters/qdrant/client.ts` importing the explore-domain `InvalidQueryError`.
The latter needs an adapter-level error class plus a mapping in `explore`, which
changes an error surfaced through MCP; it is tracked as `tea-rags-mcp-pn12w`,
and until it lands `**/domains/**` stays out of the `adapters` zone with a
fixture case skipped against that bead.

Config changes require explicit approval per `.claude/rules/linter-config.md`;
this spec is that approval request, and the guard-repair task carries it.

A fixture test asserts that a deliberately wrong import (an `infra` file
importing `domains`) trips the rule — the check the dependency-guard spec listed
as optional and never landed. Without it, the next prefix-style regression is
again silent.

## Documentation changes

- `.claude/rules/domain-boundaries.md`: `core/infra/` row changes from "nothing"
  to "`contracts/` (type-only)"; the `core/infra/` responsibility section is
  rewritten to list what actually remains; the prohibited-edge list keeps
  `infra -x-> domains/api/adapters`.
- `docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`: a
  short amendment note pointing at this spec for the foundation order.
- The `New Code Placement Rule` table gains rows for "index-lifecycle logic"
  (`domains/maintenance/`) and "generic primitive" (`core/infra/`).

## Testing and acceptance gates

| Gate                           | How                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relocations preserve behaviour | Existing suites move with their subjects; no test rewrites, per `.claude/rules/test-invariants.md`. Full suite green                                                                                                    |
| Guard actually fires           | New fixture test (wrong `infra -> domains` import trips eslint); `npm run lint` green on the whole tree                                                                                                                 |
| No new upward edges            | Repeat the fan-in scan used to author this spec: zero `infra -> {api, domains, adapters}` edges, `contracts` edges type-only                                                                                            |
| W3 runtime safety              | Fresh-database path: full reindex with `--wait-enrichments --force`, then `get_index_status` shows `codegraph.symbols` healthy. Daemon path: restart daemon against an existing collection and confirm DDL applies once |
| No cycles introduced           | `find_cycles` unchanged versus pre-branch baseline                                                                                                                                                                      |

## Execution order and forecast

Five waves, each independently committable and green:

1. **Foundation order + partial guard repair.** Rewrite the `contracts` and
   `adapters` zones prefix-free, legalize `infra -> contracts` type-only, and
   add the fixture test. Whatever the fixed globs surface has to be cleared in
   this wave or deferred against a bead — see the correction above for what they
   actually surfaced. The `infra` zone's `domains` / `api` / `adapters` patterns
   are written but stay commented with a pointer to wave 5 — the rollout
   principle the dependency-guard spec set: fix every violation first, enable in
   one commit last.
2. **Cheap edge cuts.** Delete the `runtime.ts` shim (23 importers), move
   `INDEXING_METADATA_ID` to `contracts`, move the two error classes down to
   `infra/errors.ts`, collapse the three type duplicates.
3. **Small relocations.** `qdrant-version.ts`, `graph/hierarchy-view.ts`,
   `commit-diff-memo.ts` (+ its contracts port), `schema-drift-monitor.ts`.
4. **Registry** (W1) — move plus the `bootstrap` and `ingest` re-points.
5. **Migration** (W2, W3) — the subtree move, the composition shift into `api`,
   the pool option, the daemon spawn option. Largest and last, because it is the
   only wave touching runtime behaviour. Final commit of the wave uncomments the
   `infra` deny patterns, which now have nothing left to catch.

Forecast anchors on the `domain-boundaries` epic (epic class, 3-4 weeks
calendar) with a substrate-exists discount of x0.6 — the layer matrix, the guard
spec, and the `maintenance` domain all already exist — and x1.3 for parallel
epics. No algorithmic novelty except W3, which adds half a burst day to a full
one.

- Scope: 22-30 product commits, 3-4.5 burst days.
- Calendar at 2.5-3.5 burst days per week: **P25 1 week, P50 1.5 weeks, P75 2
  weeks.**

## Risks

| Risk                                                                                             | Mitigation                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W3 changes runtime behaviour; a missed DDL application corrupts a fresh graph DB                 | Wave 5 lands alone with the reindex gate above; the applier is a required option, not optional with a default, so a missed call site is a type error           |
| `registry/collection-registry.ts` is hot and a hub (fanIn 15, bugFixRate 25, changeDensity 8.46) | Pure relocation, no logic edits; its tests move with it                                                                                                        |
| `errors.ts` carries transitiveImpact 236                                                         | The file does not move. Two classes move _into_ it — additive, and each is re-exported at its former consumption point                                         |
| The shim deletion touches 23 files                                                               | Mechanical single-symbol rewrite; type-check catches misses                                                                                                    |
| Wave 1 would turn current violations into lint failures before waves 2-5 fix them                | The `infra` deny patterns ship commented in wave 1 and are enabled in wave 5's final commit; CI stays green at every step, as the dependency-guard rollout did |

## Out of scope

- `domains/maintenance/` internal structure beyond receiving `registry/` and
  `migration/`.
- Sourcing `scope-detection.ts` test globs from `LanguageDefinition` instead of
  its own table (follow-up bead — it is a knowledge duplication with
  `domains/language`, not an infra placement issue).
- The `explore -> trajectory` and `trajectory -> ingest` edges from the
  dependency-guard spec's violation table; they are domain-level and tracked
  separately.
- Switching to an allow-list boundary plugin.
