# Qdrant Yellow-Status Handling Design

**Status:** Approved (brainstorming) **Date:** 2026-04-23 **Scope:** core
adapter + schema migration + `/tea-rags:index` skill

## Problem

Qdrant periodically enters `status=yellow` during background optimization
(segment merge + tombstone vacuum). In this state, the
`client.count(name, {exact: true})` endpoint blocks or responds extremely
slowly. Our default 60s timeout trips, and callers surface as generic
`INFRA_QDRANT_OPERATION_FAILED` or `UnknownError: This operation was aborted`.

Observed concretely this session on a live `code_27622aef` collection:
`indexed_vectors_count=144127 / points_count=60842 / segments_count=6`,
status=yellow, optimizer_status=ok. Three consecutive `index_codebase` calls
failed at the first `countPoints` step.

The problem is not Qdrant reliability — `GET /collections/{name}` kept
responding in ~10ms throughout. The problem is that our adapter conflates
"collection is busy optimizing" with "Qdrant is dead," and our domain code picks
the most expensive count endpoint when cheap metadata suffices.

## Goals

1. Domain code that decides full-vs-incremental indexing must not hit a 60s
   timeout on a healthy-but-optimizing collection.
2. When `countPoints` is legitimately needed (filtered counts), transient
   optimization failures must surface as a typed error with actionable hint, not
   as an opaque abort.
3. MCP clients (our own CLI skill included) must be able to observe Qdrant's
   internal health state (`status`, `optimizer_status`) to make informed UX
   decisions.
4. Filtered `is_empty` counts (used by enrichment recovery) must remain fast
   even during yellow phases.
5. The `/tea-rags:index` skill must interpret the new health signals and degrade
   gracefully rather than failing cryptically.

## Non-goals

- Tuning Qdrant `optimizers_config` thresholds to reduce yellow frequency. That
  is a separate performance investigation.
- Retry infrastructure for transient Qdrant errors in general. This spec covers
  only the optimization-in-progress case.
- Raising the `countPoints` client timeout. Yellow can last minutes; longer
  timeouts mask the symptom without fixing the failure mode.

## Decisions (from brainstorm)

| #   | Decision                                                                                                                                                         | Rationale                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Use `getCollectionInfo().pointsCount` in `deletion-strategy.ts`, not a new `getCollectionCount` method                                                           | `getCollectionInfo` already exposes `pointsCount` cheaply. Adding a parallel method duplicates API surface in an extreme-churn file.                                                         |
| D2  | `countPoints` probes `getCollection()` in its catch block to detect yellow, throws `QdrantOptimizationInProgressError`                                           | Probe is cheap (~10ms) on the error path; heuristic by error message string is brittle; caller-side pre-check duplicates knowledge across three call sites.                                  |
| D3  | Fail-fast at adapter level, no retry inside `countPoints`                                                                                                        | Yellow lasts minutes; short retries are placebo. Adapters are foundation layer — UX decisions (wait / force-reindex / progress indicator) belong to domain or API layer.                     |
| D4  | Baseline scope covers 3 core items (client/errors/deletion-strategy + DTO + MCP tool). Plus payload index migration for `is_empty` filters on enrichment fields. | Core items unblock `index_codebase` hot path. Migration unblocks filtered `countPoints` in `recovery.countUnenriched`, which is the one remaining consumer that genuinely needs exact count. |
| D5  | `/tea-rags:index` SKILL.md updated via `/optimize-skill` (eval-driven), not hand-edited                                                                          | Project preference: no silent skill patches. `/optimize-skill` iterates via subagent evals against explicit scenarios, ensuring measurable quality rather than one-off edits.                |
| D6  | Yellow reaction policy in the skill: inform + auto-proceed (not silent, not ask-every-time)                                                                      | Yellow is a normal operating state during active ingest. Silent proceed is opaque; ask-every-time violates "act, don't plan" preference. Informing with auto-proceed is the honest middle.   |

## Architecture

### Section 1 — Adapter, errors, DTO

#### `src/core/adapters/qdrant/errors.ts`

New class (barrel-exported):

```ts
export class QdrantOptimizationInProgressError extends InfraError {
  readonly code = "INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS";
  readonly hint =
    "Collection is under background optimization (Qdrant status=yellow). " +
    "Wait 1-5 minutes and retry, or use /tea-rags:force-reindex to build a " +
    "new collection in parallel without waiting.";

  constructor(collectionName: string, cause?: Error) {
    super(`Qdrant collection "${collectionName}" is optimizing`, cause);
  }
}
```

Single-owner file — no conflict risk from parallel work. Tests are mandatory
because there is no pair-review history in this file.

#### `src/core/adapters/qdrant/client.ts`

Two changes, both minimal in diff size (hot-file):

**(a) `getCollectionInfo` — expose health fields**

