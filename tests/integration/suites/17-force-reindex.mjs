/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { CodeIndexer } from "../../../build/code/indexer.js";
import { TEST_DIR, getIndexerConfig } from "../config.mjs";

export async function testForceReindexBehavior(qdrant, embeddings) {
  section("16. ForceReindex Early Return & Parallel Indexing");

  const forceTestDir = join(TEST_DIR, "force_reindex_test");
  await fs.mkdir(forceTestDir, { recursive: true });

  // Create test files
  await createTestFile(forceTestDir, "service1.ts", `
export class Service1 {
  process(data: string): string {
    return data.toUpperCase();
  }
}
`);
  await createTestFile(forceTestDir, "service2.ts", `
export class Service2 {
  calculate(x: number): number {
    return x * 2;
  }
}
`);

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig());

  // === TEST 1: Initial indexing should succeed ===
  log("info", "Testing initial indexing...");
  resources.trackIndexedPath(forceTestDir);
  const initialStats = await indexer.indexCodebase(forceTestDir);
  assert(initialStats.status === "completed", `Initial indexing completed: ${initialStats.status}`);
  assert(initialStats.filesIndexed >= 2, `Initial files indexed: ${initialStats.filesIndexed}`);
  assert(initialStats.chunksCreated > 0, `Initial chunks created: ${initialStats.chunksCreated}`);

  // === TEST 2: Re-indexing without forceReindex should return early ===
  log("info", "Testing early return when collection exists...");
  const reindexStats = await indexer.indexCodebase(forceTestDir);
  assert(reindexStats.status === "completed", `Reindex returns completed status`);
  assert(reindexStats.filesIndexed === 0, `No files indexed on re-run without force: ${reindexStats.filesIndexed}`);
  assert(reindexStats.chunksCreated === 0, `No chunks created on re-run without force: ${reindexStats.chunksCreated}`);
  assert(
    reindexStats.errors?.some(e => e.includes("Collection already exists")),
    "Error message mentions collection exists"
  );

  // === TEST 3: Re-indexing with forceReindex should work ===
  log("info", "Testing forceReindex=true...");
  const forceStats = await indexer.indexCodebase(forceTestDir, { forceReindex: true });
  assert(forceStats.status === "completed", `Force reindex completed: ${forceStats.status}`);
  assert(forceStats.filesIndexed >= 2, `Force reindex indexed files: ${forceStats.filesIndexed}`);
  assert(forceStats.chunksCreated > 0, `Force reindex created chunks: ${forceStats.chunksCreated}`);

  // === TEST 4: Verify search still works after force reindex ===
  log("info", "Testing search after force reindex...");
  const searchResults = await indexer.searchCode(forceTestDir, "process data");
  assert(searchResults.length > 0, `Search returns results after force reindex: ${searchResults.length}`);

  // === TEST 5: Parallel processing validation ===
  log("info", "Testing parallel file processing...");

  // Create more files for parallel processing test
  const parallelDir = join(TEST_DIR, "parallel_index_test");
  await fs.mkdir(parallelDir, { recursive: true });

  for (let i = 0; i < 30; i++) {
    await createTestFile(parallelDir, `module${i}.ts`, `
// Module ${i} - Test file for parallel processing
export class Module${i} {
  private id: number = ${i};

  process(): number {
    console.log('Processing module ${i}');
    return this.id * 2;
  }

  getName(): string {
    return 'Module${i}';
  }
}
`);
  }

  resources.trackIndexedPath(parallelDir);
  const startTime = Date.now();
  const parallelStats = await indexer.indexCodebase(parallelDir);
  const duration = Date.now() - startTime;

  assert(parallelStats.status === "completed", `Parallel indexing completed: ${parallelStats.status}`);
  assert(parallelStats.filesIndexed === 30, `All 30 files indexed: ${parallelStats.filesIndexed}`);
  assert(parallelStats.chunksCreated > 0, `Chunks created: ${parallelStats.chunksCreated}`);

  // Verify random samples are searchable
  const sampleResults1 = await indexer.searchCode(parallelDir, "Module5 process");
  const sampleResults2 = await indexer.searchCode(parallelDir, "Module15 getName");
  const sampleResults3 = await indexer.searchCode(parallelDir, "Module25 id");

  assert(sampleResults1.length > 0, `Module5 searchable: ${sampleResults1.length}`);
  assert(sampleResults2.length > 0, `Module15 searchable: ${sampleResults2.length}`);
  assert(sampleResults3.length > 0, `Module25 searchable: ${sampleResults3.length}`);

  console.log(`    30 files indexed in ${(duration / 1000).toFixed(2)}s (${(30 / (duration / 1000)).toFixed(1)} files/s)`);

  log("pass", "ForceReindex behavior and parallel indexing verified");
}
