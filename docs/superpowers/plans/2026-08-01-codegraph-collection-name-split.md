# Codegraph Collection-Name Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the codegraph write path and read path resolve the same DuckDB
file for one logical collection, and let a run detect that its graph no longer
matches the code.

**Architecture:** The incremental reindex currently carries the Qdrant alias
name end-to-end, so `GraphDbClientPool.pathFor()` opens `<alias>.duckdb` while
every reader opens `<alias>_vN.duckdb`. Tasks 1–2 give `ReindexContext` a
`targetCollection` field (the physical versioned name) exactly as `SetupResult`
already has, and route versioned artifacts through it. Tasks 3–6 add a per-file
`content_hash` to `cg_symbols_files` and an exact repair set computed by diffing
the persisted hashes against the run's eligible files, so a graph that is
missing or stale repairs itself. Task 7 lets the orphan sweep reclaim the shadow
files this bug left behind.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), DuckDB via
`@duckdb/node-api`, Qdrant, Vitest.

**Design spec:**
`docs/superpowers/specs/2026-08-01-codegraph-collection-name-split-design.md`
(merged `6899f404`). Bead: `tea-rags-mcp-6goqa` (P0).

## Global Constraints

- TDD is mandatory: write the failing test, run it, see it fail, then implement.
  No exceptions.
- Never lower a coverage threshold. Never add `eslint-disable` or `v8 ignore` to
  make a gate pass.
- Tests assert invariants, not implementation
  (`.claude/rules/test-invariants.md`). Existing business-logic tests may move
  but must not be rewritten.
- Commit type and scope per `.claude/rules/commit-rules.md`. Every commit
  subject carries `(6goqa)`.
- Work stays on branch `worktree-6goqa-cg-collection-name`. Do not push. Do not
  merge to main without an explicit ask.
- Do not run `npm run build`, `npm link`, or any reindex without an explicit
  ask. All three are user-gated in this repo.
- Migrations ship as a `.ts` exporting the SQL string **and** a mirrored `.sql`
  file with identical content. Keep both in sync; register in
  `DATABASE_MIGRATIONS`.

## Vocabulary

Two names address one collection, and confusing them is the bug:

| Name                          | tea-rags self-index | Addresses                                      |
| ----------------------------- | ------------------- | ---------------------------------------------- |
| alias (`collectionName`)      | `code_8b243ffe`     | snapshot, stats, quarantine, orphan-sweep base |
| physical (`targetCollection`) | `code_8b243ffe_v52` | Qdrant points, marker, codegraph DB and spills |

---

### Task 1: `ReindexContext` carries the physical collection name

**Files:**

- Modify: `src/core/domains/ingest/operations/reindexing.ts:30-36`
  (`ReindexContext`), `:195-217` (`prepareReindexContext`)
- Test: `tests/core/domains/ingest/operations/reindex-target-collection.test.ts`

**Interfaces:**

- Consumes: `QdrantManager.aliases.listAliases()` and
  `QdrantManager.aliases.isAlias(name)`, already used by
  `IndexPipeline.setupCollection`
  (`src/core/domains/ingest/operations/indexing.ts:242-245`).
- Produces: `ReindexContext.targetCollection: string` — the physical, versioned
  collection name. Equals `collectionName` when the collection is not an alias
  (the migration case). Tasks 2 and 6 read this field.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

import { ReindexPipeline } from "../../../../../src/core/domains/ingest/operations/reindexing.js";

/**
 * Invariant: the incremental path resolves the SAME physical collection the
 * force path would, so versioned artifacts (codegraph DuckDB above all) are
 * addressed by the versioned name and not by the alias.
 */
describe("ReindexPipeline target collection resolution", () => {
  it("resolves an alias to its active versioned collection", async () => {
    const pipeline = makePipeline({
      isAlias: true,
      aliases: [{ aliasName: "code_x", collectionName: "code_x_v52" }],
    });

    const ctx = await pipeline.exposeContextForTest("/repo", "code_x");

    expect(ctx.collectionName).toBe("code_x");
    expect(ctx.targetCollection).toBe("code_x_v52");
  });

  it("falls back to the literal name when the collection is not an alias", async () => {
    const pipeline = makePipeline({ isAlias: false, aliases: [] });

    const ctx = await pipeline.exposeContextForTest("/repo", "code_x");

    expect(ctx.targetCollection).toBe("code_x");
  });
});
```

`makePipeline` builds a `ReindexPipeline` with a stubbed `QdrantManager` whose
`collectionExists` returns true, `aliases.isAlias` returns the flag, and
`aliases.listAliases` returns the array; `createSynchronizer` returns a stub
whose `initialize()` resolves true. Mirror the stub shape already used in
`tests/core/domains/ingest/operations/`. Reuse it; do not invent a new one.
`exposeContextForTest` does not exist yet; expose `prepareReindexContext` for
the test by making it `protected` and calling it from a tiny test subclass
rather than adding production API.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/operations/reindex-target-collection.test.ts`
Expected: FAIL — `ctx.targetCollection` is `undefined`.

