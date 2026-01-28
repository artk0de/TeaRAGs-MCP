/**
 * Benchmark: Compare addPoints vs addPointsOptimized
 * Tests different wait/ordering combinations
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";
import { randomUUID } from "crypto";

const config = {
  QDRANT_URL: "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
};

const EMBEDDING_BATCH_SIZE = 2048;
const TEST_RUNS = 3;

// Test batch sizes
const BATCH_SIZES = [256, 384, 512, 768, 896, 1024];

async function preparePoints(count) {
  process.env.EMBEDDING_BATCH_SIZE = String(EMBEDDING_BATCH_SIZE);

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  const texts = Array.from({ length: count }, (_, i) =>
    `function process_${i}(data) {
      const result = data.map(item => ({
        id: item.id * ${i},
        value: Math.sqrt(item.value) + ${i % 100}
      }));
      return result;
    }`
  );

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

async function benchmark(qdrant, points, method, options = {}) {
  const collectionName = `benchmark_${Date.now()}`;
  const batchSize = points.length;

  // Create collection
  try { await qdrant.deleteCollection(collectionName); } catch (e) {}
  await qdrant.createCollection(collectionName, 768, "Cosine");

  // Optionally disable indexing
  if (options.disableIndexing) {
    await qdrant.disableIndexing(collectionName);
  }

  const start = Date.now();

  if (method === "original") {
    await qdrant.addPoints(collectionName, points);
  } else if (method === "optimized") {
    await qdrant.addPointsOptimized(collectionName, points, {
      wait: options.wait ?? false,
      ordering: options.ordering ?? "weak",
    });

    // If wait=false, we need to verify points were added
    if (!options.wait) {
      // Small delay to let async write complete
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const time = Date.now() - start;

  // Verify points count
  const info = await qdrant.getCollectionInfo(collectionName);

  // Cleanup
  try { await qdrant.deleteCollection(collectionName); } catch (e) {}

  return {
    time,
    pointsCount: info.pointsCount,
    rate: Math.round(batchSize * 1000 / time),
  };
}

async function runTest(qdrant, batchSize, methodName, method, options) {
  console.log(`\n  ${methodName}:`);

  const points = await preparePoints(batchSize);
  const results = [];

  for (let run = 0; run < TEST_RUNS; run++) {
    const result = await benchmark(qdrant, points, method, options);
    results.push(result);
    console.log(`    Run ${run + 1}: ${result.time}ms (${result.rate} chunks/sec) [${result.pointsCount} points]`);
  }

  const avgTime = results.reduce((a, b) => a + b.time, 0) / TEST_RUNS;
  const avgRate = Math.round(batchSize * 1000 / avgTime);

  return { avgTime: Math.round(avgTime), avgRate };
}

async function main() {
  console.log("========================================");
  console.log("Qdrant Optimization Benchmark");
  console.log("========================================");
  console.log(`Qdrant: ${config.QDRANT_URL}`);
  console.log(`EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);
  console.log(`Test runs per method: ${TEST_RUNS}`);

  const qdrant = new QdrantManager(config.QDRANT_URL);

  const allResults = [];

  for (const batchSize of BATCH_SIZES) {
    console.log(`\n--- CODE_BATCH_SIZE=${batchSize} ---`);

    const batchResults = { batchSize };

    // Original method (wait=true)
    batchResults.original = await runTest(
      qdrant, batchSize,
      "Original (wait=true)",
      "original", {}
    );

    // Optimized: wait=false, ordering=weak
    batchResults.optWaitFalse = await runTest(
      qdrant, batchSize,
      "Optimized (wait=false, ordering=weak)",
      "optimized", { wait: false, ordering: "weak" }
    );

    // Optimized: wait=true, ordering=weak
    batchResults.optWaitTrue = await runTest(
      qdrant, batchSize,
      "Optimized (wait=true, ordering=weak)",
      "optimized", { wait: true, ordering: "weak" }
    );

    // Optimized: wait=false + disabled indexing
    batchResults.optNoIndex = await runTest(
      qdrant, batchSize,
      "Optimized (wait=false, no indexing)",
      "optimized", { wait: false, ordering: "weak", disableIndexing: true }
    );

    allResults.push(batchResults);
  }

  // Summary
  console.log("\n========================================");
  console.log("RESULTS SUMMARY");
  console.log("========================================");
  console.log("| Batch | Original | wait=false | ordering=weak | no indexing |");
  console.log("|-------|----------|------------|---------------|-------------|");

  for (const r of allResults) {
    console.log(`| ${String(r.batchSize).padStart(5)} | ${String(r.original.avgRate).padStart(8)} | ${String(r.optWaitFalse.avgRate).padStart(10)} | ${String(r.optWaitTrue.avgRate).padStart(13)} | ${String(r.optNoIndex.avgRate).padStart(11)} |`);
  }

  // Find best configuration
  let bestConfig = { rate: 0 };
  for (const r of allResults) {
    if (r.optNoIndex.avgRate > bestConfig.rate) {
      bestConfig = { batchSize: r.batchSize, method: "no indexing", rate: r.optNoIndex.avgRate };
    }
    if (r.optWaitFalse.avgRate > bestConfig.rate) {
      bestConfig = { batchSize: r.batchSize, method: "wait=false", rate: r.optWaitFalse.avgRate };
    }
  }

  console.log("\n========================================");
  console.log("BEST CONFIGURATION:");
  console.log(`  CODE_BATCH_SIZE: ${bestConfig.batchSize}`);
  console.log(`  Method: ${bestConfig.method}`);
  console.log(`  Throughput: ${bestConfig.rate} chunks/sec`);
  console.log("========================================");
}

main().catch(console.error);
