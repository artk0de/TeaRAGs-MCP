/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { ParallelFileSynchronizer } from "../../../build/code/sync/parallel-synchronizer.js";
import { ShardedSnapshotManager } from "../../../build/code/sync/sharded-snapshot.js";
import { ConsistentHash } from "../../../build/code/sync/consistent-hash.js";
import { SnapshotMigrator } from "../../../build/code/sync/migration.js";
import { TEST_DIR } from "../config.mjs";

export async function testParallelSync() {
  section("13. Parallel File Synchronization & Sharded Snapshots");

  const parallelTestDir = join(TEST_DIR, "parallel_sync");
  const snapshotDir = join(TEST_DIR, "parallel_snapshots");
  await fs.mkdir(parallelTestDir, { recursive: true });
  await fs.mkdir(join(parallelTestDir, "src"), { recursive: true });
  await fs.mkdir(join(parallelTestDir, "lib"), { recursive: true });
  await fs.mkdir(snapshotDir, { recursive: true });

  // Create test files
  await createTestFile(parallelTestDir, "src/a.ts", "export const a = 1;");
  await createTestFile(parallelTestDir, "src/b.ts", "export const b = 2;");
  await createTestFile(parallelTestDir, "lib/c.ts", "export const c = 3;");

  // === TEST: ConsistentHash distribution ===
  log("info", "Testing ConsistentHash distribution...");

  const hashRing = new ConsistentHash(4);
  const shards = new Map();
  for (let i = 0; i < 4; i++) shards.set(i, 0);

  // Distribute 100 files and check evenness
  for (let i = 0; i < 100; i++) {
    const shard = hashRing.getShard(`file${i}.ts`);
    shards.set(shard, shards.get(shard) + 1);
  }

  const minCount = Math.min(...shards.values());
  const maxCount = Math.max(...shards.values());
  assert(maxCount - minCount <= 20, `Hash distribution reasonably even: min=${minCount}, max=${maxCount}`);

  // Same key always maps to same shard
  const path = "src/unique/path/file.ts";
  const shard1 = hashRing.getShard(path);
  const shard2 = hashRing.getShard(path);
  assert(shard1 === shard2, `Consistent hashing is deterministic: shard=${shard1}`);

  // === TEST: ShardedSnapshotManager save/load ===
  log("info", "Testing ShardedSnapshotManager...");

  const snapshotManager = new ShardedSnapshotManager(snapshotDir, "test-parallel", 4);

  const files = new Map([
    ["src/a.ts", { mtime: 1000, size: 100, hash: "hash-a" }],
    ["src/b.ts", { mtime: 2000, size: 200, hash: "hash-b" }],
    ["lib/c.ts", { mtime: 3000, size: 300, hash: "hash-c" }],
  ]);

  await snapshotManager.save(parallelTestDir, files);
  assert(await snapshotManager.exists(), "Sharded snapshot exists after save");

  const loaded = await snapshotManager.load();
  assert(loaded !== null, "Sharded snapshot loads successfully");
  assert(loaded.files.size === 3, `Loaded correct file count: ${loaded.files.size}`);
  assert(loaded.files.get("src/a.ts")?.hash === "hash-a", "File metadata preserved");
  assert(loaded.codebasePath === parallelTestDir, "Codebase path preserved");

  // Delete and verify
  await snapshotManager.delete();
  assert(!(await snapshotManager.exists()), "Snapshot deleted successfully");

  // === TEST: ParallelFileSynchronizer change detection ===
  log("info", "Testing ParallelFileSynchronizer...");

  const sync = new ParallelFileSynchronizer(
    parallelTestDir,
    "test-sync-collection",
    snapshotDir,
    4
  );

  assert(sync.getConcurrency() === 4, `Concurrency is 4: ${sync.getConcurrency()}`);

  const initialFiles = [
    join(parallelTestDir, "src/a.ts"),
    join(parallelTestDir, "src/b.ts"),
    join(parallelTestDir, "lib/c.ts"),
  ];

  // Create initial snapshot
  await sync.updateSnapshot(initialFiles);
  assert(await sync.hasSnapshot(), "Snapshot created");

  // Initialize and check no changes
  await sync.initialize();
  const noChanges = await sync.detectChanges(initialFiles);
  assert(noChanges.added.length === 0, `No files added: ${noChanges.added.length}`);
  assert(noChanges.modified.length === 0, `No files modified: ${noChanges.modified.length}`);
  assert(noChanges.deleted.length === 0, `No files deleted: ${noChanges.deleted.length}`);

  // Add new file
  await createTestFile(parallelTestDir, "src/d.ts", "export const d = 4;");
  const filesWithNew = [...initialFiles, join(parallelTestDir, "src/d.ts")];

  const addChanges = await sync.detectChanges(filesWithNew);
  assert(addChanges.added.includes("src/d.ts"), `New file detected: ${addChanges.added}`);

  // Update snapshot and modify file
  await sync.updateSnapshot(filesWithNew);
  await sync.initialize();
  await fs.writeFile(join(parallelTestDir, "src/a.ts"), "export const a = 100; // modified");

  const modifyChanges = await sync.detectChanges(filesWithNew);
  assert(modifyChanges.modified.includes("src/a.ts"), `Modified file detected: ${modifyChanges.modified}`);

  // Update snapshot and delete file
  await sync.updateSnapshot(filesWithNew);
  await sync.initialize();
  await fs.unlink(join(parallelTestDir, "src/d.ts"));
  const filesAfterDelete = initialFiles;

  const deleteChanges = await sync.detectChanges(filesAfterDelete);
  assert(deleteChanges.deleted.includes("src/d.ts"), `Deleted file detected: ${deleteChanges.deleted}`);

  // Quick check via needsReindex
  await sync.updateSnapshot(filesAfterDelete);
  await sync.initialize();
  const noReindex = await sync.needsReindex(filesAfterDelete);
  assert(!noReindex, "needsReindex returns false when no changes");

  await fs.writeFile(join(parallelTestDir, "src/b.ts"), "export const b = 999;");
  const needsReindex = await sync.needsReindex(filesAfterDelete);
  assert(needsReindex, "needsReindex returns true after modification");

  // Cleanup sync snapshot
  await sync.deleteSnapshot();
  assert(!(await sync.hasSnapshot()), "Sync snapshot deleted");

  // === TEST: SnapshotMigrator v2 → v3 ===
  log("info", "Testing SnapshotMigrator...");

  // Create v2 snapshot (old format)
  const v2Snapshot = {
    version: "2",
    codebasePath: parallelTestDir,
    timestamp: Date.now(),
    fileHashes: {
      "src/a.ts": "hash-a",
      "src/b.ts": "hash-b",
      "lib/c.ts": "hash-c",
    },
    fileMetadata: {
      "src/a.ts": { mtime: 1000, size: 100, hash: "hash-a" },
      "src/b.ts": { mtime: 2000, size: 200, hash: "hash-b" },
      "lib/c.ts": { mtime: 3000, size: 300, hash: "hash-c" },
    },
    merkleTree: '{"root":null}',
  };

  const v2Path = join(snapshotDir, "migrate-test.json");
  await fs.writeFile(v2Path, JSON.stringify(v2Snapshot, null, 2));

  const migrator = new SnapshotMigrator(snapshotDir, "migrate-test", parallelTestDir, 4);
  assert(await migrator.needsMigration(), "Migration needed for v2 snapshot");

  const migrationResult = await migrator.migrate();
  assert(migrationResult.success, `Migration succeeded: ${migrationResult.error || 'ok'}`);
  assert(migrationResult.filesCount === 3, `Migrated 3 files: ${migrationResult.filesCount}`);

  // Old file should be deleted, backup should exist
  let oldFileExists = false;
  try {
    await fs.access(v2Path);
    oldFileExists = true;
  } catch {}
  assert(!oldFileExists, "Old v2 snapshot removed");

  let backupExists = false;
  try {
    await fs.access(join(snapshotDir, "migrate-test.json.backup"));
    backupExists = true;
  } catch {}
  assert(backupExists, "Backup created during migration");

  // New format should be loadable
  const migratedManager = new ShardedSnapshotManager(snapshotDir, "migrate-test", 4);
  const migratedData = await migratedManager.load();
  assert(migratedData !== null, "Migrated snapshot loads successfully");
  assert(migratedData.files.size === 3, `Migrated data has 3 files: ${migratedData.files.size}`);

  // Migration should not run again
  assert(!(await migrator.needsMigration()), "Migration not needed after completion");

  log("pass", "Parallel sync tests complete");
}
