/**
 * Benchmark script to find optimal CODE_BATCH_SIZE
 * Uses fixed EMBEDDING_BATCH_SIZE=2048 (from previous benchmark)
 * Tests Qdrant upsert with chunks = CODE_BATCH_SIZE
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";
import { randomUUID } from "crypto";

const config = {
  QDRANT_URL: "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
};

// FIXED from previous benchmark
const EMBEDDING_BATCH_SIZE = 2048;
console.log(`\n★ EMBEDDING_BATCH_SIZE = ${EMBEDDING_BATCH_SIZE} (fixed)\n`);

const TEST_RUNS = 3;
const DEGRADATION_THRESHOLD = 0.20; // 20%

async function preparePoints(count) {
  console.log(`  Preparing ${count} embeddings...`);

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

  const start = Date.now();
  const results = await embeddings.embedBatch(texts);
  console.log(`  Embeddings done in ${Date.now() - start}ms`);

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

async function benchmarkCodeBatchSize(qdrant, batchSize) {
  console.log(`\n--- Testing CODE_BATCH_SIZE=${batchSize} ---`);

  // Measure OLLAMA time separately
  const ollamaStart = Date.now();
  const points = await preparePoints(batchSize);
  const ollamaTime = Date.now() - ollamaStart;

  const collectionName = `benchmark_${Date.now()}`;
  const qdrantTimes = [];

  for (let run = 0; run < TEST_RUNS; run++) {
    // Create fresh collection
    try { await qdrant.deleteCollection(collectionName); } catch (e) {}
    await qdrant.createCollection(collectionName, 768, "Cosine");

    // Measure QDRANT time separately
    const start = Date.now();
    await qdrant.addPoints(collectionName, points);
    const time = Date.now() - start;
    qdrantTimes.push(time);

    const rate = Math.round(batchSize * 1000 / time);
    console.log(`  Qdrant Run ${run + 1}: ${time}ms for ${batchSize} chunks (${rate} chunks/sec)`);

    // Cleanup
    try { await qdrant.deleteCollection(collectionName); } catch (e) {}
  }

  const avgQdrantTime = qdrantTimes.reduce((a, b) => a + b, 0) / qdrantTimes.length;
  const timePerChunk = avgQdrantTime / batchSize;
  const rate = Math.round(batchSize * 1000 / avgQdrantTime);

  console.log(`  OLLAMA: ${ollamaTime}ms | QDRANT avg: ${Math.round(avgQdrantTime)}ms`);
  console.log(`  Qdrant: ${timePerChunk.toFixed(3)}ms/chunk, ${rate} chunks/sec`);

  return {
    batchSize,
    ollamaTime,
    avgQdrantTime: Math.round(avgQdrantTime),
    timePerChunk,
    rate
  };
}

async function main() {
  console.log("========================================");
  console.log("CODE_BATCH_SIZE Benchmark");
  console.log("========================================");
  console.log(`Qdrant: ${config.QDRANT_URL}`);
  console.log(`EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE} (fixed)`);
  console.log(`Strategy: chunks = batch_size (1 upsert per test)`);
  console.log(`Degradation threshold: ${DEGRADATION_THRESHOLD * 100}%`);

  const qdrant = new QdrantManager(config.QDRANT_URL);

  const results = [];
  let batchSize = 128;
  const STEP = 128; // Step by 128 instead of x2
  let bestTimePerChunk = Infinity;
  let shouldContinue = true;

  while (shouldContinue) {
    try {
      const result = await benchmarkCodeBatchSize(qdrant, batchSize);
      results.push(result);

      if (result.timePerChunk < bestTimePerChunk) {
        bestTimePerChunk = result.timePerChunk;
      }

      const degradation = (result.timePerChunk - bestTimePerChunk) / bestTimePerChunk;
      console.log(`  Time/chunk degradation: ${(degradation * 100).toFixed(1)}%`);

      if (degradation >= DEGRADATION_THRESHOLD) {
        console.log(`  ⚠️  Hit ${DEGRADATION_THRESHOLD * 100}% degradation!`);
        shouldContinue = false;
      } else {
        batchSize += STEP; // +128 instead of *2
      }
    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
      shouldContinue = false;
    }
  }

  // Summary
  console.log("\n========================================");
  console.log("RESULTS (CODE_BATCH_SIZE)");
  console.log("========================================");
  console.log("| CODE_BATCH_SIZE | OLLAMA (ms) | QDRANT (ms) | ms/chunk | chunks/sec | Degradation |");
  console.log("|-----------------|-------------|-------------|----------|------------|-------------|");

  let optimalResult = results[0];
  for (const r of results) {
    const degradation = ((r.timePerChunk - bestTimePerChunk) / bestTimePerChunk * 100).toFixed(1);
    const marker = r.timePerChunk === bestTimePerChunk ? " ← best" : "";
    console.log(`| ${String(r.batchSize).padStart(15)} | ${String(r.ollamaTime).padStart(11)} | ${String(r.avgQdrantTime).padStart(11)} | ${r.timePerChunk.toFixed(3).padStart(8)} | ${String(r.rate).padStart(10)} | ${degradation.padStart(10)}% |${marker}`);

    const deg = (r.timePerChunk - bestTimePerChunk) / bestTimePerChunk;
    if (deg < DEGRADATION_THRESHOLD) {
      optimalResult = r;
    }
  }

  // Analyze bottleneck
  console.log("\n========================================");
  console.log("BOTTLENECK ANALYSIS");
  console.log("========================================");

  const lastGood = results.filter(r => (r.timePerChunk - bestTimePerChunk) / bestTimePerChunk < DEGRADATION_THRESHOLD).pop();
  const firstBad = results.find(r => (r.timePerChunk - bestTimePerChunk) / bestTimePerChunk >= DEGRADATION_THRESHOLD);

  if (firstBad) {
    const ollamaDiff = firstBad.ollamaTime - lastGood.ollamaTime;
    const qdrantDiff = firstBad.avgQdrantTime - lastGood.avgQdrantTime;
    const chunksDiff = firstBad.batchSize - lastGood.batchSize;

    console.log(`Last good: CODE_BATCH_SIZE=${lastGood.batchSize}`);
    console.log(`First bad: CODE_BATCH_SIZE=${firstBad.batchSize}`);
    console.log(`  OLLAMA delta: +${ollamaDiff}ms (+${(ollamaDiff/chunksDiff).toFixed(2)}ms per extra chunk)`);
    console.log(`  QDRANT delta: +${qdrantDiff}ms (+${(qdrantDiff/chunksDiff).toFixed(2)}ms per extra chunk)`);

    if (qdrantDiff > ollamaDiff * 2) {
      console.log("\n⚠️  BOTTLENECK: QDRANT");
      console.log("   Qdrant upsert time increased significantly more than Ollama.");
      console.log("   Possible causes: payload size limit, indexing overhead, network.");
    } else if (ollamaDiff > qdrantDiff * 2) {
      console.log("\n⚠️  BOTTLENECK: OLLAMA");
      console.log("   Ollama embedding time increased significantly more than Qdrant.");
      console.log("   Possible causes: GPU memory, batch processing limit.");
    } else {
      console.log("\n⚠️  BOTTLENECK: BOTH (proportional increase)");
    }
  }

  console.log("\n========================================");
  console.log(`OPTIMAL CODE_BATCH_SIZE: ${optimalResult.batchSize}`);
  console.log(`Time per chunk: ${optimalResult.timePerChunk.toFixed(3)}ms`);
  console.log(`Throughput: ${optimalResult.rate} chunks/sec`);
  console.log("========================================");

  console.log("\n========================================");
  console.log("FINAL OPTIMAL VALUES:");
  console.log(`  EMBEDDING_BATCH_SIZE = ${EMBEDDING_BATCH_SIZE}`);
  console.log(`  CODE_BATCH_SIZE = ${optimalResult.batchSize}`);
  console.log("========================================");
}

main().catch(console.error);
