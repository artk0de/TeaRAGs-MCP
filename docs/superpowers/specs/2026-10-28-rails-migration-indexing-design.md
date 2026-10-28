# Rails migration indexing design (vx81b)

Status: design for phase 1; later phases are explicitly deferred below.

## Validated constraints

- `generateSparseVector` supplies BM25 term-frequency weights and Qdrant applies
  IDF to the `text` sparse vector. A payload exclusion alone therefore does not
  isolate ordinary hybrid ranking from additional points.
- `FileScanner.walkDirectory` prunes ignored directories before visiting their
  children. `FileScanner.accepts` uses the same ignore matcher and marked
  ancestor checks for individual paths, including overlay admission.
- `IndexPipeline.setupCollection` claims a versioned physical collection,
  creates its indexing marker and schema, and later publishes an alias. A
  companion corpus must participate in that lifecycle and its failure and
  cleanup rules; creating an unrelated collection is not sufficient.
- Existing test and documentation scopes use payload filters, and rerank preset
  defaults can yield to an explicit scope. Those semantics are useful for the
  opt-in interface but do not provide corpus-level isolation.
- `CollectionSignalStats` includes collection-wide distributions, per-language
  scoped statistics and a similarity background. All of these need isolation,
  not only the per-language percentiles.

## Goal and boundaries

Index Rails migration history so an agent can find operations affecting a table
or column. The default code corpus, its rankings, statistics and graph must not
change when migration files are added. A schema search is an explicit opt-in and
returns evidence, not an assertion that a migration ran or that its effect
remains in the current database.

`db/migrate/**/*.rb` is the initial history scope, including nested Rails
engines. `db/post_migrate`, `db/data`, and other conventions are not silently
included. The source code remains authoritative for dynamic Ruby and SQL.

## Isolation

Use a separate migration corpus associated with each indexed project, with its
own dense and sparse vectors and lifecycle. Default code search and analytics
never query that corpus. This is stronger than putting an `isMigration` flag in
the code collection: the existing sparse generator leaves IDF to Qdrant, so
adding filtered points to the same sparse corpus can change the ranking of
ordinary hybrid searches. It also prevents migration points from entering the
code collection's distributions, percentile samples, similarity calibration, or
approximate vector index. Keep the existing Ruby codegraph exclusion for
`db/migrate/**`; no migration corpus data enters graph extraction.

Expose a schema-specific search scope on the semantic and hybrid search
surfaces. The default addresses only the code corpus; an explicit migration
scope addresses only the migration corpus. Avoid a mixed-result mode until
cross-corpus ranking and pagination have a defined contract. A dedicated scope
must not be bypassed by `filter: {}`, a rerank preset, file-level grouping,
find-similar, symbol lookup, or a working-tree overlay. Return the file, line
range, source text, operation and known table/columns so callers can verify it.
The schema describes the opt-in; an on-demand guide explains schema questions
and the difference between history and current state. Keep core routing within
its existing budget.

## Discovery and lifecycle

The current `FileScanner` prunes an ignored directory before examining files,
and `accepts` applies the same ignore matcher to a single path. Consequently, a
chunker hook alone cannot index a migration under an ignored `db/` directory.
Add a narrowly scoped migration discovery path that can traverse to `db/migrate`
without admitting siblings into the code corpus. Apply admission rules to full
scans and incremental change detection, including deletion and rename handling;
never follow symlinks. Overlay and finer ignore precedence are follow-ups
described below.

Migration corpus creation, project/worktree association, embedding model,
incremental updates, deletion, failure recovery and cleanup must follow the
existing project lifecycle. An interrupted update must not silently report a
complete migration search. Legacy collections may already contain migration
points; their cleanup and statistics repair are follow-up work. Merely excluding
new points does not repair old indexes. New chunk boundaries and embeddings
require indexing the affected Ruby migration files; no reindex is performed as
part of this task.

## Chunking and metadata

