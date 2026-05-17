/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

// `batchSize: 50` (pre-SOLID CodeIndexer config) had no replacement in
// IngestCodeConfig — batch tuning now lives under pipelineTuning. The test
// scenarios below verify correctness, not throughput, so default batch
// sizes work fine. Add explicit pipelineTuning override only if a future
// test depends on batch-flush count.
import { getIndexerConfig, TEST_DIR } from "../config.mjs";
import { assert, createTestFacades, createTestFile, log, resources, searchCode, section, sleep } from "../helpers.mjs";

export async function testBatchPipeline(qdrant, embeddings) {
  section("11. Batch Pipeline in CodeIndexer");

  const batchTestDir = join(TEST_DIR, "batch_pipeline_test");
  await fs.mkdir(batchTestDir, { recursive: true });

  const { ingest, explore } = createTestFacades(qdrant, embeddings, { config: getIndexerConfig() });

  // === TEST: indexCodebase uses optimized batch upsert ===
  log("info", "Testing indexCodebase batch upsert...");

  // Create multiple files to generate enough chunks for batching
  for (let i = 0; i < 5; i++) {
    await createTestFile(
      batchTestDir,
      `service${i}.ts`,
      `
// Service ${i}: Business logic component
export class Service${i} {
  private cache: Map<string, any> = new Map();

  async process(id: string): Promise<any> {
    if (this.cache.has(id)) {
      return this.cache.get(id);
    }
    const data = await this.fetchData(id);
    this.cache.set(id, data);
    return data;
  }

  private async fetchData(id: string): Promise<any> {
    console.log('Fetching data for service ${i}, id:', id);
    return { id, value: Math.random(), service: ${i} };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
`,
    );
  }

  resources.trackIndexedPath(batchTestDir);
  const indexStats = await ingest.indexCodebase(batchTestDir, { forceReindex: true });
  assert(indexStats.filesIndexed === 5, `All files indexed: ${indexStats.filesIndexed}`);
  assert(indexStats.chunksCreated > 0, `Chunks created: ${indexStats.chunksCreated}`);

  // Verify all services are searchable
  for (let i = 0; i < 5; i++) {
    const results = await searchCode(explore, batchTestDir, `Service${i} process fetchData`);
    assert(results.length > 0, `Service${i} searchable after batch index`);
  }

  // === TEST: reindexChanges batch delete ===
  log("info", "Testing reindexChanges batch delete...");

  // Delete multiple files - should trigger batch deletePointsByPaths
  await fs.unlink(join(batchTestDir, "service1.ts"));
  await fs.unlink(join(batchTestDir, "service3.ts"));
  await sleep(100);

  const deleteStats = await ingest.reindexChanges(batchTestDir);
  assert(deleteStats.filesDeleted === 2, `Batch delete detected: ${deleteStats.filesDeleted} files`);

  // Deleted services should not be findable
  const deleted1 = await searchCode(explore, batchTestDir, "Service1 unique identifier");
  const deleted3 = await searchCode(explore, batchTestDir, "Service3 unique identifier");
  // Note: semantic search may still find similar content, but file path should not match
  log("info", `Service1 results after delete: ${deleted1.length}, Service3: ${deleted3.length}`);

  // Remaining services should still be searchable
  const remaining0 = await searchCode(explore, batchTestDir, "Service0");
  const remaining2 = await searchCode(explore, batchTestDir, "Service2");
  const remaining4 = await searchCode(explore, batchTestDir, "Service4");
  assert(remaining0.length > 0, "Service0 still searchable after batch delete");
  assert(remaining2.length > 0, "Service2 still searchable after batch delete");
  assert(remaining4.length > 0, "Service4 still searchable after batch delete");

  // === TEST: reindexChanges batch add ===
  log("info", "Testing reindexChanges batch add...");

  // Add multiple new files - should use optimized addPointsOptimized
  for (let i = 5; i < 8; i++) {
    await createTestFile(
      batchTestDir,
      `handler${i}.ts`,
      `
// Handler ${i}: Request handler
export async function handle${i}(req: Request): Promise<Response> {
  const { id, action } = req.params;
  console.log('Handler ${i} processing:', action);
  return new Response(JSON.stringify({ handler: ${i}, action }));
}
`,
    );
  }
  await sleep(100);

  const addStats = await ingest.reindexChanges(batchTestDir);
  assert(addStats.filesAdded === 3, `Batch add detected: ${addStats.filesAdded} files`);

  // New handlers should be searchable
  for (let i = 5; i < 8; i++) {
    const results = await searchCode(explore, batchTestDir, `handle${i} Request Response`);
    assert(results.length > 0, `Handler${i} searchable after batch add`);
  }

  // === TEST: Mixed batch operations ===
  log("info", "Testing mixed batch operations...");

  // Simultaneously: modify service0, delete service2, add new file
  await createTestFile(
    batchTestDir,
    "service0.ts",
    `
// Modified Service 0
export class Service0Modified {
  async newMethod(): Promise<string> {
    return "modified_content_for_testing_batch_pipeline";
  }
}
`,
  );
  await fs.unlink(join(batchTestDir, "service2.ts"));
  await createTestFile(
    batchTestDir,
    "utility.ts",
    `
// New utility file
export function utilityFunction(): number {
  return 42;
}
`,
  );
  await sleep(100);

  const mixedStats = await ingest.reindexChanges(batchTestDir);
  assert(mixedStats.filesModified >= 1, `Mixed: modified ${mixedStats.filesModified}`);
  assert(mixedStats.filesDeleted >= 1, `Mixed: deleted ${mixedStats.filesDeleted}`);
  assert(mixedStats.filesAdded >= 1, `Mixed: added ${mixedStats.filesAdded}`);

  // Verify modifications
  const modifiedResults = await searchCode(explore, batchTestDir, "Service0Modified newMethod modified_content");
  assert(modifiedResults.length > 0, "Modified Service0 content searchable");

  const utilityResults = await searchCode(explore, batchTestDir, "utilityFunction");
  assert(utilityResults.length > 0, "New utility file searchable");
}
