---
name: add-migration
description:
  Add a new migration to an existing pipeline (schema, snapshot, or sparse). Use
  when persisted state needs upgrading — new Qdrant indexes, payload backfills,
  snapshot format changes, sparse vector rebuilds.
---

# Add Migration

Step-by-step process for adding a migration to one of three pipelines.

## Step 0: Determine Pipeline

| If you need to...                    | Pipeline   |
| ------------------------------------ | ---------- |
| Create/modify Qdrant index           | `schema`   |
| Backfill or transform payload fields | `schema`   |
| Enable/reconfigure sparse vectors    | `schema`   |
| Rebuild BM25 sparse vectors          | `sparse`   |
| Change snapshot file format          | `snapshot` |

## Step 1: Determine Version Number

Read the runner constructor to find the highest existing version:

| Pipeline   | Runner file                                     |
| ---------- | ----------------------------------------------- |
| `schema`   | `src/core/infra/migration/schema-migrator.ts`   |
| `snapshot` | `src/core/infra/migration/snapshot-migrator.ts` |
| `sparse`   | `src/core/infra/migration/sparse-migrator.ts`   |

New version = highest existing + 1.

## Step 2: Create Migration File

**File**:
`src/core/infra/migration/<pipeline>_migrations/<pipeline>-v<N>-<description>.ts`

### Template — Schema migration (index creation)

```typescript
import type { IndexStore } from "../types.js";
import type { Migration, StepResult } from "../types.js";

export class SchemaV<N><PascalDescription> implements Migration {
  readonly name = "schema-v<N>-<description>";
  readonly version = <N>;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(this.collection, "<field>", "<type>");
    return { applied: ["<field>:<type>"] };
  }
}
```

### Template — Schema migration (conditional)

```typescript
import type { IndexStore } from "../types.js";
import type { Migration, StepResult } from "../types.js";

export class SchemaV<N><PascalDescription> implements Migration {
  readonly name = "schema-v<N>-<description>";
  readonly version = <N>;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
    private readonly enabled: boolean,
  ) {}

  async apply(): Promise<StepResult> {
    if (!this.enabled) {
      return { applied: ["<description> — skipped (<reason>)"] };
    }
    // ... actual migration logic
    return { applied: ["<what was done>"] };
  }
}
```

### Template — Schema migration (payload backfill)

```typescript
import type { EnrichmentStore } from "../types.js";
import type { Migration, StepResult } from "../types.js";

export class SchemaV<N><PascalDescription> implements Migration {
  readonly name = "schema-v<N>-<description>";
  readonly version = <N>;

  constructor(
    private readonly collection: string,
    private readonly store: EnrichmentStore,
  ) {}

  async apply(): Promise<StepResult> {
    const alreadyDone = await this.store.isMigrated(this.collection);
    if (alreadyDone) {
      return { applied: ["already migrated — skipped"] };
    }

    const points = await this.store.scrollAllChunks(this.collection);
    // ... transform and batch update
    await this.store.markMigrated(this.collection);
    return { applied: [`backfilled ${points.length} points`] };
  }
}
```

### Template — Sparse migration

```typescript
import type { SparseStore } from "../types.js";
import type { Migration, StepResult } from "../types.js";

export class SparseV<N><PascalDescription> implements Migration {
  readonly name = "sparse-v<N>-<description>";
  readonly version = <N>;

  constructor(
    private readonly collection: string,
    private readonly store: SparseStore,
    private readonly enableHybrid: boolean,
  ) {}

  async apply(): Promise<StepResult> {
    if (!this.enableHybrid) {
      return { applied: ["sparse rebuild — skipped (hybrid disabled)"] };
    }
    await this.store.rebuildSparseVectors(this.collection);
    return { applied: ["rebuilt sparse vectors"] };
  }
}
```

### Template — Snapshot migration

