# Codegraph Collection-Name Split — Design

The codegraph write path opens its DuckDB file by the Qdrant **alias** name
while the read path expands that alias to the **active versioned** collection.
Qdrant tolerates the alias server-side, so every Qdrant write lands correctly
and nothing looks wrong. DuckDB does not: `GraphDbClientPool.pathFor()` opens a
file by literal name. Since the last force reindex of each project, every
incremental run has been writing into a shadow `<alias>.duckdb` that no reader
ever opens.

Seven of 44 aliased projects carry such a shadow. `find_cycles`, `get_callers`,
`get_callees` and `trace_path` have been serving a graph frozen at the last full
build, and for five projects the versioned file does not exist at all, so those
tools degrade to empty results while the real data sits in the shadow.

This spec closes the name asymmetry, adds a real completeness check that decides
whether the graph needs repair, and pins both with invariant tests.

Filed as `tea-rags-mcp-6goqa` (P0); blocks `tea-rags-mcp-vzo9k`.

## Problem

### The split

| Path                | Name it carries                                                      | File it opens                 |
| ------------------- | -------------------------------------------------------------------- | ----------------------------- |
| Force reindex       | `setup.targetCollection` = `code_x_v53` (`indexing.ts:311`)          | `code_x_v53.duckdb` — correct |
| Incremental reindex | `ctx.collectionName` = `code_x` (`reindexing.ts:95→216`)             | `code_x.duckdb` — **shadow**  |
| Any graph read      | `resolveActiveCollection(code_x)` = `code_x_v52` (`graph-facade.ts`) | `code_x_v52.duckdb`           |

`CodegraphEnrichmentProvider` hands its `collectionName` straight to
`pool.acquireWrite(collectionName)` (`provider.ts:549`), and `pathFor`
(`pool.ts:227-229`) resolves it literally.

The intended contract is already written down. `factory.ts:375-382` describes
`resolveActiveCollection` as being "for the codegraph read path (GraphFacade)",
and `graph-facade.ts` states the alias must expand to "the active versioned
collection the write path populated". The force path honours that. The
incremental path never builds a `SetupResult`, so it honours nothing.

### Measured damage

tea-rags self-index, `code_8b243ffe` → alias of `code_8b243ffe_v52`:

|                                                         | shadow `code_8b243ffe.duckdb` | active `_v52.duckdb` |
| ------------------------------------------------------- | ----------------------------- | -------------------- |
| files                                                   | 246                           | 1314                 |
| symbols                                                 | 1812                          | 3889                 |
| file edges                                              | 545                           | 2151                 |
| method edges                                            | 2989                          | 5648                 |
| file-scope cycles                                       | 0                             | 1                    |
| edge `extractors.ts → metrics.ts`                       | absent                        | **present**          |
| `run-state.ts`, `graph-finalizer.ts` (added 2026-07-26) | present                       | absent               |

`find_cycles(scope: "file")` returns a `metrics ↔ extractors` 2-cycle that lives
only in `_v52`. The source has been a DAG since `2c62d0d5` (2026-07-23) —
`metrics.ts` imports `./metrics/extractors.js`, `extractors.ts` imports
`../utils.js`, and nothing imports back. No amount of incremental reindexing
clears it.

`get_index_status.codegraphResolve.edgeKinds.total` is 5648, exactly `_v52`'s
`cg_symbols_edges_method` count (the shadow holds 2989), so the reported resolve
metrics come from the stale DB too.

Graph degrees are computed on whatever DB the run wrote and then persisted into
the Qdrant payload: `applier.ts` shows `fanIn` 2 in the shadow against 12 in
`_v52`. Every file re-enriched incrementally has had `fanIn`, `connectionCount`,
`instability`, `transitiveImpact`, `isHub` and `pageRank` recomputed against a
partial graph.

### Fleet state

| project                        | chunks | shadow files | versioned files |
| ------------------------------ | ------ | ------------ | --------------- |
| taxdome (`code_27622aef`)      | 89144  | 821          | 18518           |
| tea-rags (`code_8b243ffe`)     | 12945  | 246          | 1314            |
| ripgrep-rust (`code_6309e3ab`) | 3829   | 88           | no DB           |
| `code_372b8a3d`                | 2672   | 439          | no DB           |
| gin-go (`code_e9c45fb1`)       | 1732   | 59           | no DB           |
| `code_04f1e071`                | 772    | 50           | no DB           |
| `code_a484bf10`                | —      | 6            | no DB           |

