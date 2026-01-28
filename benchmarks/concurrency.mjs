/**
 * Benchmark: Optimal CODE_BATCH_SIZE + Concurrency Level
 *
 * Tests different combinations of:
 * - CODE_BATCH_SIZE: chunks per Qdrant upsert request
 * - CONCURRENCY: parallel upsert requests
 *
 * Goal: Find the optimal combination for maximum throughput
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";
import { randomUUID } from "crypto";

const config = {
  QDRANT_URL: "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
};

// Fixed from previous benchmarks
const EMBEDDING_BATCH_SIZE = 2048;

// Total chunks to process per test
const TOTAL_CHUNKS = 2048;
const TEST_RUNS = 2;

// Test matrix
const BATCH_SIZES = [128, 256, 384, 512, 768];
const CONCURRENCY_LEVELS = [1, 2, 4, 8, 16];

function generateTexts(count) {
  return Array.from({ length: count }, (_, i) =>
    `function process_${i}(data) {
      const result = data.map(item => ({
        id: item.id * ${i},
        value: Math.sqrt(item.value) + ${i % 100}
      }));
      return result.filter(r => r.value > 0);
    }`
  );
}

/**
 * Semaphore for controlling concurrency
 */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    }
  }
}

/**
 * Process with controlled concurrency
 */
