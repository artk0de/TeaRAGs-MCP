# Enrichment skip stamp — recovery stops rescanning deliberately-skipped points

Bead: `tea-rags-mcp-zt6qr` (P1, `performance`) Date: 2026-08-02 Status: design
approved, not implemented

## Problem

Every incremental reindex runs `EnrichmentRecovery.recoverAll` before the
reindex itself (`IndexingOps#tryIncrementalIndex`, awaited by design so recovery
writes land before `CompletionRunner` re-derives status). Recovery scrolls, per
provider and level, for points missing `<provider>.<level>.enrichedAt`.

On taxdome (`code_27622aef`, 89 336 points) that scroll is not cheap and never
becomes cheap, because it matches a large set that can never shrink.

Measured directly against the live collection on 2026-08-02, count API with
`exact: true`:

| filter                          | matches | count latency |
| ------------------------------- | ------: | ------------: |
| `git.file.enrichedAt` empty     |       0 |       1426 ms |
| `git.chunk.enrichedAt` empty    |   2 630 |       1094 ms |
| `codegraph.symbols.file` empty  |  30 669 |       1618 ms |
| `codegraph.symbols.chunk` empty |  18 241 |       1359 ms |

51 540 of 89 336 points match. `QdrantManager#scrollFiltered` pages at 200, so
those matches cost roughly 258 scroll round-trips per run — which is where the
~330 `POST /collections/<c>/points/scroll` calls observed by a live CDP probe
come from. A filter matching nothing would cost exactly one call per level:
Qdrant returns `next_page_offset: null` immediately.

The matched points are not damage. They are policy skips:

- `GitEnrichmentProvider#shouldEnrich` (`git/provider.ts:238`) returns
  `file-only` for documentation, so markdown chunks are never chunk-enriched.
  All 2 630 `git.chunk` matches are markdown.
- `CodegraphEnrichmentProvider#shouldEnrich`
  (`codegraph/symbols/provider.ts:517`) returns `none` for tests when
  `exclusion.excludeTests` is set, which is the default. 28 018 of the 30 669
  file-level matches carry `isTest: true`; the remainder is `spec/support`,
  `spec/factories` and docs that `classify()` calls a test but the payload flag
  does not.

`scrollUnenriched` transfers all of them, then discards them client-side via
`enrichmentScope`. They will never acquire an `enrichedAt`, so the traversal
repeats identically on every run, and its cost is `O(collection)` regardless of
how many files actually changed — the same minute for a 0-file delta as for a
1-file delta.

This is the failure mode the `RECOVERY_SCROLL_HARD_CAP` docblock already
describes. Raising the cap from 10 000 to 1 000 000 fixed a real correctness bug
(recovery silently truncated on 29 461 genuinely-damaged points) and, in doing
so, converted a truncation bug into a full-collection traversal.

## The defect

Absence of `<provider>.<level>.enrichedAt` is overloaded. It means two different
things:

1. enrichment was owed and missed it — recovery must heal this;
2. policy declined this point — recovery must ignore it.

The Qdrant filter can only express the union of the two, so the whole union
travels to the client and is corrected there by the policy. The transfer is the
cost.

Note this is not an index gap. `is_empty` is evaluated by scan whether or not a
payload index exists — the `git.file` count above costs 1426 ms to return zero.
Separately, and worth its own fix, this collection carries no `*.enrichedAt`
payload index at all: `schema-v12-enrichment-payload-indexes` never reached it,
and its hardcoded field list covers only `git.*` anyway, never the codegraph
provider that shipped later.

## Design

### Payload shape

A declined point gets a terminal marker alongside `enrichedAt`:

```text
<providerKey>.<level>.skippedAs = "generated" | "test" | "documentation"
```

Keyword, not boolean, and not a sentinel written into `enrichedAt`. A sentinel
would poison a datetime field, break its index and any range query over it. A
bare boolean would force an all-or-nothing invalidation when policy changes; the
reason makes invalidation targeted — dropping the key `where skippedAs = "test"`
is a filtered delete, not a full rewrite.

`skippedAs` and `enrichedAt` are mutually exclusive terminal states of one
decision, which is what makes the recovery filter a simple conjunction.

The name is `skippedAs`, not `skipReason`: `skipReason` already denotes ingest
telemetry in `pipeline/infra/debug-logger.ts:61`
(`secrets | chunk-limit | error | delete-failed | quarantined | compiled`), and
one token meaning two unrelated things violates `.claude/rules/naming.md`.

The value records the classification that held when the point was declined, not
the provider's stated reason — `shouldEnrich` returns only an `EnrichmentScope`
and gains no new obligation here. `policy.ts` already computes the
`FileClassification`; the stamp reports which flag was set, in the priority
order the providers' own if-chains use: `generated`, then `test`, then
`documentation`.

### Recovery filter

