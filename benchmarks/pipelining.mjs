/**
 * Benchmark: True Pipelining vs Sequential Processing
 *
 * Tests the real benefit of wait=false by overlapping embedding + storage:
 * - Sequential: embed batch → store batch → embed batch → store batch
 * - Pipelined: embed batch N while storing batch N-1 (parallel)
 *
 * Uses wait=false for all batches except the last one (wait=true)
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";
import { randomUUID } from "crypto";

const config = {
  QDRANT_URL: "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
};

// Optimal values from previous benchmarks
const EMBEDDING_BATCH_SIZE = 2048;
const CODE_BATCH_SIZE = 512;

// Total chunks to process (simulates real indexing)
const TOTAL_CHUNKS = 2048;
const TEST_RUNS = 3;

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

async function embedBatch(embeddings, texts) {
  const results = await embeddings.embedBatch(texts);
  return results.map((r, i) => ({
    id: randomUUID(),
    vector: r.embedding,
    payload: {
      relativePath: `test/file_${i}.ts`,
      content: texts[i],
      chunkIndex: i,
    },
  }));
}

/**
 * Sequential approach: embed → store → embed → store
 * Each batch waits for completion before starting next
 */
async function benchmarkSequential(embeddings, qdrant, collectionName, texts) {
  const batches = [];
  for (let i = 0; i < texts.length; i += CODE_BATCH_SIZE) {
    batches.push(texts.slice(i, i + CODE_BATCH_SIZE));
  }

  const start = Date.now();

  for (let i = 0; i < batches.length; i++) {
    // Embed
    const points = await embedBatch(embeddings, batches[i]);

    // Store (always wait in sequential mode)
    await qdrant.addPoints(collectionName, points);
  }

  return Date.now() - start;
}

/**
 * Pipelined approach: embed batch N while storing batch N-1
 * Uses wait=false for all except last batch
 */
async function benchmarkPipelined(embeddings, qdrant, collectionName, texts) {
  const batches = [];
  for (let i = 0; i < texts.length; i += CODE_BATCH_SIZE) {
    batches.push(texts.slice(i, i + CODE_BATCH_SIZE));
  }

  const start = Date.now();
  let pendingStore = null;

  for (let i = 0; i < batches.length; i++) {
    const isLast = i === batches.length - 1;

    // Embed current batch
    const points = await embedBatch(embeddings, batches[i]);

    // Wait for previous store to complete (if any)
    if (pendingStore) {
      await pendingStore;
    }

    // Start new store
    if (isLast) {
      // Last batch: wait for completion
      await qdrant.addPointsOptimized(collectionName, points, {
        wait: true,
        ordering: "weak",
      });
    } else {
      // Not last: fire-and-forget (will await on next iteration)
      pendingStore = qdrant.addPointsOptimized(collectionName, points, {
        wait: false,
        ordering: "weak",
      });
    }
  }

  return Date.now() - start;
}

/**
 * Full parallel approach: embed all first, then store all with wait=false
 * Final verification with collection info
 */
async function benchmarkFullParallel(embeddings, qdrant, collectionName, texts) {
  const batches = [];
  for (let i = 0; i < texts.length; i += CODE_BATCH_SIZE) {
    batches.push(texts.slice(i, i + CODE_BATCH_SIZE));
  }

  const start = Date.now();

  // Phase 1: Embed all batches
  const allPoints = [];
  for (const batch of batches) {
    const points = await embedBatch(embeddings, batch);
    allPoints.push(points);
  }

  // Phase 2: Store all batches in parallel with wait=false
  const storePromises = allPoints.map((points, i) => {
    const isLast = i === allPoints.length - 1;
    return qdrant.addPointsOptimized(collectionName, points, {
      wait: isLast, // Only wait on last
      ordering: "weak",
    });
  });

  await Promise.all(storePromises);

  return Date.now() - start;
}

