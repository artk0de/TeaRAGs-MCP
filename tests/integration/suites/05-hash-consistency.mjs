/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { CodeIndexer } from "../../../build/code/indexer.js";
import { getIndexerConfig, TEST_DIR } from "../config.mjs";
import { assert, createTestFile, hashContent, log, randomUUID, resources, section, skip, sleep } from "../helpers.mjs";

export async function testHashConsistency(qdrant, embeddings) {
  section("5. Hash & Snapshot Consistency");

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig());

  const hashTestDir = join(TEST_DIR, "hash_test");
  await fs.mkdir(hashTestDir, { recursive: true });

  // IMPORTANT: Use different content sizes to bypass mtime+size caching
  // The synchronizer uses mtime+size for fast change detection (1s tolerance)
  const content1 = "export const VERSION = '1.0.0';";
  const content2 = "export const VERSION = '2.0.0'; // Updated version with extra comment to change file size";

  await createTestFile(hashTestDir, "version.ts", content1);

  // Index initial version
  resources.trackIndexedPath(hashTestDir);
  await indexer.indexCodebase(hashTestDir, { forceReindex: true });

  // Calculate expected hash
  const expectedHash1 = hashContent(content1);

  // Reindex should detect no changes for same content
  const noChangeStats = await indexer.reindexChanges(hashTestDir);
  assert(
    noChangeStats.filesAdded === 0 && noChangeStats.filesModified === 0,
    `No changes detected for unchanged file: +${noChangeStats.filesAdded} ~${noChangeStats.filesModified}`,
  );

  // Modify file (content2 has different size to trigger hash recomputation)
  await fs.writeFile(join(hashTestDir, "version.ts"), content2);
  const expectedHash2 = hashContent(content2);
  assert(
    expectedHash1 !== expectedHash2,
    `Hash changes with content: ${expectedHash1.slice(0, 8)} → ${expectedHash2.slice(0, 8)}`,
  );

  // Reindex should detect change
  const changeStats = await indexer.reindexChanges(hashTestDir);
  assert(changeStats.filesModified >= 1, `Modified file detected by hash: ${changeStats.filesModified}`);

  // Revert to original (different size again)
  await fs.writeFile(join(hashTestDir, "version.ts"), content1);
  const revertStats = await indexer.reindexChanges(hashTestDir);
  assert(revertStats.filesModified >= 1, `Reverted file detected: ${revertStats.filesModified}`);
}
