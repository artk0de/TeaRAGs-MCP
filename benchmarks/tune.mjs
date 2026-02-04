#!/usr/bin/env node
/**
 * Unified Performance Tuning Benchmark
 *
 * Automatically finds optimal values for all performance parameters:
 * - EMBEDDING_BATCH_SIZE
 * - EMBEDDING_CONCURRENCY
 * - QDRANT_UPSERT_BATCH_SIZE
 * - QDRANT_BATCH_ORDERING
 * - QDRANT_FLUSH_INTERVAL_MS
 * - BATCH_FORMATION_TIMEOUT_MS
 * - QDRANT_DELETE_BATCH_SIZE
 * - QDRANT_DELETE_CONCURRENCY
 *
 * Run: npm run tune
 * Output: tuned_environment_variables.env
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";

import { config, CRITERIA, TEST_VALUES, SMART_STEPPING, SAMPLE_SIZE, isFullMode } from "./lib/config.mjs";
import { c, bar, formatRate, printHeader, printBox } from "./lib/colors.mjs";
import { StoppingDecision } from "./lib/stopping.mjs";
import { smartSteppingSearch, linearSteppingSearch } from "./lib/smart-stepping.mjs";
import {
  generateTexts,
  generatePoints,
  benchmarkCodeBatchSize,
  benchmarkOrdering,
  benchmarkFlushInterval,
  benchmarkBatchFormationTimeout,
  benchmarkDeleteBatchSize,
  benchmarkDeleteConcurrency,
} from "./lib/benchmarks.mjs";
import { calibrateEmbeddings } from "./lib/embedding-calibration.mjs";
import { cleanupAllCollections } from "./lib/cleanup.mjs";
import { printTimeEstimates } from "./lib/estimator.mjs";
import { writeEnvFile, printSummary, printUsage } from "./lib/output.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// Global cleanup handler
let qdrantClient = null;

/**
 * Check connectivity to required services
 * Returns array of error messages (empty if all OK)
 */
