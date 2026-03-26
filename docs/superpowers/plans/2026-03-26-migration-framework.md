# Migration Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all reindex-time migrations into `infra/migration/` with a
shared `Migration` interface, version-aware migrators, and a single `Migrator`
entry point.

**Architecture:** `Migrator` routes `run('snapshot')` / `run('schema')` to
`SnapshotMigrator` / `SchemaMigrator`. Each reads version once, runs only
applicable migration classes. Migration classes are pure — dependencies via DIP
interfaces.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-26-migration-framework-design.md`

---

### Task 1: Framework types and Migrator shell

Create the foundation: `Migration` interface, `MigrationSummary`, `StepResult`,
`Migrator` class, error types.

**Files:**

- Create: `src/core/infra/migration/types.ts`
- Create: `src/core/infra/migration/migrator.ts`
- Create: `src/core/infra/migration/errors.ts`
- Test: `tests/core/infra/migration/migrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/infra/migration/migrator.test.ts
import { describe, expect, it, vi } from "vitest";

import { Migrator } from "../../../../src/core/infra/migration/migrator.js";
import type {
  Migration,
  MigrationRunner,
  StepResult,
} from "../../../../src/core/infra/migration/types.js";

function createMockMigration(
  name: string,
  version: number,
  shouldApply = true,
): Migration {
  return {
    name,
    version,
    apply: vi.fn().mockResolvedValue({ applied: [`${name} done`] }),
  };
}

function createMockRunner(
  migrations: Migration[],
  currentVersion = 0,
): MigrationRunner {
  return {
    getVersion: vi.fn().mockResolvedValue(currentVersion),
    setVersion: vi.fn().mockResolvedValue(undefined),
    getMigrations: () => migrations,
  };
}