- [ ] **Step 3: Add the field and resolve it**

In `ReindexContext`:

```typescript
interface ReindexContext {
  absolutePath: string;
  /** Stable Qdrant alias — addresses snapshot, stats cache and quarantine. */
  collectionName: string;
  /**
   * Physical, versioned collection the alias points at. Addresses everything
   * opened by literal name — above all the codegraph DuckDB file, which the
   * pool resolves with `pathFor()` and never expands an alias for. Equals
   * `collectionName` when the collection is not an alias.
   */
  targetCollection: string;
  synchronizer: ParallelFileSynchronizer;
  scanner: FileScanner;
  currentFiles: string[];
}
```

In `prepareReindexContext`, after the `exists` guard and before `runMigrations`:

```typescript
const isAlias = await this.qdrant.aliases.isAlias(collectionName);
const targetCollection = isAlias
  ? ((await this.qdrant.aliases.listAliases()).find(
      (a) => a.aliasName === collectionName,
    )?.collectionName ?? collectionName)
  : collectionName;
```

and return it:

```typescript
return {
  absolutePath,
  collectionName,
  targetCollection,
  synchronizer,
  scanner,
  currentFiles,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/operations/reindex-target-collection.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the surrounding suite**

Run: `npx vitest run tests/core/domains/ingest/operations/` Expected: PASS, no
regressions.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/operations/reindexing.ts tests/core/domains/ingest/operations/reindex-target-collection.test.ts
git commit -m "fix(ingest): resolve the physical collection in ReindexContext (6goqa)"
```

---

### Task 2: Route versioned artifacts through `targetCollection`

**Files:**

- Modify: `src/core/domains/ingest/operations/reindexing.ts` — the
  `ctx.collectionName` use sites at `:147`, `:156`, `:164`, `:313`, `:331`,
  `:355`, `:429`, `:440`, `:544`
- Test:
  `tests/core/domains/ingest/operations/reindex-artifact-addressing.test.ts`

**Interfaces:**

- Consumes: `ReindexContext.targetCollection` from Task 1.
- Produces: nothing new. This task only changes which string reaches which
  callee.

The classification, which the test pins:

| Use site               | Callee                               | Name     |
| ---------------------- | ------------------------------------ | -------- |
| `:142`                 | `new QuarantineStore(...)`           | alias    |
| `:147`, `:156`         | `storeIndexingMarker`                | physical |
| `:164`                 | `this.startHeartbeat`                | physical |
| `:313`, `:331`         | `pauseOptimizer` / `resumeOptimizer` | physical |
| `:355`, `:429`, `:544` | pipeline / enrichment run            | physical |
| `:440`                 | `enrichment.notifyDeletions`         | physical |
| `:102`, `:104`         | `cleanupOrphanedVersions` / sweep    | alias    |
| `:204`, `:220`         | `runMigrations` / `createMigrator`   | alias    |

The two `alias` rows at the bottom take the stable base name on purpose: the
sweeps derive `<base>_vN` from it, and the snapshot-and-schema migration sweep
is keyed by the name that survives version bumps.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

/**
 * Invariant: for one logical collection, artifacts that are versioned are
 * addressed by the physical name and artifacts that must survive version bumps
 * are addressed by the alias. Asserted on the INCREMENTAL path; Task 2b asserts
 * the same table on the force path.
 */
describe("incremental reindex artifact addressing", () => {
  it("addresses enrichment and the indexing marker by the physical collection", async () => {
    const seen = {
      enrichment: [] as string[],
      marker: [] as string[],
      quarantine: [] as string[],
    };
    const pipeline = makePipelineRecording(seen, {
      aliases: [{ aliasName: "code_x", collectionName: "code_x_v52" }],
    });

    await pipeline.reindexChanges("/repo");

    expect(seen.enrichment).toEqual(["code_x_v52"]);
    expect(seen.marker).toEqual(["code_x_v52"]);
    expect(seen.quarantine).toEqual(["code_x"]);
  });
});
```

`makePipelineRecording` stubs the enrichment coordinator, `storeIndexingMarker`
and `QuarantineStore` constructor, pushing the collection string each receives
into `seen`. Drive one added file through so the pipeline reaches the enrichment
call rather than the no-changes early return at `:146`.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/operations/reindex-artifact-addressing.test.ts`
Expected: FAIL — `seen.enrichment` is `["code_x"]`, the alias.

