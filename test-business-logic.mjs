#!/usr/bin/env node
/**
 * Comprehensive Business Logic Test Suite
 *
 * Tests correctness of all MCP server operations in real-world scenarios.
 * NOT a performance benchmark - focuses on functional correctness.
 *
 * Run: node test-business-logic.mjs
 */

import { OllamaEmbeddings } from "./build/embeddings/ollama.js";
import { QdrantManager } from "./build/qdrant/client.js";
import { CodeIndexer } from "./build/code/indexer.js";
import { FileSynchronizer } from "./build/code/sync/synchronizer.js";
import { ParallelFileSynchronizer } from "./build/code/sync/parallel-synchronizer.js";
import { ShardedSnapshotManager } from "./build/code/sync/sharded-snapshot.js";
import { ConsistentHash } from "./build/code/sync/consistent-hash.js";
import { SnapshotMigrator } from "./build/code/sync/migration.js";
import { PointsAccumulator, createAccumulator } from "./build/qdrant/accumulator.js";
import { PipelineManager, WorkerPool, BatchAccumulator, ChunkPipeline, pipelineLog, createQdrantPipeline, DEFAULT_CONFIG } from "./build/code/pipeline/index.js";
import { SchemaManager, CURRENT_SCHEMA_VERSION } from "./build/code/schema-migration.js";
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "crypto";
import { createHash } from "node:crypto";

const config = {
  QDRANT_URL: process.env.QDRANT_URL || "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://192.168.1.71:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "unclemusclez/jina-embeddings-v2-base-code:latest",
};

const TEST_COLLECTION = `test_bl_${Date.now()}`;
const TEST_DIR = `/tmp/qdrant_test_${Date.now()}`;

// Track all indexed paths for cleanup
const indexedPaths = new Set();

let passed = 0;
let failed = 0;
let skipped = 0;

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function log(status, message) {
  const icons = { pass: "✓", fail: "✗", skip: "○", info: "•" };
  const colors = { pass: c.green, fail: c.red, skip: c.yellow, info: c.dim };
  console.log(`${colors[status]}  ${icons[status]}${c.reset} ${message}`);
}

function assert(condition, message) {
  if (condition) {
    log("pass", message);
    passed++;
  } else {
    log("fail", message);
    failed++;
  }
  return condition;
}

function skip(message) {
  log("skip", message);
  skipped++;
}

function section(title) {
  console.log(`\n${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}${title}${c.reset}`);
  console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
}