async function processWithConcurrency(embeddings, qdrant, collectionName, texts, batchSize, concurrency) {
  // Split into batches
  const batches = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const semaphore = new Semaphore(concurrency);
  const start = Date.now();
  let embeddingTime = 0;
  let storageTime = 0;

  // Pre-embed all batches (this is the bottleneck we can't parallelize much)
  const embStart = Date.now();
  const allPoints = [];
  for (const batch of batches) {
    const results = await embeddings.embedBatch(batch);
    const points = results.map((r, i) => ({
      id: randomUUID(),
      vector: r.embedding,
      payload: {
        relativePath: `test/file_${i}.ts`,
        content: batch[i],
        chunkIndex: i,
      },
    }));
    allPoints.push(points);
  }
  embeddingTime = Date.now() - embStart;

  // Store with concurrency control
  const storeStart = Date.now();
  const storePromises = allPoints.map(async (points, i) => {
    await semaphore.acquire();
    try {
      const isLast = i === allPoints.length - 1;
      await qdrant.addPointsOptimized(collectionName, points, {
        wait: isLast || concurrency === 1, // Wait only on last, or if single-threaded
        ordering: "weak",
      });
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(storePromises);
  storageTime = Date.now() - storeStart;

  const totalTime = Date.now() - start;

  return { totalTime, embeddingTime, storageTime };
}

/**
 * Pipelined processing: embed batch N while storing batch N-1
 * With concurrency control for storage
 */
async function processPipelined(embeddings, qdrant, collectionName, texts, batchSize, storageConcurrency) {
  // Split into batches
  const batches = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const semaphore = new Semaphore(storageConcurrency);
  const start = Date.now();

  const pendingStores = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const isLast = i === batches.length - 1;

    // Embed current batch
    const results = await embeddings.embedBatch(batch);
    const points = results.map((r, j) => ({
      id: randomUUID(),
      vector: r.embedding,
      payload: {
        relativePath: `test/file_${j}.ts`,
        content: batch[j],
        chunkIndex: j,
      },
    }));

    // Start storage with concurrency control
    const storePromise = (async () => {
      await semaphore.acquire();
      try {
        await qdrant.addPointsOptimized(collectionName, points, {
          wait: isLast, // Only wait on last
          ordering: "weak",
        });
      } finally {
        semaphore.release();
      }
    })();

    if (isLast) {
      // Wait for all pending stores plus current
      await Promise.all([...pendingStores, storePromise]);
    } else {
      pendingStores.push(storePromise);
    }
  }

  return Date.now() - start;
}

async function runTest(embeddings, qdrant, texts, batchSize, concurrency, mode = "parallel") {
  const collectionName = `bench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const times = [];

  for (let run = 0; run < TEST_RUNS; run++) {
    // Create fresh collection
    try { await qdrant.deleteCollection(collectionName); } catch (e) {}
    await qdrant.createCollection(collectionName, 768, "Cosine");

    let time;
    if (mode === "pipelined") {
      time = await processPipelined(embeddings, qdrant, collectionName, texts, batchSize, concurrency);
    } else {
      const result = await processWithConcurrency(embeddings, qdrant, collectionName, texts, batchSize, concurrency);
      time = result.totalTime;
    }
    times.push(time);

    // Verify
    const info = await qdrant.getCollectionInfo(collectionName);
    if (info.pointsCount !== TOTAL_CHUNKS) {
      console.log(`  ⚠️ Points mismatch: expected ${TOTAL_CHUNKS}, got ${info.pointsCount}`);
    }

    // Cleanup
    try { await qdrant.deleteCollection(collectionName); } catch (e) {}
  }

  const avgTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const rate = Math.round(TOTAL_CHUNKS * 1000 / avgTime);

  return { avgTime, rate };
}

async function main() {
  console.log("========================================");
  console.log("Concurrency + Batch Size Benchmark");
  console.log("========================================");
  console.log(`Qdrant: ${config.QDRANT_URL}`);
  console.log(`EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);
  console.log(`TOTAL_CHUNKS: ${TOTAL_CHUNKS}`);
  console.log(`Test runs per config: ${TEST_RUNS}`);
  console.log(`Batch sizes: ${BATCH_SIZES.join(", ")}`);
  console.log(`Concurrency levels: ${CONCURRENCY_LEVELS.join(", ")}`);

  process.env.EMBEDDING_BATCH_SIZE = String(EMBEDDING_BATCH_SIZE);

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  const qdrant = new QdrantManager(config.QDRANT_URL);

  // Generate texts once
  console.log(`\nGenerating ${TOTAL_CHUNKS} texts...`);
  const texts = generateTexts(TOTAL_CHUNKS);
  console.log("Done.\n");

  // Results matrix
  const results = {};
  let bestConfig = { rate: 0 };

  // Test 1: Parallel mode (embed all, then store with concurrency)
  console.log("=== PARALLEL MODE (embed all → store with concurrency) ===\n");

  for (const batchSize of BATCH_SIZES) {
    results[batchSize] = {};
    console.log(`--- CODE_BATCH_SIZE=${batchSize} ---`);

    for (const concurrency of CONCURRENCY_LEVELS) {
      process.stdout.write(`  Concurrency=${concurrency}: `);

      const result = await runTest(embeddings, qdrant, texts, batchSize, concurrency, "parallel");
      results[batchSize][concurrency] = result;

      console.log(`${result.avgTime}ms (${result.rate} chunks/sec)`);

      if (result.rate > bestConfig.rate) {
        bestConfig = { batchSize, concurrency, mode: "parallel", ...result };
      }
    }
    console.log();
  }

  // Test 2: Pipelined mode (embed N while store N-1)
  console.log("=== PIPELINED MODE (embed batch N while store batch N-1) ===\n");
  const pipelinedResults = {};

  for (const batchSize of BATCH_SIZES) {
    pipelinedResults[batchSize] = {};
    console.log(`--- CODE_BATCH_SIZE=${batchSize} ---`);

    for (const concurrency of CONCURRENCY_LEVELS) {
      process.stdout.write(`  Concurrency=${concurrency}: `);

      const result = await runTest(embeddings, qdrant, texts, batchSize, concurrency, "pipelined");
      pipelinedResults[batchSize][concurrency] = result;

      console.log(`${result.avgTime}ms (${result.rate} chunks/sec)`);

      if (result.rate > bestConfig.rate) {
        bestConfig = { batchSize, concurrency, mode: "pipelined", ...result };
      }
    }
    console.log();
  }

  // Summary table: Parallel mode
  console.log("========================================");
  console.log("RESULTS: PARALLEL MODE (chunks/sec)");
  console.log("========================================");
  console.log(`| Batch \\ Conc | ${CONCURRENCY_LEVELS.map(c => String(c).padStart(6)).join(" | ")} |`);
  console.log(`|--------------|${CONCURRENCY_LEVELS.map(() => "--------").join("|")}|`);

  for (const batchSize of BATCH_SIZES) {
    const row = CONCURRENCY_LEVELS.map(c => String(results[batchSize][c].rate).padStart(6));
    console.log(`| ${String(batchSize).padStart(12)} | ${row.join(" | ")} |`);
  }

  // Summary table: Pipelined mode
  console.log("\n========================================");
  console.log("RESULTS: PIPELINED MODE (chunks/sec)");
  console.log("========================================");
  console.log(`| Batch \\ Conc | ${CONCURRENCY_LEVELS.map(c => String(c).padStart(6)).join(" | ")} |`);
  console.log(`|--------------|${CONCURRENCY_LEVELS.map(() => "--------").join("|")}|`);

  for (const batchSize of BATCH_SIZES) {
    const row = CONCURRENCY_LEVELS.map(c => String(pipelinedResults[batchSize][c].rate).padStart(6));
    console.log(`| ${String(batchSize).padStart(12)} | ${row.join(" | ")} |`);
  }

  // Best configuration
  console.log("\n========================================");
  console.log("OPTIMAL CONFIGURATION");
  console.log("========================================");
  console.log(`  Mode: ${bestConfig.mode}`);
  console.log(`  CODE_BATCH_SIZE: ${bestConfig.batchSize}`);
  console.log(`  CONCURRENCY: ${bestConfig.concurrency}`);
  console.log(`  Throughput: ${bestConfig.rate} chunks/sec`);
  console.log(`  Time for ${TOTAL_CHUNKS} chunks: ${bestConfig.avgTime}ms`);
  console.log("========================================");

  // Recommendations
  console.log("\nRECOMMENDATIONS:");
  console.log(`  Add to ~/.claude.json:`);
  console.log(`  "QDRANT_CONCURRENCY": "${bestConfig.concurrency}"`);
  console.log(`  "CODE_BATCH_SIZE": "${bestConfig.batchSize}"`);
}

main().catch(console.error);