Every shadow is a small fraction of its project — by construction, since it is
the accumulated sum of changed-file slices. This kills the "promote the shadow
to the versioned name" option outright: for taxdome it would replace an
18518-file graph with an 821-file one, and for the five DB-less projects it
would enshrine a 50–439-file fragment as the complete graph.

### Why an incremental run cannot heal itself today

`onFileExtraction` is fed by `file-processor.ts:230-232`, which walks the run's
file set — for an incremental run, only changed files. The DB is cumulative with
per-file replace: `client.ts:452-453` deletes
`cg_symbols_edges_file/method WHERE source_rel_path = ?` before rewriting a
file's edges. A file's rows therefore heal only when that file is itself
re-extracted.

That is exactly why the phantom edge survives: `extractors.ts` has not changed
since 2026-07-23, so `_v52` has never re-extracted it. Pointing incremental
writes at the right DB is necessary but not sufficient — a project with no
versioned DB would get an empty file that fills up with changed files only, and
the partial graph would simply move to the correct filename.

The derived tables are not the problem. Cycles and metrics are wholesale
recomputes on every finalize (`client.ts:924` deletes `cg_symbols_cycles` per
scope, `:950` clears `cg_symbols_metrics`). Once the base tables are right, the
derived ones self-correct on the next run.

## Goal

One logical collection resolves to one DuckDB file, whichever direction you
approach it from, and a run can tell whether the graph it is about to use
matches the code it is about to index.

## Design

### 1. Name discipline

`ReindexContext` gains `targetCollection` — the physical, versioned name,
resolved the same way `IndexPipeline.setupCollection` resolves it. The
incremental pipeline then addresses artifacts the way the force pipeline already
does:

| Artifact                                                            | Name                          |
| ------------------------------------------------------------------- | ----------------------------- |
| Qdrant points, indexing marker, codegraph DB, codegraph spill paths | `targetCollection` (physical) |
| Snapshot, stats cache, quarantine store                             | `collectionName` (alias)      |

The field name is deliberately the one `SetupResult` already uses. This
introduces no new concept: the two-name distinction exists and is deliberate —
snapshots and stats are keyed by the stable alias so they survive version bumps,
versioned artifacts by the physical name. The incremental path simply never
implemented it.

Rejected alternative: pushing `resolveActiveCollection` into
`GraphDbClientPool.pathFor`. Four reasons.

- `pathFor` is synchronous and `resolveActive` is not. Async would ripple into
  `acquireRead:492`, `:522`, `copyDb:583-586` (which pairs `mkdirSync` with
  `copyFile`) and `removeDb:611`.
- `pool.ts` imports nothing from Qdrant today; this adds an adapters→adapters
  edge from the DuckDB pool to the Qdrant client, on the most-referenced
  structure in the area.
- The collection name also names `spillPathFor` (`.spill/<coll>-<runId>.ndjson`)
  and `inputSpillPathFor` (`.xpass/<coll>.ndjson`). Fixing only `pathFor` leaves
  two different names in play inside one run.
- `worktree-provisioner.ts` already calls `qdrant.aliases.resolveActive` itself,
  because it needs the physical name for more than the DB path. Pool-side
  resolution duplicates that rather than replacing it.

### 2. Completeness check

A "was this ever fully built" marker was considered and rejected: it is a proxy
flag, and it cannot distinguish a graph that is complete from one that has
drifted. The check measures the graph instead.

`cg_symbols_files` currently holds `(rel_path, language)` — enough to know
whether a file is _present_, not whether its rows are _current_. A migration
adds `content_hash`, populated at extraction from the SHA256 the snapshot
already stores per file (`snapshot.ts:26`, `sharded-snapshot.ts:25`), so no
extra I/O.

After `prepareReindexContext` has resolved `targetCollection` and before the
enrichment run begins, for that physical collection:

1. `SELECT rel_path, content_hash FROM cg_symbols_files` — one query. Call the
   result `G`.
2. Build `E`, the codegraph-eligible files of this run: the scanned file set
   filtered by the provider's own eligibility rules (supported language,
   `excludeTests`, `customExcludePatterns`, per-file enrichment policy), each
   paired with its snapshot hash.
3. `repair = { f ∈ E : f ∉ G ∨ G[f] ≠ E[f] }`
4. `orphans = { p ∈ G : p ∉ E }`
5. `repair` empty and `orphans` empty → the graph matches the code; do nothing.
6. Otherwise delete the orphan rows and extract exactly `repair` through the
   same `onFileExtraction` seam the normal pass uses, then finalize as usual.

The run does not announce this. Repair shows up as extra time, nothing else.

Properties:

- A fresh `_vN` yields `repair = E` — a full build, which is what the five
  DB-less projects and every post-force run need.