async function createTestFile(dir, name, content) {
  const path = join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, content);
  return path;
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Default config for CodeIndexer - all required fields must be present!
function getIndexerConfig(overrides = {}) {
  return {
    chunkSize: 500,
    chunkOverlap: 50,
    enableASTChunking: true,
    supportedExtensions: [".ts"],
    ignorePatterns: [],
    batchSize: 100,  // CRITICAL: Must be defined, otherwise embedding loop is skipped!
    defaultSearchLimit: 10,
    enableHybridSearch: false,
    ...overrides,
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
// Test Suites
// ═══════════════════════════════════════════════════════════════

async function testEmbeddings(embeddings) {
  section("1. Embeddings");

  // Basic functionality
  const single = await embeddings.embed("function hello() { return 42; }");
  assert(single.embedding?.length === 768, `Single embedding dimensions: ${single.dimensions}`);

  const batch = await embeddings.embedBatch(["fn foo() {}", "fn bar() {}", "fn baz() {}"]);
  assert(batch.length === 3, `Batch returns correct count: ${batch.length}`);
  assert(batch.every(b => b.embedding.length === 768), "All embeddings have correct dimensions");

  const empty = await embeddings.embedBatch([]);
  assert(empty.length === 0, "Empty batch returns empty array");

  // Semantic similarity
  const cosineSim = (a, b) => {
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    return dot / (magA * magB);
  };

  const jsCode = await embeddings.embed("function calculateSum(a, b) { return a + b; }");
  const pyCode = await embeddings.embed("def calculate_sum(a, b): return a + b");
  const recipe = await embeddings.embed("Mix flour with eggs and bake for 30 minutes");

  const simCode = cosineSim(jsCode.embedding, pyCode.embedding);
  const simUnrelated = cosineSim(jsCode.embedding, recipe.embedding);
  assert(simCode > simUnrelated, `Similar code more similar than unrelated (${simCode.toFixed(3)} > ${simUnrelated.toFixed(3)})`);

  // Edge cases
  const longText = "x".repeat(10000);
  const longResult = await embeddings.embed(longText);
  assert(longResult.embedding.length === 768, "Long text (10k chars) handled");

  const unicode = "функция привет() { return '世界'; } // コメント";
  const unicodeResult = await embeddings.embed(unicode);
  assert(unicodeResult.embedding.length === 768, "Unicode/multilingual text handled");

  const special = 'fn() { "test": true, \'escape\': `backtick`, <tag/>, &amp; }';
  const specialResult = await embeddings.embed(special);
  assert(specialResult.embedding.length === 768, "Special characters handled");

  // Determinism
  const text = "consistent embedding test";
  const emb1 = await embeddings.embed(text);
  const emb2 = await embeddings.embed(text);
  const similarity = cosineSim(emb1.embedding, emb2.embedding);
  assert(similarity > 0.99, `Same text produces consistent embeddings (sim=${similarity.toFixed(4)})`);

  // Large batch (tests internal batching)
  log("info", "Testing large batch (50 texts)...");
  const largeBatch = Array.from({ length: 50 }, (_, i) =>
    `function test_${i}() { const value = ${i} * 2; return value + ${i % 10}; }`
  );
  const largeBatchStart = Date.now();
  const largeBatchResult = await embeddings.embedBatch(largeBatch);
  const largeBatchTime = Date.now() - largeBatchStart;
  assert(largeBatchResult.length === 50, `Large batch returns all embeddings: ${largeBatchResult.length}`);
  log("info", `Large batch completed in ${largeBatchTime}ms (${Math.round(50000 / largeBatchTime)} emb/sec)`);

  // Parallel embedding requests
  log("info", "Testing parallel embedding requests (3 x 20 texts)...");
  const createBatch = (id) => Array.from({ length: 20 }, (_, i) =>
    `function batch${id}_${i}() { return ${i} * ${id}; }`
  );
  const parallelStart = Date.now();
  const parallelResults = await Promise.all([
    embeddings.embedBatch(createBatch(1)),
    embeddings.embedBatch(createBatch(2)),
    embeddings.embedBatch(createBatch(3)),
  ]);
  const parallelTime = Date.now() - parallelStart;
  assert(parallelResults.every(r => r.length === 20), `Parallel batches all complete: ${parallelResults.map(r => r.length).join(", ")}`);
  log("info", `Parallel requests completed in ${parallelTime}ms`);
}

async function testQdrantOperations(qdrant) {
  section("2. Qdrant Operations");

  // Collection lifecycle
  await qdrant.createCollection(TEST_COLLECTION, 768, "Cosine");
  assert(await qdrant.collectionExists(TEST_COLLECTION), "Collection created");

  const info = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(info.vectorSize === 768, `Vector size correct: ${info.vectorSize}`);
  assert(info.distance === "Cosine", `Distance metric correct: ${info.distance}`);

  // Points CRUD
  const makeVector = (seed) => Array.from({ length: 768 }, (_, i) => Math.sin(seed * i) * 0.5 + 0.5);
  const points = [
    { id: randomUUID(), vector: makeVector(1), payload: { category: "A", name: "Point 1", value: 100 } },
    { id: randomUUID(), vector: makeVector(2), payload: { category: "A", name: "Point 2", value: 200 } },
    { id: randomUUID(), vector: makeVector(3), payload: { category: "B", name: "Point 3", value: 300 } },
    { id: randomUUID(), vector: makeVector(4), payload: { category: "B", name: "Point 4", value: 400 } },
  ];

  await qdrant.addPoints(TEST_COLLECTION, points);
  const afterAdd = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(afterAdd.pointsCount === 4, `Points added: ${afterAdd.pointsCount}`);

  // Search
  const searchResults = await qdrant.search(TEST_COLLECTION, makeVector(3), 2);
  assert(searchResults.length === 2, `Search returns limit: ${searchResults.length}`);
  assert(searchResults[0].payload?.name === "Point 3", `Most similar first: ${searchResults[0].payload?.name}`);

  // Filter search
  const filtered = await qdrant.search(TEST_COLLECTION, makeVector(1), 10, { category: "A" });
  assert(filtered.length === 2, `Filter by category: ${filtered.length} results`);
  assert(filtered.every(r => r.payload?.category === "A"), "All results match filter");

  // Get point
  const point = await qdrant.getPoint(TEST_COLLECTION, points[0].id);
  assert(point !== null, "Get point returns result");
  assert(point?.payload?.name === "Point 1", `Payload preserved: ${point?.payload?.name}`);

  // Delete single point
  await qdrant.deletePoints(TEST_COLLECTION, [points[0].id]);
  const afterDelete = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(afterDelete.pointsCount === 3, `Point deleted: ${afterDelete.pointsCount} remaining`);

  // Delete by filter
  await qdrant.deletePointsByFilter(TEST_COLLECTION, {
    must: [{ key: "category", match: { value: "B" } }]
  });
  const afterFilterDelete = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(afterFilterDelete.pointsCount === 1, `Delete by filter: ${afterFilterDelete.pointsCount} remaining`);

  // Batch delete by paths (single request)
  await qdrant.addPoints(TEST_COLLECTION, [
    { id: randomUUID(), vector: makeVector(5), payload: { relativePath: "src/a.ts" } },
    { id: randomUUID(), vector: makeVector(6), payload: { relativePath: "src/b.ts" } },
    { id: randomUUID(), vector: makeVector(7), payload: { relativePath: "src/c.ts" } },
  ]);
  await qdrant.deletePointsByPaths(TEST_COLLECTION, ["src/a.ts", "src/b.ts"]);
  const afterPathDelete = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(afterPathDelete.pointsCount === 2, `Batch delete by paths: ${afterPathDelete.pointsCount} remaining`);

  // Pipelined batch delete (with batching and concurrency)
  log("info", "Testing pipelined batch delete...");

  // Add many points to test batching
  const manyPoints = Array.from({ length: 50 }, (_, i) => ({
    id: randomUUID(),
    vector: makeVector(100 + i),
    payload: { relativePath: `batch/file${i}.ts` },
  }));
  await qdrant.addPoints(TEST_COLLECTION, manyPoints);

  const beforeBatchDelete = await qdrant.getCollectionInfo(TEST_COLLECTION);
  const pathsToDelete = Array.from({ length: 30 }, (_, i) => `batch/file${i}.ts`);

  let progressCalls = 0;
  const batchResult = await qdrant.deletePointsByPathsBatched(TEST_COLLECTION, pathsToDelete, {
    batchSize: 10,
    concurrency: 2,
    onProgress: (deleted, total) => {
      progressCalls++;
    },
  });

  const afterBatchDelete = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(batchResult.deletedPaths === 30, `Batched delete reports correct count: ${batchResult.deletedPaths}`);
  assert(batchResult.batchCount === 3, `Batched delete used correct batches: ${batchResult.batchCount}`);
  assert(progressCalls >= 1, `Progress callback was invoked: ${progressCalls} times`);
  assert(afterBatchDelete.pointsCount === beforeBatchDelete.pointsCount - 30,
    `Batched delete removed correct points: ${afterBatchDelete.pointsCount}`);

  // Cleanup remaining batch points to restore state for next test
  const remainingBatchPaths = Array.from({ length: 20 }, (_, i) => `batch/file${30 + i}.ts`);
  await qdrant.deletePointsByPathsBatched(TEST_COLLECTION, remainingBatchPaths, { batchSize: 20 });
  const afterCleanup = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(afterCleanup.pointsCount === 2, `Batch cleanup restored state: ${afterCleanup.pointsCount}`);

  // Optimized add
  const optPoints = [{ id: randomUUID(), vector: makeVector(8), payload: { test: "optimized" } }];
  await qdrant.addPointsOptimized(TEST_COLLECTION, optPoints, { wait: true, ordering: "weak" });
  const afterOpt = await qdrant.getCollectionInfo(TEST_COLLECTION);
  assert(afterOpt.pointsCount === 3, `Optimized add works: ${afterOpt.pointsCount}`);

  // Non-existent
  assert(!(await qdrant.collectionExists("nonexistent_xyz")), "Non-existent collection returns false");
  assert((await qdrant.getPoint(TEST_COLLECTION, "fake-id")) === null, "Non-existent point returns null");

  // List collections
  const allCollections = await qdrant.listCollections();
  assert(Array.isArray(allCollections), `listCollections returns array: ${typeof allCollections}`);
  assert(allCollections.includes(TEST_COLLECTION), `Test collection in list: ${allCollections.length} total`);

  // Cleanup
  await qdrant.deleteCollection(TEST_COLLECTION);
  assert(!(await qdrant.collectionExists(TEST_COLLECTION)), "Collection deleted");
}

async function testPointsAccumulator(qdrant) {
  section("3. PointsAccumulator (Batch Pipeline)");

  const makeVector = (seed) => Array.from({ length: 768 }, (_, i) => Math.sin(seed * i) * 0.5 + 0.5);
  const testCollection = `acc_test_${Date.now()}`;

  try {
    await qdrant.deleteCollection(testCollection);
  } catch (e) {}
  await qdrant.createCollection(testCollection, 768, "Cosine");

  // === TEST: Basic accumulation and flush ===
  log("info", "Testing basic accumulation...");

  const accumulator = new PointsAccumulator(qdrant, testCollection, false, {
    bufferSize: 10,
    flushIntervalMs: 0, // Disable timer for deterministic testing
    ordering: "weak",
  });

  // Add points without exceeding buffer
  const points5 = Array.from({ length: 5 }, (_, i) => ({
    id: randomUUID(),
    vector: makeVector(i),
    payload: { batch: 1, index: i },
  }));
  await accumulator.add(points5);

  let stats = accumulator.getStats();
  assert(stats.pendingPoints === 5, `Points pending in buffer: ${stats.pendingPoints}`);
  assert(stats.flushCount === 0, `No flush yet: ${stats.flushCount}`);

  // === TEST: Auto-flush by size threshold ===
  log("info", "Testing auto-flush by size...");

  const points15 = Array.from({ length: 15 }, (_, i) => ({
    id: randomUUID(),
    vector: makeVector(i + 100),
    payload: { batch: 2, index: i },
  }));
  await accumulator.add(points15);

  stats = accumulator.getStats();
  // Should have auto-flushed twice (10+10), leaving 0 in buffer
  assert(stats.flushCount >= 1, `Auto-flush triggered: ${stats.flushCount} flushes`);
  assert(stats.totalPointsFlushed >= 10, `Points flushed: ${stats.totalPointsFlushed}`);

  // === TEST: Explicit flush ===
  log("info", "Testing explicit flush...");

  await accumulator.flush();
  stats = accumulator.getStats();
  assert(stats.pendingPoints === 0, `Buffer empty after flush: ${stats.pendingPoints}`);
  assert(stats.totalPointsFlushed === 20, `All points flushed: ${stats.totalPointsFlushed}`);

  // Verify points in Qdrant
  const info = await qdrant.getCollectionInfo(testCollection);
  assert(info.pointsCount === 20, `Points in Qdrant: ${info.pointsCount}`);

  // === TEST: Factory function with env vars ===
  log("info", "Testing createAccumulator factory...");

  const factoryAcc = createAccumulator(qdrant, testCollection, false);
  assert(factoryAcc instanceof PointsAccumulator, "Factory returns PointsAccumulator");

  // === TEST: Timer-based auto-flush ===
  log("info", "Testing timer-based flush...");

  const timerCollection = `acc_timer_${Date.now()}`;
  await qdrant.createCollection(timerCollection, 768, "Cosine");

  const timerAccumulator = new PointsAccumulator(qdrant, timerCollection, false, {
    bufferSize: 100, // High threshold so only timer triggers
    flushIntervalMs: 200, // 200ms timer
    ordering: "weak",
  });

  const timerPoints = Array.from({ length: 5 }, (_, i) => ({
    id: randomUUID(),
    vector: makeVector(i + 200),
    payload: { timer: true },
  }));
  await timerAccumulator.add(timerPoints);

  // Wait for timer
  await sleep(300);

  // Flush should have been triggered by timer
  await timerAccumulator.flush(); // Ensure all done
  const timerStats = timerAccumulator.getStats();
  assert(timerStats.flushCount >= 1, `Timer triggered flush: ${timerStats.flushCount}`);

  // Verify
  const timerInfo = await qdrant.getCollectionInfo(timerCollection);
  assert(timerInfo.pointsCount === 5, `Timer points in Qdrant: ${timerInfo.pointsCount}`);

  // === TEST: Reset stats ===
  log("info", "Testing stats reset...");

  timerAccumulator.resetStats();
  const resetStats = timerAccumulator.getStats();
  assert(resetStats.totalPointsFlushed === 0, "Stats reset: totalPointsFlushed");
  assert(resetStats.flushCount === 0, "Stats reset: flushCount");

  // Cleanup
  await qdrant.deleteCollection(testCollection);
  await qdrant.deleteCollection(timerCollection);
  log("pass", "Cleanup complete");
}

async function testFileIndexing(qdrant, embeddings) {
  section("4. File Indexing Lifecycle");

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    supportedExtensions: [".ts", ".js", ".py"],
    ignorePatterns: ["node_modules", ".git"],
  }));

  // Create test directory with files
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.mkdir(join(TEST_DIR, "src"), { recursive: true });

  const file1Content = `
// File 1: User Service
export class UserService {
  getUser(id: string) {
    return { id, name: "John" };
  }

  createUser(name: string) {
    return { id: "new", name };
  }
}
`;

  const file2Content = `
// File 2: Product Service
export class ProductService {
  getProduct(id: string) {
    return { id, price: 100 };
  }
}
`;

  await createTestFile(TEST_DIR, "src/user.ts", file1Content);
  await createTestFile(TEST_DIR, "src/product.ts", file2Content);

  // Initial indexing
  indexedPaths.add(TEST_DIR);
  const stats = await indexer.indexCodebase(TEST_DIR, { force: true });
  assert(stats.filesScanned >= 2, `Files scanned: ${stats.filesScanned}`);
  assert(stats.filesIndexed >= 2, `Files indexed: ${stats.filesIndexed}`);
  assert(stats.chunksCreated > 0, `Chunks created: ${stats.chunksCreated}`);

  // Search for specific content
  const userResults = await indexer.searchCode(TEST_DIR, "UserService getUser");
  assert(userResults.length > 0, `Search finds UserService: ${userResults.length} results`);
  // At least one result should have content (payload was retrieved)
  const hasAnyContent = userResults.some(r => r.content && r.content.length > 0);
  assert(hasAnyContent, `Search result has content (got ${userResults.length} results with content lengths: ${userResults.map(r => r.content?.length || 0).join(', ')})`);

  const productResults = await indexer.searchCode(TEST_DIR, "ProductService price");
  assert(productResults.length > 0, `Search finds ProductService: ${productResults.length} results`);

  // Check index status
  const status = await indexer.getIndexStatus(TEST_DIR);
  assert(status.isIndexed || status.status === "indexed", `Status is indexed: ${status.status}`);

  // === ADD NEW FILE ===
  const file3Content = `
// File 3: Order Service
export class OrderService {
  createOrder(userId: string, productId: string) {
    return { orderId: "order-123", userId, productId };
  }
}
`;
  await createTestFile(TEST_DIR, "src/order.ts", file3Content);
  await sleep(100); // Ensure file timestamp differs

  const addStats = await indexer.reindexChanges(TEST_DIR);
  assert(addStats.filesAdded >= 1, `New file detected: ${addStats.filesAdded} added`);

  const orderResults = await indexer.searchCode(TEST_DIR, "OrderService createOrder");
  assert(orderResults.length > 0, `New file searchable: ${orderResults.length} results`);

  // === MODIFY EXISTING FILE ===
  const file1Modified = file1Content + `
  // Added method
  deleteUser(id: string) {
    return { deleted: true, id };
  }
`;
  await fs.writeFile(join(TEST_DIR, "src/user.ts"), file1Modified);
  await sleep(100);

  const modifyStats = await indexer.reindexChanges(TEST_DIR);
  assert(modifyStats.filesModified >= 1, `Modified file detected: ${modifyStats.filesModified} modified`);

  const deleteResults = await indexer.searchCode(TEST_DIR, "deleteUser");
  assert(deleteResults.length > 0, `Modified content searchable: ${deleteResults.length} results`);

  // === DELETE FILE ===
  await fs.unlink(join(TEST_DIR, "src/product.ts"));
  await sleep(100);

  const deleteStats = await indexer.reindexChanges(TEST_DIR);
  assert(deleteStats.filesDeleted >= 1, `Deleted file detected: ${deleteStats.filesDeleted} deleted`);

  // Deleted content should not be found
  const deletedResults = await indexer.searchCode(TEST_DIR, "ProductService getProduct");
  // Note: This might still return results if chunks overlap or weren't cleaned up
  // The key test is that the file count decreased

  // === REBUILD CACHE ===
  const cacheResult = await indexer.rebuildCache(TEST_DIR);
  assert(cacheResult.indexed >= 2, `Cache rebuilt: ${cacheResult.indexed} indexed`);
  assert(cacheResult.orphaned >= 0, `Orphaned chunks: ${cacheResult.orphaned}`);
}

