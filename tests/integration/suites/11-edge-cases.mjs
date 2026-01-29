/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { CodeIndexer } from "../../../build/code/indexer.js";
import { TEST_DIR, getIndexerConfig } from "../config.mjs";

export async function testEdgeCases(qdrant, embeddings) {
  section("10. Edge Cases");

  const edgeTestDir = join(TEST_DIR, "edge_test");
  await fs.mkdir(edgeTestDir, { recursive: true });

  // Empty file
  await createTestFile(edgeTestDir, "empty.ts", "");

  // Whitespace only
  await createTestFile(edgeTestDir, "whitespace.ts", "   \n\n\t\t\n   ");

  // Single line
  await createTestFile(edgeTestDir, "oneline.ts", "export const x = 1;");

  // Very long line
  await createTestFile(edgeTestDir, "longline.ts", `export const data = "${'x'.repeat(5000)}";`);

  // Binary-like content (but still .ts)
  await createTestFile(edgeTestDir, "binary.ts", `export const buf = Buffer.from([${Array(100).fill(0).join(',')}]);`);

  // Deeply nested
  await fs.mkdir(join(edgeTestDir, "a/b/c/d/e"), { recursive: true });
  await createTestFile(edgeTestDir, "a/b/c/d/e/deep.ts", "export const DEEP = true;");

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig());

  // Should not crash
  resources.trackIndexedPath(edgeTestDir);
  let errorOccurred = false;
  try {
    await indexer.indexCodebase(edgeTestDir, { forceReindex: true });
  } catch (e) {
    errorOccurred = true;
    console.log(`    Error: ${e.message}`);
  }
  assert(!errorOccurred, "Edge cases don't crash indexer");

  // Deep file should be indexed
  const deepResults = await indexer.searchCode(edgeTestDir, "DEEP");
  assert(deepResults.length > 0, `Deeply nested file indexed: ${deepResults.length}`);
}