- Today's damage in `_v52` self-heals: `extractors.ts` is present but its stored
  hash predates 2026-07-23, so it lands in `repair` and its stale outgoing edge
  is deleted and rewritten. A presence-only check would miss this case entirely,
  which is the reason the check is hash-based.
- A healthy graph costs one query.
- Narrowing or widening the exclusion config is handled without a config
  fingerprint: newly-eligible files appear in `repair`, newly-ineligible ones in
  `orphans`.

### 3. Placement

The diff needs the run's file list (owned by ingest) and the graph's file rows
(owned by the codegraph provider). Split accordingly:

- `EnrichmentProvider` gains an optional
  `readPersistedFileHashes(collectionName) => Promise<Map<relPath, contentHash>>`.
  Optional provider capabilities are the established pattern here —
  `finalizeSignals`, `beginExtractionRun`, `endExtractionRun` and
  `defersChunkEnrichment` already work this way, and git simply does not
  implement it.
- `computeExtractionRepair(eligible, persisted) => { repair, orphans }` is a
  pure function in ingest's enrichment package. Pure because it needs no
  collaborators — two maps in, two lists out — which also makes the invariant
  test trivial.

The coordinator calls the provider, computes the diff, and feeds `repair`
through the seam that already exists for extraction.

### 4. Orphan sweep

`GraphDbClientPool.listCollectionDbNames` matches `^<base>_v\d+$`, so shadow
files are invisible to the sweep that reclaims dead DBs. Extend it to recognise
`<base>.duckdb` when `<base>` is a live Qdrant alias. After this fix the seven
shadows hold nothing worth keeping, so the sweep deletes them.

## Data model change

One migration adding `content_hash VARCHAR` to `cg_symbols_files`. Existing rows
get NULL.

NULL is treated as **unknown, therefore repair**. The alternative — assume
existing rows are current — is precisely the assumption that hid this bug, and
it would leave known-bad state (the phantom edge) in place until each affected
file happens to change on its own.

Consequence, accepted deliberately: the first run of each project after this
ships re-extracts every eligible file once. For taxdome that is ~18.5k files of
tree-sitter parsing with no embedding work. Silent, one time, per project.

## Testing and acceptance

Invariants, per `.claude/rules/test-invariants.md`:

1. **One collection, one file.** For a collection addressed by alias, the path
   the ingest write path opens equals the path `GraphFacade` opens. This is the
   regression guard for the whole bug.
2. **No shadow.** For a collection name that is a live Qdrant alias, no
   `<alias>.duckdb` is ever created.
3. **Name-to-artifact table.** Snapshot, stats and quarantine address by alias;
   codegraph DB, spill paths and indexing marker address by physical name.
   Asserted against **both** pipelines, force and incremental — the asymmetry
   between them is what produced this defect.
4. **Repair set is exact.** `computeExtractionRepair` returns empty for a graph
   whose files and hashes match the eligible set, and returns precisely the
   missing, hash-drifted and orphaned entries otherwise.
5. **Missing hash means repair.** A row with NULL `content_hash` lands in the
   repair set.
6. **Sweep reclaims shadows.** The extended sweep deletes `<alias>.duckdb` for a
   live alias and leaves the active versioned DB alone.

Acceptance on the live index: after the fix, an incremental reindex of tea-rags
leaves `code_8b243ffe.duckdb` absent, `code_8b243ffe_v52.duckdb` current, and
`find_cycles(scope: "file")` returning no `metrics ↔ extractors` cycle.

## Risks

- **First-run cost is fleet-wide.** Every project pays one full re-extraction.
  Parsing only, but on taxdome it is minutes. Accepted above.
- **`indexing.ts:setupCollection` is a hotspot** — bugFixRate 53% (chunk 70%),
  100 lines, instability 0.92. The fix does not touch it: the incremental path
  never calls it (line 227 is a defensive guard the facade bypasses), so the
  change lands in `reindexing.ts#prepareReindexContext`, which is 22 lines and
  outside the hotspot set.
- **Repair during a run competes with the run's own extraction** for the same
  DuckDB write lock. The repair pass runs through the existing seam and the
  daemon serialises writes, so this is a latency concern, not a correctness one.

## Out of scope

- Recomputing the Qdrant payload signals that were written from partial graphs.
  They correct themselves as each file is re-enriched; a forced payload rewrite
  is a separate decision.
- Any change to how versioned collections are created or when the alias flips.
- The enrichment-health half of `vzo9k`. Re-measured on 2026-08-01 against local
  main and not reproduced — that symptom belonged to the published v1.35.0
  binary.