- [ ] **Step 3: Swap the use sites**

Replace `ctx.collectionName` with `ctx.targetCollection` at exactly the nine
lines listed in the table above. Leave `:142`, `:102`, `:104`, `:204` and `:220`
untouched. Do not use a blanket find-and-replace. The split is the point of the
change, and both names remain live in this file.

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/operations/reindex-artifact-addressing.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the ingest suite**

Run: `npx vitest run tests/core/domains/ingest/` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/operations/reindexing.ts tests/core/domains/ingest/operations/reindex-artifact-addressing.test.ts
git commit -m "fix(ingest): address versioned artifacts by the physical collection on the incremental path (6goqa)"
```

---

### Task 2b: Pin the same addressing table on the force path

**Files:**

- Test: `tests/core/domains/ingest/operations/index-artifact-addressing.test.ts`
- Modify: none expected. If the force path disagrees with the table, fix the
  force path. Do not weaken the test.

**Interfaces:**

- Consumes: `SetupResult.targetCollection`
  (`src/core/domains/ingest/operations/indexing.ts:311`).
- Produces: nothing.

The asymmetry between the two pipelines is what produced this defect, so the
table is asserted on both. This task exists separately because it can pass
without any production change, and a reviewer must be able to approve it alone.

- [ ] **Step 1: Write the test**

```typescript
describe("force reindex artifact addressing", () => {
  it("addresses enrichment and the indexing marker by the versioned collection", async () => {
    const seen = {
      enrichment: [] as string[],
      marker: [] as string[],
      snapshot: [] as string[],
    };
    const pipeline = makeIndexPipelineRecording(seen);

    await pipeline.indexCodebase("/repo", { forceReindex: true });

    expect(seen.enrichment).toEqual(["code_x_v1"]);
    expect(seen.marker).toEqual(["code_x_v1"]);
    expect(seen.snapshot).toEqual(["code_x"]);
  });
});
```

- [ ] **Step 2: Run it**

Run:
`npx vitest run tests/core/domains/ingest/operations/index-artifact-addressing.test.ts`
Expected: PASS. A failure here means the force path also drifted. Fix the
production code, then re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/core/domains/ingest/operations/index-artifact-addressing.test.ts
git commit -m "test(ingest): pin the artifact-to-collection-name table on the force path (6goqa)"
```

---

### Task 3: Persist a per-file content hash in the graph

**Files:**

- Create:
  `src/core/domains/maintenance/migration/database/migrations/017-cg-symbols-files-content-hash.ts`
- Create:
  `src/core/domains/maintenance/migration/database/migrations/017-cg-symbols-files-content-hash.sql`
- Modify: `src/core/domains/maintenance/migration/database/migrations/index.ts`
- Modify: `src/core/contracts/types/codegraph.ts:1549-1552` (`GraphFileNode`)
- Modify: `src/core/adapters/duckdb/client.ts:447-450` (`upsertFileRows`)
- Test: `tests/core/adapters/duckdb/content-hash-column.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `GraphFileNode.contentHash?: string`; column
  `cg_symbols_files.content_hash VARCHAR` (nullable, no default). Task 5 reads
  the column, Task 6 compares it.

This file has the highest transitive impact in the change set (6), so it gets a
task of its own with an explicit round-trip test.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";

describe("cg_symbols_files.content_hash", () => {
  it("round-trips the hash written with a file node", async () => {
    const client = await openTempGraphClient(); // existing helper in tests/core/adapters/duckdb/

    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript", contentHash: "abc123" },
      { fileEdges: [], methodEdges: [] },
    );

    const rows = await client.queryAll<{
      rel_path: string;
      content_hash: string | null;
    }>("SELECT rel_path, content_hash FROM cg_symbols_files");
    expect(rows).toEqual([{ rel_path: "src/a.ts", content_hash: "abc123" }]);
  });

  it("stores NULL when the node carries no hash", async () => {
    const client = await openTempGraphClient();

    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [] },
    );

    const rows = await client.queryAll<{ content_hash: string | null }>(
      "SELECT content_hash FROM cg_symbols_files WHERE rel_path = 'src/b.ts'",
    );
    expect(rows[0].content_hash).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/content-hash-column.test.ts`
Expected: FAIL — `Binder Error: Referenced column "content_hash" not found`.

- [ ] **Step 3: Add the migration**

`017-cg-symbols-files-content-hash.ts`:

```typescript
/**
 * Codegraph schema — per-file content hash on `cg_symbols_files` (bd
 * tea-rags-mcp-6goqa).
 *
 * `cg_symbols_files` held only `(rel_path, language)`, so the graph could tell
 * whether a file was PRESENT but not whether its rows were CURRENT. The repair
 * check diffs this column against the SHA256 the snapshot already stores per
 * file. Nullable with no default: existing rows read as NULL, which the repair
 * check treats as "unknown, therefore re-extract".
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_017_CG_SYMBOLS_FILES_CONTENT_HASH = `
ALTER TABLE cg_symbols_files ADD COLUMN IF NOT EXISTS content_hash VARCHAR;
`;
```

`017-cg-symbols-files-content-hash.sql`:

```sql
-- Codegraph schema — per-file content hash on cg_symbols_files (bd tea-rags-mcp-6goqa).
-- cg_symbols_files held only (rel_path, language), so the graph could tell whether a
-- file was PRESENT but not whether its rows were CURRENT. The repair check diffs this
-- column against the SHA256 the snapshot already stores per file. Nullable with no
-- default: existing rows read as NULL, which the repair check treats as "unknown,
-- therefore re-extract".
-- Mirrors 017-cg-symbols-files-content-hash.ts — keep in sync.
ALTER TABLE cg_symbols_files ADD COLUMN IF NOT EXISTS content_hash VARCHAR;
```

Register in `migrations/index.ts`: add the import next to the `016` import and
append to `DATABASE_MIGRATIONS`:

```typescript
  { filename: "017-cg-symbols-files-content-hash.sql", sql: SQL_017_CG_SYMBOLS_FILES_CONTENT_HASH },
```

- [ ] **Step 4: Widen the node type and the write**

`GraphFileNode` in `src/core/contracts/types/codegraph.ts`:

```typescript
export interface GraphFileNode {
  relPath: RelPath;
  language: string;
  /**
   * SHA256 of the file's contents at extraction time, sourced from the ingest
   * snapshot. Undefined when the caller has no hash (direct/test writes), which
   * persists as NULL and makes the repair check re-extract the file.
   */
  contentHash?: string;
}
```

`upsertFileRows` in `src/core/adapters/duckdb/client.ts`:

```typescript
await this.run(
  "INSERT OR REPLACE INTO cg_symbols_files (rel_path, language, content_hash) VALUES (?, ?, ?)",
  [node.relPath, node.language, node.contentHash ?? null],
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/duckdb/content-hash-column.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the adapter suite**

Run: `npx vitest run tests/core/adapters/duckdb/` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/maintenance/migration/database/migrations/ \
        src/core/contracts/types/codegraph.ts \
        src/core/adapters/duckdb/client.ts \
        tests/core/adapters/duckdb/content-hash-column.test.ts
git commit -m "feat(contracts): persist per-file content hash on cg_symbols_files (6goqa)"
```

---

### Task 4: Expose the run's per-file hashes

**Files:**

- Modify: `src/core/domains/ingest/sync/parallel-synchronizer.ts`
- Test: `tests/core/domains/ingest/sync/current-file-hashes.test.ts`

**Interfaces:**

- Consumes: the synchronizer's existing `lastComputedHashes` cache and the
  snapshot's per-file `{ mtime, size, hash }` metadata
  (`sync/snapshot/snapshot.ts:26`).
- Produces:
  `ParallelFileSynchronizer.getCurrentFileHashes(): Map<string, string>` —
  relative path to SHA256, covering every file of the current scan. Task 6
  consumes it.

The hashes already exist; nothing is re-read from disk. Changed files come from
`lastComputedHashes` (computed during `detectChanges`), unchanged ones from the
snapshot the synchronizer loaded.

- [ ] **Step 1: Write the failing test**

```typescript
describe("ParallelFileSynchronizer.getCurrentFileHashes", () => {
  it("merges freshly computed hashes over snapshot hashes", async () => {
    const sync = await makeSynchronizerWithSnapshot({
      "src/a.ts": "hash-a-old",
      "src/b.ts": "hash-b",
    });
    await sync.detectChanges(["src/a.ts", "src/b.ts"], {
      "src/a.ts": "hash-a-new",
    });

    expect(sync.getCurrentFileHashes()).toEqual(
      new Map([
        ["src/a.ts", "hash-a-new"],
        ["src/b.ts", "hash-b"],
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/sync/current-file-hashes.test.ts`
Expected: FAIL — `sync.getCurrentFileHashes is not a function`.

- [ ] **Step 3: Implement the accessor**

```typescript
  /**
   * Per-file SHA256 for every file of the current scan: freshly computed hashes
   * from the last `detectChanges` layered over the snapshot's stored hashes.
   * Read-only view — no disk access, no recomputation. Consumed by the codegraph
   * repair check (bd tea-rags-mcp-6goqa).
   */
  getCurrentFileHashes(): Map<string, string> {
    const merged = new Map<string, string>();
    for (const [path, meta] of this.snapshotFileMetadata()) merged.set(path, meta.hash);
    for (const [path, hash] of this.lastComputedHashes) merged.set(path, hash);
    return merged;
  }
```