```ts
return {
  name,
  vectorSize: size,
  pointsCount: info.points_count || 0,
  distance,
  hybridEnabled,
  status: info.status as "green" | "yellow" | "red",
  optimizerStatus: info.optimizer_status ?? "unknown",
};
```

Qdrant already returns `status` and `optimizer_status` in the metadata response.
We simply propagate them. No new HTTP call.

**(b) `countPoints` — yellow probe in catch**

```ts
async countPoints(collectionName: string, filter?: Record<string, unknown>): Promise<number> {
  try {
    const result = await this.call(async () =>
      this.client.count(collectionName, { filter, exact: true }),
    );
    return result.count;
  } catch (error: unknown) {
    if (error instanceof QdrantUnavailableError) throw error;

    try {
      const info = await this.call(async () =>
        this.client.getCollection(collectionName),
      );
      if (info.status === "yellow") {
        throw new QdrantOptimizationInProgressError(
          collectionName,
          error instanceof Error ? error : undefined,
        );
      }
    } catch (probeError) {
      if (probeError instanceof QdrantOptimizationInProgressError) throw probeError;
      // probe failed too → Qdrant genuinely unreachable → fall through
    }

    const errorData = error as { data?: { status?: { error?: string } }; message?: string };
    const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
    throw new QdrantOperationError(
      "countPoints",
      `collection "${collectionName}": ${errorMessage}`,
      error instanceof Error ? error : undefined,
    );
  }
}
```

Probe safety: if the probe itself hangs or fails, `probeError` is caught and we
fall through to the original `QdrantOperationError`. Worst case is identical to
today (generic operation error); best case is a typed error with actionable
hint. The probe does not introduce a new unbounded wait — the underlying
`@qdrant/js-client-rest` has its own client-side abort behavior, and
`getCollection` is the lightest endpoint Qdrant exposes. If during
implementation the probe latency proves unacceptable on degraded hosts, wrap it
in an `AbortController` with a 5s explicit timeout (noted in Open Questions).

#### `src/core/domains/ingest/sync/deletion-strategy.ts`

Lines 31 and 115:

```ts
const totalBefore = (await qdrant.getCollectionInfo(collectionName))
  .pointsCount;
// ...
const totalAfter = (await qdrant.getCollectionInfo(collectionName)).pointsCount;
```

`totalBefore - totalAfter` does not require single-point accuracy; the cached
`points_count` from collection metadata is more than enough for this return
value.

#### DTO and MCP tool

- `CollectionInfo` interface (location: `src/core/api/public/dto/collection.ts`
  — confirmed during implementation) gains two fields:
  `status: "green" | "yellow" | "red"` and `optimizerStatus: string`.
- `src/mcp/tools/collection.ts` `get_index_status` tool surfaces the new fields
  automatically — the handler returns `info` directly via
  `app.getCollectionInfo(name)`. A schema update in the tool's Zod response type
  is required so MCP clients see the fields in their typed response.

#### Data flow (yellow scenario, after changes)

```
MCP Client            MCP Tool              Facade           QdrantManager         Qdrant
    │                    │                     │                    │                  │
    │─ index_codebase ──▶│                     │                    │                  │
    │                    │─ ingest.start ─────▶│                    │                  │
    │                    │                     │─ getCollInfo ─────▶│                  │
    │                    │                     │                    │─ GET /coll ─────▶│
    │                    │                     │                    │◀─ yellow ────────│
    │                    │                     │◀ {status:yellow}  │                  │
    │                    │◀ InfraError or ────│                    │                  │
    │                    │   proceed-with-    │                    │                  │
    │                    │   cached-count     │                    │                  │
    │◀── typed response ─│                     │                    │                  │
```

### Section 2 — Payload indexes migration

#### Target fields

Currently the only enrichment provider is `git`. Fields used by
`recovery.countUnenriched` filter `is_empty`:

- `git.file.enrichedAt`
- `git.chunk.enrichedAt`

Schema: `datetime`. Qdrant's `datetime` index supports range filters and
`is_empty`/`is_null` checks. If the field is actually stored as a Unix epoch
integer (to be confirmed during implementation by reading `applier.ts`), we
switch to `integer` schema — this is a one-line change, not a design blocker.

#### File placement

- Directory: `src/core/infra/migration/schema_migrations/`
- Previous migration: `schema-v7-sparse-config.ts`
- New file: `schema-v8-enrichment-payload-indexes.ts`
- Register in the migrator (exact registry location confirmed via
  `add-migration` skill during implementation)

#### Migration body (sketch)