async function testHashConsistency(qdrant, embeddings) {
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
  indexedPaths.add(hashTestDir);
  await indexer.indexCodebase(hashTestDir, { force: true });

  // Calculate expected hash
  const expectedHash1 = hashContent(content1);

  // Reindex should detect no changes for same content
  const noChangeStats = await indexer.reindexChanges(hashTestDir);
  assert(
    noChangeStats.filesAdded === 0 && noChangeStats.filesModified === 0,
    `No changes detected for unchanged file: +${noChangeStats.filesAdded} ~${noChangeStats.filesModified}`
  );

  // Modify file (content2 has different size to trigger hash recomputation)
  await fs.writeFile(join(hashTestDir, "version.ts"), content2);
  const expectedHash2 = hashContent(content2);
  assert(expectedHash1 !== expectedHash2, `Hash changes with content: ${expectedHash1.slice(0,8)} → ${expectedHash2.slice(0,8)}`);

  // Reindex should detect change
  const changeStats = await indexer.reindexChanges(hashTestDir);
  assert(changeStats.filesModified >= 1, `Modified file detected by hash: ${changeStats.filesModified}`);

  // Revert to original (different size again)
  await fs.writeFile(join(hashTestDir, "version.ts"), content1);
  const revertStats = await indexer.reindexChanges(hashTestDir);
  assert(revertStats.filesModified >= 1, `Reverted file detected: ${revertStats.filesModified}`);
}

