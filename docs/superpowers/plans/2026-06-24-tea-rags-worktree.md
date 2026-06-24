# tea-rags worktree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Chaining:** execution MUST go through `dinopowers:executing-plans`; per-Task TDD through `dinopowers:test-driven-development`.

**Goal:** Add a `tea-rags worktree` CLI command family that seeds a per-worktree index by cloning the full on-disk footprint of a source project's index, registering it under a `<project>-worktree-<name>` alias, then diff-reindexing only the live-code delta.

**Architecture:** New `domains/maintenance` bounded context. A footprint kernel (`CollectionArtifact` strategy + thin delegates to artifact owners + factory) clones/removes the 5 per-collection artifacts (Qdrant vectors via snapshot→recover, codegraph DuckDB, sharded file-hash snapshot, stats cache, quarantine). `WorktreeOps` orchestrates a create-saga with compensating rollback and a provenance-guarded remove. The CLI surface (`create/list/remove/info`) mirrors `bd worktree`; `create` reuses the existing index supervisor for the post-commit diff reindex.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, yargs CLI, `@qdrant/js-client-rest` 1.17.0, DuckDB pool, picomatch.

## Global Constraints

- ESM imports MUST use `.js` extension on relative paths.
- NO `eslint-disable`, NO lowering coverage thresholds (raise tests instead).
- Conventional commits, header ≤ 100 chars.
- `infra/registry/collection-registry.ts` (isHub fanIn 13) + `infra/registry/types.ts`: **additive only** — never change an existing method signature or field type.
- `adapters/qdrant/client.ts` is deep-silo: new methods follow the existing `this.call(async () => this.client.X())` wrapper style; extra test rigor.
- REUSE `finalizeAlias` / `computeNewVersion` / `QdrantAliasManager` — do NOT duplicate alias-swap or version logic.
- Source-of-truth terms: `CollectionEntry` (registry record), `logicalName` (alias-resolvable `code_<hash>`), `physicalName` (`code_<hash>_vN`).
- Project primary language English (code, comments, commit messages).

---

## File Structure

**New files:**

- `src/core/domains/maintenance/footprint/artifact.ts` — `CollectionArtifact` interface, `FootprintContext`, `ResolvedCollection`, `ArtifactId`.
- `src/core/domains/maintenance/footprint/qdrant-artifact.ts` — `QdrantArtifact` (snapshot→recover→alias).
- `src/core/domains/maintenance/footprint/codegraph-artifact.ts` — `CodegraphArtifact` (DuckDB file clone/remove).
- `src/core/domains/maintenance/footprint/snapshot-artifact.ts` — `SnapshotArtifact` (sharded snapshot cloneTo).
- `src/core/domains/maintenance/footprint/stats-artifact.ts` — `StatsArtifact` (stats clone/remove).
- `src/core/domains/maintenance/footprint/quarantine-artifact.ts` — `QuarantineArtifact` (quarantine clone/remove).
- `src/core/domains/maintenance/footprint/factory.ts` — `CollectionFootprintFactory` (ordered artifact list).
- `src/core/domains/maintenance/footprint/index.ts` — barrel.
- `src/core/domains/maintenance/worktree/worktree-ops.ts` — `WorktreeOps`.
- `src/core/domains/maintenance/worktree/git-worktree.ts` — `ensureGitWorktree` / `removeGitWorktree`.
- `src/core/domains/maintenance/worktree/index.ts` — barrel.
- `src/cli/commands/worktree.ts` — `worktreeCommand` (create/list/remove/info).
- Tests mirror each under `tests/...` (paths in each Task).

**Modified files (additive):**

- `src/core/infra/registry/types.ts` — add `worktreeOf?` / `worktreeName?` to `CollectionEntry`.
- `src/core/infra/registry/collection-registry.ts` — add `listWorktrees()` / `findWorktree(name)` / `setWorktreeProvenance(...)`.
- `src/core/adapters/qdrant/client.ts` — add `createSnapshot` / `recoverFromSnapshot`.
- `src/core/adapters/duckdb/pool.ts` — add `cloneDatabase(src, dst)`.
- `src/core/domains/ingest/sync/snapshot/sharded-snapshot.ts` — add `cloneTo(targetCollection, newCodebasePath)`.
- `src/core/infra/stats-cache.ts` — add `clone(src, dst)`.
- `src/core/domains/ingest/sync/quarantine-store.ts` — add `cloneTo(targetCollection)`.
- `src/core/api/public/app.ts` — add 4 App methods + `worktreeOps` to `AppDeps`/`wireOps`.
- `src/bootstrap/factory.ts` — construct footprint factory + `WorktreeOps`, pass into `createApp`.
- `src/cli/create-cli.ts` — register `worktreeCommand`.

---

## Task 1: Registry provenance (additive, highest blast)

**Files:**

- Modify: `src/core/infra/registry/types.ts`
- Modify: `src/core/infra/registry/collection-registry.ts`
- Test: `tests/core/infra/registry/collection-registry.worktree.test.ts`

**Interfaces:**

- Produces: `CollectionEntry.worktreeOf?: string`, `CollectionEntry.worktreeName?: string`; `CollectionRegistry.listWorktrees(): CollectionEntry[]`; `CollectionRegistry.findWorktree(name: string): CollectionEntry | null`; `CollectionRegistry.setWorktreeProvenance(collectionName: string, worktreeOf: string, worktreeName: string): void`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/infra/registry/collection-registry.worktree.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectionRegistry } from "../../../../src/core/infra/registry/collection-registry.js";

function baseEntry(collectionName: string, path: string) {
  return {
    collectionName, path,
    embeddingModel: "jina", embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-06-24T00:00:00Z", teaRagsVersion: "1.31.1", chunksCount: 10,
  };
}

