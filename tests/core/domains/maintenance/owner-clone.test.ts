import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatsCache } from "../../../../src/core/infra/stats-cache.js";
import { ShardedSnapshotManager } from "../../../../src/core/domains/ingest/sync/snapshot/sharded-snapshot.js";
import { QuarantineStore } from "../../../../src/core/domains/ingest/sync/quarantine-store.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";

describe("owner clone methods", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "own-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // --- StatsCache ---
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

  // --- ShardedSnapshotManager ---
  it("ShardedSnapshotManager.cloneTo copies shards and rewrites codebasePath", async () => {
    const src = new ShardedSnapshotManager(dir, "code_src");
    await src.save("/old/repo", new Map([["a.ts", { hash: "h", mtime: 1, size: 2 }]]));
    await src.cloneTo("code_dst", "/new/worktree");

    const metaRaw = readFileSync(join(dir, "code_dst", "meta.json"), "utf8");
    expect(JSON.parse(metaRaw).codebasePath).toBe("/new/worktree");
    const dst = new ShardedSnapshotManager(dir, "code_dst");
    expect(await dst.exists()).toBe(true);
  });

  // --- QuarantineStore ---
  it("QuarantineStore.cloneTo copies quarantine file to target collection name", async () => {
    const store = new QuarantineStore(dir, "code_src");
    writeFileSync(join(dir, "code_src.quarantine.json"), '{"version":1,"updatedAt":"2026-01-01","files":{}}');
    await store.cloneTo("code_dst");
    expect(existsSync(join(dir, "code_dst.quarantine.json"))).toBe(true);
  });

  it("QuarantineStore.cloneTo is a no-op when source quarantine is absent", async () => {
    const store = new QuarantineStore(dir, "code_missing");
    await expect(store.cloneTo("code_dst")).resolves.not.toThrow();
    expect(existsSync(join(dir, "code_dst.quarantine.json"))).toBe(false);
  });

  // --- GraphDbClientPool ---
  it("GraphDbClientPool.cloneDatabase copies the duckdb file to target", async () => {
    const pool = new GraphDbClientPool({
      rootDir: dir,
      symbolTableFactory: () => ({ symbols: new Map(), methods: new Map() } as never),
    });
    const srcPath = pool.pathFor("code_src");
    mkdirSync(join(dir, "codegraph"), { recursive: true });
    writeFileSync(srcPath, "fake-duckdb-content");
    await pool.cloneDatabase("code_src", "code_dst");
    expect(existsSync(pool.pathFor("code_dst"))).toBe(true);
  });

  it("GraphDbClientPool.cloneDatabase is a no-op when source file is absent", async () => {
    const pool = new GraphDbClientPool({
      rootDir: dir,
      symbolTableFactory: () => ({ symbols: new Map(), methods: new Map() } as never),
    });
    await expect(pool.cloneDatabase("code_missing", "code_dst")).resolves.not.toThrow();
    expect(existsSync(pool.pathFor("code_dst"))).toBe(false);
  });
});