```typescript
import type { SnapshotStore } from "../types.js";
import type { Migration, StepResult } from "../types.js";

export class SnapshotV<N><PascalDescription> implements Migration {
  readonly name = "snapshot-v<N>-<description>";
  readonly version = <N>;

  constructor(private readonly store: SnapshotStore) {}

  async apply(): Promise<StepResult> {
    const data = await this.store.readV<prev>();
    if (data === null) {
      return { applied: ["no v<prev> data — skipped"] };
    }
    // ... transform data to new format
    // ... write new format
    return { applied: ["converted from v<prev> to v<N>"] };
  }
}
```

## Step 3: Register in Runner

Add the new migration to the runner constructor's `this.migrations` array.

**Schema** (`schema-migrator.ts`):

```typescript
this.migrations = [
  // ... existing migrations ...
  new SchemaV() < N > <Name>(collection, indexStore), // unconditional
  new SchemaV() < N > <Name>(collection, indexStore, options.X), // conditional on flag
];
```

**Conditional inclusion** (optional dependencies):

```typescript
...(enrichmentStore
  ? [new SchemaV<N><Name>(collection, enrichmentStore)]
  : []),
```

**Sparse** (`sparse-migrator.ts`):

```typescript
this.migrations = [
  // ... existing migrations ...
  new SparseV() < N > <Name>(collection, store, enableHybrid),
];
```

**Snapshot** (`snapshot-migrator.ts`):

```typescript
this.migrations = [
  // ... existing migrations ...
  new SnapshotV() < N > <Name>store,
];
```

## Step 4: Extend Store Interface (if needed)

If the migration needs capabilities not in the existing store interface:

1. Add method to interface in `src/core/infra/migration/types.ts`
2. Implement in adapter: `src/core/infra/migration/adapters/<store>-adapter.ts`
3. Update mock in tests

**Do NOT** inject `QdrantManager` or other concrete classes directly into
migrations.

## Step 5: Update Factory (if needed)

If the migration requires new constructor arguments, update
`src/core/domains/ingest/factory.ts` → `createIngestDependencies()` to pass
them.

## Step 6: Write Tests

**File**: `tests/core/infra/migration/<pipeline>-migrator.test.ts`

Add to existing test file or create new one for the specific migration.

### Required test cases

1. **Happy path** — migration applies and returns correct `StepResult`
2. **Skip condition** — conditional migration returns skip message when disabled
3. **Idempotency** — re-running after success is safe (or handled by version
   check)
4. **Integration** — runner only applies migration when version > current

### Test pattern

```typescript
describe("SchemaV<N><Name>", () => {
  it("creates index on <field>", async () => {
    const store = createMockIndexStore();
    const migration = new SchemaV() < N > <Name>(COLLECTION, store);

    const result = await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "<field>",
      "<type>",
    );
    expect(result.applied).toContain("<field>:<type>");
  });

  it("skips when <condition>", async () => {
    const store = createMockIndexStore();
    const migration = new SchemaV() < N > <Name>(COLLECTION, store, false);

    const result = await migration.apply();

    expect(store.ensureIndex).not.toHaveBeenCalled();
    expect(result.applied[0]).toContain("skipped");
  });
});
```

## Step 7: Verify

```bash
npx tsc --noEmit && npx vitest run
```

## Checklist

- [ ] Version number is next integer after highest existing in pipeline
- [ ] File name follows `<pipeline>-v<N>-<kebab-description>.ts` convention
- [ ] Class implements `Migration` interface with `name`, `version`, `apply()`
- [ ] Uses store interface (NOT concrete `QdrantManager`)
- [ ] `apply()` is idempotent (safe to re-run)
- [ ] Conditional migrations return descriptive skip message
- [ ] Registered in runner constructor (correct position in array)
- [ ] Factory updated if new constructor args needed
- [ ] Store interface extended + adapter updated if new capabilities needed
- [ ] Tests cover happy path, skip condition, idempotency
- [ ] `npx tsc --noEmit && npx vitest run` passes
