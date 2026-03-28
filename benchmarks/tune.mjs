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

import { QdrantManager } from "../build/core/adapters/qdrant/client.js";
import {
  benchmarkBatchFormationTimeout,
  benchmarkChunkerPoolSize,
  benchmarkCodeBatchSize,
  benchmarkDeleteBatchSize,
  benchmarkDeleteConcurrency,
  benchmarkDeleteFlushTimeout,
  benchmarkFileConcurrency,
  benchmarkFlushInterval,
  benchmarkGitChunkConcurrency,
  benchmarkIoConcurrency,
  benchmarkMinBatchSize,
  benchmarkOrdering,
  generatePoints,
  generateTexts,
  measureGitLogDuration,
} from "./lib/benchmarks.mjs";
import { cleanupAllCollections } from "./lib/cleanup.mjs";
import { bar, c, formatRate, printBox, printHeader } from "./lib/colors.mjs";
import {
  config,
  CRITERIA,
  GIT_TEST_VALUES,
  isFullMode,
  PIPELINE_TEST_VALUES,
  PROJECT_PATH,
  SAMPLE_SIZE,
  SMART_STEPPING,
  TEST_VALUES,
} from "./lib/config.mjs";
import { calibrateEmbeddings } from "./lib/embedding-calibration.mjs";
import { printTimeEstimates } from "./lib/estimator.mjs";
import { collectSourceFiles, preloadFiles } from "./lib/files.mjs";
import { printSummary, printUsage, writeEnvFile } from "./lib/output.mjs";
import { checkProviderConnectivity, createEmbeddingProvider } from "./lib/provider.mjs";
import { smartSteppingSearch } from "./lib/smart-stepping.mjs";
import { StoppingDecision } from "./lib/stopping.mjs";

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

  // Check embedding provider connectivity
  const embeddingCheck = await checkProviderConnectivity();
  const ollamaCheck = embeddingCheck.ok ? null : embeddingCheck.error;

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
  printBox(
    "TEA RAGS MCP — PERFORMANCE TUNING",
    `Automatic parameter optimization (${isFullMode ? "full" : "quick"} mode)`,
  );

  // Print configuration (dimension will be shown after initialization)
  const embeddingProviderType = process.env.EMBEDDING_PROVIDER || "ollama";
  console.log(`${c.bold}Configuration:${c.reset}`);
  console.log(`  ${c.dim}Qdrant:${c.reset}        ${config.QDRANT_URL}`);
  console.log(`  ${c.dim}Provider:${c.reset}      ${embeddingProviderType}`);
  if (embeddingProviderType === "ollama") {
    console.log(`  ${c.dim}Ollama URL:${c.reset}    ${config.EMBEDDING_BASE_URL}`);
  }
  console.log(
    `  ${c.dim}Model:${c.reset}         ${embeddingProviderType === "onnx" ? "jinaai/jina-embeddings-v2-base-code-fp16 (default)" : config.EMBEDDING_MODEL}`,
  );
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
    console.log(
      `  ${c.dim}QDRANT_URL${c.reset}=${config.QDRANT_URL} ${c.dim}(default: http://localhost:6333)${c.reset}`,
    );
    console.log(
      `  ${c.dim}EMBEDDING_BASE_URL${c.reset}=${config.EMBEDDING_BASE_URL} ${c.dim}(default: http://localhost:11434)${c.reset}`,
    );
    console.log(
      `  ${c.dim}EMBEDDING_MODEL${c.reset}=${config.EMBEDDING_MODEL} ${c.dim}(default: jina-embeddings-v2-base-code)${c.reset}`,
    );
    console.log();
    console.log(`${c.bold}To fix:${c.reset}`);
    console.log(`  1. Start Qdrant:  ${c.cyan}docker compose up -d qdrant${c.reset}`);
    console.log(`  2. Start Ollama:  ${c.cyan}docker compose up -d ollama${c.reset}`);
    console.log(`  3. Pull model:    ${c.cyan}docker exec ollama ollama pull ${config.EMBEDDING_MODEL}${c.reset}`);
    console.log();
    process.exit(1);
  }
  console.log(`  ${c.green}✓${c.reset} Qdrant connected`);
  console.log(`  ${c.green}✓${c.reset} Embedding provider connected`);
  console.log();

  // Initialize clients
  const { provider: embeddings, name: providerName } = await createEmbeddingProvider();
  console.log(`  ${c.green}✓${c.reset} Embedding provider: ${providerName}`);

  // Get actual dimension (auto-detected if not specified)
  const actualDimension = embeddings.getDimensions();
  if (!config.EMBEDDING_DIMENSION) {
    config.EMBEDDING_DIMENSION = actualDimension;
  }
  console.log(
    `  ${c.green}✓${c.reset} Vector dimension: ${actualDimension}${!process.env.EMBEDDING_DIMENSION ? ` ${c.dim}(auto-detected)${c.reset}` : ""}`,
  );
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

  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE}${c.reset}`,
  );
  console.log(
    `  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY}${c.reset}`,
  );
  console.log(`    ${c.dim}Throughput: ${embeddingResult.throughput_chunks_per_sec.toFixed(1)} chunks/sec${c.reset}`);
  console.log(`    ${c.dim}Plateau detected: ${embeddingResult.plateau_detected ? "yes" : "no"}${c.reset}`);
  console.log(
    `    ${c.dim}Configurations tested: ${embeddingResult.stable_configs_count} stable, ${embeddingResult.discarded_configs_count} discarded${c.reset}`,
  );

  process.env.EMBEDDING_BATCH_SIZE = String(optimal.EMBEDDING_BATCH_SIZE);
  process.env.EMBEDDING_CONCURRENCY = String(optimal.EMBEDDING_CONCURRENCY);

  // ============ PIPELINE BENCHMARKS ============

  let projectFiles = null;
  let preloadedFiles = null;
  try {
    console.log(`\n${c.dim}Collecting source files from ${PROJECT_PATH}...${c.reset}`);
    projectFiles = collectSourceFiles(PROJECT_PATH);
    if (projectFiles.length < 50) {
      console.log(`  ${c.yellow}⚠${c.reset} Only ${projectFiles.length} files found (minimum 50 recommended)`);
      console.log(`  ${c.dim}Skipping pipeline benchmarks. Use --path <project> with a larger codebase.${c.reset}\n`);
    } else {
      console.log(`  ${c.green}✓${c.reset} Found ${projectFiles.length} source files\n`);
      preloadedFiles = preloadFiles(projectFiles);
    }
  } catch (err) {
    console.log(`  ${c.yellow}⚠${c.reset} ${err.message}`);
    console.log(`  ${c.dim}Skipping pipeline benchmarks.${c.reset}\n`);
  }

  if (preloadedFiles && preloadedFiles.length >= 50) {
    // CHUNKER_POOL_SIZE
    printHeader("Pipeline: Chunker Pool Size", "Finding optimal INGEST_TUNE_CHUNKER_POOL_SIZE");
    console.log(`  ${c.dim}Warmup...${c.reset}`);
    await benchmarkChunkerPoolSize(preloadedFiles, 2);

    const poolDecision = new StoppingDecision();
    for (const size of PIPELINE_TEST_VALUES.CHUNKER_POOL_SIZE) {
      process.stdout.write(`  Testing CHUNKER_POOL_SIZE=${c.bold}${size.toString().padStart(2)}${c.reset} `);
      const result = await benchmarkChunkerPoolSize(preloadedFiles, size);
      const decision = poolDecision.addResult(result);
      if (result.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
      } else {
        console.log(
          `${bar(result.rate, poolDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms)${c.reset}`,
        );
      }
      if (decision.stop) {
        console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
        break;
      }
    }
    const bestPool = poolDecision.getBest();
    optimal.INGEST_TUNE_CHUNKER_POOL_SIZE = bestPool?.poolSize || 4;
    console.log(
      `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: INGEST_TUNE_CHUNKER_POOL_SIZE=${optimal.INGEST_TUNE_CHUNKER_POOL_SIZE}${c.reset}`,
    );

    // FILE_CONCURRENCY
    printHeader("Pipeline: File Concurrency", "Finding optimal INGEST_TUNE_FILE_CONCURRENCY");
    console.log(`  ${c.dim}Warmup...${c.reset}`);
    await benchmarkFileConcurrency(preloadedFiles, 10);

    const fileDecision = new StoppingDecision();
    for (const conc of PIPELINE_TEST_VALUES.FILE_CONCURRENCY) {
      process.stdout.write(`  Testing FILE_CONCURRENCY=${c.bold}${conc.toString().padStart(3)}${c.reset} `);
      const result = await benchmarkFileConcurrency(preloadedFiles, conc);
      const decision = fileDecision.addResult(result);
      if (result.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
      } else {
        console.log(
          `${bar(result.rate, fileDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms)${c.reset}`,
        );
      }
      if (decision.stop) {
        console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
        break;
      }
    }
    const bestFile = fileDecision.getBest();
    optimal.INGEST_TUNE_FILE_CONCURRENCY = bestFile?.concurrency || 50;
    console.log(
      `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: INGEST_TUNE_FILE_CONCURRENCY=${optimal.INGEST_TUNE_FILE_CONCURRENCY}${c.reset}`,
    );

    // IO_CONCURRENCY
    printHeader("Pipeline: IO Concurrency", "Finding optimal INGEST_TUNE_IO_CONCURRENCY");
    console.log(`  ${c.dim}Warmup...${c.reset}`);
    await benchmarkIoConcurrency(preloadedFiles, 10);

    const ioDecision = new StoppingDecision();
    for (const conc of PIPELINE_TEST_VALUES.IO_CONCURRENCY) {
      process.stdout.write(`  Testing IO_CONCURRENCY=${c.bold}${conc.toString().padStart(3)}${c.reset} `);
      const result = await benchmarkIoConcurrency(preloadedFiles, conc);
      const decision = ioDecision.addResult(result);
      if (result.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
      } else {
        console.log(
          `${bar(result.rate, ioDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms)${c.reset}`,
        );
      }
      if (decision.stop) {
        console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
        break;
      }
    }
    const bestIo = ioDecision.getBest();
    optimal.INGEST_TUNE_IO_CONCURRENCY = bestIo?.concurrency || 50;
    console.log(
      `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: INGEST_TUNE_IO_CONCURRENCY=${optimal.INGEST_TUNE_IO_CONCURRENCY}${c.reset}`,
    );
  }

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
        console.log(
          `${bar(result.rate, codeBestRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms)${c.reset}`,
        );
      }
    },
  });

  optimal.QDRANT_UPSERT_BATCH_SIZE = codeResult.bestValue;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_UPSERT_BATCH_SIZE=${optimal.QDRANT_UPSERT_BATCH_SIZE}${c.reset}`,
  );
  console.log(`    ${c.dim}Speed: ${codeResult.bestRate} chunks/sec${c.reset}`);

  // ============ PHASE 4: QDRANT_BATCH_ORDERING ============

  printHeader("Phase 4: Qdrant Ordering Mode", "Finding optimal QDRANT_BATCH_ORDERING");

  const orderResults = [];

  for (const ordering of TEST_VALUES.QDRANT_BATCH_ORDERING) {
    process.stdout.write(`  Testing QDRANT_BATCH_ORDERING=${c.bold}${ordering.padEnd(6)}${c.reset} `);

    const result = await benchmarkOrdering(qdrant, points, ordering);
    orderResults.push(result);

    const bestOrderRate = Math.max(...orderResults.filter((r) => !r.error).map((r) => r.rate), 1);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, bestOrderRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }
  }

  const bestOrder = orderResults.reduce((best, r) => (!r.error && r.rate > (best?.rate || 0) ? r : best), null);
  optimal.QDRANT_BATCH_ORDERING = bestOrder?.ordering || "weak";
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_BATCH_ORDERING=${optimal.QDRANT_BATCH_ORDERING}${c.reset}`,
  );
  if (bestOrder) console.log(`    ${c.dim}Speed: ${bestOrder.rate} chunks/sec${c.reset}`);

  // ============ PHASE 5: QDRANT_FLUSH_INTERVAL_MS ============

  printHeader("Phase 5: Qdrant Flush Interval", "Finding optimal QDRANT_FLUSH_INTERVAL_MS");

  const flushDecision = new StoppingDecision();

  for (const interval of TEST_VALUES.QDRANT_FLUSH_INTERVAL_MS) {
    process.stdout.write(`  Testing QDRANT_FLUSH_INTERVAL_MS=${c.bold}${interval.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkFlushInterval(
      qdrant,
      points,
      interval,
      optimal.QDRANT_UPSERT_BATCH_SIZE,
      optimal.QDRANT_BATCH_ORDERING,
    );
    const decision = flushDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, flushDecision.bestRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestFlush = flushDecision.getBest();
  optimal.QDRANT_FLUSH_INTERVAL_MS = bestFlush?.interval || 500;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_FLUSH_INTERVAL_MS=${optimal.QDRANT_FLUSH_INTERVAL_MS}${c.reset}`,
  );
  if (bestFlush) console.log(`    ${c.dim}Speed: ${bestFlush.rate} chunks/sec${c.reset}`);

  // ============ PHASE 6: BATCH_FORMATION_TIMEOUT_MS ============

  printHeader(
    "Phase 6: Batch Formation Timeout",
    "Finding optimal BATCH_FORMATION_TIMEOUT_MS (partial batch simulation)",
  );

  const bftDecision = new StoppingDecision();

  for (const timeoutMs of TEST_VALUES.BATCH_FORMATION_TIMEOUT_MS) {
    process.stdout.write(
      `  Testing BATCH_FORMATION_TIMEOUT_MS=${c.bold}${timeoutMs.toString().padStart(4)}${c.reset} `,
    );

    const result = await benchmarkBatchFormationTimeout(
      qdrant,
      points,
      timeoutMs,
      optimal.QDRANT_UPSERT_BATCH_SIZE,
      optimal.QDRANT_BATCH_ORDERING,
    );
    const decision = bftDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      const fillInfo = `fill=${Math.round(result.fillRate * 100)}%`;
      console.log(
        `${bar(result.rate, bftDecision.bestRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms, ${fillInfo})${c.reset}`,
      );
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestBft = bftDecision.getBest();
  optimal.BATCH_FORMATION_TIMEOUT_MS = bestBft?.timeoutMs || 2000;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: BATCH_FORMATION_TIMEOUT_MS=${optimal.BATCH_FORMATION_TIMEOUT_MS}${c.reset}`,
  );
  if (bestBft) {
    console.log(
      `    ${c.dim}Speed: ${bestBft.rate} chunks/sec (fill rate: ${Math.round(bestBft.fillRate * 100)}%)${c.reset}`,
    );
  }

  // ============ PHASE 7: QDRANT_DELETE_BATCH_SIZE ============

  printHeader("Phase 7: Delete Batch Size", "Finding optimal QDRANT_DELETE_BATCH_SIZE");

  const delDecision = new StoppingDecision();

  for (const size of TEST_VALUES.QDRANT_DELETE_BATCH_SIZE) {
    process.stdout.write(`  Testing QDRANT_DELETE_BATCH_SIZE=${c.bold}${size.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkDeleteBatchSize(
      qdrant,
      points,
      size,
      optimal.QDRANT_UPSERT_BATCH_SIZE,
      optimal.QDRANT_BATCH_ORDERING,
    );
    const decision = delDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, delDecision.bestRate)} ${formatRate(result.rate, "del/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestDel = delDecision.getBest();
  optimal.QDRANT_DELETE_BATCH_SIZE = bestDel?.batchSize || 500;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_DELETE_BATCH_SIZE=${optimal.QDRANT_DELETE_BATCH_SIZE}${c.reset}`,
  );
  if (bestDel) console.log(`    ${c.dim}Speed: ${bestDel.rate} deletions/sec${c.reset}`);

  // ============ PHASE 8: QDRANT_DELETE_CONCURRENCY ============

  printHeader("Phase 8: Delete Concurrency", "Finding optimal QDRANT_DELETE_CONCURRENCY");

  const delConcDecision = new StoppingDecision();

  for (const conc of TEST_VALUES.QDRANT_DELETE_CONCURRENCY) {
    process.stdout.write(`  Testing QDRANT_DELETE_CONCURRENCY=${c.bold}${conc.toString().padStart(2)}${c.reset} `);

    const result = await benchmarkDeleteConcurrency(
      qdrant,
      points,
      conc,
      optimal.QDRANT_UPSERT_BATCH_SIZE,
      optimal.QDRANT_BATCH_ORDERING,
      optimal.QDRANT_DELETE_BATCH_SIZE,
    );
    const decision = delConcDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, delConcDecision.bestRate)} ${formatRate(result.rate, "del/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestDelConc = delConcDecision.getBest();
  optimal.QDRANT_DELETE_CONCURRENCY = bestDelConc?.concurrency || 8;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_DELETE_CONCURRENCY=${optimal.QDRANT_DELETE_CONCURRENCY}${c.reset}`,
  );
  if (bestDelConc) console.log(`    ${c.dim}Speed: ${bestDelConc.rate} deletions/sec${c.reset}`);

  // ============ PHASE 9: DELETE_FLUSH_TIMEOUT ============

  printHeader("Phase 9: Delete Flush Timeout", "Finding optimal QDRANT_DELETE_FLUSH_TIMEOUT_MS");

  const dftDecision = new StoppingDecision();

  for (const timeoutMs of PIPELINE_TEST_VALUES.DELETE_FLUSH_TIMEOUT_MS) {
    process.stdout.write(`  Testing DELETE_FLUSH_TIMEOUT_MS=${c.bold}${timeoutMs.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkDeleteFlushTimeout(
      qdrant,
      points,
      timeoutMs,
      optimal.QDRANT_DELETE_BATCH_SIZE,
      optimal.QDRANT_DELETE_CONCURRENCY,
    );
    const decision = dftDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, dftDecision.bestRate)} ${formatRate(result.rate, "del/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestDft = dftDecision.getBest();
  optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS = bestDft?.timeoutMs || 500;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS=${optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS}${c.reset}`,
  );
  if (bestDft) console.log(`    ${c.dim}Speed: ${bestDft.rate} deletions/sec${c.reset}`);

  // ============ PHASE 10: MIN_BATCH_SIZE ============

  printHeader("Phase 10: Min Batch Size", "Finding optimal EMBEDDING_TUNE_MIN_BATCH_SIZE (tail latency)");

  const minBatchResults = [];
  for (const ratio of PIPELINE_TEST_VALUES.MIN_BATCH_RATIO) {
    const minSize = Math.max(1, Math.round(optimal.EMBEDDING_BATCH_SIZE * ratio));
    process.stdout.write(
      `  Testing MIN_BATCH_SIZE=${c.bold}${minSize.toString().padStart(4)}${c.reset} (${Math.round(ratio * 100)}% of batch) `,
    );
    const result = await benchmarkMinBatchSize(embeddings, qdrantTexts, ratio, optimal.EMBEDDING_BATCH_SIZE);
    minBatchResults.push(result);
    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${c.dim}${result.latencyMs}ms${c.reset}`);
    }
  }

  const validResults = minBatchResults.filter((r) => !r.error);
  if (validResults.length > 0) {
    const minLatency = Math.min(...validResults.map((r) => r.latencyMs));
    const acceptable = validResults.filter((r) => r.latencyMs <= minLatency * 1.2);
    const best = acceptable.reduce((a, b) => (a.ratio < b.ratio ? a : b));
    optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE = best.minBatchSize;
  } else {
    optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE = Math.round(optimal.EMBEDDING_BATCH_SIZE * 0.5);
  }
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_TUNE_MIN_BATCH_SIZE=${optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE}${c.reset}`,
  );

  // ============ GIT TRAJECTORY BENCHMARKS ============

  if (projectFiles && projectFiles.length >= 50) {
    // ---- GIT_CHUNK_CONCURRENCY ----
    printHeader("Git: Chunk Concurrency", "Finding optimal TRAJECTORY_GIT_CHUNK_CONCURRENCY");

    const gitTestFiles = [...projectFiles]
      .sort((a, b) => b.size - a.size)
      .slice(0, 20)
      .map((f) => f.relativePath);

    console.log(`  ${c.dim}Testing with ${gitTestFiles.length} files from ${PROJECT_PATH}${c.reset}\n`);

    const gitDecision = new StoppingDecision();
    for (const conc of GIT_TEST_VALUES.CHUNK_CONCURRENCY) {
      process.stdout.write(`  Testing GIT_CHUNK_CONCURRENCY=${c.bold}${conc.toString().padStart(2)}${c.reset} `);
      const result = await benchmarkGitChunkConcurrency(PROJECT_PATH, gitTestFiles, conc);
      const decision = gitDecision.addResult(result);
      if (result.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
      } else {
        console.log(
          `${bar(result.rate, gitDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms, ${result.filesProcessed} files)${c.reset}`,
        );
      }
      if (decision.stop) {
        console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
        break;
      }
    }
    const bestGitConc = gitDecision.getBest();
    optimal.TRAJECTORY_GIT_CHUNK_CONCURRENCY = bestGitConc?.concurrency || 10;
    console.log(
      `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: TRAJECTORY_GIT_CHUNK_CONCURRENCY=${optimal.TRAJECTORY_GIT_CHUNK_CONCURRENCY}${c.reset}`,
    );

    // ---- GIT_LOG_TIMEOUT (informational) ----
    printHeader("Git: Log Duration", "Measuring git log duration at different depths");

    for (const months of GIT_TEST_VALUES.LOG_DEPTHS_MONTHS) {
      process.stdout.write(`  Testing --since="${months} months ago" `);
      const result = await measureGitLogDuration(PROJECT_PATH, months);
      if (result.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
      } else {
        console.log(`${c.dim}${result.durationMs}ms (${result.entries} commits)${c.reset}`);
      }
    }
    console.log(
      `\n  ${c.dim}ℹ Recommended: set TRAJECTORY_GIT_LOG_TIMEOUT_MS to 2× your target depth duration${c.reset}`,
    );
  }

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

  // Terminate embedding provider (ONNX daemon socket keeps process alive)
  if ("terminate" in embeddings && typeof embeddings.terminate === "function") {
    await embeddings.terminate();
  }
}

main().catch(async (error) => {
  console.error(`${c.red}${c.bold}Fatal error:${c.reset}`, error.message);
  if (qdrantClient) {
    await cleanupAllCollections(qdrantClient);
  }
  process.exit(1);
});