describe("Migrator", () => {
  it("routes run() to correct pipeline runner", async () => {
    const snapshotMigration = createMockMigration("snap-v2", 2);
    const schemaMigration = createMockMigration("schema-v4", 4);

    const migrator = new Migrator({
      snapshot: createMockRunner([snapshotMigration], 1),
      schema: createMockRunner([schemaMigration], 3),
    });

    const result = await migrator.run("snapshot");
    expect(result.pipeline).toBe("snapshot");
    expect(snapshotMigration.apply).toHaveBeenCalled();
    expect(schemaMigration.apply).not.toHaveBeenCalled();
  });

  it("skips migrations at or below current version", async () => {
    const m1 = createMockMigration("old", 2);
    const m2 = createMockMigration("new", 4);
    const runner = createMockRunner([m1, m2], 3);

    const migrator = new Migrator({
      snapshot: runner,
      schema: createMockRunner([]),
    });
    const result = await migrator.run("snapshot");

    expect(m1.apply).not.toHaveBeenCalled();
    expect(m2.apply).toHaveBeenCalled();
    expect(result.fromVersion).toBe(3);
    expect(result.toVersion).toBe(4);
  });

  it("runs migrations in version order", async () => {
    const order: string[] = [];
    const m5: Migration = {
      name: "v5",
      version: 5,
      apply: vi.fn().mockImplementation(async () => {
        order.push("v5");
        return { applied: [] };
      }),
    };
    const m4: Migration = {
      name: "v4",
      version: 4,
      apply: vi.fn().mockImplementation(async () => {
        order.push("v4");
        return { applied: [] };
      }),
    };
    // Register out of order to verify sorting
    const runner = createMockRunner([m5, m4], 3);
    const migrator = new Migrator({
      snapshot: runner,
      schema: createMockRunner([]),
    });
    await migrator.run("snapshot");

    expect(order).toEqual(["v4", "v5"]);
  });

  it("stores version after successful migrations", async () => {
    const migration = createMockMigration("v8", 8);
    const runner = createMockRunner([migration], 6);
    const migrator = new Migrator({
      snapshot: runner,
      schema: createMockRunner([]),
    });

    await migrator.run("snapshot");
    expect(runner.setVersion).toHaveBeenCalledWith(8);
  });

  it("does not store version when no migrations applied", async () => {
    const runner = createMockRunner([], 8);
    const migrator = new Migrator({
      snapshot: runner,
      schema: createMockRunner([]),
    });

    const result = await migrator.run("snapshot");
    expect(runner.setVersion).not.toHaveBeenCalled();
    expect(result.steps).toEqual([]);
  });

  it("stops on first failure and does not store version", async () => {
    const m1: Migration = {
      name: "ok",
      version: 4,
      apply: vi.fn().mockResolvedValue({ applied: ["done"] }),
    };
    const m2: Migration = {
      name: "fail",
      version: 5,
      apply: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const m3: Migration = {
      name: "never",
      version: 6,
      apply: vi.fn(),
    };
    const runner = createMockRunner([m1, m2, m3], 3);
    const migrator = new Migrator({
      snapshot: runner,
      schema: createMockRunner([]),
    });

    await expect(migrator.run("snapshot")).rejects.toThrow("boom");
    expect(m3.apply).not.toHaveBeenCalled();
    expect(runner.setVersion).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/migration/migrator.test.ts` Expected: FAIL
— cannot resolve modules

- [ ] **Step 3: Create `types.ts`**

Create `src/core/infra/migration/types.ts`:

```typescript
/**
 * Migration framework types.
 *
 * Migration = single versioned upgrade step (one class, one file).
 * MigrationRunner = version-aware pipeline that owns a set of migrations.
 * Migrator = top-level router dispatching run() to the correct runner.
 */

/** Single migration. One class = one file. */
export interface Migration {
  /** Human-readable name for logging. */
  readonly name: string;
  /** Version this migration upgrades TO. Migrations run in version order. */
  readonly version: number;
  /** Apply the migration. Throws on failure. */
  apply(): Promise<StepResult>;
}

/** Result of a single migration step. */
export interface StepResult {
  /** Human-readable descriptions of what was done. */
  applied: string[];
}

/** Version-aware pipeline that runs a set of migrations. */
export interface MigrationRunner {
  /** Read current version (once per run). */
  getVersion(): Promise<number>;
  /** Store new version after all migrations succeed. */
  setVersion(version: number): Promise<void>;
  /** Get all registered migrations (runner sorts by version). */
  getMigrations(): Migration[];
}

/** Summary returned by Migrator.run(). */
export interface MigrationSummary {
  pipeline: string;
  fromVersion: number;
  toVersion: number;
  steps: Array<{
    name: string;
    status: "applied" | "skipped";
    applied?: string[];
  }>;
}

/** DIP: filesystem operations for snapshot migrations. */
export interface SnapshotStore {
  getFormat(): Promise<"v1" | "v2" | "sharded" | "none">;
  readV1(): Promise<{
    fileHashes: Record<string, string>;
    codebasePath: string;
  } | null>;
  readV2(): Promise<{
    fileMetadata: Record<string, { mtime: number; size: number; hash: string }>;
    codebasePath: string;
  } | null>;
  writeSharded(
    codebasePath: string,
    files: Map<string, { mtime: number; size: number; hash: string }>,
  ): Promise<void>;
  backup(): Promise<void>;
  deleteOld(): Promise<void>;
  statFile(
    absolutePath: string,
  ): Promise<{ mtimeMs: number; size: number } | null>;
}

/** DIP: Qdrant index operations for schema migrations. */
export interface IndexStore {
  getSchemaVersion(collection: string): Promise<number>;
  ensureIndex(
    collection: string,
    field: string,
    type: string,
  ): Promise<boolean>;
  storeSchemaVersion(
    collection: string,
    version: number,
    indexes: string[],
  ): Promise<void>;
  hasPayloadIndex(collection: string, field: string): Promise<boolean>;
  getCollectionInfo(
    collection: string,
  ): Promise<{ hybridEnabled: boolean; vectorSize: number }>;
  updateSparseConfig(collection: string): Promise<void>;
}

/** DIP: Sparse vector operations. */
export interface SparseStore {
  getSparseVersion(collection: string): Promise<number>;
  rebuildSparseVectors(collection: string): Promise<void>;
  storeSparseVersion(collection: string, version: number): Promise<void>;
}
```

- [ ] **Step 4: Create `errors.ts`**

Create `src/core/infra/migration/errors.ts`:

```typescript
import { TeaRagsError } from "../errors.js";

/** A migration step failed. */
export class MigrationStepError extends TeaRagsError {
  constructor(pipeline: string, stepName: string, cause: Error) {
    super({
      code: "MIGRATION_STEP_FAILED",
      message: `Migration "${stepName}" failed in pipeline "${pipeline}"`,
      hint: "Check the error details and retry. If persistent, try forceReindex=true.",
      cause,
    });
  }
}
```

- [ ] **Step 5: Create `migrator.ts`**

Create `src/core/infra/migration/migrator.ts`:

```typescript
/**
 * Migrator — single entry point for all migration pipelines.
 *
 * Routes run(pipelineName) to the appropriate MigrationRunner.
 * Runner reads version once, runs applicable migrations in order,
 * stores new version on success.
 */

import { MigrationStepError } from "./errors.js";
import type { MigrationRunner, MigrationSummary } from "./types.js";

type PipelineName = "snapshot" | "schema";

export class Migrator {
  private readonly pipelines: Map<PipelineName, MigrationRunner>;

  constructor(pipelines: Record<PipelineName, MigrationRunner>) {
    this.pipelines = new Map(
      Object.entries(pipelines) as [PipelineName, MigrationRunner][],
    );
  }

  async run(pipeline: PipelineName): Promise<MigrationSummary> {
    const runner = this.pipelines.get(pipeline);
    if (!runner) {
      throw new Error(`Unknown migration pipeline: ${pipeline}`);
    }

    const currentVersion = await runner.getVersion();
    const migrations = runner
      .getMigrations()
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    const summary: MigrationSummary = {
      pipeline,
      fromVersion: currentVersion,
      toVersion: currentVersion,
      steps: [],
    };

    if (migrations.length === 0) return summary;

    for (const migration of migrations) {
      try {
        const result = await migration.apply();
        summary.steps.push({
          name: migration.name,
          status: "applied",
          applied: result.applied,
        });
        summary.toVersion = migration.version;
      } catch (error) {
        throw new MigrationStepError(
          pipeline,
          migration.name,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    await runner.setVersion(summary.toVersion);
    return summary;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/migration/migrator.test.ts` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/infra/migration/ tests/core/infra/migration/
git commit -m "feat(infra): add migration framework — Migrator, Migration interface, types"
```

---

### Task 2: SnapshotMigrator + snapshot migration classes

Move snapshot migration logic from `sync/migration.ts` and
`synchronizer.ts:ensureSnapshotV2()` into two migration classes +
`SnapshotMigrator` runner.

**Files:**

- Create: `src/core/infra/migration/snapshot-migrator.ts`
- Create: `src/core/infra/migration/snapshot_migrations/snapshot-v1-to-v2.ts`
- Create:
  `src/core/infra/migration/snapshot_migrations/snapshot-v2-to-sharded.ts`
- Test: `tests/core/infra/migration/snapshot-migrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/infra/migration/snapshot-migrator.test.ts
import { describe, expect, it, vi } from "vitest";

import { SnapshotMigrator } from "../../../../src/core/infra/migration/snapshot-migrator.js";
import type { SnapshotStore } from "../../../../src/core/infra/migration/types.js";

function createMockStore(
  format: "v1" | "v2" | "sharded" | "none" = "v1",
): SnapshotStore {
  return {
    getFormat: vi.fn().mockResolvedValue(format),
    readV1: vi.fn().mockResolvedValue({
      fileHashes: { "src/a.ts": "abc123" },
      codebasePath: "/project",
    }),
    readV2: vi.fn().mockResolvedValue({
      fileMetadata: { "src/a.ts": { mtime: 1000, size: 100, hash: "abc123" } },
      codebasePath: "/project",
    }),
    writeSharded: vi.fn().mockResolvedValue(undefined),
    backup: vi.fn().mockResolvedValue(undefined),
    deleteOld: vi.fn().mockResolvedValue(undefined),
    statFile: vi.fn().mockResolvedValue({ mtimeMs: 1000, size: 100 }),
  };
}

describe("SnapshotMigrator", () => {
  it("reports version 1 for v1 format", async () => {
    const store = createMockStore("v1");
    const migrator = new SnapshotMigrator(store);
    expect(await migrator.getVersion()).toBe(1);
  });

  it("reports version 3 for sharded format", async () => {
    const store = createMockStore("sharded");
    const migrator = new SnapshotMigrator(store);
    expect(await migrator.getVersion()).toBe(3);
  });

  it("reports version 0 for no snapshot", async () => {
    const store = createMockStore("none");
    const migrator = new SnapshotMigrator(store);
    expect(await migrator.getVersion()).toBe(0);
  });

  it("has 2 migrations registered", () => {
    const store = createMockStore();
    const migrator = new SnapshotMigrator(store);
    const migrations = migrator.getMigrations();
    expect(migrations).toHaveLength(2);
    expect(migrations[0].version).toBe(2);
    expect(migrations[1].version).toBe(3);
  });
});

describe("SnapshotV1ToV2", () => {
  it("adds mtime/size to each file via stat()", async () => {
    const store = createMockStore("v1");
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[0]; // v1→v2

    const result = await migration.apply();
    expect(store.statFile).toHaveBeenCalledWith("/project/src/a.ts");
    expect(result.applied.length).toBeGreaterThan(0);
  });

  it("skips files that no longer exist", async () => {
    const store = createMockStore("v1");
    (store.statFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[0];

    const result = await migration.apply();
    expect(result.applied).toEqual(
      expect.arrayContaining([expect.stringContaining("skipped")]),
    );
  });
});

describe("SnapshotV2ToSharded", () => {
  it("reads v2, backs up, writes sharded, deletes old", async () => {
    const store = createMockStore("v2");
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[1]; // v2→sharded

    await migration.apply();
    expect(store.readV2).toHaveBeenCalled();
    expect(store.backup).toHaveBeenCalled();
    expect(store.writeSharded).toHaveBeenCalled();
    expect(store.deleteOld).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/migration/snapshot-migrator.test.ts`
Expected: FAIL

- [ ] **Step 3: Create `snapshot_migrations/snapshot-v1-to-v2.ts`**

```typescript
import type { Migration, SnapshotStore, StepResult } from "../types.js";

/** Migrate snapshot v1 → v2: add mtime/size via stat() for each file. */
export class SnapshotV1ToV2 implements Migration {
  readonly name = "SnapshotV1ToV2";
  readonly version = 2;

  constructor(private readonly store: SnapshotStore) {}

  async apply(): Promise<StepResult> {
    const data = await this.store.readV1();
    if (!data) return { applied: ["no v1 snapshot found"] };

    const files = new Map<
      string,
      { mtime: number; size: number; hash: string }
    >();
    let upgraded = 0;
    let skipped = 0;

    for (const [path, hash] of Object.entries(data.fileHashes)) {
      const absolutePath = `${data.codebasePath}/${path}`;
      const stats = await this.store.statFile(absolutePath);
      if (stats) {
        files.set(path, { mtime: stats.mtimeMs, size: stats.size, hash });
        upgraded++;
      } else {
        skipped++;
      }
    }

    // Write as v2 (writeSharded handles format)
    // Note: at this point we write v2 metadata for the next migration to pick up
    await this.store.writeSharded(data.codebasePath, files);
    await this.store.deleteOld();

    return {
      applied: [`${upgraded} files upgraded, ${skipped} skipped (missing)`],
    };
  }
}
```

- [ ] **Step 4: Create `snapshot_migrations/snapshot-v2-to-sharded.ts`**

```typescript
import type { Migration, SnapshotStore, StepResult } from "../types.js";

/** Migrate snapshot v2 (single JSON) → v3 (sharded format). */
export class SnapshotV2ToSharded implements Migration {
  readonly name = "SnapshotV2ToSharded";
  readonly version = 3;

  constructor(private readonly store: SnapshotStore) {}

  async apply(): Promise<StepResult> {
    const data = await this.store.readV2();
    if (!data) return { applied: ["no v2 snapshot found"] };

    await this.store.backup();

    const files = new Map<
      string,
      { mtime: number; size: number; hash: string }
    >();
    let count = 0;
    let skipped = 0;

    for (const [path, metadata] of Object.entries(data.fileMetadata)) {
      const absolutePath = `${data.codebasePath}/${path}`;
      const exists = await this.store.statFile(absolutePath);
      if (exists) {
        files.set(path, metadata);
        count++;
      } else {
        skipped++;
      }
    }

    await this.store.writeSharded(data.codebasePath, files);
    await this.store.deleteOld();

    return {
      applied: [
        `${count} files migrated to sharded format, ${skipped} skipped`,
      ],
    };
  }
}
```

- [ ] **Step 5: Create `snapshot-migrator.ts`**

```typescript
import { SnapshotV1ToV2 } from "./snapshot_migrations/snapshot-v1-to-v2.js";
import { SnapshotV2ToSharded } from "./snapshot_migrations/snapshot-v2-to-sharded.js";
import type { Migration, MigrationRunner, SnapshotStore } from "./types.js";

const FORMAT_TO_VERSION: Record<string, number> = {
  none: 0,
  v1: 1,
  v2: 2,
  sharded: 3,
};

/** Version-aware runner for snapshot format migrations. */
export class SnapshotMigrator implements MigrationRunner {
  private readonly migrations: Migration[];

  constructor(private readonly store: SnapshotStore) {
    this.migrations = [
      new SnapshotV1ToV2(store),
      new SnapshotV2ToSharded(store),
    ];
  }

  async getVersion(): Promise<number> {
    const format = await this.store.getFormat();
    return FORMAT_TO_VERSION[format] ?? 0;
  }

  async setVersion(): Promise<void> {
    // Version is implicit in format — no explicit store needed.
    // After migrations run, format is "sharded" = version 3.
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/migration/snapshot-migrator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/infra/migration/snapshot-migrator.ts src/core/infra/migration/snapshot_migrations/ tests/core/infra/migration/snapshot-migrator.test.ts
git commit -m "feat(infra): add SnapshotMigrator with v1→v2 and v2→sharded migrations"
```

---

### Task 3: SchemaMigrator + schema migration classes

Move schema migration logic from `adapters/qdrant/schema-migration.ts` into
individual migration classes + `SchemaMigrator` runner.

**Files:**

- Create: `src/core/infra/migration/schema-migrator.ts`
- Create:
  `src/core/infra/migration/schema_migrations/schema-v4-relativepath-keyword.ts`
- Create:
  `src/core/infra/migration/schema_migrations/schema-v5-relativepath-text.ts`
- Create:
  `src/core/infra/migration/schema_migrations/schema-v6-filter-field-indexes.ts`
- Create:
  `src/core/infra/migration/schema_migrations/schema-v7-sparse-config.ts`
- Create:
  `src/core/infra/migration/schema_migrations/schema-v8-symbolid-text.ts`
- Create: `src/core/infra/migration/schema_migrations/sparse-vector-rebuild.ts`
- Test: `tests/core/infra/migration/schema-migrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/infra/migration/schema-migrator.test.ts
import { describe, expect, it, vi } from "vitest";

import { SchemaMigrator } from "../../../../src/core/infra/migration/schema-migrator.js";
import type {
  IndexStore,
  SparseStore,
} from "../../../../src/core/infra/migration/types.js";

function createMockIndexStore(version = 0): IndexStore {
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(version),
    ensureIndex: vi.fn().mockResolvedValue(true),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn().mockResolvedValue(false),
    getCollectionInfo: vi
      .fn()
      .mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSparseStore(version = 0): SparseStore {
  return {
    getSparseVersion: vi.fn().mockResolvedValue(version),
    rebuildSparseVectors: vi.fn().mockResolvedValue(undefined),
    storeSparseVersion: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SchemaMigrator", () => {
  const COLLECTION = "test_col";

  it("has 5 schema migrations + 1 sparse rebuild", () => {
    const migrator = new SchemaMigrator(
      COLLECTION,
      createMockIndexStore(),
      createMockSparseStore(),
      { enableHybrid: false },
    );
    expect(migrator.getMigrations().length).toBeGreaterThanOrEqual(5);
  });

  it("reads schema version from IndexStore", async () => {
    const store = createMockIndexStore(6);
    const migrator = new SchemaMigrator(
      COLLECTION,
      store,
      createMockSparseStore(),
      { enableHybrid: false },
    );

    const version = await migrator.getVersion();
    expect(version).toBe(6);
    expect(store.getSchemaVersion).toHaveBeenCalledWith(COLLECTION);
  });

  it("stores version via IndexStore after migrations", async () => {
    const store = createMockIndexStore(7);
    const migrator = new SchemaMigrator(
      COLLECTION,
      store,
      createMockSparseStore(),
      { enableHybrid: false },
    );

    await migrator.setVersion(8);
    expect(store.storeSchemaVersion).toHaveBeenCalledWith(
      COLLECTION,
      8,
      expect.any(Array),
    );
  });
});

describe("individual schema migrations", () => {
  const COLLECTION = "test_col";

  it("v4 creates keyword index on relativePath", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(
      COLLECTION,
      store,
      createMockSparseStore(),
      { enableHybrid: false },
    );
    const v4 = migrator.getMigrations().find((m) => m.version === 4)!;

    await v4.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "relativePath",
      "keyword",
    );
  });

  it("v6 creates indexes on language, fileExtension, chunkType", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(
      COLLECTION,
      store,
      createMockSparseStore(),
      { enableHybrid: false },
    );
    const v6 = migrator.getMigrations().find((m) => m.version === 6)!;

    await v6.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "language",
      "keyword",
    );
    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "fileExtension",
      "keyword",
    );
    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "chunkType",
      "keyword",
    );
  });

  it("v7 enables sparse config when enableHybrid=true", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(
      COLLECTION,
      store,
      createMockSparseStore(),
      { enableHybrid: true },
    );
    const v7 = migrator.getMigrations().find((m) => m.version === 7)!;

    await v7.apply();
    expect(store.updateSparseConfig).toHaveBeenCalledWith(COLLECTION);
  });

  it("v7 skips sparse config when enableHybrid=false", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(
      COLLECTION,
      store,
      createMockSparseStore(),
      { enableHybrid: false },
    );
    const v7 = migrator.getMigrations().find((m) => m.version === 7)!;

    const result = await v7.apply();
    expect(store.updateSparseConfig).not.toHaveBeenCalled();
    expect(result.applied).toEqual(
      expect.arrayContaining([expect.stringContaining("skipped")]),
    );
  });

  it("v8 creates text index on symbolId", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(
      COLLECTION,
      store,
      createMockSparseStore(),
      { enableHybrid: false },
    );
    const v8 = migrator.getMigrations().find((m) => m.version === 8)!;

    await v8.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "symbolId",
      "text",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/migration/schema-migrator.test.ts`
Expected: FAIL

- [ ] **Step 3: Create schema migration classes**

Each file in `src/core/infra/migration/schema_migrations/`:

**`schema-v4-relativepath-keyword.ts`:**

```typescript
import type { IndexStore, Migration, StepResult } from "../types.js";

export class RelativePathKeywordIndex implements Migration {
  readonly name = "RelativePathKeywordIndex";
  readonly version = 4;

  constructor(
    private readonly store: IndexStore,
    private readonly collection: string,
  ) {}

  async apply(): Promise<StepResult> {
    const created = await this.store.ensureIndex(
      this.collection,
      "relativePath",
      "keyword",
    );
    return {
      applied: [
        created
          ? "Created keyword index on relativePath"
          : "relativePath keyword index already exists",
      ],
    };
  }
}
```

**`schema-v5-relativepath-text.ts`:**

```typescript
import type { IndexStore, Migration, StepResult } from "../types.js";

export class RelativePathTextIndex implements Migration {
  readonly name = "RelativePathTextIndex";
  readonly version = 5;

  constructor(
    private readonly store: IndexStore,
    private readonly collection: string,
  ) {}

  async apply(): Promise<StepResult> {
    const created = await this.store.ensureIndex(
      this.collection,
      "relativePath",
      "text",
    );
    return {
      applied: [
        created
          ? "Created text index on relativePath"
          : "relativePath text index already exists",
      ],
    };
  }
}
```

**`schema-v6-filter-field-indexes.ts`:**

```typescript
import type { IndexStore, Migration, StepResult } from "../types.js";

export class FilterFieldIndexes implements Migration {
  readonly name = "FilterFieldIndexes";
  readonly version = 6;

  constructor(
    private readonly store: IndexStore,
    private readonly collection: string,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];
    for (const field of ["language", "fileExtension", "chunkType"]) {
      const created = await this.store.ensureIndex(
        this.collection,
        field,
        "keyword",
      );
      applied.push(
        created
          ? `Created keyword index on ${field}`
          : `${field} index already exists`,
      );
    }
    return { applied };
  }
}
```

**`schema-v7-sparse-config.ts`:**

```typescript
import type { IndexStore, Migration, StepResult } from "../types.js";

export class SparseConfig implements Migration {
  readonly name = "SparseConfig";
  readonly version = 7;

  constructor(
    private readonly store: IndexStore,
    private readonly collection: string,
    private readonly enableHybrid: boolean,
  ) {}

  async apply(): Promise<StepResult> {
    if (!this.enableHybrid) {
      return { applied: ["Sparse config skipped (hybrid not enabled)"] };
    }
    const info = await this.store.getCollectionInfo(this.collection);
    if (info.hybridEnabled) {
      return { applied: ["Sparse config already present"] };
    }
    await this.store.updateSparseConfig(this.collection);
    return { applied: ["Enabled sparse vectors on collection"] };
  }
}
```

**`schema-v8-symbolid-text.ts`:**

```typescript
import type { IndexStore, Migration, StepResult } from "../types.js";

export class SymbolIdTextIndex implements Migration {
  readonly name = "SymbolIdTextIndex";
  readonly version = 8;

  constructor(
    private readonly store: IndexStore,
    private readonly collection: string,
  ) {}

  async apply(): Promise<StepResult> {
    const created = await this.store.ensureIndex(
      this.collection,
      "symbolId",
      "text",
    );
    return {
      applied: [
        created
          ? "Created text index on symbolId"
          : "symbolId text index already exists",
      ],
    };
  }
}
```

**`sparse-vector-rebuild.ts`:**

```typescript
import type { Migration, SparseStore, StepResult } from "../types.js";

/** Current sparse vector version — bump when BM25 tokenizer changes. */
export const CURRENT_SPARSE_VERSION = 1;

export class SparseVectorRebuild implements Migration {
  readonly name = "SparseVectorRebuild";
  /** Version 100+ to always run after schema migrations. */
  readonly version = 100;

  constructor(
    private readonly store: SparseStore,
    private readonly collection: string,
    private readonly enableHybrid: boolean,
  ) {}

  async apply(): Promise<StepResult> {
    if (!this.enableHybrid) {
      return { applied: ["Sparse rebuild skipped (hybrid not enabled)"] };
    }

    const currentVersion = await this.store.getSparseVersion(this.collection);
    if (currentVersion >= CURRENT_SPARSE_VERSION) {
      return { applied: [`Sparse vectors already at v${currentVersion}`] };
    }

    await this.store.rebuildSparseVectors(this.collection);
    await this.store.storeSparseVersion(
      this.collection,
      CURRENT_SPARSE_VERSION,
    );
    return {
      applied: [
        `Rebuilt sparse vectors (v${currentVersion} → v${CURRENT_SPARSE_VERSION})`,
      ],
    };
  }
}
```

- [ ] **Step 4: Create `schema-migrator.ts`**

```typescript
import { RelativePathKeywordIndex } from "./schema_migrations/schema-v4-relativepath-keyword.js";
import { RelativePathTextIndex } from "./schema_migrations/schema-v5-relativepath-text.js";
import { FilterFieldIndexes } from "./schema_migrations/schema-v6-filter-field-indexes.js";
import { SparseConfig } from "./schema_migrations/schema-v7-sparse-config.js";
import { SymbolIdTextIndex } from "./schema_migrations/schema-v8-symbolid-text.js";
import { SparseVectorRebuild } from "./schema_migrations/sparse-vector-rebuild.js";
import type {
  IndexStore,
  Migration,
  MigrationRunner,
  SparseStore,
} from "./types.js";

/** Version-aware runner for Qdrant schema migrations. */
export class SchemaMigrator implements MigrationRunner {
  private readonly migrations: Migration[];
  private readonly appliedIndexes: string[] = [];

  constructor(
    private readonly collection: string,
    private readonly indexStore: IndexStore,
    private readonly sparseStore: SparseStore,
    options: { enableHybrid: boolean },
  ) {
    this.migrations = [
      new RelativePathKeywordIndex(indexStore, collection),
      new RelativePathTextIndex(indexStore, collection),
      new FilterFieldIndexes(indexStore, collection),
      new SparseConfig(indexStore, collection, options.enableHybrid),
      new SymbolIdTextIndex(indexStore, collection),
      new SparseVectorRebuild(sparseStore, collection, options.enableHybrid),
    ];
  }

  async getVersion(): Promise<number> {
    return this.indexStore.getSchemaVersion(this.collection);
  }

  async setVersion(version: number): Promise<void> {
    await this.indexStore.storeSchemaVersion(
      this.collection,
      version,
      this.appliedIndexes,
    );
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/migration/schema-migrator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/infra/migration/schema-migrator.ts src/core/infra/migration/schema_migrations/ tests/core/infra/migration/schema-migrator.test.ts
git commit -m "feat(infra): add SchemaMigrator with v4-v8 + sparse rebuild migrations"
```

---

### Task 4: Wire Migrator into composition root and ReindexPipeline

Replace `createMigrator`/`createSchemaManager` factories with single `Migrator`
instance. Update `ReindexPipeline.runMigrations()` to use
`migrator.run('snapshot')` / `migrator.run('schema')`.

**Files:**

- Modify: `src/core/domains/ingest/factory.ts`
- Modify: `src/core/domains/ingest/reindexing.ts`
- Modify: `src/core/domains/ingest/indexing.ts` (keep `initializeSchema`)
- Test: existing pipeline tests should still pass

- [ ] **Step 1: Update `factory.ts`**

Replace `createMigrator` and `createSchemaManager` with a single `migrator`
factory function that accepts `collectionName` and returns a configured
`Migrator`.

Remove imports of `SchemaManager` and `SnapshotMigrator`. Add import of
`Migrator`, `SnapshotMigrator`, `SchemaMigrator`, and adapter implementations.

- [ ] **Step 2: Update `ReindexPipeline.runMigrations()`**

Replace:

```typescript
const migrator = this.deps.createMigrator(collectionName, absolutePath);
await migrator.ensureMigrated();
const schemaManager = this.deps.createSchemaManager();
const schemaMigration = await schemaManager.ensureCurrentSchema(collectionName);
// ... logging ...
const sparseResult =
  await schemaManager.checkSparseVectorVersion(collectionName);
// ... logging ...
```

With:

```typescript
const migrator = this.deps.createMigrator(collectionName, absolutePath);
const snapshotResult = await migrator.run("snapshot");
// log snapshotResult.steps
const schemaResult = await migrator.run("schema");
// log schemaResult.steps
```

- [ ] **Step 3: Keep `initializeSchema` for `IndexPipeline`**

`IndexPipeline` uses `SchemaManager.initializeSchema()` for new collections.
This is NOT a migration — it creates indexes from scratch. Extract it into a
standalone function or keep `SchemaManager` with only `initializeSchema()`.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/factory.ts src/core/domains/ingest/reindexing.ts src/core/domains/ingest/indexing.ts
git commit -m "refactor(ingest): wire Migrator into ReindexPipeline, replace inline migration calls"
```

---

### Task 5: Delete old migration code

Remove replaced files and methods now that the new framework is wired in.

**Files:**

- Delete: `src/core/domains/ingest/sync/migration.ts`
- Modify: `src/core/domains/ingest/sync/synchronizer.ts` (remove
  `ensureSnapshotV2()`)
- Modify: `src/core/adapters/qdrant/schema-migration.ts` (keep only
  `initializeSchema` if needed, or delete entirely)
- Update: `src/core/domains/ingest/errors.ts` (move `MigrationFailedError` to
  `infra/migration/errors.ts` or keep as re-export)
- Update: affected test files

- [ ] **Step 1: Delete `sync/migration.ts`**

Remove entire file. `SnapshotMigrator` class is replaced by
`infra/migration/snapshot-migrator.ts`.

- [ ] **Step 2: Remove `ensureSnapshotV2()` from `synchronizer.ts`**

Remove the method (lines 87-143). The v1→v2 logic is now in
`snapshot_migrations/snapshot-v1-to-v2.ts`.

- [ ] **Step 3: Clean up `schema-migration.ts`**

If `initializeSchema()` is extracted elsewhere, delete the entire file.
Otherwise, keep only `initializeSchema()` + helper methods it uses
(`storeSchemaMetadata`).

Remove: `ensureCurrentSchema()`, `checkSparseVectorVersion()`,
`rebuildSparseVectors()`, `getSchemaVersion()`, `updateSparseVersion()`,
`getSchemaMetadata()`.

- [ ] **Step 4: Update test imports**

Tests in `tests/core/adapters/qdrant/schema-migration.test.ts` and
`tests/core/domains/ingest/sync/migration.test.ts` need to be updated or
replaced by the new tests in `tests/core/infra/migration/`.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(ingest): remove old migration code, replaced by infra/migration framework"
```

---

### Task 6: Barrel export and documentation

- [ ] **Step 1: Add barrel for migration module**

Create `src/core/infra/migration/index.ts`:

```typescript
export { Migrator } from "./migrator.js";
export { SnapshotMigrator } from "./snapshot-migrator.js";
export { SchemaMigrator } from "./schema-migrator.js";
export type {
  Migration,
  MigrationRunner,
  MigrationSummary,
  StepResult,
  SnapshotStore,
  IndexStore,
  SparseStore,
} from "./types.js";
export { MigrationStepError } from "./errors.js";
```

- [ ] **Step 2: Update wiring.md and project-structure.md**

Add `infra/migration/` to the project structure docs. Update wiring chain to
show `Migrator` in the bootstrap flow.

- [ ] **Step 3: Run build + full test suite**

Run: `npm run build && npx vitest run` Expected: Build clean, all tests pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(infra): add migration framework barrel export and update project docs"
```