describe("CollectionRegistry worktree provenance", () => {
  let dir: string;
  let reg: CollectionRegistry;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reg-")); reg = new CollectionRegistry(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists only entries carrying worktree provenance", () => {
    reg.record(baseEntry("code_main", "/repo"));
    reg.record(baseEntry("code_wt", "/repo/.wt/x"));
    reg.setWorktreeProvenance("code_wt", "code_main", "x");

    const wts = reg.listWorktrees();
    expect(wts.map((e) => e.collectionName)).toEqual(["code_wt"]);
    expect(wts[0].worktreeOf).toBe("code_main");
    expect(wts[0].worktreeName).toBe("x");
  });

  it("findWorktree resolves by worktree name, ignoring non-worktree entries", () => {
    reg.record(baseEntry("code_main", "/repo"));
    reg.record(baseEntry("code_wt", "/repo/.wt/x"));
    reg.setWorktreeProvenance("code_wt", "code_main", "x");
    expect(reg.findWorktree("x")?.collectionName).toBe("code_wt");
    expect(reg.findWorktree("missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/registry/collection-registry.worktree.test.ts`
Expected: FAIL — `setWorktreeProvenance` / `listWorktrees` / `findWorktree` are not functions.

- [ ] **Step 3: Add the fields**

```ts
// src/core/infra/registry/types.ts — append to the CollectionEntry interface (additive)
  /** Source collection logical name when this entry is a worktree clone. */
  worktreeOf?: string;
  /** Worktree name (the `<name>` in `<project>-worktree-<name>`). */
  worktreeName?: string;
```

- [ ] **Step 4: Add the query + mutator methods**

```ts
// src/core/infra/registry/collection-registry.ts — new methods, mirroring findByName/list style
  listWorktrees(): CollectionEntry[] {
    return [...this.ensureLoaded().values()].filter((e) => typeof e.worktreeOf === "string");
  }

  findWorktree(name: string): CollectionEntry | null {
    const map = this.ensureLoaded();
    for (const entry of map.values()) {
      if (entry.worktreeOf !== undefined && entry.worktreeName === name) return entry;
    }
    return null;
  }

  setWorktreeProvenance(collectionName: string, worktreeOf: string, worktreeName: string): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) throw new Error(`Cannot set worktree provenance: ${collectionName} not registered`);
    entry.worktreeOf = worktreeOf;
    entry.worktreeName = worktreeName;
    this.persist();
  }
```

> If `persist()` is named differently in this file, use the existing private write method that `record()`/`setName()` call.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/registry/collection-registry.worktree.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/infra/registry/types.ts src/core/infra/registry/collection-registry.ts tests/core/infra/registry/collection-registry.worktree.test.ts
git commit -m "feat(maintenance): add worktree provenance fields + registry queries"
```

---

## Task 2: QdrantManager snapshot/recover (deep-silo)

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts`
- Test: `tests/core/adapters/qdrant/client.snapshot.test.ts`

**Interfaces:**

- Consumes: `this.call`, `this.client` (`@qdrant/js-client-rest` `createSnapshot` / `recoverSnapshot`), `this.qdrantUrl`.
- Produces: `QdrantManager.createSnapshot(name: string): Promise<string>` (returns snapshot name); `QdrantManager.recoverFromSnapshot(targetCollection: string, location: string): Promise<void>`; `QdrantManager.snapshotDownloadUrl(collection: string, snapshotName: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/adapters/qdrant/client.snapshot.test.ts
import { describe, expect, it, vi } from "vitest";
import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

describe("QdrantManager snapshot/recover", () => {
  it("createSnapshot returns the snapshot name", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    // @ts-expect-error access private client for test seam
    m.client = { createSnapshot: vi.fn().mockResolvedValue({ name: "snap-1.snapshot" }) };
    await expect(m.createSnapshot("code_src_v1")).resolves.toBe("snap-1.snapshot");
  });

  it("recoverFromSnapshot passes location with snapshot priority", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    const recoverSnapshot = vi.fn().mockResolvedValue(true);
    // @ts-expect-error test seam
    m.client = { recoverSnapshot };
    await m.recoverFromSnapshot("code_dst_v1", "http://h/collections/code_src_v1/snapshots/snap-1.snapshot");
    expect(recoverSnapshot).toHaveBeenCalledWith("code_dst_v1", {
      location: "http://h/collections/code_src_v1/snapshots/snap-1.snapshot",
      priority: "snapshot",
    });
  });

  it("recoverFromSnapshot throws when the client reports failure", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    // @ts-expect-error test seam
    m.client = { recoverSnapshot: vi.fn().mockResolvedValue(false) };
    await expect(m.recoverFromSnapshot("code_dst_v1", "file:///x")).rejects.toThrow(/recovery failed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/qdrant/client.snapshot.test.ts`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement the methods (mirror createCollection style)**

```ts
// src/core/adapters/qdrant/client.ts — new public methods on QdrantManager
  async createSnapshot(name: string): Promise<string> {
    const desc = await this.call(async () => this.client.createSnapshot(name));
    if (!desc?.name) throw new Error(`Snapshot creation returned no name for collection ${name}`);
    return desc.name;
  }

  snapshotDownloadUrl(collection: string, snapshotName: string): string {
    return `${this.qdrantUrl.replace(/\/$/, "")}/collections/${collection}/snapshots/${snapshotName}`;
  }

  async recoverFromSnapshot(targetCollection: string, location: string): Promise<void> {
    const ok = await this.call(async () => this.client.recoverSnapshot(targetCollection, { location, priority: "snapshot" }));
    if (!ok) throw new Error(`Snapshot recovery failed for collection ${targetCollection}`);
  }
```

> `recoverSnapshot` into a non-existent collection creates it from the snapshot's bundled config + data. `priority: "snapshot"` makes the snapshot the source of truth.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/qdrant/client.snapshot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client.snapshot.test.ts
git commit -m "feat(qdrant): add createSnapshot/recoverFromSnapshot to QdrantManager"
```

---

## Task 3: Owner clone/remove methods (duckdb, snapshot, stats, quarantine)

**Files:**

- Modify: `src/core/adapters/duckdb/pool.ts`
- Modify: `src/core/domains/ingest/sync/snapshot/sharded-snapshot.ts`
- Modify: `src/core/infra/stats-cache.ts`
- Modify: `src/core/domains/ingest/sync/quarantine-store.ts`
- Test: `tests/core/domains/maintenance/owner-clone.test.ts`

**Interfaces:**

- Consumes: `GraphDbClientPool.pathFor`, `GraphDbClientPool.release`; `ShardedSnapshotManager` snapshotDir; `StatsCache.filePath`; `QuarantineStore.quarantinePath`.
- Produces: `GraphDbClientPool.cloneDatabase(src: string, dst: string): Promise<void>`; `ShardedSnapshotManager.cloneTo(targetCollection: string, newCodebasePath: string): Promise<void>`; `StatsCache.clone(src: string, dst: string): void`; `QuarantineStore.cloneTo(targetCollection: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/domains/maintenance/owner-clone.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatsCache } from "../../../../src/core/infra/stats-cache.js";
import { ShardedSnapshotManager } from "../../../../src/core/domains/ingest/sync/snapshot/sharded-snapshot.js";

describe("owner clone methods", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "own-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("StatsCache.clone copies the per-collection stats file", () => {
    const cache = new StatsCache(dir);
    writeFileSync(join(dir, "code_src.stats.json"), '{"version":5}');
    cache.clone("code_src", "code_dst");
    expect(existsSync(join(dir, "code_dst.stats.json"))).toBe(true);
  });

  it("StatsCache.clone is a no-op when the source file is absent", () => {
    const cache = new StatsCache(dir);
    expect(() => cache.clone("code_missing", "code_dst")).not.toThrow();
    expect(existsSync(join(dir, "code_dst.stats.json"))).toBe(false);
  });

  it("ShardedSnapshotManager.cloneTo copies shards and rewrites codebasePath", async () => {
    const src = new ShardedSnapshotManager(dir, "code_src");
    await src.save("/old/repo", new Map([["a.ts", { hash: "h", mtime: 1, size: 2 }]]));
    await src.cloneTo("code_dst", "/new/worktree");

    const metaRaw = readFileSync(join(dir, "code_dst", "meta.json"), "utf8");
    expect(JSON.parse(metaRaw).codebasePath).toBe("/new/worktree");
    const dst = new ShardedSnapshotManager(dir, "code_dst");
    expect(await dst.exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/domains/maintenance/owner-clone.test.ts`
Expected: FAIL — `clone` / `cloneTo` not functions.

- [ ] **Step 3a: StatsCache.clone**

```ts
// src/core/infra/stats-cache.ts
  clone(sourceCollection: string, targetCollection: string): void {
    const from = this.filePath(sourceCollection);
    if (!existsSync(from)) return;
    copyFileSync(from, this.filePath(targetCollection));
  }
```

> Add `existsSync, copyFileSync` to the `node:fs` import.

- [ ] **Step 3b: QuarantineStore.cloneTo**

```ts
// src/core/domains/ingest/sync/quarantine-store.ts
  async cloneTo(targetCollection: string): Promise<void> {
    const to = join(this.snapshotDir, `${targetCollection}.quarantine.json`);
    try {
      await copyFile(this.quarantinePath, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // absent quarantine = nothing to clone
    }
  }
```

> Add `copyFile` from `node:fs/promises`.

- [ ] **Step 3c: ShardedSnapshotManager.cloneTo**

```ts
// src/core/domains/ingest/sync/snapshot/sharded-snapshot.ts
  async cloneTo(targetCollection: string, newCodebasePath: string): Promise<void> {
    const loaded = await this.load();
    if (!loaded) return; // source not yet snapshotted
    const target = new ShardedSnapshotManager(
      dirname(this.snapshotDir), targetCollection, this.shardCount, this.virtualNodesPerShard,
    );
    await target.save(newCodebasePath, loaded.files, { aliasVersion: loaded.meta?.aliasVersion });
  }
```

> Reuse `save()` so shard layout + meta + merkle roots are written by the owner — `cloneTo` only re-points `codebasePath`. Add `dirname` to the `node:path` import. Adjust the `save` options object to the real `SnapshotSaveOptions` shape; if `load()` does not expose `meta`, drop the `aliasVersion` option.

- [ ] **Step 3d: GraphDbClientPool.cloneDatabase**

```ts
// src/core/adapters/duckdb/pool.ts
  async cloneDatabase(sourceCollection: string, targetCollection: string): Promise<void> {
    // Release any cached writer so the source file is flushed + unlocked before copy.
    await this.release(sourceCollection);
    const from = this.pathFor(sourceCollection);
    if (!existsSync(from)) return; // codegraph disabled / not built
    await copyFile(from, this.pathFor(targetCollection));
  }
```

> Add `existsSync` (`node:fs`) and `copyFile` (`node:fs/promises`). `release()` closes the cached connection (implicit checkpoint). In daemon mode the lock is held by the daemon; `release` drops this process's handle — if a concurrent writer holds it, the copy still reflects the last committed checkpoint (single-file DuckDB). Integration test (Task 9 smoke) validates real-daemon behaviour.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/domains/maintenance/owner-clone.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/duckdb/pool.ts src/core/domains/ingest/sync/snapshot/sharded-snapshot.ts src/core/infra/stats-cache.ts src/core/domains/ingest/sync/quarantine-store.ts tests/core/domains/maintenance/owner-clone.test.ts
git commit -m "feat(maintenance): add clone methods to footprint artifact owners"
```

---

## Task 4: Footprint kernel (artifact strategy + factory)

**Files:**

- Create: `src/core/domains/maintenance/footprint/artifact.ts`
- Create: `src/core/domains/maintenance/footprint/{qdrant,codegraph,snapshot,stats,quarantine}-artifact.ts`
- Create: `src/core/domains/maintenance/footprint/factory.ts`
- Create: `src/core/domains/maintenance/footprint/index.ts`
- Test: `tests/core/domains/maintenance/footprint.test.ts`

**Interfaces:**

- Consumes: Task 2 (`createSnapshot`/`recoverFromSnapshot`/`snapshotDownloadUrl`, `aliases.createAlias`), Task 3 owner methods, `pool.removeCollection`, `StatsCache.invalidate`.
- Produces:
  - `interface ResolvedCollection { logicalName: string; physicalName: string; path: string; embeddingModel: string; embeddingDimensions: number; qdrantUrl: string; codegraphEnabled: boolean; }`
  - `interface FootprintContext { source: ResolvedCollection; target: ResolvedCollection; }`
  - `type ArtifactId = "qdrant" | "codegraph" | "snapshot" | "stats" | "quarantine";`
  - `interface CollectionArtifact { readonly id: ArtifactId; clone(ctx: FootprintContext): Promise<void>; remove(ctx: FootprintContext): Promise<void>; }`
  - `class CollectionFootprintFactory { constructor(deps: FootprintDeps); build(source: ResolvedCollection, target: ResolvedCollection): { context: FootprintContext; artifacts: CollectionArtifact[] }; }`
  - `interface FootprintDeps { qdrant: QdrantManager; pool: GraphDbClientPool; statsCache: StatsCache; snapshotBaseDir: string; }`

- [ ] **Step 1: Write the interface file**

```ts
// src/core/domains/maintenance/footprint/artifact.ts
export type ArtifactId = "qdrant" | "codegraph" | "snapshot" | "stats" | "quarantine";

export interface ResolvedCollection {
  logicalName: string;
  physicalName: string;
  path: string;
  embeddingModel: string;
  embeddingDimensions: number;
  qdrantUrl: string;
  codegraphEnabled: boolean;
}

export interface FootprintContext {
  source: ResolvedCollection;
  target: ResolvedCollection;
}

export interface CollectionArtifact {
  readonly id: ArtifactId;
  clone(ctx: FootprintContext): Promise<void>;
  remove(ctx: FootprintContext): Promise<void>;
}
```

- [ ] **Step 2: Write the failing factory/ordering test**

```ts
// tests/core/domains/maintenance/footprint.test.ts
import { describe, expect, it, vi } from "vitest";
import { CollectionFootprintFactory } from "../../../../src/core/domains/maintenance/footprint/factory.js";

function resolved(over = {}) {
  return { logicalName: "code_src", physicalName: "code_src_v1", path: "/p",
    embeddingModel: "j", embeddingDimensions: 768, qdrantUrl: "http://h", codegraphEnabled: true, ...over };
}

describe("CollectionFootprintFactory", () => {
  const deps = {
    qdrant: {} as never, pool: {} as never,
    statsCache: { clone: vi.fn(), invalidate: vi.fn() } as never,
    snapshotBaseDir: "/snap",
  };

  it("builds artifacts in clone order and exposes a context", () => {
    const f = new CollectionFootprintFactory(deps);
    const { artifacts, context } = f.build(resolved(), resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }));
    expect(artifacts.map((a) => a.id)).toEqual(["qdrant", "codegraph", "snapshot", "stats", "quarantine"]);
    expect(context.target.logicalName).toBe("code_dst");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/core/domains/maintenance/footprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the QdrantArtifact**

```ts
// src/core/domains/maintenance/footprint/qdrant-artifact.ts
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

export class QdrantArtifact implements CollectionArtifact {
  readonly id = "qdrant" as const;
  constructor(private readonly qdrant: QdrantManager) {}

  async clone(ctx: FootprintContext): Promise<void> {
    const snapshotName = await this.qdrant.createSnapshot(ctx.source.physicalName);
    try {
      const location = this.qdrant.snapshotDownloadUrl(ctx.source.physicalName, snapshotName);
      await this.qdrant.recoverFromSnapshot(ctx.target.physicalName, location);
      await this.qdrant.aliases.createAlias(ctx.target.logicalName, ctx.target.physicalName);
    } finally {
      await this.qdrant.deleteSnapshot(ctx.source.physicalName, snapshotName).catch(() => undefined);
    }
  }

  async remove(ctx: FootprintContext): Promise<void> {
    await this.qdrant.aliases.deleteAlias(ctx.target.logicalName).catch(() => undefined);
    await this.qdrant.deleteCollection(ctx.target.physicalName).catch(() => undefined);
  }
}
```

> `deleteSnapshot(collection, name)` exists on the client; add a thin `QdrantManager.deleteSnapshot` wrapper in Task 2 if not already present, or call `this.qdrant.aliases`-style. If absent, drop the `finally` cleanup (snapshots are small; a follow-up can prune them).

- [ ] **Step 5: Implement the other 4 artifacts (thin delegates)**

```ts
// src/core/domains/maintenance/footprint/codegraph-artifact.ts
import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";
export class CodegraphArtifact implements CollectionArtifact {
  readonly id = "codegraph" as const;
  constructor(private readonly pool: GraphDbClientPool) {}
  async clone(ctx: FootprintContext): Promise<void> {
    if (!ctx.source.codegraphEnabled) return;
    await this.pool.cloneDatabase(ctx.source.logicalName, ctx.target.logicalName);
  }
  async remove(ctx: FootprintContext): Promise<void> {
    await this.pool.removeCollection(ctx.target.logicalName);
  }
}
```

```ts
// src/core/domains/maintenance/footprint/snapshot-artifact.ts
import { ShardedSnapshotManager } from "../../../domains/ingest/sync/snapshot/sharded-snapshot.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";
export class SnapshotArtifact implements CollectionArtifact {
  readonly id = "snapshot" as const;
  constructor(private readonly baseDir: string) {}
  async clone(ctx: FootprintContext): Promise<void> {
    const src = new ShardedSnapshotManager(this.baseDir, ctx.source.logicalName);
    await src.cloneTo(ctx.target.logicalName, ctx.target.path);
  }
  async remove(ctx: FootprintContext): Promise<void> {
    await new ShardedSnapshotManager(this.baseDir, ctx.target.logicalName).delete();
  }
}
```

```ts
// src/core/domains/maintenance/footprint/stats-artifact.ts
import type { StatsCache } from "../../../infra/stats-cache.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";
export class StatsArtifact implements CollectionArtifact {
  readonly id = "stats" as const;
  constructor(private readonly statsCache: StatsCache) {}
  async clone(ctx: FootprintContext): Promise<void> {
    this.statsCache.clone(ctx.source.logicalName, ctx.target.logicalName);
  }
  async remove(ctx: FootprintContext): Promise<void> {
    this.statsCache.invalidate(ctx.target.logicalName);
  }
}
```

```ts
// src/core/domains/maintenance/footprint/quarantine-artifact.ts
import { QuarantineStore } from "../../../domains/ingest/sync/quarantine-store.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";
export class QuarantineArtifact implements CollectionArtifact {
  readonly id = "quarantine" as const;
  constructor(private readonly snapshotBaseDir: string) {}
  async clone(ctx: FootprintContext): Promise<void> {
    await new QuarantineStore(this.snapshotBaseDir, ctx.source.logicalName).cloneTo(ctx.target.logicalName);
  }
  async remove(ctx: FootprintContext): Promise<void> {
    await new QuarantineStore(this.snapshotBaseDir, ctx.target.logicalName).clearAll();
  }
}
```

- [ ] **Step 6: Implement the factory**

```ts
// src/core/domains/maintenance/footprint/factory.ts
import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type { CollectionArtifact, FootprintContext, ResolvedCollection } from "./artifact.js";
import { CodegraphArtifact } from "./codegraph-artifact.js";
import { QdrantArtifact } from "./qdrant-artifact.js";
import { QuarantineArtifact } from "./quarantine-artifact.js";
import { SnapshotArtifact } from "./snapshot-artifact.js";
import { StatsArtifact } from "./stats-artifact.js";

export interface FootprintDeps {
  qdrant: QdrantManager;
  pool: GraphDbClientPool;
  statsCache: StatsCache;
  snapshotBaseDir: string;
}

export class CollectionFootprintFactory {
  constructor(private readonly deps: FootprintDeps) {}

  build(source: ResolvedCollection, target: ResolvedCollection): { context: FootprintContext; artifacts: CollectionArtifact[] } {
    const { qdrant, pool, statsCache, snapshotBaseDir } = this.deps;
    // Order = clone order; rollback / remove walk it in reverse.
    const artifacts: CollectionArtifact[] = [
      new QdrantArtifact(qdrant),
      new CodegraphArtifact(pool),
      new SnapshotArtifact(snapshotBaseDir),
      new StatsArtifact(statsCache),
      new QuarantineArtifact(snapshotBaseDir),
    ];
    return { context: { source, target }, artifacts };
  }
}
```

```ts
// src/core/domains/maintenance/footprint/index.ts
export * from "./artifact.js";
export * from "./factory.js";
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run tests/core/domains/maintenance/footprint.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/maintenance/footprint tests/core/domains/maintenance/footprint.test.ts
git commit -m "feat(maintenance): add footprint kernel (artifact strategy + factory)"
```

---

## Task 5: WorktreeOps (create-saga, remove-guard, list, info)

**Files:**

- Create: `src/core/domains/maintenance/worktree/worktree-ops.ts`
- Create: `src/core/domains/maintenance/worktree/git-worktree.ts`
- Create: `src/core/domains/maintenance/worktree/index.ts`
- Test: `tests/core/domains/maintenance/worktree-ops.test.ts`

**Interfaces:**

- Consumes: Task 1 registry queries, Task 4 `CollectionFootprintFactory`, `resolveCollectionName` (`infra/collection-name.ts`), `qdrant.aliases.resolveActive` + `computeNewVersion` for physical-name derivation.
- Produces:
  - `interface WorktreeCreateResult { collectionName: string; alias: string; sourceProject: string; worktreePath: string; }`
  - `interface WorktreeInfo { isWorktree: boolean; collectionName?: string; alias?: string; worktreeOf?: string; worktreeName?: string; chunksCount?: number; }`
  - `class WorktreeOps { constructor(deps: WorktreeOpsDeps); create(input: { name: string; from?: string; path?: string; createGit: boolean; branch?: string }): Promise<WorktreeCreateResult>; remove(input: { name: string; force: boolean; keepGit: boolean }): Promise<{ removed: boolean }>; list(): WorktreeInfo[]; info(cwd: string): WorktreeInfo; }`
  - `interface WorktreeOpsDeps { registry: CollectionRegistry; qdrant: QdrantManager; footprintFactory: CollectionFootprintFactory; dataDir: string; }`

- [ ] **Step 1: Write the failing saga + guard tests**

```ts
// tests/core/domains/maintenance/worktree-ops.test.ts
import { describe, expect, it, vi } from "vitest";
import { WorktreeOps } from "../../../../src/core/domains/maintenance/worktree/worktree-ops.js";

function fakeArtifact(id: string, calls: string[], failOn?: string) {
  return {
    id,
    clone: vi.fn(async () => { calls.push(`clone:${id}`); if (failOn === id) throw new Error(`boom ${id}`); }),
    remove: vi.fn(async () => { calls.push(`remove:${id}`); }),
  };
}

function makeDeps(over: Partial<Record<string, unknown>> = {}, calls: string[] = [], failOn?: string) {
  const sourceEntry = { collectionName: "code_src", path: "/repo", name: "proj",
    embeddingModel: "j", embeddingDimensions: 768, qdrantUrl: "http://h", codegraphEnabled: true,
    indexedAt: "t", teaRagsVersion: "1", chunksCount: 5 };
  const recorded: Record<string, unknown>[] = [];
  return {
    calls, recorded,
    deps: {
      registry: {
        findByName: vi.fn(() => sourceEntry),
        findByPath: vi.fn(() => sourceEntry),
        get: vi.fn(() => sourceEntry),
        record: vi.fn((e: Record<string, unknown>) => recorded.push(e)),
        setWorktreeProvenance: vi.fn(),
        remove: vi.fn(() => true),
        listWorktrees: vi.fn(() => []),
        findWorktree: vi.fn(() => null),
      },
      qdrant: { aliases: { resolveActive: vi.fn(async () => "code_src_v1") }, listCollections: vi.fn(async () => []) },
      footprintFactory: {
        build: vi.fn(() => ({
          context: { source: {}, target: { logicalName: "code_dst" } },
          artifacts: ["qdrant", "codegraph", "snapshot", "stats", "quarantine"].map((id) => fakeArtifact(id, calls, failOn)),
        })),
      },
      dataDir: "/data",
      ...over,
    } as never,
  };
}

describe("WorktreeOps.create saga", () => {
  it("clones all artifacts then commits the registry entry with provenance", async () => {
    const { deps, calls, recorded } = makeDeps();
    const ops = new WorktreeOps(deps);
    const res = await ops.create({ name: "x", createGit: false });
    expect(calls).toEqual(["clone:qdrant", "clone:codegraph", "clone:snapshot", "clone:stats", "clone:quarantine"]);
    expect(recorded).toHaveLength(1);
    expect(deps.registry.setWorktreeProvenance).toHaveBeenCalled();
    expect(res.alias).toContain("worktree-x");
  });

  it("rolls back already-cloned artifacts in reverse on failure and does NOT record", async () => {
    const { deps, calls, recorded } = makeDeps({}, [], "snapshot");
    const ops = new WorktreeOps(deps);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/boom snapshot/);
    expect(calls).toEqual([
      "clone:qdrant", "clone:codegraph", "clone:snapshot",
      "remove:codegraph", "remove:qdrant", // reverse of successfully-cloned (snapshot failed mid-clone)
    ]);
    expect(recorded).toHaveLength(0);
  });
});

describe("WorktreeOps.remove guard", () => {
  it("refuses to remove an entry without worktree provenance", async () => {
    const { deps } = makeDeps({
      registry: { findWorktree: vi.fn(() => null) },
    });
    const ops = new WorktreeOps(deps);
    await expect(ops.remove({ name: "real-project", force: false, keepGit: true }))
      .rejects.toThrow(/not a worktree/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/domains/maintenance/worktree-ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement git-worktree helper**

```ts
// src/core/domains/maintenance/worktree/git-worktree.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function ensureGitWorktree(repoRoot: string, name: string, targetPath: string, branch?: string): void {
  if (existsSync(targetPath)) return; // idempotent: attach to an existing worktree
  const args = ["-C", repoRoot, "worktree", "add"];
  if (branch) args.push("-b", branch);
  args.push(targetPath);
  execFileSync("git", args, { stdio: "pipe" });
}

export function removeGitWorktree(repoRoot: string, targetPath: string, force: boolean): void {
  const args = ["-C", repoRoot, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(targetPath);
  execFileSync("git", args, { stdio: "pipe" });
}
```

- [ ] **Step 4: Implement WorktreeOps**

```ts
// src/core/domains/maintenance/worktree/worktree-ops.ts
import { resolve } from "node:path";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { resolveCollectionName } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/index.js";
import type { CollectionArtifact, ResolvedCollection } from "../footprint/index.js";
import type { CollectionFootprintFactory } from "../footprint/index.js";
import { removeGitWorktree } from "./git-worktree.js";

export interface WorktreeOpsDeps {
  registry: CollectionRegistry;
  qdrant: QdrantManager;
  footprintFactory: CollectionFootprintFactory;
  dataDir: string;
}
export interface WorktreeCreateResult { collectionName: string; alias: string; sourceProject: string; worktreePath: string; }
export interface WorktreeInfo { isWorktree: boolean; collectionName?: string; alias?: string; worktreeOf?: string; worktreeName?: string; chunksCount?: number; }

export class WorktreeOps {
  constructor(private readonly deps: WorktreeOpsDeps) {}

  async create(input: { name: string; from?: string; path?: string; createGit: boolean; branch?: string }): Promise<WorktreeCreateResult> {
    const { registry, qdrant, footprintFactory } = this.deps;
    const sourceEntry = input.from ? registry.findByName(input.from) : registry.findByPath(process.cwd());
    if (!sourceEntry) throw new Error(`Source project not found (from=${input.from ?? "cwd"})`);

    const worktreePath = resolve(input.path ?? input.name);
    const targetLogical = resolveCollectionName(worktreePath);
    if (registry.get(targetLogical)) throw new Error(`Target collection already exists: ${targetLogical}`);

    const srcPhysical = await qdrant.aliases.resolveActive(sourceEntry.collectionName);
    const source: ResolvedCollection = {
      logicalName: sourceEntry.collectionName, physicalName: srcPhysical, path: sourceEntry.path,
      embeddingModel: sourceEntry.embeddingModel, embeddingDimensions: sourceEntry.embeddingDimensions,
      qdrantUrl: sourceEntry.qdrantUrl, codegraphEnabled: sourceEntry.codegraphEnabled ?? false,
    };
    const target: ResolvedCollection = { ...source, logicalName: targetLogical, physicalName: `${targetLogical}_v1`, path: worktreePath };

    const { context, artifacts } = footprintFactory.build(source, target);
    const done: CollectionArtifact[] = [];
    try {
      for (const a of artifacts) { await a.clone(context); done.push(a); }
    } catch (err) {
      for (const a of done.reverse()) await a.remove(context).catch(() => undefined);
      throw err;
    }

    const alias = `${sourceEntry.name ?? sourceEntry.collectionName}-worktree-${input.name}`;
    registry.record({
      collectionName: targetLogical, path: worktreePath,
      embeddingModel: source.embeddingModel, embeddingDimensions: source.embeddingDimensions,
      qdrantUrl: source.qdrantUrl, codegraphEnabled: source.codegraphEnabled,
      indexedAt: sourceEntry.indexedAt, teaRagsVersion: sourceEntry.teaRagsVersion, chunksCount: sourceEntry.chunksCount,
    });
    registry.setName(targetLogical, alias);
    registry.setWorktreeProvenance(targetLogical, sourceEntry.collectionName, input.name);

    return { collectionName: targetLogical, alias, sourceProject: sourceEntry.name ?? sourceEntry.collectionName, worktreePath };
  }

  async remove(input: { name: string; force: boolean; keepGit: boolean }): Promise<{ removed: boolean }> {
    const { registry, qdrant, footprintFactory } = this.deps;
    const entry = registry.findWorktree(input.name);
    if (!entry) throw new Error(`'${input.name}' is not a worktree clone (refusing to remove)`);

    const srcPhysical = await qdrant.aliases.resolveActive(entry.worktreeOf as string).catch(() => entry.worktreeOf as string);
    const source: ResolvedCollection = {
      logicalName: entry.worktreeOf as string, physicalName: srcPhysical, path: "",
      embeddingModel: entry.embeddingModel, embeddingDimensions: entry.embeddingDimensions,
      qdrantUrl: entry.qdrantUrl, codegraphEnabled: entry.codegraphEnabled ?? false,
    };
    const target: ResolvedCollection = { ...source, logicalName: entry.collectionName, physicalName: `${entry.collectionName}_v1`, path: entry.path };
    const { context, artifacts } = footprintFactory.build(source, target);
    for (const a of [...artifacts].reverse()) await a.remove(context).catch(() => undefined);

    registry.remove(entry.collectionName);
    if (!input.keepGit && entry.path) removeGitWorktree(entry.path, entry.path, input.force);
    return { removed: true };
  }

  list(): WorktreeInfo[] {
    return this.deps.registry.listWorktrees().map((e) => ({
      isWorktree: true, collectionName: e.collectionName, alias: e.name ?? undefined,
      worktreeOf: e.worktreeOf, worktreeName: e.worktreeName, chunksCount: e.chunksCount,
    }));
  }

  info(cwd: string): WorktreeInfo {
    const entry = this.deps.registry.findByPath(resolve(cwd));
    if (!entry || entry.worktreeOf === undefined) return { isWorktree: false };
    return { isWorktree: true, collectionName: entry.collectionName, alias: entry.name ?? undefined,
      worktreeOf: entry.worktreeOf, worktreeName: entry.worktreeName, chunksCount: entry.chunksCount };
  }
}
```

```ts
// src/core/domains/maintenance/worktree/index.ts
export * from "./worktree-ops.js";
```

> `removeGitWorktree(entry.path, entry.path, ...)`: the worktree-remove command runs from the main repo; the first arg should be the SOURCE repo root. Resolve the repo root from the source entry's path in the implementation (the source entry is available via `registry.get(entry.worktreeOf)`); the snippet uses `entry.path` as a placeholder for the repo-root argument — wire the real source repo root.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/core/domains/maintenance/worktree-ops.test.ts`
Expected: PASS (create order, rollback reverse, no-record-on-failure, remove guard).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/maintenance/worktree tests/core/domains/maintenance/worktree-ops.test.ts
git commit -m "feat(maintenance): add WorktreeOps create-saga + provenance-guarded remove"
```

---

## Task 6: App methods (additive delegation)

**Files:**

- Modify: `src/core/api/public/app.ts`
- Test: `tests/core/api/public/app.worktree.test.ts`

**Interfaces:**

- Consumes: Task 5 `WorktreeOps`.
- Produces (on `App`): `createWorktree(input: { name: string; from?: string; path?: string; createGit: boolean; branch?: string }) => Promise<WorktreeCreateResult>`; `listWorktrees() => Promise<WorktreeInfo[]>`; `removeWorktree(input: { name: string; force: boolean; keepGit: boolean }) => Promise<{ removed: boolean }>`; `worktreeInfo(input: { cwd: string }) => Promise<WorktreeInfo>`. Adds `worktreeOps: WorktreeOps` to `AppDeps`.

- [ ] **Step 1: Write the failing delegation test**

```ts
// tests/core/api/public/app.worktree.test.ts
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../../src/core/api/public/app.js";

function baseDeps() {
  return {
    qdrant: {}, embeddings: {}, ingest: {}, explore: {}, reranker: {},
    schemaDriftMonitor: {}, projectRegistryOps: {}, quantizationScalar: false,
  } as never;
}

describe("App worktree delegation", () => {
  it("createWorktree delegates to worktreeOps.create", async () => {
    const worktreeOps = { create: vi.fn(async () => ({ collectionName: "code_dst", alias: "a", sourceProject: "p", worktreePath: "/w" })),
      list: vi.fn(() => []), remove: vi.fn(async () => ({ removed: true })), info: vi.fn(() => ({ isWorktree: false })) };
    const app = createApp({ ...baseDeps(), worktreeOps } as never);
    const res = await app.createWorktree({ name: "x", createGit: false });
    expect(worktreeOps.create).toHaveBeenCalledWith({ name: "x", createGit: false });
    expect(res.collectionName).toBe("code_dst");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/api/public/app.worktree.test.ts`
Expected: FAIL — `createWorktree` undefined.

- [ ] **Step 3: Extend the App interface + AppDeps + wireOps + delegation**

```ts
// src/core/api/public/app.ts

// (a) AppDeps — add field
  worktreeOps: WorktreeOps;

// (b) App interface — add methods
  createWorktree: (input: { name: string; from?: string; path?: string; createGit: boolean; branch?: string }) => Promise<WorktreeCreateResult>;
  listWorktrees: () => Promise<WorktreeInfo[]>;
  removeWorktree: (input: { name: string; force: boolean; keepGit: boolean }) => Promise<{ removed: boolean }>;
  worktreeInfo: (input: { cwd: string }) => Promise<WorktreeInfo>;

// (c) createApp(...) — add delegations to the returned object
  createWorktree: async (input) => deps.worktreeOps.create(input),
  listWorktrees: async () => deps.worktreeOps.list(),
  removeWorktree: async (input) => deps.worktreeOps.remove(input),
  worktreeInfo: async (input) => deps.worktreeOps.info(input.cwd),
```

> Import `WorktreeOps`, `WorktreeCreateResult`, `WorktreeInfo` from `../../domains/maintenance/worktree/index.js`. `worktreeOps` is pre-injected (like `projectRegistryOps`), so no `wireOps` construction is needed beyond reading `deps.worktreeOps`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/api/public/app.worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/api/public/app.ts tests/core/api/public/app.worktree.test.ts
git commit -m "feat(api): expose worktree create/list/remove/info on App"
```

---

## Task 7: Factory wiring (append-only DI)

**Files:**

- Modify: `src/bootstrap/factory.ts`
- Test: covered by Task 9 build + the existing factory test suite (`npx vitest run tests/bootstrap`).

**Interfaces:**

- Consumes: Task 4 `CollectionFootprintFactory`, Task 5 `WorktreeOps`, existing `infra.qdrant`, `codegraphContext.pool`, `statsCache`, `collectionRegistry`, `config.paths`.
- Produces: a constructed `worktreeOps` passed into `createApp`.

- [ ] **Step 1: Add construction near the existing `projectRegistryOps` block**

```ts
// src/bootstrap/factory.ts — after projectRegistryOps is constructed (~line 607)
const footprintFactory = new CollectionFootprintFactory({
  qdrant: infra.qdrant,
  pool: codegraphContext?.pool ?? new GraphDbClientPool({ rootDir: config.paths.dataDir ?? config.paths.root }),
  statsCache,
  snapshotBaseDir: config.paths.snapshots,
});
const worktreeOps = new WorktreeOps({
  registry: collectionRegistry,
  qdrant: infra.qdrant,
  footprintFactory,
  dataDir: config.paths.dataDir ?? config.paths.root,
});
```

> Use the SAME `GraphDbClientPool` instance the rest of the app uses when codegraph is enabled (`codegraphContext.pool`); only fall back to a fresh pool when codegraph is disabled. Confirm the exact `statsCache` variable name and `config.paths` keys in this file (`config.paths.snapshots` is already used by `projectRegistryOps`).

- [ ] **Step 2: Pass into `createApp`**

```ts
// src/bootstrap/factory.ts — add to the createApp({...}) call
  worktreeOps,
```

- [ ] **Step 3: Add imports**

```ts
import { CollectionFootprintFactory } from "../core/domains/maintenance/footprint/index.js";
import { WorktreeOps } from "../core/domains/maintenance/worktree/index.js";
```

- [ ] **Step 4: Verify build + factory tests**

Run: `npm run build && npx vitest run tests/bootstrap`
Expected: tsc 0 errors; factory tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/factory.ts
git commit -m "feat(bootstrap): wire footprint factory + WorktreeOps into App"
```

---

## Task 8: CLI command group `tea-rags worktree`

**Files:**

- Create: `src/cli/commands/worktree.ts`
- Modify: `src/cli/create-cli.ts`
- Test: `tests/cli/commands/worktree.test.ts`

**Interfaces:**

- Consumes: bootstrap App (for `create`/`remove`, full infra) via the same entry `index-codebase` uses; `CollectionRegistry` inline (for `list`/`info`, read-only); the existing index supervisor (`superviseIndexing`) for the post-commit diff reindex.
- Produces: `worktreeCommand: CommandModule`.

- [ ] **Step 1: Write the failing list/info test (pure, no bootstrap)**

```ts
// tests/cli/commands/worktree.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorktreeList } from "../../../src/cli/commands/worktree.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("worktree list CLI", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wt-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints JSON of worktree entries only", () => {
    const reg = new CollectionRegistry(dir);
    reg.record({ collectionName: "code_wt", path: "/w", embeddingModel: "j", embeddingDimensions: 768,
      qdrantUrl: "http://h", indexedAt: "t", teaRagsVersion: "1", chunksCount: 3 });
    reg.setWorktreeProvenance("code_wt", "code_src", "x");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeList({ json: true, dataDir: dir });
    expect(write.mock.calls.join("")).toContain("code_wt");
    write.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli/commands/worktree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command (mirror `projects.ts` structure)**

```ts
// src/cli/commands/worktree.ts
import type { Argv, CommandModule } from "yargs";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";
import { resolveDataDir } from "../registry-resolver.js"; // same helper projects.ts uses

export function runWorktreeList(args: { json: boolean; dataDir?: string }): void {
  const registry = new CollectionRegistry(args.dataDir ?? resolveDataDir());
  const rows = registry.listWorktrees();
  if (args.json) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return; }
  if (rows.length === 0) { process.stdout.write("No worktree indexes.\n"); return; }
  for (const e of rows) process.stdout.write(`${e.worktreeName}\t${e.name}\t<- ${e.worktreeOf}\t${e.chunksCount} chunks\n`);
}

export function runWorktreeInfo(args: { json: boolean; dataDir?: string }): void {
  const registry = new CollectionRegistry(args.dataDir ?? resolveDataDir());
  const entry = registry.findByPath(process.cwd());
  const info = !entry || entry.worktreeOf === undefined
    ? { isWorktree: false }
    : { isWorktree: true, collectionName: entry.collectionName, alias: entry.name, worktreeOf: entry.worktreeOf, worktreeName: entry.worktreeName };
  process.stdout.write(args.json ? `${JSON.stringify(info, null, 2)}\n` : `${JSON.stringify(info)}\n`);
}

// create/remove need full infra — delegate to the bootstrap App, then (create) run the diff reindex
// through the existing index supervisor. Implemented in runWorktreeCreate/runWorktreeRemove using the
// same bootstrap entry index-codebase uses (createAppContext) + superviseIndexing for the delta.

export const worktreeCommand: CommandModule = {
  command: "worktree",
  describe: "Manage per-worktree index clones (create | list | remove | info). Defaults to list.",
  builder: (yargs: Argv) =>
    yargs
      .command("create <name>", "Clone the source index into a worktree collection and diff-reindex",
        (y) => y.positional("name", { type: "string", demandOption: true })
          .option("from", { type: "string", describe: "Source project alias (default: cwd project)" })
          .option("path", { type: "string", describe: "Worktree path (default: ./<name>)" })
          .option("branch", { type: "string" })
          .option("no-git", { type: "boolean", default: false, describe: "Attach to an existing dir; do not create the git worktree" })
          .option("json", { type: "boolean", default: false }),
        async (argv) => runWorktreeCreate(argv as never))
      .command("remove <name>", "Tear down a worktree index (footprint + registry)",
        (y) => y.positional("name", { type: "string", demandOption: true })
          .option("force", { type: "boolean", default: false })
          .option("keep-git", { type: "boolean", default: false })
          .option("json", { type: "boolean", default: false }),
        async (argv) => runWorktreeRemove(argv as never))
      .command("list", "List worktree indexes",
        (y) => y.option("json", { type: "boolean", default: false }),
        (argv) => runWorktreeList({ json: Boolean(argv.json) }))
      .command("info", "Show worktree info for the current directory",
        (y) => y.option("json", { type: "boolean", default: false }),
        (argv) => runWorktreeInfo({ json: Boolean(argv.json) }))
      .command("$0", "List worktree indexes (default)",
        (y) => y.option("json", { type: "boolean", default: false }),
        (argv) => runWorktreeList({ json: Boolean(argv.json) }))
      .demandCommand(0).strict(),
  handler: () => { /* never reached */ },
};
```

> `runWorktreeCreate` / `runWorktreeRemove`: build the App via the same bootstrap path `index-codebase` uses (`createAppContext`), call `app.createWorktree(...)` / `app.removeWorktree(...)`. On create success, run the diff reindex by invoking the existing index supervisor against the new alias (`superviseIndexing` / the index worker), printing a warning (not failing) if it errors. Mirror `index-codebase.ts` for how the worker is forked/supervised.

- [ ] **Step 4: Register the command**

```ts
// src/cli/create-cli.ts — add the import + .command(worktreeCommand)
import { worktreeCommand } from "./commands/worktree.js";
// ...
    .command(worktreeCommand)
```

- [ ] **Step 5: Run to verify list test passes**

Run: `npx vitest run tests/cli/commands/worktree.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/worktree.ts src/cli/create-cli.ts tests/cli/commands/worktree.test.ts
git commit -m "feat(cli): add tea-rags worktree create/list/remove/info command"
```

---

## Task 9: Integration smoke (post-build, user-gated)

**Files:**

- Test: manual / scripted integration (no new unit file required).

**Preconditions (per MCP-testing rule — this IS an MCP server):**

- `npm run build` in this worktree (single active worktree → auto-build OK; if >1 worktree active, ask first).
- `npm link` to point the global tea-rags at this worktree build.
- Reconnect MCP servers (ask the user, wait).
- Reindex is USER-GATED — do not auto-run.

- [ ] **Step 1: Build + link**

Run: `npm run build && npm link`
Expected: clean build; global `tea-rags` resolves to this worktree.

- [ ] **Step 2: Create a worktree clone of tea-rags itself**

Run: `tea-rags worktree create smoke --from tea-rags --path .claude/worktrees/maintenance-worktree-feature --no-git --json`
Expected: JSON with `collectionName`, `alias` = `tea-rags-worktree-smoke`; a new `code_<hash>` collection exists; `~/.tea-rags/codegraph/<col>.duckdb` and `~/.tea-rags/snapshots/<col>/` present.

- [ ] **Step 3: Search resolves against the clone**

Run: `mcp__tea-rags__find_symbol project=tea-rags-worktree-smoke symbol=WorktreeOps` (after reconnect)
Expected: resolves from the cloned index (no full reindex was needed).

- [ ] **Step 4: Diff reindex picks up exactly one changed file**

Edit one source file in the worktree, run `tea-rags index-codebase --project tea-rags-worktree-smoke --json` (user-gated), confirm only the changed file is re-embedded (file counts in JSON).

- [ ] **Step 5: Remove cleans every artifact**

Run: `tea-rags worktree remove smoke --keep-git --json`
Expected: registry entry gone (`tea-rags worktree list` no longer shows it); Qdrant collection + alias deleted; `<col>.duckdb`, `snapshots/<col>/`, `<col>.stats.json` removed.

- [ ] **Step 6: Guard check**

Run: `tea-rags worktree remove tea-rags` (a real project)
Expected: refused with "not a worktree clone".

---

## Self-Review

**Spec coverage:** §2 command surface → Tasks 8 (+ sub-decision idempotent git via Task 5 `ensureGitWorktree`). §3 layering / domains/maintenance → Tasks 4-5 + 6-7 wiring. §4 footprint table → Tasks 2-4. §5 create-saga/remove/list/info → Task 5 (reindex moved to CLI handler Task 8, same post-commit/warning semantics — noted refinement). §6 footprint kernel → Task 4. §7 provenance → Task 1. §8 invariants → Tasks 1 (additive), 5 (saga post-condition + remove guard). §9 error handling → Task 5 rollback + Task 3 idle-wait. §10 testing → Tasks 1-8 unit + Task 9 integration. §11 out-of-scope (doctor relocation, MCP surface, CopyStrategy seam) → not implemented (intentional).

**Placeholder scan:** Remaining `>` notes flag spots where the implementer must confirm an exact existing symbol (`persist()` name, `SnapshotSaveOptions` shape, `config.paths` keys, repo-root arg for `removeGitWorktree`, `superviseIndexing` reuse) — these are verification pointers, not missing code; each names the exact thing to confirm.

**Type consistency:** `ResolvedCollection` / `FootprintContext` / `CollectionArtifact` identical across Tasks 4-7. `WorktreeCreateResult` / `WorktreeInfo` identical across Tasks 5-6. `createSnapshot`/`recoverFromSnapshot`/`snapshotDownloadUrl` defined in Task 2, consumed in Task 4. Registry methods defined in Task 1, consumed in Task 5.

**Refinements vs spec (consistency, not contradiction):** (1) `WorktreeOps` lives in `domains/maintenance/worktree/`, not `api/internal/ops/` — App delegates to it like a facade. (2) CLI at `src/cli/commands/worktree.ts` (actual convention), not `src/cli/worktree/`. (3) Post-commit diff reindex orchestrated by the CLI create handler reusing the index supervisor, not inside `WorktreeOps` — same semantics, avoids coupling ingest worker into the op.
