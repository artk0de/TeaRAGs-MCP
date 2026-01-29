/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { PipelineManager, WorkerPool, BatchAccumulator, ChunkPipeline, DEFAULT_CONFIG } from "../../../build/code/pipeline/index.js";

export async function testPipelineWorkerpool(qdrant) {
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