async function runBenchmark(name, fn, embeddings, qdrant, texts) {
  const collectionName = `bench_${Date.now()}`;
  const times = [];

  for (let run = 0; run < TEST_RUNS; run++) {
    // Create fresh collection
    try { await qdrant.deleteCollection(collectionName); } catch (e) {}
    await qdrant.createCollection(collectionName, 768, "Cosine");

    const time = await fn(embeddings, qdrant, collectionName, texts);
    times.push(time);

    // Verify points count
    const info = await qdrant.getCollectionInfo(collectionName);
    const rate = Math.round(TOTAL_CHUNKS * 1000 / time);
    console.log(`  Run ${run + 1}: ${time}ms (${rate} chunks/sec) [${info.pointsCount} points]`);

    // Cleanup
    try { await qdrant.deleteCollection(collectionName); } catch (e) {}
  }

  const avgTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const avgRate = Math.round(TOTAL_CHUNKS * 1000 / avgTime);

  return { avgTime, avgRate };
}

async function main() {
  console.log("========================================");
  console.log("Pipelining Benchmark");
  console.log("========================================");
  console.log(`Qdrant: ${config.QDRANT_URL}`);
  console.log(`EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);
  console.log(`CODE_BATCH_SIZE: ${CODE_BATCH_SIZE}`);
  console.log(`TOTAL_CHUNKS: ${TOTAL_CHUNKS}`);
  console.log(`Batches: ${Math.ceil(TOTAL_CHUNKS / CODE_BATCH_SIZE)}`);
  console.log(`Test runs: ${TEST_RUNS}`);

  process.env.EMBEDDING_BATCH_SIZE = String(EMBEDDING_BATCH_SIZE);

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  const qdrant = new QdrantManager(config.QDRANT_URL);

  // Generate all texts once
  console.log(`\nGenerating ${TOTAL_CHUNKS} texts...`);
  const texts = generateTexts(TOTAL_CHUNKS);
  console.log("Done.\n");

  const results = {};

  // Test 1: Sequential (original approach)
  console.log("--- Sequential (embed → store → embed → store) ---");
  results.sequential = await runBenchmark(
    "Sequential",
    benchmarkSequential,
    embeddings,
    qdrant,
    texts
  );
  console.log(`  Average: ${results.sequential.avgTime}ms (${results.sequential.avgRate} chunks/sec)\n`);

  // Test 2: Pipelined (overlap embed N with store N-1)
  console.log("--- Pipelined (embed N while store N-1) ---");
  results.pipelined = await runBenchmark(
    "Pipelined",
    benchmarkPipelined,
    embeddings,
    qdrant,
    texts
  );
  console.log(`  Average: ${results.pipelined.avgTime}ms (${results.pipelined.avgRate} chunks/sec)\n`);

  // Test 3: Full parallel (embed all, then store all)
  console.log("--- Full Parallel (embed all → store all) ---");
  results.fullParallel = await runBenchmark(
    "Full Parallel",
    benchmarkFullParallel,
    embeddings,
    qdrant,
    texts
  );
  console.log(`  Average: ${results.fullParallel.avgTime}ms (${results.fullParallel.avgRate} chunks/sec)\n`);

  // Summary
  console.log("========================================");
  console.log("RESULTS SUMMARY");
  console.log("========================================");
  console.log(`| Method         | Time (ms) | Rate (chunks/sec) | Speedup |`);
  console.log(`|----------------|-----------|-------------------|---------|`);

  const baseline = results.sequential.avgTime;
  for (const [name, r] of Object.entries(results)) {
    const speedup = (baseline / r.avgTime).toFixed(2);
    console.log(`| ${name.padEnd(14)} | ${String(r.avgTime).padStart(9)} | ${String(r.avgRate).padStart(17)} | ${speedup.padStart(7)}x |`);
  }

  // Best method
  const best = Object.entries(results).sort((a, b) => a[1].avgTime - b[1].avgTime)[0];
  console.log(`\n========================================`);
  console.log(`BEST METHOD: ${best[0]}`);
  console.log(`  Time: ${best[1].avgTime}ms`);
  console.log(`  Rate: ${best[1].avgRate} chunks/sec`);
  console.log(`  Speedup: ${(baseline / best[1].avgTime).toFixed(2)}x vs sequential`);
  console.log(`========================================`);
}

main().catch(console.error);