Use the Ruby AST and a specialised migration reader. Emit one operation per
chunk where the AST identifies an operation: `create_table`, `change_table`,
column add/remove/rename/change, index operations, and `execute`. Keep a
`create_table` or `change_table` block together with its builder calls so the
table and its column definitions remain intelligible; split oversized blocks
with the existing size and context rules. Preserve `change`, `up`, `down`, and
`reversible` direction in the context. Unknown or dynamic expressions and
unrecognised operations must remain searchable as source text rather than be
invented as static table or column facts.

Each chunk has a distinct migration chunk type, a stable path-qualified
symbol-like identifier derived from migration version, operation and occurrence,
and metadata for filename version, operation, direction, statically known table
and columns. Multiple identical operations in one file must not collide. Keep
the original source and exact line ranges; derived metadata is optional when the
syntax cannot be resolved. Preserve textual SQL without claiming to fully parse
it. Treat renames as both old and new names when statically available.

## Current state

Do not index `db/schema.rb` or `db/structure.sql` in the initial migration
corpus. They are snapshots, not migration history; the existing Ruby schema
snapshot parser serves a separate codegraph typing purpose. A search over
migrations alone cannot establish the current schema: the answer should say that
a current snapshot or live database is needed. Supporting searchable snapshots
is a separate extension with explicit provenance and freshness.

## Verification

Use neutral `orders` and `vendors` fixtures. Test AST operation boundaries,
repeated operations, direction, dynamic arguments, SQL and oversized blocks;
test ignored parent directories, nested engines, updates and deletions; test
explicit exclusions and overlays in phase 2. Test every default search entry
point and preset for isolation, compare code ranking and statistics before and
after adding migrations, and verify graph exclusion. Test opt-in retrieval and
its result metadata end to end. Check Ruby and shared chunking version axes and
pin files; run targeted suites, TypeScript and lint checks. Run the required
local `review_changes` gate before each commit.

## Decisions

- Use a companion collection associated with the code collection: Qdrant IDF and
  collection statistics must remain isolated.
- Search with `scope: "migrations"` on semantic and hybrid search; the default
  is `"code"`: explicit selection avoids mixing incomparable scores.
- Build and update the companion during project index runs, tracking migration
  files independently: ignored directories must not enter the code snapshot.
- Treat an absent companion as an empty migration corpus and surface update
  failures: old indexes remain usable without presenting partial data as
  complete.
- Discover `db/migrate/**/*.rb` even when `db/` is ignored, without following
  symlinks: this is the Rails layout the feature exists to cover.
- Keep migration history out of the codegraph and ordinary searches: separate
  storage prevents ranking and statistics contamination.
- Keep `schema.rb` and `structure.sql` out of phase 1: a snapshot cannot
  establish migration history.
- Use operation-level chunks with source ranges, version, direction, table and
  columns when statically known: source remains evidence for dynamic
  expressions.
- Use a path-qualified version, operation and occurrence for IDs: repeated
  operations must remain distinguishable.
- Defer overlay, legacy point cleanup and precise ignore precedence: these
  require separate lifecycle work and do not block a new companion corpus.
- Use the existing file synchronizer with a companion-specific snapshot and
  update only added, modified, and deleted files: routine changes must not
  re-embed an entire migration history. A missing snapshot or changed embedding
  configuration requires a one-time rebuild of the companion corpus.
- Invalidate changed snapshot entries before mutating existing points: an
  interrupted update must be retried on the next index run.
- Mark the migration collection incomplete and record pending paths before
  incremental writes; reject migration searches until recovery finishes: a
  removed newly-added file must not leave a stale searchable point after a
  crash.
- Check an update revision before and after migration search: overlapping
  updates must not return mixed results as a completed corpus.
- Suppress legacy `db/migrate/**` points in ordinary search results: existing
  collections remain safe to query until a dedicated cleanup is available.
  Filtering after candidate retrieval can shorten a page; legacy points may
  still affect sparse IDF and collection statistics until cleanup.

## Delivery phases

1. Implement operation chunking, discovery, companion collection lifecycle,
   explicit semantic/hybrid scope and isolation tests. Full and incremental runs
   must create, update and remove companion data.
2. Add worktree overlays and define precedence for explicit migration-specific
   ignores, with matching scan and overlay admission.
3. Repair legacy migration points in code collections and invalidate affected
   statistics and sparse state; document the operator cost.