```ts
export class SchemaV8EnrichmentPayloadIndexes implements SchemaMigration {
  readonly version = 8;
  readonly description =
    "Add payload indexes on enrichment enrichedAt fields for fast is_empty filters";

  async apply(store: SparseStore): Promise<void> {
    const FIELDS: { path: string; schema: "datetime" }[] = [
      { path: "git.file.enrichedAt", schema: "datetime" },
      { path: "git.chunk.enrichedAt", schema: "datetime" },
    ];
    for (const { path, schema } of FIELDS) {
      await store.ensurePayloadIndex(path, schema);
    }
  }
}
```

#### Provider list: hardcoded, not dynamic

The migration lists fields explicitly rather than iterating
`EnrichmentProvider[]` from the live registry. Rationale: a migration is a
snapshot of schema intent at the moment it was written. If a future `static`
provider appears, it ships its own migration (v9+), not a mutation of v8's
behavior across time. This matches the existing pattern in `schema_migrations/`
(v7 is specific to sparse config, not "whatever sparse settings exist at
runtime").

#### Idempotency and drift classification

`QdrantManager.ensurePayloadIndex` (client.ts:234-245) already checks
`hasPayloadIndex` before creating. The migration is idempotent — safe to rerun.

Per the project rule `schema-drift-vs-migration.md`:

- **Drift** = new payload fields that require full reindex to populate.
- **Migration** = partial update without reindex.

Adding a payload index does not require reindex — Qdrant builds the index on
existing points. This is a proper migration.

On large collections (100k+ points), `createPayloadIndex` with `wait: true` may
take tens of seconds, but this is a one-time cost per collection and does not
block search.

### Section 3 — Skill update via `/optimize-skill`

#### Why `/optimize-skill` and not hand-edit

Project policy: no silent SKILL.md patches. `/optimize-skill` runs eval cycles
with parallel subagents, measuring skill behavior against declared scenarios and
iterating until 100% pass rate. This produces measurable, defensible changes
rather than free-form edits.

#### Target skill

`/tea-rags:index` — invoked at session start (per the loaded Search Cascade
hook) and manually by users. Currently checks `get_index_status`, branches on
isError, parses `[CODE]` from the error text. Has no awareness of new
`status`/`optimizerStatus` fields or the new `QDRANT_OPTIMIZATION_IN_PROGRESS`
error code.

#### Policy for yellow status — D6 ("inform + auto-proceed")

When `get_index_status` returns `status=yellow`:

1. Log an informational note describing what yellow means
   (`"Qdrant is optimizing in background (status=yellow, optimizer_status=ok). Indexing will proceed; some operations may be slower."`).
2. Continue to `/tea-rags:index` normal path.
3. If the eventual `index_codebase` call throws
   `INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS` (unlikely once Section 1 + 2 ship,
   but possible in edge cases like filtered count within recovery), the skill
   reads the hint and offers the three options from the error contract.

When `status=red`: surface as blocking error, propose diagnostic via
`get_collection_info` plus manual investigation.

When `status=green`: no behavior change from today.

#### Eval scenarios for `/optimize-skill`

| Scenario                                                                | Expected behavior (after skill update)                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `get_index_status` returns `status=yellow, optimizer_status=ok`         | Skill logs informational note referencing both fields, proceeds to indexing       |
| `get_index_status` returns `status=red`                                 | Skill surfaces blocking message, proposes `get_collection_info` diagnostic        |
| Any MCP tool returns error code `INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS` | Skill parses code, reads hint, offers three options (wait / force-reindex / skip) |
| `get_index_status` returns `status=green`                               | Zero behavior change vs. current skill                                            |

`/optimize-skill` takes these scenarios, runs evals against the current
SKILL.md, identifies failing cases, edits SKILL.md, re-evaluates, iterates until
100% pass.

#### SKILL.md diff scope (explicit, per "no silent skill patches" rule)

| Section in SKILL.md                           | Change                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "Check and update index"                      | Add: check `response.status`; if yellow/red, emit informational note with `optimizerStatus` detail |
| Error handling block                          | Add case for `[QDRANT_OPTIMIZATION_IN_PROGRESS]` with three user-facing options                    |
| (optional) New section "Qdrant health states" | Short reference table green/yellow/red → expected action                                           |

The exact wording is produced by `/optimize-skill`'s eval-driven iteration, not
predetermined here.

#### Ordering

1. Section 1 and 2 land in code first; their tests pass; MCP server rebuilt;
   client reconnected.
2. Live verification: `get_index_status` actually returns `status` and
   `optimizerStatus` fields.
3. Only then run `/optimize-skill` with the eval scenarios above. Evals need
   real MCP responses with the new fields to be meaningful.

## File touch list

| Change                                                     | File                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| New typed error class                                      | `src/core/adapters/qdrant/errors.ts`                                                         |
| Extend `getCollectionInfo`; yellow probe in `countPoints`  | `src/core/adapters/qdrant/client.ts`                                                         |
| Replace `countPoints` with `getCollectionInfo.pointsCount` | `src/core/domains/ingest/sync/deletion-strategy.ts`                                          |
| Extend `CollectionInfo` interface                          | `src/core/api/public/dto/collection.ts`                                                      |
| Update response schema for `get_index_status`              | `src/mcp/tools/collection.ts`                                                                |
| New migration                                              | `src/core/infra/migration/schema_migrations/schema-v8-enrichment-payload-indexes.ts`         |
| Register migration                                         | migrator registry (exact file confirmed via `add-migration` skill)                           |
| Adapter tests                                              | `tests/core/adapters/qdrant/client.test.ts`, `tests/core/adapters/qdrant/errors.test.ts`     |
| Domain tests                                               | `tests/core/domains/ingest/sync/deletion-strategy.test.ts`                                   |
| Migration tests                                            | `tests/core/infra/migration/schema_migrations/schema-v8-enrichment-payload-indexes.test.ts`  |
| Skill eval + edit                                          | `/tea-rags:index` SKILL.md (location inside plugin cache; `/optimize-skill` handles pathing) |

## Test plan

### Adapter (`client.ts`)

- `countPoints` throws `QdrantOptimizationInProgressError` when count fails AND
  probe returns `status=yellow`.
- `countPoints` throws `QdrantOperationError` (existing behavior) when probe
  returns `status=green` (i.e. count failed for some other reason).
- `countPoints` throws `QdrantOperationError` when probe itself fails (Qdrant
  unreachable).
- `getCollectionInfo` returns `status` and `optimizerStatus` fields populated
  from Qdrant metadata.
- Happy-path count still works when collection is green.

### Errors

- `QdrantOptimizationInProgressError` has correct code, hint, and cause chain.
- Serializes correctly through the MCP error middleware.

### Domain (`deletion-strategy.ts`)

- Behavior-level test: deletion reports correct `totalBefore - totalAfter` delta
  when using cached `pointsCount`. Mock `getCollectionInfo`, not `countPoints`.
- Verify existing 3-level fallback cascade is unaffected (regression test).

### Migration (`schema-v8`)

- Runs against a test collection with no indexes — creates both indexes.
- Runs against a collection with partial indexes — creates only the missing one
  (idempotency).
- Runs against a collection with both indexes — no-op.
- Runs in correct sequence relative to v7 (version ordering test, already
  covered by existing migrator tests — just add v8 to fixtures).

### Skill evals

Defined in Section 3 eval scenarios table. Executed by `/optimize-skill`.

## Open questions for implementation

1. Exact `CollectionInfo` DTO location — likely
   `src/core/api/public/dto/collection.ts` per the project-structure rule;
   verify at implementation time.
2. `enrichedAt` storage format (ISO string vs. epoch integer) determines
   migration schema (`datetime` vs. `integer`). One-line decision when reading
   `applier.ts`.
3. Migrator registry file name — resolved via `add-migration` skill during
   execution.
4. Whether `index_codebase` MCP tool needs explicit surfacing of
   `optimizerStatus` in its response telemetry. Probably yes for observability,
   but not strictly in scope — log a TODO if deferred.
5. Probe timeout: current plan relies on `@qdrant/js-client-rest` default abort
   behavior. If probe latency is unbounded on degraded hosts, wrap the probe in
   an explicit 5s `AbortController`. Decide during implementation after
   measuring probe latency on a live yellow collection.

## Alternatives considered and rejected

| Alternative                                                 | Why rejected                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Increase `countPoints` timeout to 5 minutes                 | Masks the symptom; yellow can last longer. Blocks the agent loop meaningfully.                                  |
| Retry `countPoints` with exponential backoff inside adapter | Yellow lasts minutes; 2-retry × 8s backoff is placebo. Violates layer boundaries (UX in adapter).               |
| Dynamic provider iteration inside migration                 | Migrations should be stable snapshots; dynamic lookup makes migration outcome a function of current code state. |
| Hand-edit `/tea-rags:index` SKILL.md                        | Violates "no silent skill patches" policy. `/optimize-skill` gives measurable quality.                          |
| Silent yellow handling in skill (variant A)                 | Leaves user confused when things get slow (exactly the situation we observed this session).                     |
| Ask-every-time yellow handling (variant C)                  | Violates "act, don't plan" preference; yellow is common operating state, not an exception.                      |

## References

- Observed failure: session of 2026-04-23, `code_27622aef` collection, three
  consecutive `index_codebase` timeouts.
- Project rules: `.claude/rules/domain-boundaries.md`,
  `.claude/rules/typed-errors.md`,
  `.claude/rules/.local/schema-drift-vs-migration.md`,
  `.claude/rules/.local/working-style.md` (no silent skill patches).
- Qdrant REST API: `GET /collections/{name}` returns
  `{status, optimizer_status, points_count, indexed_vectors_count, segments_count, ...}`.