```text
must:     [ is_empty <provider>.<level>.enrichedAt,
            is_empty <provider>.<level>.skippedAs ]
must_not: [ _type = indexing_metadata,
            _type = schema_metadata,
            is_empty relativePath ]
```

A point is a recovery candidate only when it carries neither terminal marker.

### Who writes the stamp

The stamp is written by `EnrichmentApplier`, which already owns every write to
the `<provider>.<level>` payload subtree — the colocation rule says one
structure is populated in one place. The decision stays in `policy.ts`, which
already bridges `classify()` and `shouldEnrich`; it gains a partitioning
function that returns both halves instead of a filter that silently drops one.

Call sites are exactly the ones that consult the policy today:
`filterFileEnrichPaths` (file-phase, backfiller, recovery) and
`filterChunkEnrichMap` (chunk-phase, backfiller, recovery).

### Backfill: recovery liquidates its own scan

No data migration. Recovery already scrolls the unenriched set and already
computes `enrichmentScope` per point; today it discards the declined ones.
Instead it stamps them.

The first run after the upgrade therefore pays the current full traversal once
and converts it into permanent state. Every subsequent run matches close to
nothing and costs one scroll call per level.

This is recovery doing its actual job rather than extra work bolted onto it:
recovery exists to make the collection's recorded state honest, and the honest
state of a declined point is "skipped", not "absent".

A migration is still needed, but only to create payload indexes — never to
compute policy, which a migration cannot do because the policy lives on provider
instances it has no access to.

### Invalidation

A stamp is a claim that policy declined this point. If policy changes, stale
stamps hide points that recovery should now heal — the one way this design can
violate its own correctness bar.

Targeted invalidation is what the reason buys: a policy change that stops
skipping tests clears `skippedAs = "test"` and those points return to the
recovery candidate set on the next run. That clearing belongs to whichever
change alters the policy, and the design decision approved on this bead is that
`CODEGRAPH_EXCLUDE_TESTS` will be removed rather than flipped, so the largest
such change happens exactly once.

## What this does not fix

The predicate itself still scans. `is_empty` is not served by any index, so
Qdrant walks the collection to evaluate it — measured at roughly 1.4 s per level
on 89 336 points. Four levels, so the recovery phase settles at about 6 s,
against roughly 60 s today.

That is a 10× improvement, not elimination. Eliminating the scan entirely
requires gating recovery on the previous run's terminal marker, which
subordinates recovery to the self-report of the run it exists to check. Rejected
on that ground.

## Correctness invariants

The bar: no change may make a genuinely-unenriched point invisible to recovery
forever.

1. A point carrying `skippedAs` was declined by the policy at write time. Pinned
   by a property test over the real `classify()`: for every stamped path, the
   provider's `enrichmentScope` must not be `full` at that level.
2. A point carrying neither marker is a recovery candidate. Pinned by the filter
   test.
3. Stamping is idempotent — re-running recovery over an already-stamped
   collection writes nothing new and heals nothing, and the marker it produces
   is `completed`, not `degraded`.
4. `countUnenriched` and `scrollUnenriched` continue to see the same set. This
   invariant already exists in the code and is the reason
   `buildUnenrichedFilter` excludes points without a `relativePath`; the new
   condition is added to both paths or neither.

## Out of scope

Two findings from the same measurement, each filed separately:

- Removing `CODEGRAPH_EXCLUDE_TESTS`. It eliminates 44 546 of the 51 540 matched
  points at the source rather than stamping them, but it puts 28 018 test chunks
  into the dependency graph and shifts every codegraph percentile threshold, so
  it needs its own before/after validation. Kept out of this spec so the 60 s →
  6 s claim is measured without a graph-size change mixed into it.
- `CODEGRAPH_CUSTOM_EXCLUDE` is honoured by the graph walk
  (`discoverSupportedFiles`) but not by `shouldEnrich`. A file matched by those
  patterns passes the policy as `full`, is skipped by the walk, never receives
  an `enrichedAt`, and so is retried by recovery forever while the marker sticks
  at `degraded`. Latent only because the variable is empty in every registered
  project.

## Risks

- **Stale stamps after a policy change.** Addressed by the reason field and
  targeted clearing; the residual risk is a policy change that forgets to clear.
  A test that fails when a provider's decline rule changes without a
  corresponding invalidation step would close this, but the rule is a function
  body and no cheap structural check catches it. Accepted, documented here.
- **`recovery.ts` is the most defect-dense file in the area** — file-level
  `bugFixRate` 67, and the methods this touches carry chunk-level rates of 71
  to 80. It is structurally isolated (`fanIn` 1, `transitiveImpact` 1), so the
  hazard is internal correctness rather than ripple. The design keeps the
  decision in `policy.ts` (`fanIn` 5, `commitCount` 2, the most stable file in
  the area) and the write in `EnrichmentApplier`, leaving recovery's own scan
  logic close to unchanged.
- **First run after upgrade still pays the full traversal.** By construction —
  that run is what performs the backfill.
