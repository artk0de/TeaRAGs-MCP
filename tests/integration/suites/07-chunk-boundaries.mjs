/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { CodeIndexer } from "../../../build/code/indexer.js";
import { getIndexerConfig, TEST_DIR } from "../config.mjs";
import { assert, createTestFile, hashContent, log, randomUUID, resources, section, skip, sleep } from "../helpers.mjs";

export async function testChunkBoundaries(qdrant, embeddings) {
  section("7. Chunk Boundaries & Line Numbers");

  const chunkTestDir = join(TEST_DIR, "chunk_test");
  await fs.mkdir(chunkTestDir, { recursive: true });

  // Create a file with distinct sections
  const largeContent = `
// Section 1: Imports (lines 2-5)
import { foo } from 'foo';
import { bar } from 'bar';
import { baz } from 'baz';

// Section 2: Constants (lines 7-15)
const MAGIC_NUMBER_ALPHA = 42;
const MAGIC_NUMBER_BETA = 84;
const MAGIC_NUMBER_GAMMA = 126;
const CONFIG = {
  timeout: 5000,
  retries: 3,
  debug: true,
};

// Section 3: Main Function (lines 17-30)
export function processData(input: string) {
  const result = input
    .split(',')
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .map(x => parseInt(x, 10))
    .reduce((a, b) => a + b, 0);

  console.log('Processing complete');
  return result;
}

// Section 4: Helper (lines 32-40)
function helperFunction() {
  return {
    status: 'ok',
    timestamp: Date.now(),
  };
}
`.trim();

  await createTestFile(chunkTestDir, "large.ts", largeContent);

  const indexer = new CodeIndexer(
    qdrant,
    embeddings,
    getIndexerConfig({
      chunkSize: 300, // Small chunks to force splitting
      chunkOverlap: 30,
    }),
  );

  resources.trackIndexedPath(chunkTestDir);
  const stats = await indexer.indexCodebase(chunkTestDir, { forceReindex: true });
  assert(stats.chunksCreated > 1, `Multiple chunks created: ${stats.chunksCreated}`);

  // Search for content in different sections
  const magicResults = await indexer.searchCode(chunkTestDir, "MAGIC_NUMBER_ALPHA");
  assert(magicResults.length > 0, `Found MAGIC_NUMBER: ${magicResults.length} results`);

  // Line numbers should be defined and non-negative
  const hasValidLineNumbers =
    magicResults[0].startLine !== undefined &&
    magicResults[0].endLine !== undefined &&
    magicResults[0].startLine >= 0 &&
    magicResults[0].endLine >= magicResults[0].startLine;
  assert(hasValidLineNumbers, `Line numbers valid: ${magicResults[0].startLine}-${magicResults[0].endLine}`);

  const processResults = await indexer.searchCode(chunkTestDir, "processData split map filter");
  assert(processResults.length > 0, `Found processData function: ${processResults.length}`);

  const helperResults = await indexer.searchCode(chunkTestDir, "helperFunction timestamp");
  assert(helperResults.length > 0, `Found helper function: ${helperResults.length}`);
}
