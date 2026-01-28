/**
 * Benchmark: PointsAccumulator Buffer Size Optimization
 *
 * Tests different buffer sizes and flush strategies to find optimal configuration.
 * Compares:
 *  1. Direct upsert (current behavior, wait=true per batch)
 *  2. Accumulator with different buffer sizes
 *  3. Accumulator with/without auto-flush timer
 *
 * Usage:
 *   QDRANT_URL=http://localhost:6333 \
 *   EMBEDDING_BASE_URL=http://localhost:11434 \
 *   node benchmarks/accumulator-buffer.mjs
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";
import { PointsAccumulator } from "../build/qdrant/accumulator.js";
import { randomUUID } from "crypto";

// Configuration
const config = {
  QDRANT_URL: process.env.QDRANT_URL || "http://localhost:6333",
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://localhost:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "nomic-embed-text",
};

const EMBEDDING_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || "64", 10);
const TOTAL_POINTS = 1000;  // Total points to insert
const TEST_RUNS = 3;

// Buffer sizes to test
const BUFFER_SIZES = [25, 50, 100, 150, 200, 250];

// Flush intervals to test (ms, 0 = disabled)
const FLUSH_INTERVALS = [0, 250, 500, 1000];

// Generate synthetic code snippets
function generateCodeSnippets(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    text: `async function handler_${i}(req, res) {
      const { userId, action } = req.params;
      const data = await db.query(\`SELECT * FROM users WHERE id = $1\`, [userId]);

      if (!data) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await processAction_${i}(data, action);
      logger.info(\`Processed action \${action} for user \${userId}\`);

      return res.json({ success: true, result });
    }`,
    metadata: {
      relativePath: `src/handlers/handler_${i}.ts`,
      language: "typescript",
      chunkIndex: i,
    },
  }));
}

async function generateEmbeddings(snippets, embeddings) {
  const texts = snippets.map((s) => s.text);
  const results = await embeddings.embedBatch(texts);

  return snippets.map((s, i) => ({
    id: s.id,
    vector: results[i].embedding,
    payload: {
      ...s.metadata,
      content: s.text,
    },
  }));
}

// Benchmark: Direct upsert (baseline)
async function benchmarkDirect(qdrant, points, batchSize) {
  const collectionName = `bench_direct_${Date.now()}`;

  try {
    await qdrant.deleteCollection(collectionName);
  } catch (e) {}
  await qdrant.createCollection(collectionName, points[0].vector.length, "Cosine");

  const start = Date.now();

  // Process in batches (current behavior)
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    await qdrant.addPoints(collectionName, batch);  // wait=true
  }

  const elapsed = Date.now() - start;

  // Verify
  const info = await qdrant.getCollectionInfo(collectionName);
  await qdrant.deleteCollection(collectionName);

  return {
    elapsed,
    pointsCount: info.pointsCount,
    rate: Math.round((points.length / elapsed) * 1000),
  };
}

// Benchmark: Accumulator with buffer
async function benchmarkAccumulator(qdrant, points, bufferSize, flushIntervalMs) {
  const collectionName = `bench_acc_${Date.now()}`;

  try {
    await qdrant.deleteCollection(collectionName);
  } catch (e) {}
  await qdrant.createCollection(collectionName, points[0].vector.length, "Cosine");

  const accumulator = new PointsAccumulator(qdrant, collectionName, false, {
    bufferSize,
    flushIntervalMs,
    ordering: "weak",
  });

  const start = Date.now();

  // Add all points (accumulator handles batching)
  await accumulator.add(points);

  // Flush remaining
  await accumulator.flush();

  const elapsed = Date.now() - start;

  // Verify
  const info = await qdrant.getCollectionInfo(collectionName);
  const stats = accumulator.getStats();

  await qdrant.deleteCollection(collectionName);

  return {
    elapsed,
    pointsCount: info.pointsCount,
    rate: Math.round((points.length / elapsed) * 1000),
    flushCount: stats.flushCount,
  };
}

// Benchmark: Pipelined accumulator (simulate concurrent embedding + storage)
async function benchmarkPipelined(qdrant, points, bufferSize, embeddingBatchSize) {
  const collectionName = `bench_pipe_${Date.now()}`;

  try {
    await qdrant.deleteCollection(collectionName);
  } catch (e) {}
  await qdrant.createCollection(collectionName, points[0].vector.length, "Cosine");

  const accumulator = new PointsAccumulator(qdrant, collectionName, false, {
    bufferSize,
    flushIntervalMs: 0,  // Disable timer, use explicit flush
    ordering: "weak",
  });

  const start = Date.now();

  // Simulate pipelined processing: add in embedding batch-sized chunks
  for (let i = 0; i < points.length; i += embeddingBatchSize) {
    const batch = points.slice(i, i + embeddingBatchSize);
    await accumulator.add(batch);
  }

  // Final flush
  await accumulator.flush();

  const elapsed = Date.now() - start;

  // Verify
  const info = await qdrant.getCollectionInfo(collectionName);
  const stats = accumulator.getStats();

  await qdrant.deleteCollection(collectionName);

  return {
    elapsed,
    pointsCount: info.pointsCount,
    rate: Math.round((points.length / elapsed) * 1000),
    flushCount: stats.flushCount,
  };
}

function progressBar(value, max, width = 20) {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PointsAccumulator Buffer Size Benchmark");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Qdrant: ${config.QDRANT_URL}`);
  console.log(`  Ollama: ${config.EMBEDDING_BASE_URL}`);
  console.log(`  Model:  ${config.EMBEDDING_MODEL}`);
  console.log(`  Points: ${TOTAL_POINTS}`);
  console.log(`  Runs:   ${TEST_RUNS}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Initialize
  process.env.EMBEDDING_BATCH_SIZE = String(EMBEDDING_BATCH_SIZE);
  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );
  const qdrant = new QdrantManager(config.QDRANT_URL);

  // Generate test data
  console.log("📊 Generating embeddings...");
  const snippets = generateCodeSnippets(TOTAL_POINTS);
  const points = await generateEmbeddings(snippets, embeddings);
  console.log(`   ✓ Generated ${points.length} points\n`);

  const results = [];

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Baseline (Direct upsert with wait=true)
  // ════════════════════════════════════════════════════════════════════════
  console.log("Phase 1: Baseline (Direct upsert, wait=true)");
  console.log("─────────────────────────────────────────────");

  for (const batchSize of BUFFER_SIZES) {
    const runs = [];
    for (let r = 0; r < TEST_RUNS; r++) {
      const result = await benchmarkDirect(qdrant, points, batchSize);
      runs.push(result);
    }
    const avgRate = Math.round(runs.reduce((a, b) => a + b.rate, 0) / TEST_RUNS);
    results.push({ method: "direct", batchSize, avgRate, flushInterval: 0 });
    console.log(`  batch=${String(batchSize).padStart(3)} → ${progressBar(avgRate, 5000)} ${avgRate} pts/s`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 2: Accumulator with different buffer sizes (no timer)
  // ════════════════════════════════════════════════════════════════════════
  console.log("\nPhase 2: Accumulator (wait=false, no timer)");
  console.log("─────────────────────────────────────────────");

  for (const bufferSize of BUFFER_SIZES) {
    const runs = [];
    for (let r = 0; r < TEST_RUNS; r++) {
      const result = await benchmarkAccumulator(qdrant, points, bufferSize, 0);
      runs.push(result);
    }
    const avgRate = Math.round(runs.reduce((a, b) => a + b.rate, 0) / TEST_RUNS);
    results.push({ method: "accumulator", batchSize: bufferSize, avgRate, flushInterval: 0 });
    console.log(`  buffer=${String(bufferSize).padStart(3)} → ${progressBar(avgRate, 5000)} ${avgRate} pts/s`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3: Accumulator with auto-flush timer
  // ════════════════════════════════════════════════════════════════════════
  console.log("\nPhase 3: Accumulator with auto-flush timer");
  console.log("─────────────────────────────────────────────");

  const bestBufferSize = results
    .filter((r) => r.method === "accumulator")
    .sort((a, b) => b.avgRate - a.avgRate)[0].batchSize;

  console.log(`  Using best buffer size: ${bestBufferSize}`);

  for (const interval of FLUSH_INTERVALS) {
    if (interval === 0) continue;  // Already tested
    const runs = [];
    for (let r = 0; r < TEST_RUNS; r++) {
      const result = await benchmarkAccumulator(qdrant, points, bestBufferSize, interval);
      runs.push(result);
    }
    const avgRate = Math.round(runs.reduce((a, b) => a + b.rate, 0) / TEST_RUNS);
    results.push({ method: "accumulator+timer", batchSize: bestBufferSize, avgRate, flushInterval: interval });
    console.log(`  interval=${String(interval).padStart(4)}ms → ${progressBar(avgRate, 5000)} ${avgRate} pts/s`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 4: Pipelined (simulating EMBEDDING_BATCH_SIZE chunks)
  // ════════════════════════════════════════════════════════════════════════
  console.log("\nPhase 4: Pipelined (embedding batch → accumulator)");
  console.log("─────────────────────────────────────────────────");

  for (const bufferSize of BUFFER_SIZES) {
    const runs = [];
    for (let r = 0; r < TEST_RUNS; r++) {
      const result = await benchmarkPipelined(qdrant, points, bufferSize, EMBEDDING_BATCH_SIZE);
      runs.push(result);
    }
    const avgRate = Math.round(runs.reduce((a, b) => a + b.rate, 0) / TEST_RUNS);
    results.push({ method: "pipelined", batchSize: bufferSize, avgRate, flushInterval: 0 });
    console.log(`  buffer=${String(bufferSize).padStart(3)} → ${progressBar(avgRate, 5000)} ${avgRate} pts/s (${runs[0].flushCount} flushes)`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");

  // Group by method
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.method]) grouped[r.method] = [];
    grouped[r.method].push(r);
  }

  // Find best in each category
  console.log("\n  Best per category:");
  for (const [method, items] of Object.entries(grouped)) {
    const best = items.sort((a, b) => b.avgRate - a.avgRate)[0];
    const label = method === "accumulator+timer"
      ? `${method} (interval=${best.flushInterval}ms)`
      : method;
    console.log(`    ${label.padEnd(35)} → buffer=${best.batchSize} @ ${best.avgRate} pts/s`);
  }

  // Overall best
  const overallBest = results.sort((a, b) => b.avgRate - a.avgRate)[0];
  const improvement = Math.round(
    ((overallBest.avgRate - results.find((r) => r.method === "direct").avgRate) /
      results.find((r) => r.method === "direct").avgRate) *
      100
  );

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RECOMMENDED CONFIGURATION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Method:          ${overallBest.method}`);
  console.log(`  CODE_BATCH_SIZE: ${overallBest.batchSize}`);
  if (overallBest.flushInterval > 0) {
    console.log(`  QDRANT_FLUSH_INTERVAL_MS: ${overallBest.flushInterval}`);
  }
  console.log(`  Throughput:      ${overallBest.avgRate} pts/s`);
  console.log(`  Improvement:     +${improvement}% vs baseline`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
