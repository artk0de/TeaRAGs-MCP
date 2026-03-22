# Snapshot Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-cleanup stale snapshot artifacts (checkpoints, legacy v1/v2
files, migration backups) after indexing operations.

**Architecture:** New stateless `SnapshotCleaner` class in `ingest/sync/`
handles all cleanup. Called from `finally` blocks in
`IndexPipeline.indexCodebase()` and `ReindexPipeline.reindexChanges()`. No DI —
instantiated inline with `snapshotDir` and `collectionName`.

**Tech Stack:** Node.js `fs/promises`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-22-snapshot-cleanup-design.md`

---

### Task 1: SnapshotCleaner — tests

**Files:**

- Create: `tests/core/domains/ingest/sync/snapshot-cleaner.test.ts`

- [ ] **Step 1: Write test file with all cases**

```typescript
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SnapshotCleaner } from "../../../../../src/core/domains/ingest/sync/snapshot-cleaner.js";

describe("SnapshotCleaner", () => {
  let tempDir: string;
  const collectionName = "code_test1234";

  beforeEach(async () => {
    tempDir = join(process.env.TEA_RAGS_DATA_DIR!, "snapshots-cleaner-test");
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("cleanupAfterIndexing()", () => {
    it("should delete all artifact types", async () => {
      // Create all 4 artifact types
      await fs.writeFile(
        join(tempDir, `${collectionName}.checkpoint.json`),
        "{}",
      );
      await fs.writeFile(
        join(tempDir, `${collectionName}.checkpoint.json.tmp`),
        "{}",
      );
      await fs.writeFile(join(tempDir, `${collectionName}.json`), "{}");
      await fs.writeFile(join(tempDir, `${collectionName}.json.backup`), "{}");

      // Create v3 snapshot directory (must survive)
      const v3Dir = join(tempDir, collectionName);
      await fs.mkdir(v3Dir, { recursive: true });
      await fs.writeFile(join(v3Dir, "meta.json"), "{}");

      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      await cleaner.cleanupAfterIndexing();

      // All artifacts gone
      await expect(
        fs.access(join(tempDir, `${collectionName}.checkpoint.json`)),
      ).rejects.toThrow();
      await expect(
        fs.access(join(tempDir, `${collectionName}.checkpoint.json.tmp`)),
      ).rejects.toThrow();
      await expect(
        fs.access(join(tempDir, `${collectionName}.json`)),
      ).rejects.toThrow();
      await expect(
        fs.access(join(tempDir, `${collectionName}.json.backup`)),
      ).rejects.toThrow();

      // v3 snapshot untouched
      await expect(
        fs.access(join(v3Dir, "meta.json")),
      ).resolves.toBeUndefined();
    });

    it("should be idempotent — no-op on clean directory", async () => {
      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      // Should not throw
      await cleaner.cleanupAfterIndexing();
    });

    it("should handle partial presence — only checkpoint exists", async () => {
      await fs.writeFile(
        join(tempDir, `${collectionName}.checkpoint.json`),
        "{}",
      );

      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      await cleaner.cleanupAfterIndexing();

      await expect(
        fs.access(join(tempDir, `${collectionName}.checkpoint.json`)),
      ).rejects.toThrow();
    });

    it("should not touch other collections' artifacts", async () => {
      const otherCollection = "code_other999";
      await fs.writeFile(
        join(tempDir, `${otherCollection}.checkpoint.json`),
        "{}",
      );
      await fs.writeFile(join(tempDir, `${otherCollection}.json`), "{}");

      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      await cleaner.cleanupAfterIndexing();

      // Other collection's files untouched
      await expect(
        fs.access(join(tempDir, `${otherCollection}.checkpoint.json`)),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(join(tempDir, `${otherCollection}.json`)),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/sync/snapshot-cleaner.test.ts`
Expected: FAIL — `SnapshotCleaner` does not exist yet.

---

### Task 2: SnapshotCleaner — implementation

**Files:**

- Create: `src/core/domains/ingest/sync/snapshot-cleaner.ts`

- [ ] **Step 1: Implement SnapshotCleaner**

```typescript
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { isDebug } from "../pipeline/infra/runtime.js";

/**
 * Cleans up stale snapshot artifacts for a specific collection.
 *
 * Targets: checkpoints, legacy v1/v2 snapshots, migration backups.
 * Does NOT touch v3 sharded snapshot directories.
 */
export class SnapshotCleaner {
  private readonly snapshotDir: string;
  private readonly collectionName: string;

  constructor(snapshotDir: string, collectionName: string) {
    this.snapshotDir = snapshotDir;
    this.collectionName = collectionName;
  }

  /**
   * Remove stale artifacts after indexing completes (success or failure).
   * Safe to call multiple times (idempotent).
   */
  async cleanupAfterIndexing(): Promise<void> {
    const artifacts = [
      `${this.collectionName}.checkpoint.json`,
      `${this.collectionName}.checkpoint.json.tmp`,
      `${this.collectionName}.json`,
      `${this.collectionName}.json.backup`,
    ];

    const removed: string[] = [];

    for (const artifact of artifacts) {
      const path = join(this.snapshotDir, artifact);
      try {
        await fs.unlink(path);
        removed.push(artifact);
      } catch {
        // File doesn't exist — expected for most runs
      }
    }

    if (removed.length > 0 && isDebug()) {
      const labels = removed.map((a) =>
        a.replace(`${this.collectionName}.`, "").replace(".json", ""),
      );
      console.error(
        `[Cleanup] Removed ${removed.length} artifact(s) for ${this.collectionName}: ${labels.join(", ")}`,
      );
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/core/domains/ingest/sync/snapshot-cleaner.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/ingest/sync/snapshot-cleaner.ts tests/core/domains/ingest/sync/snapshot-cleaner.test.ts
git commit -m "feat(ingest): add SnapshotCleaner for post-indexing artifact cleanup"
```

---

### Task 3: Wire into IndexPipeline

**Files:**

- Modify: `src/core/domains/ingest/indexing.ts:56-121` (add `finally` block)

- [ ] **Step 1: Write integration test**

There is no dedicated test for `IndexPipeline.indexCodebase()` that checks
cleanup. The cleanup is tested via unit tests in Task 1. This step verifies the
wiring compiles and runs correctly.

- [ ] **Step 2: Add finally block to indexCodebase()**

In `src/core/domains/ingest/indexing.ts`, add import at top:

```typescript
import { SnapshotCleaner } from "./sync/snapshot-cleaner.js";
```

Wrap the existing try/catch in `indexCodebase()` with a `finally`:

```typescript
// After line 54: const { absolutePath, collectionName } = await this.resolveContext(path);

try {
  // ... existing try body (lines 57-109) ...
} catch (error) {
  // ... existing catch body (lines 110-120) ...
} finally {
  const cleaner = new SnapshotCleaner(this.snapshotDir, collectionName);
  await cleaner.cleanupAfterIndexing();
}
```

Notes:

- `collectionName` is declared before the try block (line 54), so it's available
  in `finally`.
- `this.snapshotDir` is a protected getter on `BaseIndexingPipeline`
  (base.ts:67) that delegates to `this.deps.snapshotDir`. Use the getter for
  consistency.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run` Expected: All tests pass. No regressions.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/ingest/indexing.ts
git commit -m "improve(ingest): wire SnapshotCleaner into IndexPipeline.indexCodebase()"
```

---

### Task 4: Wire into ReindexPipeline

**Files:**

- Modify: `src/core/domains/ingest/reindexing.ts:42-103` (add `finally` block)

- [ ] **Step 1: Add finally block to reindexChanges()**

In `src/core/domains/ingest/reindexing.ts`, add import at top:

```typescript
import { SnapshotCleaner } from "./sync/snapshot-cleaner.js";
```

The challenge: `collectionName` is only available inside the try block (from
`prepareReindexContext()`). Extract it before try, or use a variable:

```typescript
async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
  const startTime = Date.now();
  const { absolutePath, collectionName } = await this.resolveContext(path);
  const stats: ChangeStats = { /* ... same as before ... */ };

  try {
    const ctx = await this.prepareReindexContext(absolutePath, collectionName);
    // ... rest of existing try body unchanged, using ctx ...
  } catch (error) {
    // ... existing catch body unchanged ...
  } finally {
    const cleaner = new SnapshotCleaner(this.snapshotDir, collectionName);
    await cleaner.cleanupAfterIndexing();
  }
}
```

This requires refactoring `prepareReindexContext()` to accept pre-resolved
values instead of raw `path`. Only the first line changes — the rest of the
method body is unchanged:

```typescript
// BEFORE (current):
private async prepareReindexContext(path: string): Promise<ReindexContext> {
  const { absolutePath, collectionName } = await this.resolveContext(path);
  const exists = await this.qdrant.collectionExists(collectionName);
  if (!exists) { throw new NotIndexedError(path); }
  await this.runMigrations(collectionName, absolutePath);
  // ... lines 117-126 unchanged ...
}

// AFTER:
private async prepareReindexContext(absolutePath: string, collectionName: string): Promise<ReindexContext> {
  // resolveContext() removed — caller provides pre-resolved values
  const exists = await this.qdrant.collectionExists(collectionName);
  if (!exists) { throw new NotIndexedError(absolutePath); }
  await this.runMigrations(collectionName, absolutePath);
  // ... lines 117-126 unchanged (scanner, currentFiles, return ReindexContext) ...
}
```

`ReindexContext` interface stays the same — it still contains `absolutePath` and
`collectionName`, they just come from parameters now instead of internal
`resolveContext()` call.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run` Expected: All tests pass. No regressions.

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/ingest/reindexing.ts
git commit -m "improve(ingest): wire SnapshotCleaner into ReindexPipeline.reindexChanges()"
```

---

### Task 5: Build verification

- [ ] **Step 1: Run type-check + full tests + build**

```bash
npx tsc --noEmit && npx vitest run && npm run build
```

Expected: No type errors, all tests pass, build succeeds.

- [ ] **Step 2: Final commit if any fixups needed**

Only if previous steps required adjustments.