Use whatever accessor the class already has for snapshot metadata; if it is
private, keep `snapshotFileMetadata()` private too and call it directly. Do not
widen the public surface beyond `getCurrentFileHashes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/ingest/sync/current-file-hashes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/sync/parallel-synchronizer.ts tests/core/domains/ingest/sync/current-file-hashes.test.ts
git commit -m "feat(ingest): expose the run's per-file content hashes (6goqa)"
```

---

### Task 5: Providers can report the hashes they persisted

**Files:**

- Modify: `src/core/contracts/types/provider.ts` (near the other optional
  provider methods, `:358-499`)
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/read-persisted-file-hashes.test.ts`

**Interfaces:**

- Consumes: `GraphDbClientPool.acquireReader(collectionName)` and the
  `content_hash` column from Task 3.
- Produces:
  `EnrichmentProvider.readPersistedFileHashes?: (collectionName: string) => Promise<Map<string, string | null>>`,
  implemented by `CodegraphEnrichmentProvider`. Task 6 consumes it. The value is
  `null` for a row whose hash was never written.

Optional provider capability, exactly like `finalizeSignals`,
`beginExtractionRun`, `endExtractionRun` and `defersChunkEnrichment`. The git
provider does not implement it and must not be changed.

- [ ] **Step 1: Write the failing test**

```typescript
describe("CodegraphEnrichmentProvider.readPersistedFileHashes", () => {
  it("returns the persisted rel_path to content_hash map, NULL included", async () => {
    const { provider, client } = await makeProviderWithTempDb();
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript", contentHash: "h1" },
      EMPTY_EDGES,
    );
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      EMPTY_EDGES,
    );

    const hashes = await provider.readPersistedFileHashes("code_x_v1");

    expect(hashes).toEqual(
      new Map([
        ["src/a.ts", "h1"],
        ["src/b.ts", null],
      ]),
    );
  });

  it("returns an empty map when the collection has no graph yet", async () => {
    const { provider } = await makeProviderWithTempDb();

    expect(
      await provider.readPersistedFileHashes("code_never_indexed"),
    ).toEqual(new Map());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/read-persisted-file-hashes.test.ts`
Expected: FAIL — `provider.readPersistedFileHashes is not a function`.

- [ ] **Step 3: Declare the optional capability**

In `src/core/contracts/types/provider.ts`, beside the other optional methods:

```typescript
  /**
   * Per-file content hashes this provider has persisted for `collectionName`,
   * as `relPath -> hash`, with `null` for a row written before the hash column
   * existed. The coordinator diffs this against the run's eligible files to
   * decide which files must be re-extracted (bd tea-rags-mcp-6goqa). Optional:
   * a provider that keeps no per-file store simply omits it, and the coordinator
   * skips the repair pass for that provider.
   */
  readPersistedFileHashes?: (collectionName: string) => Promise<Map<string, string | null>>;
```

- [ ] **Step 4: Implement it on the codegraph provider**

```typescript
  async readPersistedFileHashes(collectionName: string): Promise<Map<string, string | null>> {
    const handle = await this.deps.pool.acquireReader(collectionName);
    try {
      const rows = await handle.graphDb.queryAll<{ rel_path: string; content_hash: string | null }>(
        "SELECT rel_path, content_hash FROM cg_symbols_files",
      );
      return new Map(rows.map((r) => [r.rel_path, r.content_hash]));
    } finally {
      await handle.graphDb.close();
    }
  }
```

Match the acquire-query-close shape `GraphFacade.withReadHandle` uses; a
pool-level acquire failure must yield an empty map, not throw, so a project with
no graph yet is treated as "everything needs extraction".

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/read-persisted-file-hashes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/contracts/types/provider.ts src/core/domains/trajectory/codegraph/symbols/provider.ts tests/core/domains/trajectory/codegraph/symbols/read-persisted-file-hashes.test.ts
git commit -m "feat(contracts): optional readPersistedFileHashes provider capability (6goqa)"
```

---

### Task 6: Compute and run the repair set

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/extraction-repair.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/extraction-repair.test.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/repair-pass.test.ts`

**Interfaces:**

- Consumes: `getCurrentFileHashes()` (Task 4), `readPersistedFileHashes()` (Task
  5), `ReindexContext.targetCollection` (Task 1).
- Produces:
  `computeExtractionRepair(eligible: Map<string, string>, persisted: Map<string, string | null>): ExtractionRepair`
  where `interface ExtractionRepair { repair: string[]; orphans: string[] }`.

A pure function because it needs no collaborators: two maps in, two lists out.
That is also what makes the exactness invariant cheap to assert.

- [ ] **Step 1: Write the failing test for the pure function**

```typescript
import { describe, expect, it } from "vitest";

import { computeExtractionRepair } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/extraction-repair.js";

describe("computeExtractionRepair", () => {
  it("is empty when the graph matches the eligible set", () => {
    const eligible = new Map([["src/a.ts", "h1"]]);
    const persisted = new Map([["src/a.ts", "h1"]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({
      repair: [],
      orphans: [],
    });
  });

  it("repairs files missing from the graph", () => {
    const eligible = new Map([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
    ]);
    const persisted = new Map([["src/a.ts", "h1"]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({
      repair: ["src/b.ts"],
      orphans: [],
    });
  });

  it("repairs files whose hash drifted", () => {
    const eligible = new Map([["src/a.ts", "h2"]]);
    const persisted = new Map([["src/a.ts", "h1"]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({
      repair: ["src/a.ts"],
      orphans: [],
    });
  });

  it("treats a NULL persisted hash as unknown and repairs it", () => {
    const eligible = new Map([["src/a.ts", "h1"]]);
    const persisted = new Map([["src/a.ts", null]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({
      repair: ["src/a.ts"],
      orphans: [],
    });
  });

  it("reports graph rows that are no longer eligible as orphans", () => {
    const eligible = new Map([["src/a.ts", "h1"]]);
    const persisted = new Map([
      ["src/a.ts", "h1"],
      ["src/gone.ts", "h9"],
    ]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({
      repair: [],
      orphans: ["src/gone.ts"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/extraction-repair.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure function**

```typescript
/**
 * Which files a provider must re-extract before its graph matches the code, and
 * which of its rows no longer belong (bd tea-rags-mcp-6goqa).
 *
 * `repair` = eligible files absent from the graph, plus eligible files whose
 * persisted hash differs from the current one. A persisted `null` — a row
 * written before the hash column existed — counts as a difference, because
 * "assume it is current" is the assumption that hid the shadow-DB bug.
 *
 * `orphans` = rows for files that are no longer eligible (deleted, or excluded
 * after a config change). Both lists empty means the graph matches the code.
 */
export interface ExtractionRepair {
  repair: string[];
  orphans: string[];
}

export function computeExtractionRepair(
  eligible: Map<string, string>,
  persisted: Map<string, string | null>,
): ExtractionRepair {
  const repair: string[] = [];
  for (const [path, hash] of eligible) {
    const known = persisted.get(path);
    if (known === undefined || known === null || known !== hash)
      repair.push(path);
  }
  const orphans: string[] = [];
  for (const path of persisted.keys()) {
    if (!eligible.has(path)) orphans.push(path);
  }
  return { repair, orphans };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/extraction-repair.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for the coordinator pass**

```typescript
describe("enrichment repair pass", () => {
  it("re-extracts exactly the repair set and deletes orphan rows", async () => {
    const extracted: string[] = [];
    const deleted: string[] = [];
    const eligible = new Map([
      ["src/a.ts", "new"],
      ["src/b.ts", "h2"],
    ]);
    const coordinator = makeCoordinator({
      provider: {
        key: "codegraph.symbols",
        readPersistedFileHashes: async () =>
          new Map([
            ["src/a.ts", "old"],
            ["src/gone.ts", "h"],
          ]),
        notifyDeletions: async (paths: string[]) => void deleted.push(...paths),
      },
      onExtract: (p: string) => extracted.push(p),
    });

    await coordinator.runRepairPass("code_x_v52", eligible);

    expect(extracted.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(deleted).toEqual(["src/gone.ts"]);
  });

  it("extracts nothing when the graph already matches", async () => {
    const extracted: string[] = [];
    const eligible = new Map([["src/a.ts", "h1"]]);
    const coordinator = makeCoordinator({
      provider: {
        key: "codegraph.symbols",
        readPersistedFileHashes: async () => new Map([["src/a.ts", "h1"]]),
      },
      onExtract: (p: string) => extracted.push(p),
    });

    await coordinator.runRepairPass("code_x_v52", eligible);

    expect(extracted).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/repair-pass.test.ts`
Expected: FAIL — `coordinator.runRepairPass is not a function`.

- [ ] **Step 7: Wire the pass into the coordinator**

Add to `EnrichmentCoordinator`, called by `ReindexPipeline` after
`prepareReindexContext` and before the enrichment run, with
`ctx.targetCollection` and `ctx.synchronizer.getCurrentFileHashes()`:

```typescript
  /**
   * Bring each provider's per-file store back in line with the code before the
   * run's own enrichment starts (bd tea-rags-mcp-6goqa). Silent by design: a
   * repair surfaces as extra time, not as a message. Providers without
   * `readPersistedFileHashes` are skipped.
   */
  async runRepairPass(collectionName: string, eligible: Map<string, string>): Promise<void> {
    for (const ctx of this.contexts.values()) {
      const read = ctx.provider.readPersistedFileHashes;
      if (!read) continue;
      const persisted = await read.call(ctx.provider, collectionName);
      const { repair, orphans } = computeExtractionRepair(eligible, persisted);
      if (orphans.length > 0) await ctx.provider.notifyDeletions?.(orphans, collectionName);
      for (const relPath of repair) this.enqueueForExtraction(relPath, collectionName);
    }
  }
```

`enqueueForExtraction` routes through the same `onFileExtraction` seam the
normal pass uses. Do not add a second extraction path.

The caller in `ReindexPipeline` builds `eligible` from the two pieces that
already exist, with no new filtering logic:

```typescript
const hashes = ctx.synchronizer.getCurrentFileHashes();
const eligiblePaths = filterFileEnrichPaths(
  codegraphProvider,
  ctx.currentFiles,
);
const eligible = new Map(eligiblePaths.map((p) => [p, hashes.get(p) ?? ""]));
await this.enrichment.runRepairPass(ctx.targetCollection, eligible);
```

`filterFileEnrichPaths` is the existing helper in
`src/core/domains/ingest/pipeline/enrichment/policy.ts:39`. It drops every path
the provider declines (`shouldEnrich` returning `"none"`), which is how
`excludeTests`, the custom exclude patterns and the generated/docs policy
already reach every other file-level dispatch site. A path with no hash maps to
`""`, which never equals a persisted hash and therefore repairs.

- [ ] **Step 8: Run both tests**

Run: `npx vitest run tests/core/domains/ingest/pipeline/enrichment/` Expected:
PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/ tests/core/domains/ingest/pipeline/enrichment/
git commit -m "feat(ingest): repair the codegraph when it no longer matches the code (6goqa)"
```

---

### Task 7: Orphan sweep reclaims shadow databases

**Files:**

- Modify: `src/core/adapters/duckdb/pool.ts:231-259` (`listCollectionDbNames`)
- Test: `tests/core/adapters/duckdb/list-collection-db-names.test.ts`
- Test: `tests/core/domains/ingest/infra/sweep-shadow-db.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `listCollectionDbNames(base)` additionally returns `base` itself
  when `<base>.duckdb` exists on disk. `sweepCodegraphOrphans`
  (`src/core/domains/ingest/infra/alias-cleanup.ts:77-106`) needs no change: it
  already skips the active alias target and any name backed by a live Qdrant
  collection, so a genuinely unversioned project keeps its DB while a shadow
  left beside an alias is reclaimed.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("GraphDbClientPool.listCollectionDbNames", () => {
  it("returns versioned DBs and the unversioned shadow", async () => {
    const pool = makePoolWithFiles([
      "code_x.duckdb",
      "code_x_v1.duckdb",
      "code_x_v2.duckdb",
      "code_y_v1.duckdb",
    ]);

    expect(pool.listCollectionDbNames("code_x").sort()).toEqual([
      "code_x",
      "code_x_v1",
      "code_x_v2",
    ]);
  });

  it("ignores WAL and spill sidecars", async () => {
    const pool = makePoolWithFiles([
      "code_x.duckdb",
      "code_x.duckdb.wal",
      "code_x_v1.duckdb.wal",
    ]);

    expect(pool.listCollectionDbNames("code_x")).toEqual(["code_x"]);
  });
});

describe("sweepCodegraphOrphans", () => {
  it("removes the shadow DB left beside a live alias", async () => {
    const removed: string[] = [];
    await sweepCodegraphOrphans(
      qdrantWith({
        aliases: [{ aliasName: "code_x", collectionName: "code_x_v52" }],
        collections: ["code_x_v52"],
      }),
      "code_x",
      () => ["code_x", "code_x_v52"],
      async (db) => void removed.push(db),
    );

    expect(removed).toEqual(["code_x"]);
  });

  it("keeps the DB of an unversioned, non-aliased collection", async () => {
    const removed: string[] = [];
    await sweepCodegraphOrphans(
      qdrantWith({ aliases: [], collections: ["code_x"] }),
      "code_x",
      () => ["code_x"],
      async (db) => void removed.push(db),
    );

    expect(removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run:
`npx vitest run tests/core/adapters/duckdb/list-collection-db-names.test.ts tests/core/domains/ingest/infra/sweep-shadow-db.test.ts`
Expected: FAIL — the lister omits `code_x`, so the sweep never sees the shadow.

- [ ] **Step 3: Widen the pattern**

```typescript
const pattern = new RegExp(`^(${escapeRegExp(base)}(?:_v\\d+)?)\\.duckdb$`);
```

Update the method's docblock: it now enumerates the versioned DBs **and** the
unversioned base file, the latter being the shadow this bug produced. The
sweep's own guards keep a legitimately unversioned collection safe.

- [ ] **Step 4: Run them to verify they pass**

Run:
`npx vitest run tests/core/adapters/duckdb/list-collection-db-names.test.ts tests/core/domains/ingest/infra/sweep-shadow-db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/duckdb/pool.ts tests/core/adapters/duckdb/list-collection-db-names.test.ts tests/core/domains/ingest/infra/sweep-shadow-db.test.ts
git commit -m "fix(adapters): let the orphan sweep reclaim shadow codegraph databases (6goqa)"
```

---

### Task 8: Path-identity invariant

**Files:**

- Test: `tests/core/adapters/duckdb/collection-path-identity.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

This is the regression guard for the whole bug, and the last task deliberately:
it is meaningful only once Tasks 1, 2 and 7 have landed.

- [ ] **Step 1: Write the test**

```typescript
/**
 * Invariant: one logical collection resolves to one DuckDB file, whichever
 * direction you approach it from. The write path (ingest, via
 * ReindexContext.targetCollection) and the read path (GraphFacade, via
 * resolveActiveCollection) must land on the same path.
 */
describe("collection path identity", () => {
  it("write and read resolve the same DuckDB path for an aliased collection", async () => {
    const aliases = [{ aliasName: "code_x", collectionName: "code_x_v52" }];
    const pool = makePool();

    const writePath = pool.pathFor(await resolveWriteTarget("code_x", aliases));
    const readPath = pool.pathFor(
      await resolveActiveCollection("code_x", aliases),
    );

    expect(writePath).toBe(readPath);
  });

  it("never creates an unversioned DB for a live alias", async () => {
    const { pool, dir } = makePoolOnTempDir();
    const aliases = [{ aliasName: "code_x", collectionName: "code_x_v52" }];

    await pool
      .acquireWrite(await resolveWriteTarget("code_x", aliases))
      .then((h) => h.graphDb.close());

    expect(readdirSync(dir)).not.toContain("code_x.duckdb");
  });
});
```

`resolveWriteTarget` is the resolution Task 1 added; import it from wherever
Task 1 placed it rather than re-implementing the alias lookup in the test.

- [ ] **Step 2: Run it**

Run:
`npx vitest run tests/core/adapters/duckdb/collection-path-identity.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full suite and the coverage gate**

Run: `npx vitest run` Expected: PASS, no regressions.

Run: `npm run test:coverage` Expected: thresholds met. If coverage falls below a
threshold, delegate to the `coverage-expander` agent (`Agent` tool,
`subagent_type: "coverage-expander"`, `run_in_background: true`). Do not lower
the threshold.

- [ ] **Step 4: Commit**

```bash
git add tests/core/adapters/duckdb/collection-path-identity.test.ts
git commit -m "test(adapters): pin one-collection-one-database path identity (6goqa)"
```

---

## Acceptance (user-gated, not part of the code tasks)

Building, linking and reindexing are all user-gated in this repo. When the user
asks for them, in this order:

1. `npm run build && npm link` from this worktree, always as one unit.
2. Ask the user to reconnect MCP servers, and wait.
3. `DEBUG=1 tea-rags index-codebase --project tea-rags --wait-enrichments --json`
4. Check all three, and report the raw values rather than a verdict:
   - `~/.tea-rags/codegraph/code_8b243ffe.duckdb` is gone (Task 7 swept it) and
     `code_8b243ffe_v52.duckdb` has a fresh mtime.
   - `find_cycles(project: "tea-rags", scope: "file")` returns no
     `metrics ↔ extractors` cycle.
   - `get_index_status` reports `codegraph.symbols` file and chunk healthy.

The first run is expected to take noticeably longer than a normal incremental
reindex: every existing row has a NULL `content_hash`, so the repair set is the
whole eligible file set once. That is the accepted cost of the design, not a
regression.

## Beads

Create the epic and one task per plan Task before execution starts, per
`.claude/rules/.local/plan-beads-sync.md`. Titles match the plan Task titles
1:1. Label the epic and every task `architecture`; also label Tasks 1, 2, 2b and
7 `bugfix`, and Tasks 3–6 `api`. Link every task to the epic with
`bd dep add <task> <epic>`, and link the epic to `tea-rags-mcp-6goqa`.