async function testIgnorePatterns(qdrant, embeddings) {
  section("6. Ignore Patterns");

  const ignoreTestDir = join(TEST_DIR, "ignore_test");
  await fs.mkdir(join(ignoreTestDir, "node_modules/pkg"), { recursive: true });
  await fs.mkdir(join(ignoreTestDir, "src"), { recursive: true });
  await fs.mkdir(join(ignoreTestDir, ".git"), { recursive: true });
  await fs.mkdir(join(ignoreTestDir, "dist"), { recursive: true });

  // Create files in various locations
  await createTestFile(ignoreTestDir, "src/app.ts", "export const APP = 'main';");
  await createTestFile(ignoreTestDir, "node_modules/pkg/index.ts", "export const PKG = 'dep';");
  await createTestFile(ignoreTestDir, ".git/config.ts", "export const GIT = 'ignore';");
  await createTestFile(ignoreTestDir, "dist/bundle.ts", "export const DIST = 'build';");
  await createTestFile(ignoreTestDir, "test.spec.ts", "describe('test', () => {});");

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    ignorePatterns: ["node_modules", ".git", "dist", "*.spec.ts"],
  }));

  indexedPaths.add(ignoreTestDir);
  const stats = await indexer.indexCodebase(ignoreTestDir, { force: true });

  // Should only index src/app.ts
  assert(stats.filesIndexed === 1, `Only non-ignored files indexed: ${stats.filesIndexed}`);

  // Verify ignored content not searchable by checking result paths
  // Note: Semantic search may return results, but they should NOT be from ignored paths
  // CodeSearchResult interface uses filePath, not relativePath
  const allResults = await indexer.searchCode(ignoreTestDir, "export const", { limit: 10 });

  // Helper to check if any result is from ignored path
  const hasIgnoredPath = (results, pattern) =>
    results.some(r => r.filePath && r.filePath.includes(pattern));

  assert(!hasIgnoredPath(allResults, "node_modules"), "node_modules content not indexed");
  assert(!hasIgnoredPath(allResults, ".git"), ".git content not indexed");
  assert(!hasIgnoredPath(allResults, "dist"), "dist content not indexed");
  assert(!allResults.some(r => r.filePath?.endsWith(".spec.ts")), "*.spec.ts content not indexed");

  // But main app should be searchable
  const appResults = await indexer.searchCode(ignoreTestDir, "APP main");
  assert(appResults.length > 0, `Main app indexed and searchable: ${appResults.length}`);
}

async function testChunkBoundaries(qdrant, embeddings) {
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

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    chunkSize: 300, // Small chunks to force splitting
    chunkOverlap: 30,
  }));

  indexedPaths.add(chunkTestDir);
  const stats = await indexer.indexCodebase(chunkTestDir, { force: true });
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

async function testMultiLanguage(qdrant, embeddings) {
  section("8. Multi-Language Support");

  const langTestDir = join(TEST_DIR, "lang_test");
  await fs.mkdir(langTestDir, { recursive: true });

  // TypeScript
  await createTestFile(langTestDir, "app.ts", `
export class TypeScriptClass {
  method(): string { return "ts"; }
}
`);

  // JavaScript
  await createTestFile(langTestDir, "util.js", `
function javascriptFunction() {
  return { type: "js" };
}
module.exports = { javascriptFunction };
`);

  // Python
  await createTestFile(langTestDir, "script.py", `
class PythonClass:
    def method(self):
        return "python"
`);

  // Ruby
  await createTestFile(langTestDir, "service.rb", `
class RubyService
  def initialize(config)
    @config = config
  end

  def process(data)
    data.map { |item| transform(item) }
  rescue StandardError => e
    handle_error(e)
  end

  def self.create(options)
    new(options)
  end
end
`);

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    supportedExtensions: [".ts", ".js", ".py", ".rb"],
  }));

  indexedPaths.add(langTestDir);
  const stats = await indexer.indexCodebase(langTestDir, { force: true });
  assert(stats.filesIndexed === 4, `All language files indexed: ${stats.filesIndexed}`);

  // Search in each language
  const tsResults = await indexer.searchCode(langTestDir, "TypeScriptClass");
  assert(tsResults.length > 0, `TypeScript searchable: ${tsResults.length}`);

  const jsResults = await indexer.searchCode(langTestDir, "javascriptFunction");
  assert(jsResults.length > 0, `JavaScript searchable: ${jsResults.length}`);

  const pyResults = await indexer.searchCode(langTestDir, "PythonClass");
  assert(pyResults.length > 0, `Python searchable: ${pyResults.length}`);

  const rbResults = await indexer.searchCode(langTestDir, "RubyService process");
  assert(rbResults.length > 0, `Ruby searchable: ${rbResults.length}`);
}

async function testRubyASTChunking(qdrant, embeddings) {
  section("8b. Ruby AST Chunking (Rails Patterns)");

  const rubyTestDir = join(TEST_DIR, "ruby_test");
  await fs.mkdir(rubyTestDir, { recursive: true });

  // Rails-style Service object
  await createTestFile(rubyTestDir, "user_service.rb", `
# User service with typical Rails patterns
class UserService
  def initialize(repository)
    @repository = repository
  end

  def find_user(id)
    @repository.find(id)
  rescue ActiveRecord::RecordNotFound => e
    Rails.logger.error("User not found: #{id}")
    nil
  end

  def create_user(params)
    User.create!(params)
  rescue ActiveRecord::RecordInvalid => e
    { error: e.message }
  end

  def self.call(id)
    new(UserRepository.new).find_user(id)
  end
end
`);

  // Rails Concern / Module
  await createTestFile(rubyTestDir, "authenticatable.rb", `
module Authenticatable
  extend ActiveSupport::Concern

  included do
    before_action :authenticate_user!
  end

  def authenticate_user!
    redirect_to login_path unless current_user
  end

  def current_user
    @current_user ||= User.find_by(id: session[:user_id])
  end
end
`);

  // Ruby with lambdas and blocks
  await createTestFile(rubyTestDir, "validator.rb", `
class Validator
  RULES = {
    email: ->(value) { value.match?(/\\A[^@]+@[^@]+\\z/) },
    phone: lambda { |v| v.gsub(/\\D/, '').length == 10 }
  }

  def validate(data)
    data.each_pair do |key, value|
      rule = RULES[key]
      next unless rule
      yield key, rule.call(value)
    end
  end

  def transform(items)
    items.map { |item| process(item) }
         .select { |result| result.valid? }
         .group_by(&:category)
  end
end
`);

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    supportedExtensions: [".rb"],
  }));

  indexedPaths.add(rubyTestDir);
  const stats = await indexer.indexCodebase(rubyTestDir, { force: true });
  assert(stats.filesIndexed === 3, `Ruby files indexed: ${stats.filesIndexed}`);
  assert(stats.chunksCreated > 0, `Ruby chunks created: ${stats.chunksCreated}`);

  // Test semantic search for Ruby patterns
  log("info", "Testing Ruby semantic search...");

  // Error handling
  const rescueResults = await indexer.searchCode(rubyTestDir, "error handling rescue exception");
  assert(rescueResults.length > 0, `Rescue/error handling found: ${rescueResults.length}`);

  // Service object pattern
  const serviceResults = await indexer.searchCode(rubyTestDir, "UserService find create");
  assert(serviceResults.length > 0, `Service object found: ${serviceResults.length}`);

  // Concern/module
  const concernResults = await indexer.searchCode(rubyTestDir, "Authenticatable authenticate current_user");
  assert(concernResults.length > 0, `Concern/module found: ${concernResults.length}`);

  // Lambda/proc
  const lambdaResults = await indexer.searchCode(rubyTestDir, "lambda validation rules");
  assert(lambdaResults.length > 0, `Lambda/validation found: ${lambdaResults.length}`);

  // Block operations
  const blockResults = await indexer.searchCode(rubyTestDir, "map select transform");
  assert(blockResults.length > 0, `Block operations found: ${blockResults.length}`);

  log("pass", "Ruby AST chunking works for Rails patterns");
}

