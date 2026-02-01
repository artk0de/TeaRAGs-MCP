#!/usr/bin/env node
/**
 * Embedding-Only Benchmark
 *
 * Tests EMBEDDING_BATCH_SIZE and EMBEDDING_CONCURRENCY only.
 * Focused on GPU utilization and embedding throughput.
 *
 * Run: npm run benchmark-embeddings
 *
 * Environment variables:
 *   EMBEDDING_BASE_URL  - Ollama server URL (default: http://localhost:11434)
 *   EMBEDDING_MODEL     - Model name (default: jina-embeddings-v2-base-code)
 *   TUNE_SAMPLE_SIZE    - Number of test chunks (default: 4096)
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";

import { config, CRITERIA, SAMPLE_SIZE, CODE_CHUNK_SIZE, BATCH_TEST_SAMPLES } from "./lib/config.mjs";
import { c, bar, formatRate, printHeader, printBox } from "./lib/colors.mjs";
import { generateTexts } from "./lib/benchmarks.mjs";
import { runBatchSizeBenchmark, runConcurrencyBenchmark, formatTime } from "./lib/embedding-steps.mjs";

/**
 * Check Ollama connectivity and model availability
 */
async function checkOllama() {
  try {
    const tagsResponse = await fetch(`${config.EMBEDDING_BASE_URL}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!tagsResponse.ok) {
      return { ok: false, error: `Ollama returned status ${tagsResponse.status}` };
    }

    const tags = await tagsResponse.json();
    const models = tags.models || [];
    const modelNames = models.map(m => m.name.replace(/:latest$/, ""));

    const targetModel = config.EMBEDDING_MODEL.replace(/:latest$/, "");
    const modelExists = modelNames.some(name =>
      name === targetModel || name === config.EMBEDDING_MODEL
    );

    if (!modelExists) {
      const availableModels = modelNames.length > 0
        ? `Available: ${modelNames.slice(0, 5).join(", ")}${modelNames.length > 5 ? "..." : ""}`
        : "No models found";
      return { ok: false, error: `Model "${config.EMBEDDING_MODEL}" not found. ${availableModels}` };
    }

    return { ok: true };
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED") {
      return { ok: false, error: `Cannot connect to Ollama at ${config.EMBEDDING_BASE_URL}` };
    }
    if (err.name === "TimeoutError") {
      return { ok: false, error: `Connection timed out (${config.EMBEDDING_BASE_URL})` };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Calculate throughput metrics
 */
function calculateMetrics(results) {
  const validResults = results.filter(r => !r.error);
  if (validResults.length === 0) return null;

  const rates = validResults.map(r => r.rate);
  const times = validResults.map(r => r.time);

  return {
    minRate: Math.min(...rates),
    maxRate: Math.max(...rates),
    avgRate: Math.round(rates.reduce((a, b) => a + b, 0) / rates.length),
    minTime: Math.min(...times),
    maxTime: Math.max(...times),
    avgTime: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
  };
}

async function main() {
  console.clear();
  printBox("EMBEDDING BENCHMARK", "GPU utilization and throughput testing");

  // Print configuration
  console.log(`${c.bold}Configuration:${c.reset}`);
  console.log(`  ${c.dim}Ollama:${c.reset}       ${config.EMBEDDING_BASE_URL}`);
  console.log(`  ${c.dim}Model:${c.reset}        ${config.EMBEDDING_MODEL}`);
  console.log(`  ${c.dim}Chunk size:${c.reset}   ${CODE_CHUNK_SIZE} chars${process.env.CODE_CHUNK_SIZE ? ` ${c.cyan}(custom)${c.reset}` : ""}`);
  console.log(`  ${c.dim}Sample size:${c.reset}  ${SAMPLE_SIZE} chunks${process.env.TUNE_SAMPLE_SIZE ? ` ${c.cyan}(custom)${c.reset}` : ""}`);
  console.log(`  ${c.dim}Batch test:${c.reset}   ${BATCH_TEST_SAMPLES} samples/test${process.env.BATCH_TEST_SAMPLES ? ` ${c.cyan}(custom)${c.reset}` : ""}`);
  console.log();
  console.log();

  // Check Ollama
  console.log(`${c.dim}Checking Ollama...${c.reset}`);
  const ollamaCheck = await checkOllama();
  if (!ollamaCheck.ok) {
    console.log(`\n${c.red}${c.bold}Error:${c.reset} ${ollamaCheck.error}`);
    console.log(`\n${c.bold}To fix:${c.reset}`);
    console.log(`  1. Start Ollama:  ${c.cyan}docker compose up -d ollama${c.reset}`);
    console.log(`  2. Pull model:    ${c.cyan}docker exec ollama ollama pull ${config.EMBEDDING_MODEL}${c.reset}`);
    process.exit(1);
  }
  console.log(`  ${c.green}✓${c.reset} Ollama connected (model: ${config.EMBEDDING_MODEL})`);

  // Initialize embeddings
  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIMENSION, // undefined = auto-detect
    undefined,
    config.EMBEDDING_BASE_URL
  );

  // Get actual dimension (auto-detected if not specified)
  const actualDimension = embeddings.getDimensions();
  if (!config.EMBEDDING_DIMENSION) {
    config.EMBEDDING_DIMENSION = actualDimension;
  }

  console.log(`  ${c.green}✓${c.reset} Vector dimension: ${actualDimension}${!process.env.EMBEDDING_DIMENSION ? ` ${c.dim}(auto-detected)${c.reset}` : ""}`);
  console.log();

  // Generate test data
  console.log(`${c.dim}Generating ${SAMPLE_SIZE} test samples...${c.reset}`);
  const texts = generateTexts(SAMPLE_SIZE);

  console.log(`${c.dim}Warming up GPU...${c.reset}`);
  process.env.EMBEDDING_BATCH_SIZE = "64";
  process.env.EMBEDDING_CONCURRENCY = "1";
  await embeddings.embedBatch(texts.slice(0, 128));
  console.log();

  const startTime = Date.now();

  // ============ PHASE 1: EMBEDDING_BATCH_SIZE ============

  printHeader("Phase 1: Batch Size", "Finding optimal EMBEDDING_BATCH_SIZE");

  const embResult = await runBatchSizeBenchmark(embeddings, texts);

  const optimalBatchSize = embResult.bestValue;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_BATCH_SIZE=${optimalBatchSize}${c.reset}`);
  console.log(`    ${c.dim}Speed: ${embResult.bestRate} embeddings/sec${c.reset}`);

  process.env.EMBEDDING_BATCH_SIZE = String(optimalBatchSize);

  // ============ PHASE 2: EMBEDDING_CONCURRENCY ============

  printHeader("Phase 2: Concurrency", "Finding optimal EMBEDDING_CONCURRENCY");

  const concResult = await runConcurrencyBenchmark(embeddings, texts, embResult, optimalBatchSize);

  const optimalConcurrency = concResult.bestValue;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_CONCURRENCY=${optimalConcurrency}${c.reset}`);
  console.log(`    ${c.dim}Speed: ${concResult.bestRate} embeddings/sec${c.reset}`);

  // ============ SUMMARY ============

  const totalTime = Date.now() - startTime;

  printBox("BENCHMARK COMPLETE", "");

  // Optimal configuration
  console.log(`${c.bold}Optimal configuration:${c.reset}`);
  console.log(`  EMBEDDING_BATCH_SIZE   = ${c.green}${c.bold}${optimalBatchSize}${c.reset}`);
  console.log(`  EMBEDDING_CONCURRENCY  = ${c.green}${c.bold}${optimalConcurrency}${c.reset}`);
  console.log();

  // Performance metrics
  const finalRate = concResult.bestRate || embResult.bestRate;
  console.log(`${c.bold}Performance metrics:${c.reset}`);
  console.log(`  ${c.dim}Embedding rate:${c.reset}     ${c.bold}${finalRate}${c.reset} emb/s`);
  console.log(`  ${c.dim}Time per embedding:${c.reset} ${c.bold}${(1000 / finalRate).toFixed(2)}${c.reset} ms`);
  console.log();

  // Batch size analysis
  const batchMetrics = calculateMetrics(embResult.results);
  if (batchMetrics) {
    console.log(`${c.bold}Batch size analysis:${c.reset}`);
    console.log(`  ${c.dim}Rate range:${c.reset}  ${batchMetrics.minRate} - ${batchMetrics.maxRate} emb/s`);
    console.log(`  ${c.dim}Time range:${c.reset}  ${batchMetrics.minTime} - ${batchMetrics.maxTime} ms`);
    console.log();
  }

  // Concurrency analysis
  const concMetrics = calculateMetrics(concResult.results);
  if (concMetrics) {
    console.log(`${c.bold}Concurrency analysis:${c.reset}`);
    console.log(`  ${c.dim}Rate range:${c.reset}  ${concMetrics.minRate} - ${concMetrics.maxRate} emb/s`);
    console.log(`  ${c.dim}Scaling:${c.reset}     ${((concMetrics.maxRate / concMetrics.minRate - 1) * 100).toFixed(0)}% improvement with parallelism`);
    console.log();
  }

  // Time estimates
  console.log(`${c.bold}Estimated indexing times:${c.reset}`);
  const projects = [
    { name: "10K LoC", loc: 10_000 },
    { name: "100K LoC", loc: 100_000 },
    { name: "1M LoC", loc: 1_000_000 },
    { name: "VS Code (3.5M)", loc: 3_500_000 },
  ];
  for (const p of projects) {
    const chunks = Math.ceil(p.loc / 35);
    const seconds = Math.ceil(chunks / finalRate);
    console.log(`  ${c.dim}${p.name.padEnd(15)}${c.reset} ${formatTime(seconds * 1000)}`);
  }
  console.log();

  console.log(`${c.dim}Total benchmark time: ${formatTime(totalTime)}${c.reset}`);
  console.log();

  process.exit(0);
}

main().catch((error) => {
  console.error(`${c.red}${c.bold}Fatal error:${c.reset}`, error.message);
  process.exit(1);
});
