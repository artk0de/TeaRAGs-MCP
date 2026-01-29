/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";

export async function testQdrantOperations(qdrant) {
  const TEST_COLLECTION = `test_${Date.now()}`;
  resources.trackCollection(TEST_COLLECTION);

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
