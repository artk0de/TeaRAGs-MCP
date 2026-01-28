/**
 * Benchmark script to find optimal EMBEDDING_BATCH_SIZE
 * Tests ONE full batch of size = EMBEDDING_BATCH_SIZE
 * Measures time per batch, stops at 20% degradation
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";

const config = {
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
};

const WARMUP_RUNS = 1;
const TEST_RUNS = 3;
const DEGRADATION_THRESHOLD = 0.20; // 20%

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

async function benchmarkBatchSize(batchSize) {
  console.log(`\n--- Testing EMBEDDING_BATCH_SIZE=${batchSize} ---`);

  // SET ENV VAR
  process.env.EMBEDDING_BATCH_SIZE = String(batchSize);

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  // TEXTS COUNT = BATCH SIZE (one full batch = one HTTP request)
  const texts = generateTexts(batchSize);
  const times = [];

  console.log(`  Texts count: ${batchSize} (= 1 full batch = 1 HTTP request)`);

  // Warmup
  for (let i = 0; i < WARMUP_RUNS; i++) {
    await embeddings.embedBatch(texts);
  }

  // Actual runs
  for (let i = 0; i < TEST_RUNS; i++) {
    const start = Date.now();
    await embeddings.embedBatch(texts);
    const time = Date.now() - start;
    times.push(time);
    const rate = Math.round(batchSize * 1000 / time);
    console.log(`  Run ${i + 1}: ${time}ms for ${batchSize} texts (${rate} emb/sec)`);
  }

  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  const timePerText = avgTime / batchSize;
  const rate = Math.round(batchSize * 1000 / avgTime);

  console.log(`  Avg: ${Math.round(avgTime)}ms, ${timePerText.toFixed(2)}ms/text, ${rate} emb/sec`);

  return { batchSize, avgTime: Math.round(avgTime), timePerText, rate };
}

async function main() {
  console.log("========================================");
  console.log("EMBEDDING_BATCH_SIZE Benchmark");
  console.log("========================================");
  console.log(`Model: ${config.EMBEDDING_MODEL}`);
  console.log(`Strategy: texts_count = batch_size (1 full batch per test)`);
  console.log(`Degradation threshold: ${DEGRADATION_THRESHOLD * 100}%`);
  console.log(`Start at 128, double until degradation`);

  const results = [];
  let batchSize = 128;
  let bestTimePerText = Infinity;
  let shouldContinue = true;

  while (shouldContinue) {
    try {
      const result = await benchmarkBatchSize(batchSize);
      results.push(result);

      if (result.timePerText < bestTimePerText) {
        bestTimePerText = result.timePerText;
      }

      // Check degradation based on time per text
      const degradation = (result.timePerText - bestTimePerText) / bestTimePerText;
      console.log(`  Time/text degradation: ${(degradation * 100).toFixed(1)}%`);

      if (degradation >= DEGRADATION_THRESHOLD) {
        console.log(`  ⚠️  Hit ${DEGRADATION_THRESHOLD * 100}% degradation!`);
        shouldContinue = false;
      } else {
        batchSize *= 2;
      }
    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
      shouldContinue = false;
    }
  }

  // Summary
  console.log("\n========================================");
  console.log("RESULTS (EMBEDDING_BATCH_SIZE)");
  console.log("========================================");
  console.log("| EMBEDDING_BATCH_SIZE | Batch Time (ms) | ms/text | emb/sec | Degradation |");
  console.log("|----------------------|-----------------|---------|---------|-------------|");

  let optimalResult = results[0];
  for (const r of results) {
    const degradation = ((r.timePerText - bestTimePerText) / bestTimePerText * 100).toFixed(1);
    const marker = r.timePerText === bestTimePerText ? " ← best" : "";
    console.log(`| ${String(r.batchSize).padStart(20)} | ${String(r.avgTime).padStart(15)} | ${r.timePerText.toFixed(2).padStart(7)} | ${String(r.rate).padStart(7)} | ${degradation.padStart(10)}% |${marker}`);

    const deg = (r.timePerText - bestTimePerText) / bestTimePerText;
    if (deg < DEGRADATION_THRESHOLD) {
      optimalResult = r;
    }
  }

  console.log("\n========================================");
  console.log(`OPTIMAL EMBEDDING_BATCH_SIZE: ${optimalResult.batchSize}`);
  console.log(`Time per text: ${optimalResult.timePerText.toFixed(2)}ms`);
  console.log(`Throughput: ${optimalResult.rate} emb/sec`);
  console.log("========================================");
}

main().catch(console.error);
