/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { CodeIndexer } from "../../../build/code/indexer.js";
import { TEST_DIR, getIndexerConfig } from "../config.mjs";

export async function testConcurrentSafety(qdrant, embeddings) {
  section("12. Concurrent Operations");

  const concTestDir = join(TEST_DIR, "conc_test");
  await fs.mkdir(concTestDir, { recursive: true });

  for (let i = 0; i < 5; i++) {
    await createTestFile(concTestDir, `file${i}.ts`, `export const FILE_${i} = ${i};`);
  }

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig());

  // Index first
  resources.trackIndexedPath(concTestDir);
  await indexer.indexCodebase(concTestDir, { forceReindex: true });

  // Concurrent searches should not interfere
  const searches = await Promise.all([
    indexer.searchCode(concTestDir, "FILE_0"),
    indexer.searchCode(concTestDir, "FILE_1"),
    indexer.searchCode(concTestDir, "FILE_2"),
    indexer.searchCode(concTestDir, "FILE_3"),
    indexer.searchCode(concTestDir, "FILE_4"),
  ]);

  assert(searches.every(s => s.length > 0), `All concurrent searches returned results`);

  // Concurrent status checks
  const statuses = await Promise.all([
    indexer.getIndexStatus(concTestDir),
    indexer.getIndexStatus(concTestDir),
    indexer.getIndexStatus(concTestDir),
  ]);

  assert(
    statuses.every(s => s.status === "indexed" || s.isIndexed),
    "Concurrent status checks consistent"
  );
}