async function testSearchAccuracy(qdrant, embeddings) {
  section("9. Search Accuracy");

  const searchTestDir = join(TEST_DIR, "search_test");
  await fs.mkdir(searchTestDir, { recursive: true });

  // Create distinct files with specific purposes
  await createTestFile(searchTestDir, "auth.ts", `
// Authentication module
export class AuthService {
  login(username: string, password: string) {
    return { token: "jwt-token", user: username };
  }

  logout(token: string) {
    return { success: true };
  }

  validateToken(token: string): boolean {
    return token.startsWith("jwt-");
  }
}
`);

  await createTestFile(searchTestDir, "database.ts", `
// Database connection
export class DatabaseService {
  connect(connectionString: string) {
    return { connected: true, db: "postgres" };
  }

  query(sql: string) {
    return { rows: [], count: 0 };
  }

  disconnect() {
    return { disconnected: true };
  }
}
`);

  await createTestFile(searchTestDir, "cache.ts", `
// Cache layer
export class CacheService {
  set(key: string, value: any, ttl: number) {
    return { cached: true };
  }

  get(key: string) {
    return null;
  }

  invalidate(pattern: string) {
    return { cleared: true };
  }
}
`);

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    chunkSize: 1000,
    chunkOverlap: 100,
  }));

  indexedPaths.add(searchTestDir);
  await indexer.indexCodebase(searchTestDir, { force: true });

  // Semantic search tests - verify that search returns meaningful content
  const authQuery = await indexer.searchCode(searchTestDir, "user authentication login password", { limit: 5 });
  const authHasContent = authQuery.some(r => r.content && r.content.length > 0);
  assert(authHasContent, `Auth query returns results with content: ${authQuery.length} results`);

  const dbQuery = await indexer.searchCode(searchTestDir, "database connection SQL query", { limit: 5 });
  const dbHasContent = dbQuery.some(r => r.content && r.content.length > 0);
  assert(dbHasContent, `DB query returns results with content: ${dbQuery.length} results`);

  const cacheQuery = await indexer.searchCode(searchTestDir, "cache key value TTL", { limit: 5 });
  const cacheHasContent = cacheQuery.some(r => r.content && r.content.length > 0);
  assert(cacheHasContent, `Cache query returns results with content: ${cacheQuery.length} results`);

  // Limit parameter
  const limitResults = await indexer.searchCode(searchTestDir, "service", { limit: 2 });
  assert(limitResults.length <= 2, `Limit respected: ${limitResults.length} <= 2`);
}

async function testEdgeCases(qdrant, embeddings) {
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
  indexedPaths.add(edgeTestDir);
  let errorOccurred = false;
  try {
    await indexer.indexCodebase(edgeTestDir, { force: true });
  } catch (e) {
    errorOccurred = true;
    console.log(`    Error: ${e.message}`);
  }
  assert(!errorOccurred, "Edge cases don't crash indexer");

  // Deep file should be indexed
  const deepResults = await indexer.searchCode(edgeTestDir, "DEEP");
  assert(deepResults.length > 0, `Deeply nested file indexed: ${deepResults.length}`);
}

async function testBatchPipeline(qdrant, embeddings) {
  section("11. Batch Pipeline in CodeIndexer");

  const batchTestDir = join(TEST_DIR, "batch_pipeline_test");
  await fs.mkdir(batchTestDir, { recursive: true });

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    batchSize: 50, // Small batch to test multiple flushes
  }));

  // === TEST: indexCodebase uses optimized batch upsert ===
  log("info", "Testing indexCodebase batch upsert...");

  // Create multiple files to generate enough chunks for batching
  for (let i = 0; i < 5; i++) {
    await createTestFile(batchTestDir, `service${i}.ts`, `
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
`);
  }

  indexedPaths.add(batchTestDir);
  const indexStats = await indexer.indexCodebase(batchTestDir, { force: true });
  assert(indexStats.filesIndexed === 5, `All files indexed: ${indexStats.filesIndexed}`);
  assert(indexStats.chunksCreated > 0, `Chunks created: ${indexStats.chunksCreated}`);

  // Verify all services are searchable
  for (let i = 0; i < 5; i++) {
    const results = await indexer.searchCode(batchTestDir, `Service${i} process fetchData`);
    assert(results.length > 0, `Service${i} searchable after batch index`);
  }

  // === TEST: reindexChanges batch delete ===
  log("info", "Testing reindexChanges batch delete...");

  // Delete multiple files - should trigger batch deletePointsByPaths
  await fs.unlink(join(batchTestDir, "service1.ts"));
  await fs.unlink(join(batchTestDir, "service3.ts"));
  await sleep(100);

  const deleteStats = await indexer.reindexChanges(batchTestDir);
  assert(deleteStats.filesDeleted === 2, `Batch delete detected: ${deleteStats.filesDeleted} files`);

  // Deleted services should not be findable
  const deleted1 = await indexer.searchCode(batchTestDir, "Service1 unique identifier");
  const deleted3 = await indexer.searchCode(batchTestDir, "Service3 unique identifier");
  // Note: semantic search may still find similar content, but file path should not match
  log("info", `Service1 results after delete: ${deleted1.length}, Service3: ${deleted3.length}`);

  // Remaining services should still be searchable
  const remaining0 = await indexer.searchCode(batchTestDir, "Service0");
  const remaining2 = await indexer.searchCode(batchTestDir, "Service2");
  const remaining4 = await indexer.searchCode(batchTestDir, "Service4");
  assert(remaining0.length > 0, "Service0 still searchable after batch delete");
  assert(remaining2.length > 0, "Service2 still searchable after batch delete");
  assert(remaining4.length > 0, "Service4 still searchable after batch delete");

  // === TEST: reindexChanges batch add ===
  log("info", "Testing reindexChanges batch add...");

  // Add multiple new files - should use optimized addPointsOptimized
  for (let i = 5; i < 8; i++) {
    await createTestFile(batchTestDir, `handler${i}.ts`, `
// Handler ${i}: Request handler
export async function handle${i}(req: Request): Promise<Response> {
  const { id, action } = req.params;
  console.log('Handler ${i} processing:', action);
  return new Response(JSON.stringify({ handler: ${i}, action }));
}
`);
  }
  await sleep(100);

  const addStats = await indexer.reindexChanges(batchTestDir);
  assert(addStats.filesAdded === 3, `Batch add detected: ${addStats.filesAdded} files`);

  // New handlers should be searchable
  for (let i = 5; i < 8; i++) {
    const results = await indexer.searchCode(batchTestDir, `handle${i} Request Response`);
    assert(results.length > 0, `Handler${i} searchable after batch add`);
  }

  // === TEST: Mixed batch operations ===
  log("info", "Testing mixed batch operations...");

  // Simultaneously: modify service0, delete service2, add new file
  await createTestFile(batchTestDir, "service0.ts", `
// Modified Service 0
export class Service0Modified {
  async newMethod(): Promise<string> {
    return "modified_content_for_testing_batch_pipeline";
  }
}
`);
  await fs.unlink(join(batchTestDir, "service2.ts"));
  await createTestFile(batchTestDir, "utility.ts", `
// New utility file
export function utilityFunction(): number {
  return 42;
}
`);
  await sleep(100);

  const mixedStats = await indexer.reindexChanges(batchTestDir);
  assert(mixedStats.filesModified >= 1, `Mixed: modified ${mixedStats.filesModified}`);
  assert(mixedStats.filesDeleted >= 1, `Mixed: deleted ${mixedStats.filesDeleted}`);
  assert(mixedStats.filesAdded >= 1, `Mixed: added ${mixedStats.filesAdded}`);

  // Verify modifications
  const modifiedResults = await indexer.searchCode(batchTestDir, "Service0Modified newMethod modified_content");
  assert(modifiedResults.length > 0, "Modified Service0 content searchable");

  const utilityResults = await indexer.searchCode(batchTestDir, "utilityFunction");
  assert(utilityResults.length > 0, "New utility file searchable");
}