async function checkConnectivity() {
  const errors = [];

  // Check Qdrant connectivity
  const qdrantCheck = await (async () => {
    try {
      const response = await fetch(`${config.QDRANT_URL}/collections`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return `Qdrant returned status ${response.status}`;
      }
      return null;
    } catch (err) {
      if (err.cause?.code === "ECONNREFUSED") {
        return `Cannot connect to Qdrant at ${config.QDRANT_URL}`;
      }
      if (err.name === "TimeoutError") {
        return `Connection to Qdrant timed out (${config.QDRANT_URL})`;
      }
      return `Qdrant error: ${err.message}`;
    }
  })();

  // Check Ollama connectivity and model availability
  const ollamaCheck = await (async () => {
    try {
      // First check if Ollama is reachable
      const tagsResponse = await fetch(`${config.EMBEDDING_BASE_URL}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (!tagsResponse.ok) {
        return `Ollama returned status ${tagsResponse.status}`;
      }

      // Check if the model exists
      const tags = await tagsResponse.json();
      const models = tags.models || [];
      const modelNames = models.map(m => m.name.replace(/:latest$/, ""));

      // Check both with and without :latest suffix
      const targetModel = config.EMBEDDING_MODEL.replace(/:latest$/, "");
      const modelExists = modelNames.some(name =>
        name === targetModel || name === config.EMBEDDING_MODEL
      );

      if (!modelExists) {
        const availableModels = modelNames.length > 0
          ? `\n    Available models: ${modelNames.slice(0, 5).join(", ")}${modelNames.length > 5 ? "..." : ""}`
          : "\n    No models found. Run: ollama pull " + config.EMBEDDING_MODEL;
        return `Model "${config.EMBEDDING_MODEL}" not found on Ollama${availableModels}`;
      }

      return null;
    } catch (err) {
      if (err.cause?.code === "ECONNREFUSED") {
        return `Cannot connect to Ollama at ${config.EMBEDDING_BASE_URL}`;
      }
      if (err.name === "TimeoutError") {
        return `Connection to Ollama timed out (${config.EMBEDDING_BASE_URL})`;
      }
      return `Ollama error: ${err.message}`;
    }
  })();

  if (qdrantCheck) errors.push(qdrantCheck);
  if (ollamaCheck) errors.push(ollamaCheck);

  return errors;
}

process.on("SIGINT", async () => {
  console.log(`\n${c.yellow}Interrupted. Cleaning up...${c.reset}`);
  if (qdrantClient) {
    await cleanupAllCollections(qdrantClient);
  }
  process.exit(1);
});

async function main() {
  console.clear();
  printBox("TEA RAGS MCP — PERFORMANCE TUNING", `Automatic parameter optimization (${isFullMode ? "full" : "quick"} mode)`);

  // Print configuration (dimension will be shown after initialization)
  console.log(`${c.bold}Configuration:${c.reset}`);
  console.log(`  ${c.dim}Qdrant:${c.reset}        ${config.QDRANT_URL}`);
  console.log(`  ${c.dim}Ollama:${c.reset}        ${config.EMBEDDING_BASE_URL}`);
  console.log(`  ${c.dim}Model:${c.reset}         ${config.EMBEDDING_MODEL}`);
  console.log();

  console.log(`${c.bold}Embedding calibration:${c.reset}`);
  console.log(`  ${c.dim}Algorithm:${c.reset}     Three-phase plateau detection`);
  console.log(`  ${c.dim}Total chunks:${c.reset}  4096 (fixed workload)`);
  console.log(`  ${c.dim}Runs:${c.reset}          2 per configuration (median)`);
  console.log(`  ${c.dim}Batch search:${c.reset}  [256, 1024, 2048, 3072, 4096]`);
  console.log(`  ${c.dim}Concurrency:${c.reset}   [1, 2, 4] (tested on plateau only)`);
  console.log();

  console.log(`${c.bold}Qdrant tests:${c.reset}`);
  console.log(`  ${c.dim}Sample size:${c.reset}   ${SAMPLE_SIZE} chunks`);
  console.log(`  ${c.dim}Test timeout:${c.reset}  ${CRITERIA.TEST_TIMEOUT_MS / 1000}s`);
  console.log();

  // Check connectivity to services
  console.log(`${c.dim}Checking services...${c.reset}`);
  const connectivityErrors = await checkConnectivity();

  if (connectivityErrors.length > 0) {
    console.log();
    console.log(`${c.red}${c.bold}Connection errors:${c.reset}`);
    for (const err of connectivityErrors) {
      console.log(`  ${c.red}✗${c.reset} ${err}`);
    }
    console.log();
    console.log(`${c.bold}Configuration:${c.reset}`);
    console.log(`  ${c.dim}QDRANT_URL${c.reset}=${config.QDRANT_URL} ${c.dim}(default: http://localhost:6333)${c.reset}`);
    console.log(`  ${c.dim}EMBEDDING_BASE_URL${c.reset}=${config.EMBEDDING_BASE_URL} ${c.dim}(default: http://localhost:11434)${c.reset}`);
    console.log(`  ${c.dim}EMBEDDING_MODEL${c.reset}=${config.EMBEDDING_MODEL} ${c.dim}(default: jina-embeddings-v2-base-code)${c.reset}`);
    console.log();
    console.log(`${c.bold}To fix:${c.reset}`);
    console.log(`  1. Start Qdrant:  ${c.cyan}docker compose up -d qdrant${c.reset}`);
    console.log(`  2. Start Ollama:  ${c.cyan}docker compose up -d ollama${c.reset}`);
    console.log(`  3. Pull model:    ${c.cyan}docker exec ollama ollama pull ${config.EMBEDDING_MODEL}${c.reset}`);
    console.log();
    process.exit(1);
  }
  console.log(`  ${c.green}✓${c.reset} Qdrant connected`);
  console.log(`  ${c.green}✓${c.reset} Ollama connected (model: ${config.EMBEDDING_MODEL})`);
  console.log();

  // Initialize clients
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

  const qdrant = new QdrantManager(config.QDRANT_URL);
  qdrantClient = qdrant;

  // Generate test data for Qdrant tests
  console.log(`${c.dim}Generating ${SAMPLE_SIZE} test samples for Qdrant tests...${c.reset}`);
  const qdrantTexts = generateTexts(SAMPLE_SIZE);

  const optimal = {};
  const startTime = Date.now();

  // ============ EMBEDDING CALIBRATION (3-PHASE) ============

  printHeader("Embedding Calibration", "Three-phase plateau detection (batch → concurrency → selection)");

  const embeddingResult = await calibrateEmbeddings(embeddings, { verbose: true });

  optimal.EMBEDDING_BATCH_SIZE = embeddingResult.EMBEDDING_BATCH_SIZE;
  optimal.EMBEDDING_CONCURRENCY = embeddingResult.EMBEDDING_CONCURRENCY;

  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE}${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY}${c.reset}`);
  console.log(`    ${c.dim}Throughput: ${embeddingResult.throughput_chunks_per_sec.toFixed(1)} chunks/sec${c.reset}`);
  console.log(`    ${c.dim}Plateau detected: ${embeddingResult.plateau_detected ? "yes" : "no"}${c.reset}`);
  console.log(`    ${c.dim}Configurations tested: ${embeddingResult.stable_configs_count} stable, ${embeddingResult.discarded_configs_count} discarded${c.reset}`);

  process.env.EMBEDDING_BATCH_SIZE = String(optimal.EMBEDDING_BATCH_SIZE);
  process.env.EMBEDDING_CONCURRENCY = String(optimal.EMBEDDING_CONCURRENCY);

  // ============ PHASE 3: QDRANT_UPSERT_BATCH_SIZE ============

  printHeader("Phase 3: Qdrant Batch Size", "Finding optimal QDRANT_UPSERT_BATCH_SIZE (smart stepping: x2 + midpoint)");

  console.log(`  ${c.dim}Pre-generating embeddings for Qdrant tests...${c.reset}`);
  const embeddingResults = await embeddings.embedBatch(qdrantTexts);
  const points = generatePoints(embeddingResults, qdrantTexts);
  console.log(`  ${c.dim}Done. Testing batch sizes...${c.reset}\n`);

  let codeBestRate = 0;
  const codeResult = await smartSteppingSearch({
    start: SMART_STEPPING.QDRANT_UPSERT_BATCH_SIZE.start,
    max: SMART_STEPPING.QDRANT_UPSERT_BATCH_SIZE.max,
    testFn: async (size) => {
      return await benchmarkCodeBatchSize(qdrant, points, size);
    },
    onResult: (size, result, isMidpoint) => {
      const prefix = isMidpoint ? `  ${c.cyan}↳ Midpoint${c.reset} ` : "  Testing ";
      process.stdout.write(`${prefix}QDRANT_UPSERT_BATCH_SIZE=${c.bold}${size.toString().padStart(4)}${c.reset} `);

      if (result.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
      } else {
        if (result.rate > codeBestRate) codeBestRate = result.rate;
        console.log(`${bar(result.rate, codeBestRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms)${c.reset}`);
      }
    },
  });

  optimal.QDRANT_UPSERT_BATCH_SIZE = codeResult.bestValue;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_UPSERT_BATCH_SIZE=${optimal.QDRANT_UPSERT_BATCH_SIZE}${c.reset}`);
  console.log(`    ${c.dim}Speed: ${codeResult.bestRate} chunks/sec${c.reset}`);

  // ============ PHASE 4: QDRANT_BATCH_ORDERING ============

  printHeader("Phase 4: Qdrant Ordering Mode", "Finding optimal QDRANT_BATCH_ORDERING");

  const orderResults = [];

  for (const ordering of TEST_VALUES.QDRANT_BATCH_ORDERING) {
    process.stdout.write(`  Testing QDRANT_BATCH_ORDERING=${c.bold}${ordering.padEnd(6)}${c.reset} `);

    const result = await benchmarkOrdering(qdrant, points, ordering);
    orderResults.push(result);

    const bestOrderRate = Math.max(...orderResults.filter(r => !r.error).map(r => r.rate), 1);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${bar(result.rate, bestOrderRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms)${c.reset}`);
    }
  }

  const bestOrder = orderResults.reduce((best, r) =>
    (!r.error && r.rate > (best?.rate || 0)) ? r : best, null);
  optimal.QDRANT_BATCH_ORDERING = bestOrder?.ordering || "weak";
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_BATCH_ORDERING=${optimal.QDRANT_BATCH_ORDERING}${c.reset}`);
  if (bestOrder) console.log(`    ${c.dim}Speed: ${bestOrder.rate} chunks/sec${c.reset}`);

  // ============ PHASE 5: QDRANT_FLUSH_INTERVAL_MS ============

  printHeader("Phase 5: Qdrant Flush Interval", "Finding optimal QDRANT_FLUSH_INTERVAL_MS");

  const flushDecision = new StoppingDecision();

  for (const interval of TEST_VALUES.QDRANT_FLUSH_INTERVAL_MS) {
    process.stdout.write(`  Testing QDRANT_FLUSH_INTERVAL_MS=${c.bold}${interval.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkFlushInterval(qdrant, points, interval, optimal.QDRANT_UPSERT_BATCH_SIZE, optimal.QDRANT_BATCH_ORDERING);
    const decision = flushDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${bar(result.rate, flushDecision.bestRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms)${c.reset}`);
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestFlush = flushDecision.getBest();
  optimal.QDRANT_FLUSH_INTERVAL_MS = bestFlush?.interval || 500;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_FLUSH_INTERVAL_MS=${optimal.QDRANT_FLUSH_INTERVAL_MS}${c.reset}`);
  if (bestFlush) console.log(`    ${c.dim}Speed: ${bestFlush.rate} chunks/sec${c.reset}`);

  // ============ PHASE 6: BATCH_FORMATION_TIMEOUT_MS ============

  printHeader("Phase 6: Batch Formation Timeout", "Finding optimal BATCH_FORMATION_TIMEOUT_MS (partial batch simulation)");

  const bftDecision = new StoppingDecision();

  for (const timeoutMs of TEST_VALUES.BATCH_FORMATION_TIMEOUT_MS) {
    process.stdout.write(`  Testing BATCH_FORMATION_TIMEOUT_MS=${c.bold}${timeoutMs.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkBatchFormationTimeout(qdrant, points, timeoutMs, optimal.QDRANT_UPSERT_BATCH_SIZE, optimal.QDRANT_BATCH_ORDERING);
    const decision = bftDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      const fillInfo = `fill=${Math.round(result.fillRate * 100)}%`;
      console.log(`${bar(result.rate, bftDecision.bestRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms, ${fillInfo})${c.reset}`);
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestBft = bftDecision.getBest();
  optimal.BATCH_FORMATION_TIMEOUT_MS = bestBft?.timeoutMs || 2000;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: BATCH_FORMATION_TIMEOUT_MS=${optimal.BATCH_FORMATION_TIMEOUT_MS}${c.reset}`);
  if (bestBft) console.log(`    ${c.dim}Speed: ${bestBft.rate} chunks/sec (fill rate: ${Math.round(bestBft.fillRate * 100)}%)${c.reset}`);

  // ============ PHASE 7: QDRANT_DELETE_BATCH_SIZE ============

  printHeader("Phase 7: Delete Batch Size", "Finding optimal QDRANT_DELETE_BATCH_SIZE");

  const delDecision = new StoppingDecision();

  for (const size of TEST_VALUES.QDRANT_DELETE_BATCH_SIZE) {
    process.stdout.write(`  Testing QDRANT_DELETE_BATCH_SIZE=${c.bold}${size.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkDeleteBatchSize(qdrant, points, size, optimal.QDRANT_UPSERT_BATCH_SIZE, optimal.QDRANT_BATCH_ORDERING);
    const decision = delDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${bar(result.rate, delDecision.bestRate)} ${formatRate(result.rate, "del/s")} ${c.dim}(${result.time}ms)${c.reset}`);
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestDel = delDecision.getBest();
  optimal.QDRANT_DELETE_BATCH_SIZE = bestDel?.batchSize || 500;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_DELETE_BATCH_SIZE=${optimal.QDRANT_DELETE_BATCH_SIZE}${c.reset}`);
  if (bestDel) console.log(`    ${c.dim}Speed: ${bestDel.rate} deletions/sec${c.reset}`);

  // ============ PHASE 8: QDRANT_DELETE_CONCURRENCY ============

  printHeader("Phase 8: Delete Concurrency", "Finding optimal QDRANT_DELETE_CONCURRENCY");

  const delConcDecision = new StoppingDecision();

  for (const conc of TEST_VALUES.QDRANT_DELETE_CONCURRENCY) {
    process.stdout.write(`  Testing QDRANT_DELETE_CONCURRENCY=${c.bold}${conc.toString().padStart(2)}${c.reset} `);

    const result = await benchmarkDeleteConcurrency(qdrant, points, conc, optimal.QDRANT_UPSERT_BATCH_SIZE, optimal.QDRANT_BATCH_ORDERING, optimal.QDRANT_DELETE_BATCH_SIZE);
    const decision = delConcDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${bar(result.rate, delConcDecision.bestRate)} ${formatRate(result.rate, "del/s")} ${c.dim}(${result.time}ms)${c.reset}`);
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestDelConc = delConcDecision.getBest();
  optimal.QDRANT_DELETE_CONCURRENCY = bestDelConc?.concurrency || 8;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_DELETE_CONCURRENCY=${optimal.QDRANT_DELETE_CONCURRENCY}${c.reset}`);
  if (bestDelConc) console.log(`    ${c.dim}Speed: ${bestDelConc.rate} deletions/sec${c.reset}`);

  // ============ CLEANUP ============

  await cleanupAllCollections(qdrant);

  // ============ SUMMARY ============

  const totalTime = Math.round((Date.now() - startTime) / 1000);

  printBox("TUNING COMPLETE", "");

  printSummary(optimal);

  // Time estimation table
  // Use embedding calibration result (includes optimal batch size + concurrency)
  const embeddingRate = Math.round(embeddingResult.throughput_chunks_per_sec);
  const storageRate = codeResult.bestRate || 0;

  // Calculate actual indexing rate (bottleneck)
  const indexingRate = Math.min(embeddingRate, storageRate);
  const bottleneck = embeddingRate < storageRate ? "embedding" : "storage";

  console.log(`${c.bold}Indexing Pipeline Performance:${c.reset}`);
  console.log(`  ${c.dim}Embedding:${c.reset}  ${embeddingRate} chunks/sec`);
  console.log(`  ${c.dim}Storage:${c.reset}    ${storageRate} chunks/sec`);
  console.log(`  ${c.dim}Bottleneck:${c.reset} ${c.yellow}${bottleneck}${c.reset} (${indexingRate} chunks/sec)`);
  console.log();

  printTimeEstimates(embeddingRate, storageRate);

  // Write output file
  const metrics = {
    embeddingRate,
    storageRate,
    deletionRate: bestDel?.rate || 0,
  };
  const envPath = writeEnvFile(PROJECT_ROOT, optimal, metrics, totalTime);

  console.log(`${c.bold}Output file:${c.reset}`);
  console.log(`  ${c.dim}${envPath}${c.reset}`);
  console.log();

  printUsage(optimal);

  console.log(`${c.dim}Total tuning time: ${totalTime}s${c.reset}`);
  console.log();
}

main().catch(async (error) => {
  console.error(`${c.red}${c.bold}Fatal error:${c.reset}`, error.message);
  if (qdrantClient) {
    await cleanupAllCollections(qdrantClient);
  }
  process.exit(1);
});