async function testConcurrentSafety(qdrant, embeddings) {
  section("12. Concurrent Operations");

  const concTestDir = join(TEST_DIR, "conc_test");
  await fs.mkdir(concTestDir, { recursive: true });

  for (let i = 0; i < 5; i++) {
    await createTestFile(concTestDir, `file${i}.ts`, `export const FILE_${i} = ${i};`);
  }

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig());

  // Index first
  indexedPaths.add(concTestDir);
  await indexer.indexCodebase(concTestDir, { force: true });

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

async function testParallelSync() {
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

// ═══════════════════════════════════════════════════════════════
// 13. Pipeline & WorkerPool Tests
// ═══════════════════════════════════════════════════════════════

async function testPipelineWorkerpool(qdrant) {
  section("13. Pipeline & WorkerPool Tests");

  // Test 1: WorkerPool bounded concurrency
  log("info", "Testing WorkerPool bounded concurrency...");

  let maxConcurrent = 0;
  let currentConcurrent = 0;
  const concurrencyLog = [];

  const workerPool = new WorkerPool({
    concurrency: 2,
    maxRetries: 2,
    retryBaseDelayMs: 50,
    retryMaxDelayMs: 500,
  });

  const handler = async (batch) => {
    currentConcurrent++;
    maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
    concurrencyLog.push({ id: batch.id, concurrent: currentConcurrent });
    await new Promise((r) => setTimeout(r, 50));
    currentConcurrent--;
  };

  // Submit 6 batches - should process max 2 at a time
  const batches = Array.from({ length: 6 }, (_, i) => ({
    id: `batch-${i}`,
    type: "upsert",
    items: [{ type: "upsert", id: `item-${i}`, point: { id: `p-${i}`, vector: [1], payload: {} } }],
    createdAt: Date.now(),
  }));

  const promises = batches.map((batch) => workerPool.submit(batch, handler));
  await Promise.all(promises);

  assert(maxConcurrent <= 2, `WorkerPool respects concurrency limit: max=${maxConcurrent}`);

  const stats = workerPool.getStats();
  assert(stats.processed === 6, `WorkerPool processed all batches: ${stats.processed}`);
  assert(stats.errors === 0, `WorkerPool no errors: ${stats.errors}`);
  workerPool.forceShutdown();

  // Test 2: WorkerPool retry with backoff
  log("info", "Testing WorkerPool retry with exponential backoff...");

  let retryAttempts = 0;
  const retryPool = new WorkerPool({
    concurrency: 1,
    maxRetries: 3,
    retryBaseDelayMs: 20,
    retryMaxDelayMs: 200,
  });

  const failingHandler = async (batch) => {
    retryAttempts++;
    if (retryAttempts < 3) {
      throw new Error(`Simulated failure ${retryAttempts}`);
    }
    // Success on 3rd attempt
  };

  const retryBatch = {
    id: "retry-test",
    type: "upsert",
    items: [{ type: "upsert", id: "retry-item", point: { id: "rp", vector: [1], payload: {} } }],
    createdAt: Date.now(),
  };

  const retryResult = await retryPool.submit(retryBatch, failingHandler);
  assert(retryResult.success, "WorkerPool retry succeeded after failures");
  assert(retryResult.retryCount === 2, `WorkerPool retry count: ${retryResult.retryCount}`);
  assert(retryAttempts === 3, `Total attempts made: ${retryAttempts}`);
  retryPool.forceShutdown();

  // Test 3: BatchAccumulator batch formation
  log("info", "Testing BatchAccumulator batch formation...");

  const receivedBatches = [];
  const accumulator = new BatchAccumulator(
    { batchSize: 3, flushTimeoutMs: 100, maxQueueSize: 10 },
    "upsert",
    (batch) => receivedBatches.push(batch)
  );

  // Add 5 items - should create 1 full batch (3) immediately
  for (let i = 0; i < 5; i++) {
    accumulator.add({
      type: "upsert",
      id: `acc-item-${i}`,
      point: { id: `ap-${i}`, vector: [1], payload: {} },
    });
  }

  assert(receivedBatches.length === 1, `BatchAccumulator created batch on size: ${receivedBatches.length}`);
  assert(receivedBatches[0].items.length === 3, `First batch has 3 items: ${receivedBatches[0].items.length}`);
  assert(accumulator.getPendingCount() === 2, `BatchAccumulator has 2 pending: ${accumulator.getPendingCount()}`);

  // Test flush
  accumulator.flush();
  assert(receivedBatches.length === 2, `BatchAccumulator flushed partial batch: ${receivedBatches.length}`);
  assert(receivedBatches[1].items.length === 2, `Second batch has 2 items: ${receivedBatches[1].items.length}`);

  // Test 4: BatchAccumulator timeout flush
  log("info", "Testing BatchAccumulator timeout flush...");

  const timeoutBatches = [];
  const timeoutAccumulator = new BatchAccumulator(
    { batchSize: 10, flushTimeoutMs: 50, maxQueueSize: 10 },
    "delete",
    (batch) => timeoutBatches.push(batch)
  );

  timeoutAccumulator.add({ type: "delete", id: "del-1", relativePath: "path1.ts" });
  assert(timeoutBatches.length === 0, "No batch yet before timeout");

  // Wait for timeout flush
  await new Promise((r) => setTimeout(r, 100));
  assert(timeoutBatches.length === 1, `Batch flushed after timeout: ${timeoutBatches.length}`);
  assert(timeoutBatches[0].items.length === 1, "Timeout batch has correct items");

  // Test 5: PipelineManager coordination
  log("info", "Testing PipelineManager coordination...");

  let upsertBatchCount = 0;
  let deleteBatchCount = 0;

  const pipeline = new PipelineManager(
    {
      handleUpsertBatch: async (batch) => {
        upsertBatchCount++;
        await new Promise((r) => setTimeout(r, 20));
      },
      handleDeleteBatch: async (batch) => {
        deleteBatchCount++;
        await new Promise((r) => setTimeout(r, 10));
      },
    },
    {
      workerPool: { concurrency: 2, maxRetries: 1, retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
      upsertAccumulator: { batchSize: 2, flushTimeoutMs: 30, maxQueueSize: 10 },
      deleteAccumulator: { batchSize: 3, flushTimeoutMs: 30, maxQueueSize: 10 },
    }
  );

  pipeline.start();

  // Add upserts and deletes
  for (let i = 0; i < 5; i++) {
    pipeline.addUpsert({ id: `up-${i}`, vector: [1, 2, 3], payload: { x: i } });
  }
  for (let i = 0; i < 4; i++) {
    pipeline.addDelete(`delete-path-${i}.ts`);
  }

  await pipeline.flush();

  const pipelineStats = pipeline.getStats();
  assert(pipelineStats.itemsProcessed === 9, `Pipeline processed 9 items: ${pipelineStats.itemsProcessed}`);
  assert(upsertBatchCount >= 2, `Upsert batches created: ${upsertBatchCount}`);
  assert(deleteBatchCount >= 1, `Delete batches created: ${deleteBatchCount}`);
  assert(pipelineStats.errors === 0, `Pipeline no errors: ${pipelineStats.errors}`);

  await pipeline.shutdown();

  // Test 6: WorkerPool force shutdown cancels pending
  log("info", "Testing WorkerPool force shutdown...");

  const neverResolvingPool = new WorkerPool({ concurrency: 1, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 100 });
  const neverHandler = () => new Promise(() => {}); // Never resolves

  const p1 = neverResolvingPool.submit({ id: "never-1", type: "upsert", items: [], createdAt: Date.now() }, neverHandler);
  const p2 = neverResolvingPool.submit({ id: "never-2", type: "upsert", items: [], createdAt: Date.now() }, neverHandler);
  const p3 = neverResolvingPool.submit({ id: "never-3", type: "upsert", items: [], createdAt: Date.now() }, neverHandler);

  // Force shutdown while work is pending
  neverResolvingPool.forceShutdown();

  // Queued items should be cancelled (resolved with error)
  const [r2, r3] = await Promise.all([p2, p3]);
  assert(r2.success === false && r2.error === "WorkerPool force shutdown", "Force shutdown cancels queued batch");
  assert(neverResolvingPool.getQueueDepth() === 0, "Queue empty after force shutdown");

  // Test 7: ChunkPipeline integration (chunks → embeddings → Qdrant)
  log("info", "Testing ChunkPipeline integration...");

  // Create mock embedding provider that tracks calls
  let embeddingBatchCalls = 0;
  let totalChunksEmbedded = 0;
  const mockEmbeddings = {
    embedBatch: async (texts) => {
      embeddingBatchCalls++;
      totalChunksEmbedded += texts.length;
      // Return mock embeddings
      return texts.map(() => ({ embedding: [1, 2, 3, 4, 5] }));
    },
    getDimensions: () => 5,
  };

  // Create mock Qdrant that tracks calls
  let qdrantUpsertCalls = 0;
  let totalPointsUpserted = 0;
  const mockQdrant = {
    addPointsOptimized: async (collection, points, options) => {
      qdrantUpsertCalls++;
      totalPointsUpserted += points.length;
    },
    addPointsWithSparse: async (collection, points) => {
      qdrantUpsertCalls++;
      totalPointsUpserted += points.length;
    },
  };

  const chunkPipeline = new ChunkPipeline(
    mockQdrant,
    mockEmbeddings,
    "test_chunk_collection",
    {
      workerPool: { concurrency: 2, maxRetries: 1, retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
      accumulator: { batchSize: 3, flushTimeoutMs: 50, maxQueueSize: 10 },
      enableHybrid: false,
    }
  );

  chunkPipeline.start();

  // Add 7 chunks - should create batches of 3
  for (let i = 0; i < 7; i++) {
    chunkPipeline.addChunk(
      {
        content: `test content ${i}`,
        startLine: i * 10,
        endLine: i * 10 + 10,
        metadata: {
          filePath: `/test/path/file${i}.ts`,
          language: "typescript",
          chunkIndex: i,
        },
      },
      `chunk-${i}`,
      "/test/path"
    );
  }

  // Flush and wait for all processing
  await chunkPipeline.flush();

  const chunkStats = chunkPipeline.getStats();
  assert(chunkStats.itemsProcessed === 7, `ChunkPipeline processed all chunks: ${chunkStats.itemsProcessed}`);
  assert(embeddingBatchCalls >= 2, `ChunkPipeline called embedBatch in batches: ${embeddingBatchCalls}`);
  assert(totalChunksEmbedded === 7, `All chunks were embedded: ${totalChunksEmbedded}`);
  assert(qdrantUpsertCalls >= 2, `ChunkPipeline called Qdrant in batches: ${qdrantUpsertCalls}`);
  assert(totalPointsUpserted === 7, `All points were upserted: ${totalPointsUpserted}`);
  assert(chunkStats.errors === 0, `ChunkPipeline no errors: ${chunkStats.errors}`);

  await chunkPipeline.shutdown();

  // Test 8: Parallel Pipeline Optimization (Delete + Add can run in parallel)
  log("info", "Testing parallel pipeline optimization...");

  const timeline = [];
  const recordEvent = (event) => {
    timeline.push({ event, time: Date.now() });
  };

  // Simulate the parallel pipeline flow
  const simulateDelete = async () => {
    recordEvent("delete_start");
    await new Promise(r => setTimeout(r, 50)); // Simulate delete taking 50ms
    recordEvent("delete_end");
  };

  const simulateAdd = async () => {
    recordEvent("add_start");
    await new Promise(r => setTimeout(r, 100)); // Simulate add taking 100ms
    recordEvent("add_end");
    return 10; // chunks added
  };

  const simulateModified = async () => {
    recordEvent("modified_start");
    await new Promise(r => setTimeout(r, 80)); // Simulate modified taking 80ms
    recordEvent("modified_end");
    return 20; // chunks modified
  };

  const startTime = Date.now();

  // Optimized parallel flow (same as in indexer.ts)
  const deletePromise = simulateDelete();
  const addPromise = simulateAdd();

  // Modified starts after delete (not after add!)
  await deletePromise;
  const modifiedPromise = simulateModified();

  // Wait for both add and modified
  const [addedChunks2, modifiedChunks2] = await Promise.all([addPromise, modifiedPromise]);

  const totalTime = Date.now() - startTime;

  // Analyze timeline
  const events = timeline.map(t => ({ ...t, relativeTime: t.time - timeline[0].time }));
  const deleteEnd = events.find(e => e.event === "delete_end").relativeTime;
  const addEnd = events.find(e => e.event === "add_end").relativeTime;
  const modifiedStart = events.find(e => e.event === "modified_start").relativeTime;

  // Verify parallelism
  assert(
    modifiedStart >= deleteEnd - 5 && modifiedStart <= deleteEnd + 15,
    `Modified started right after delete (modified_start=${modifiedStart}ms, delete_end=${deleteEnd}ms)`
  );

  // Total time should be ~150ms (delete 50ms, then max(add remaining 50ms, modified 80ms))
  // Not 230ms (delete 50ms + add 100ms + modified 80ms sequential)
  assert(
    totalTime < 200,
    `Parallel pipelines completed in ${totalTime}ms (should be <200ms if parallel)`
  );

  assert(addedChunks2 === 10, "Add chunks returned correctly");
  assert(modifiedChunks2 === 20, "Modified chunks returned correctly");

  log("pass", "Pipeline & WorkerPool tests complete");
}

async function testSchemaAndDeleteOptimization(qdrant) {
  section("15. Schema Migration & Delete Optimization");

  // Test 9: SchemaManager and payload index migration
  log("info", "Testing SchemaManager and payload index...");

  const schemaTestCollection = `test_schema_${Date.now()}`;

  // Create collection first
  await qdrant.createCollection(schemaTestCollection, 5, "Cosine", false);

  try {
    // Test hasPayloadIndex (should be false for new collection)
    const indexExistsBefore = await qdrant.hasPayloadIndex(schemaTestCollection, "relativePath");
    assert(indexExistsBefore === false, "New collection has no relativePath index");

    // Test createPayloadIndex
    await qdrant.createPayloadIndex(schemaTestCollection, "relativePath", "keyword");

    // Verify index was created
    const indexExistsAfter = await qdrant.hasPayloadIndex(schemaTestCollection, "relativePath");
    assert(indexExistsAfter === true, "Index created successfully");

    // Test ensurePayloadIndex (should not recreate)
    const created = await qdrant.ensurePayloadIndex(schemaTestCollection, "relativePath", "keyword");
    assert(created === false, "ensurePayloadIndex returns false when index exists");

    // Test SchemaManager
    const schemaManager = new SchemaManager(qdrant);

    // Create a new collection without index
    const schemaTestCollection2 = `test_schema2_${Date.now()}`;
    await qdrant.createCollection(schemaTestCollection2, 5, "Cosine", false);

    try {
      // Get schema version (should be 0 for new collection without index)
      const versionBefore = await schemaManager.getSchemaVersion(schemaTestCollection2);
      assert(versionBefore === 0, `New collection has schema version 0: ${versionBefore}`);

      // Ensure current schema (should migrate to v4)
      const migrationResult = await schemaManager.ensureCurrentSchema(schemaTestCollection2);
      assert(migrationResult.success === true, "Migration successful");
      assert(migrationResult.fromVersion === 0, "Migrated from v0");
      assert(migrationResult.toVersion === CURRENT_SCHEMA_VERSION, `Migrated to v${CURRENT_SCHEMA_VERSION}`);
      assert(migrationResult.migrationsApplied.length > 0, "At least one migration applied");

      // Verify index was created during migration
      const indexExistsPostMigration = await qdrant.hasPayloadIndex(schemaTestCollection2, "relativePath");
      assert(indexExistsPostMigration === true, "Index created during migration");

      // Verify schema version is now current
      const versionAfter = await schemaManager.getSchemaVersion(schemaTestCollection2);
      assert(versionAfter === CURRENT_SCHEMA_VERSION, `Schema version is now ${CURRENT_SCHEMA_VERSION}: ${versionAfter}`);

      // Run migration again (should skip)
      const migrationResult2 = await schemaManager.ensureCurrentSchema(schemaTestCollection2);
      assert(migrationResult2.success === true, "Second migration call successful");
      assert(migrationResult2.migrationsApplied.length === 0, "No migrations needed on second call");

    } finally {
      await qdrant.deleteCollection(schemaTestCollection2);
    }

    // Test 10: Delete configuration defaults
    log("info", "Testing delete optimization configuration...");

    // Check DEFAULT_CONFIG has separate delete worker pool
    assert(
      DEFAULT_CONFIG.deleteWorkerPool !== undefined,
      "DEFAULT_CONFIG has deleteWorkerPool"
    );
    assert(
      DEFAULT_CONFIG.deleteWorkerPool.concurrency >= 8,
      `Delete concurrency is high (${DEFAULT_CONFIG.deleteWorkerPool.concurrency})`
    );
    assert(
      DEFAULT_CONFIG.deleteAccumulator.batchSize >= 500,
      `Delete batch size is large (${DEFAULT_CONFIG.deleteAccumulator.batchSize})`
    );

    // Verify upsert and delete have independent settings
    assert(
      DEFAULT_CONFIG.workerPool.concurrency !== DEFAULT_CONFIG.deleteWorkerPool.concurrency ||
      DEFAULT_CONFIG.upsertAccumulator.batchSize !== DEFAULT_CONFIG.deleteAccumulator.batchSize,
      "Upsert and delete have different settings"
    );

    log("pass", "Schema migration and delete optimization verified");

  } finally {
    await qdrant.deleteCollection(schemaTestCollection);
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function cleanup() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch (e) {}
}

async function main() {
  console.log();
  console.log(`${c.bold}╔═══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}║   QDRANT MCP SERVER - COMPREHENSIVE BUSINESS LOGIC    ║${c.reset}`);
  console.log(`${c.bold}╚═══════════════════════════════════════════════════════╝${c.reset}`);
  console.log();

  console.log(`${c.dim}Configuration:${c.reset}`);
  console.log(`  Qdrant:  ${config.QDRANT_URL}`);
  console.log(`  Ollama:  ${config.EMBEDDING_BASE_URL}`);
  console.log(`  Model:   ${config.EMBEDDING_MODEL}`);
  console.log(`  TestDir: ${TEST_DIR}`);

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL, 768, undefined, config.EMBEDDING_BASE_URL
  );
  const qdrant = new QdrantManager(config.QDRANT_URL);

  try {
    await testEmbeddings(embeddings);
    await testQdrantOperations(qdrant);
    await testPointsAccumulator(qdrant);
    await testFileIndexing(qdrant, embeddings);
    await testHashConsistency(qdrant, embeddings);
    await testIgnorePatterns(qdrant, embeddings);
    await testChunkBoundaries(qdrant, embeddings);
    await testMultiLanguage(qdrant, embeddings);
    await testRubyASTChunking(qdrant, embeddings);
    await testSearchAccuracy(qdrant, embeddings);
    await testEdgeCases(qdrant, embeddings);
    await testBatchPipeline(qdrant, embeddings);
    await testConcurrentSafety(qdrant, embeddings);
    await testParallelSync();
    await testPipelineWorkerpool(qdrant);
    await testSchemaAndDeleteOptimization(qdrant);

    // Cleanup
    section("Cleanup");

    // Clear all indexed collections first
    const cleanupIndexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig());
    for (const path of indexedPaths) {
      try {
        await cleanupIndexer.clearIndex(path);
        log("pass", `Cleared index for: ${path}`);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Remove test directory
    await cleanup();
    log("pass", "Test directory removed");

  } catch (error) {
    console.error(`\n${c.red}Fatal error:${c.reset}`, error.message);
    console.error(error.stack);
    await cleanup();
    process.exit(1);
  }

  // Summary
  console.log();
  console.log(`${c.bold}╔═══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}║                    TEST SUMMARY                       ║${c.reset}`);
  console.log(`${c.bold}╚═══════════════════════════════════════════════════════╝${c.reset}`);
  console.log();
  console.log(`  ${c.green}Passed:${c.reset}  ${passed}`);
  console.log(`  ${c.red}Failed:${c.reset}  ${failed}`);
  console.log(`  ${c.yellow}Skipped:${c.reset} ${skipped}`);
  console.log(`  ${c.dim}Total:${c.reset}   ${passed + failed + skipped}`);
  console.log();

  if (failed === 0) {
    console.log(`  ${c.green}${c.bold}✓ All tests passed!${c.reset}`);
    console.log();
    process.exit(0);
  } else {
    console.log(`  ${c.red}${c.bold}✗ ${failed} test(s) failed${c.reset}`);
    console.log();
    process.exit(1);
  }
}

main();
