/**
 * Embedding Calibration Algorithm
 *
 * Three-phase automatic calibration for EMBEDDING_BATCH_SIZE and EMBEDDING_CONCURRENCY.
 *
 * ROLE: Senior systems performance engineer implementing automatic calibration.
 * GOAL: Find PRACTICALLY OPTIMAL and STABLE configuration, not theoretical maximum.
 *
 * SYSTEM MODEL:
 * - Ollama embeddings are GPU-bound and stateful
 * - Batch size controls GPU utilization
 * - Concurrency controls queue pressure, NOT GPU parallelism
 * - Optimal performance forms a PLATEAU, not a single peak
 * - Excessive batch/concurrency causes contention and degradation
 *
 * CORE PRINCIPLES:
 * 1. Adaptive workload: min(batch×2, MAX_TOTAL_CHUNKS) per batch size
 * 2. Throughput = chunks / wall_clock_time
 * 3. Search for STABLE PLATEAU, not absolute maximum
 * 4. Differences < 2-3% are considered NOISE
 * 5. Prefer stability and robustness over peak performance
 */

import { benchmarkEmbeddingBatchSize, benchmarkConcurrency, generateTexts } from "./benchmarks.mjs";
import { c, formatRate } from "./colors.mjs";
import { config } from "./config.mjs";

// Calibration constants
const CALIBRATION_CONFIG = {
  // Phase 1: Batch plateau detection
  BATCH_SET: [256, 512, 1024, 2048, 3072, 4096],
  PLATEAU_THRESHOLD: 0.03,  // 3% improvement threshold

  // Phase 2: Concurrency testing
  CONCURRENCY_SET: [1, 2, 4, 6, 8],

  // Phase 3: Configuration selection
  ACCEPTABLE_THRESHOLD: 0.02,  // Within 2% of max = acceptable

  // Workload sizing
  MAX_TOTAL_CHUNKS: 4096,  // Maximum chunks to test (replaces TUNE_SAMPLE_SIZE)
  RUNS: 2,  // Number of runs for median

  // Stall detection
  STALL_TIMEOUT_MS: 30000,  // 30s without progress = STALL
};

/**
 * Format time in human readable format
 */
function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * PHASE 1: BATCH PLATEAU DETECTION (CONCURRENCY = 1)
 *
 * Purpose: Find where increasing batch size stops improving throughput.
 *
 * Strategy:
 * 1. Test batch sizes: [256, 1024, 2048, 3072, 4096]
 * 2. Stop when improvement < 3% or throughput decreases
 * 3. Define plateau as: first slow-improvement batch + next 1-2 batches
 *
 * @param {Object} embeddings - Embeddings client
 * @param {string[]} texts - Test texts (TOTAL_CHUNKS count)
 * @param {Object} options - Display options
 * @returns {Promise<{plateauBatches: number[], results: Object[]}>}
 */
export async function findBatchPlateau(embeddings, texts, options = {}) {
  const { verbose = true } = options;
  const { BATCH_SET, PLATEAU_THRESHOLD, RUNS } = CALIBRATION_CONFIG;

  if (verbose) {
    console.log(`${c.bold}Phase 1: Batch Plateau Detection${c.reset} ${c.dim}(CONCURRENCY=1)${c.reset}`);
    console.log(`  Testing ${BATCH_SET.length} batch sizes: [${BATCH_SET.join(", ")}]`);
    console.log(`  ${c.dim}Chunk count per batch: min(batch×2, ${texts.length})${c.reset}`);
    console.log(`  ${c.dim}Plateau threshold: ${(PLATEAU_THRESHOLD * 100).toFixed(0)}% improvement${c.reset}`);
    console.log();
  }

  const results = [];
  let prevRate = 0;

  for (let i = 0; i < BATCH_SET.length; i++) {
    const batchSize = BATCH_SET[i];
    // Use min(batch×2, MAX_TOTAL_CHUNKS) chunks for this batch size
    const chunkCount = Math.min(batchSize * 2, texts.length);
    const testTexts = texts.slice(0, chunkCount);

    // Calculate plateau timeout based on previous throughput
    // If throughput drops below (1 - PLATEAU_THRESHOLD) of previous, it's degradation
    // Add 1.5x buffer for network jitter and variance
    let plateauTimeout = null;
    if (prevRate > 0) {
      const minAcceptableRate = prevRate * (1 - PLATEAU_THRESHOLD);
      // Time = chunks / rate, convert to ms, add 1.5x buffer
      plateauTimeout = Math.ceil((chunkCount / minAcceptableRate) * 1000 * 1.5);
    }

    if (verbose) {
      const timeoutInfo = plateauTimeout ? ` ${c.dim}(max ${formatTime(plateauTimeout)})${c.reset}` : "";
      process.stdout.write(`  ${chunkCount.toString().padStart(4)} chunks @ batch ${c.bold}${batchSize}${c.reset}${timeoutInfo}  `);
    }

    const testResult = await benchmarkEmbeddingBatchSize(embeddings, testTexts, batchSize, RUNS, { plateauTimeout });
    results.push({ batchSize, ...testResult });

    if (testResult.degraded) {
      if (verbose) {
        console.log(`${c.yellow}DEGRADED${c.reset} ${c.dim}(exceeded plateau timeout)${c.reset}`);
        console.log(`  ${c.yellow}→ Performance degradation detected, stopping${c.reset}`);
      }
      break;
    }

    if (testResult.error) {
      if (verbose) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${testResult.error}${c.reset}`);
      }
      continue;
    }

    const { rate } = testResult;
    const improvement = prevRate > 0 ? (rate - prevRate) / prevRate : 1.0;

    if (verbose) {
      const improvementPct = (improvement * 100).toFixed(1);
      const sign = improvement >= 0 ? "+" : "";
      const color = improvement < PLATEAU_THRESHOLD ? c.yellow : c.green;

      console.log(
        `${formatRate(rate, "chunks/s")}  ` +
        `${c.dim}(${formatTime(testResult.time)})${c.reset}  ` +
        `${color}${sign}${improvementPct}%${c.reset}`
      );
    }

    // Detect plateau and STOP immediately
    if (prevRate > 0 && (improvement < PLATEAU_THRESHOLD || improvement < 0)) {
      if (verbose) {
        console.log(`  ${c.yellow}→ Plateau detected, stopping${c.reset}`);
      }
      break;
    }

    prevRate = rate;
  }

  // Define plateau batches: last 2-3 valid results (exclude degraded and errors)
  const validResults = results.filter(r => !r.error && !r.degraded);
  const plateauBatches = validResults.slice(-Math.min(3, validResults.length)).map(r => r.batchSize);

  if (verbose) {
    console.log(`  ${c.green}Plateau batches: [${plateauBatches.join(", ")}]${c.reset}`);
  }

  // Create map of batchSize -> rate for Phase 2 reuse
  const batchRates = {};
  for (const r of results) {
    if (!r.error) {
      batchRates[r.batchSize] = r.rate;
    }
  }

  return { plateauBatches, results, batchRates };
}

/**
 * PHASE 2: CONCURRENCY EFFECT TEST (ON PLATEAU ONLY)
 *
 * Purpose: Determine whether concurrency helps or hurts.
 *
 * Strategy:
 * 1. Reuse CONC=1 results from Phase 1 (no retesting)
 * 2. For each batch in plateau: test CONCURRENCY [2, 4]
 * 3. Early exit if concurrency degrades performance (> PLATEAU_THRESHOLD)
 * 4. Early exit if next batch size degrades baseline performance
 *
 * @param {Object} embeddings - Embeddings client
 * @param {string[]} texts - Test texts (TOTAL_CHUNKS count)
 * @param {number[]} plateauBatches - Batch sizes from Phase 1
 * @param {Object} batchRates - Map of batchSize -> rate from Phase 1 (CONC=1)
 * @param {Object} options - Display options
 * @returns {Promise<{stableConfigs: Object[], discardedConfigs: Object[]}>}
 */
export async function testConcurrencyOnPlateau(embeddings, texts, plateauBatches, batchRates, options = {}) {
  const { verbose = true } = options;
  const { CONCURRENCY_SET, PLATEAU_THRESHOLD, RUNS } = CALIBRATION_CONFIG;

  if (verbose) {
    console.log();
    console.log(`${c.bold}Phase 2: Concurrency Effect Test${c.reset}`);
    console.log(`  Testing ${plateauBatches.length} batch sizes × ${CONCURRENCY_SET.length} concurrency levels`);
    console.log(`  ${c.dim}Plateau batches: [${plateauBatches.join(", ")}]${c.reset}`);
    console.log();
  }

  const stableConfigs = [];
  const discardedConfigs = [];

  for (const batchSize of plateauBatches) {
    if (verbose) {
      console.log(`  ${c.dim}BATCH=${batchSize}${c.reset}`);
    }

    // Use Phase 1 result for CONC=1 (no retesting)
    const baselineRate = batchRates[batchSize];

    if (!baselineRate) {
      if (verbose) {
        console.log(`    ${c.yellow}Skipping: no baseline from Phase 1${c.reset}`);
      }
      continue;
    }

    // Add CONC=1 config from Phase 1 (reusing result)
    stableConfigs.push({
      batchSize,
      concurrency: 1,
      throughput: baselineRate,
      wallTime: 0, // Unknown from Phase 1, but not needed for selection
      status: "STABLE",
      reused: true,
    });

    if (verbose) {
      console.log(`    CONC=${c.bold}1${c.reset}  ${c.dim}(from Phase 1)${c.reset}  ${formatRate(baselineRate, "chunks/s")}`);
    }

    // Track previous concurrency rate for plateau detection
    let prevConcRate = baselineRate;

    // Test higher concurrency levels [2, 4, 6, 8]
    for (const conc of CONCURRENCY_SET) {
      if (conc === 1) continue; // Skip, already added from Phase 1

      // Calculate chunk count: batch_size × concurrency × 2 (minimum 2 runs per worker)
      const chunkCount = Math.min(batchSize * conc * 2, texts.length);
      const testTexts = texts.slice(0, chunkCount);

      // Calculate plateau timeout based on actual chunk count and baseline rate
      // Add 1.5x buffer for network jitter and variance
      const minAcceptableRate = baselineRate * (1 - PLATEAU_THRESHOLD);
      const plateauTimeout = Math.ceil((chunkCount / minAcceptableRate) * 1000 * 1.5);

      if (verbose) {
        process.stdout.write(`    CONC=${c.bold}${conc}${c.reset} ${c.dim}(${chunkCount} chunks, max ${formatTime(plateauTimeout)})${c.reset}  `);
      }

      const testResult = await benchmarkConcurrency(embeddings, testTexts, conc, batchSize, RUNS, { plateauTimeout });

      if (testResult.degraded) {
        discardedConfigs.push({ batchSize, concurrency: conc, reason: "degradation" });
        if (verbose) {
          console.log(`${c.yellow}DEGRADED${c.reset} ${c.dim}(exceeded plateau timeout)${c.reset}`);
        }
        break; // Stop testing higher concurrency for this batch
      }

      if (testResult.error) {
        discardedConfigs.push({ batchSize, concurrency: conc, reason: testResult.error });
        if (verbose) {
          console.log(`${c.red}ERROR${c.reset} ${c.dim}${testResult.error}${c.reset}`);
        }
        continue;
      }

      const config = {
        batchSize,
        concurrency: conc,
        throughput: testResult.rate,
        wallTime: testResult.time,
        status: "STABLE"
      };

      stableConfigs.push(config);

      // Check for concurrency plateau - stop if improvement < PLATEAU_THRESHOLD
      const concImprovement = (testResult.rate - prevConcRate) / prevConcRate;

      if (verbose) {
        const improvementPct = (concImprovement * 100).toFixed(1);
        const sign = concImprovement >= 0 ? "+" : "";
        console.log(
          `${c.green}STABLE${c.reset}  ` +
          `${formatRate(testResult.rate, "chunks/s")}  ` +
          `${c.dim}(${formatTime(testResult.time)})${c.reset}  ` +
          `${concImprovement < PLATEAU_THRESHOLD ? c.yellow : c.green}${sign}${improvementPct}%${c.reset}`
        );
      }

      if (concImprovement < PLATEAU_THRESHOLD) {
        if (verbose) {
          console.log(`    ${c.yellow}→ Concurrency plateau, stopping${c.reset}`);
        }
        break;
      }

      prevConcRate = testResult.rate;
    }
  }

  return { stableConfigs, discardedConfigs };
}

/**
 * PHASE 3: CONFIGURATION SELECTION (PLATEAU-BASED)
 *
 * Purpose: Choose a robust production configuration.
 *
 * Strategy:
 * 1. Find MAX_THROUGHPUT among stable configurations
 * 2. ACCEPTABLE_SET = throughput >= 0.98 × MAX_THROUGHPUT
 * 3. Choose from ACCEPTABLE_SET with priority:
 *    - Lower CONCURRENCY (reduces tail-risk)
 *    - Lower BATCH_SIZE (faster responsiveness)
 *    - Higher throughput (only if difference > 3%)
 *
 * This avoids overfitting to noise and reduces tail-risk.
 *
 * @param {Object[]} stableConfigs - Stable configurations from Phase 2
 * @param {Object} options - Display options
 * @returns {Object} - Selected configuration
 */
export function selectOptimalConfiguration(stableConfigs, options = {}) {
  const { verbose = true, isRemote = false } = options;
  const { ACCEPTABLE_THRESHOLD } = CALIBRATION_CONFIG;

  if (verbose) {
    console.log();
    console.log(`${c.bold}Phase 3: Configuration Selection${c.reset}`);
    console.log(`  ${c.dim}Acceptable threshold: within ${(ACCEPTABLE_THRESHOLD * 100).toFixed(0)}% of maximum${c.reset}`);
    console.log();
  }

  if (stableConfigs.length === 0) {
    throw new Error("No stable configurations found!");
  }

  // Find maximum throughput
  const maxThroughput = Math.max(...stableConfigs.map(c => c.throughput));
  const acceptableThreshold = maxThroughput * (1 - ACCEPTABLE_THRESHOLD);

  // Filter acceptable configurations
  const acceptableConfigs = stableConfigs.filter(c => c.throughput >= acceptableThreshold);

  if (verbose) {
    console.log(`  ${c.dim}Max throughput: ${maxThroughput.toFixed(1)} chunks/s${c.reset}`);
    console.log(`  ${c.dim}Acceptable configs: ${acceptableConfigs.length}/${stableConfigs.length}${c.reset}`);
    console.log();

    console.log(`  ${c.bold}Acceptable configurations:${c.reset}`);
    for (const cfg of acceptableConfigs) {
      const pct = ((cfg.throughput / maxThroughput) * 100).toFixed(1);
      console.log(
        `    BATCH=${cfg.batchSize.toString().padStart(4)} CONC=${cfg.concurrency}  ` +
        `${formatRate(cfg.throughput, "chunks/s")}  ` +
        `${c.dim}(${pct}% of max)${c.reset}`
      );
    }
    console.log();
  }

  // Sort for LOCAL: lower concurrency → higher batch → higher throughput
  // (minimize overhead, GPU works sequentially)
  const sortedLocal = [...acceptableConfigs].sort((a, b) => {
    if (a.concurrency !== b.concurrency) return a.concurrency - b.concurrency;
    if (a.batchSize !== b.batchSize) return b.batchSize - a.batchSize; // prefer higher batch
    return b.throughput - a.throughput;
  });

  // Sort for REMOTE: higher concurrency → lower batch → higher throughput
  // (hide network latency with parallelism)
  const sortedRemote = [...acceptableConfigs].sort((a, b) => {
    if (a.concurrency !== b.concurrency) return b.concurrency - a.concurrency; // prefer higher conc
    if (a.batchSize !== b.batchSize) return a.batchSize - b.batchSize; // prefer lower batch
    return b.throughput - a.throughput;
  });

  const selectedLocal = sortedLocal[0];
  const selectedRemote = sortedRemote[0];
  const selected = isRemote ? selectedRemote : selectedLocal;

  if (verbose) {
    // Show recommendations for both setups
    console.log(`  ${c.bold}Recommended configurations:${c.reset}`);
    console.log();

    // Local recommendation
    const localPct = ((selectedLocal.throughput / maxThroughput) * 100).toFixed(1);
    console.log(`  ${c.green}🏠 Local GPU:${c.reset}`);
    console.log(`    BATCH_SIZE=${c.bold}${selectedLocal.batchSize}${c.reset}  CONCURRENCY=${c.bold}${selectedLocal.concurrency}${c.reset}  ${formatRate(selectedLocal.throughput, "chunks/s")} ${c.dim}(${localPct}%)${c.reset}`);
    if (selectedLocal.concurrency === 1) {
      console.log(`    ${c.dim}→ GPU-bound: minimize overhead with larger batches${c.reset}`);
    } else {
      console.log(`    ${c.dim}→ Lower concurrency reduces contention${c.reset}`);
    }
    console.log();

    // Remote recommendation (only if different)
    if (selectedRemote.batchSize !== selectedLocal.batchSize || selectedRemote.concurrency !== selectedLocal.concurrency) {
      const remotePct = ((selectedRemote.throughput / maxThroughput) * 100).toFixed(1);
      console.log(`  ${c.cyan}🌐 Remote GPU:${c.reset}`);
      console.log(`    BATCH_SIZE=${c.bold}${selectedRemote.batchSize}${c.reset}  CONCURRENCY=${c.bold}${selectedRemote.concurrency}${c.reset}  ${formatRate(selectedRemote.throughput, "chunks/s")} ${c.dim}(${remotePct}%)${c.reset}`);
      console.log(`    ${c.dim}→ Concurrency hides network latency${c.reset}`);
      console.log();
    }

    // Current setup indicator
    const setupType = isRemote ? "🌐 Remote" : "🏠 Local";
    console.log(`  ${c.dim}Detected setup: ${setupType}${c.reset}`);
  }

  return selected;
}

/**
 * MAIN ORCHESTRATOR: Complete calibration workflow
 *
 * Runs all three phases and returns optimal configuration.
 *
 * @param {Object} embeddings - Embeddings client
 * @param {Object} options - Options
 * @returns {Promise<Object>} - Calibration result
 */
export async function calibrateEmbeddings(embeddings, options = {}) {
  const { verbose = true, maxTotalChunks = CALIBRATION_CONFIG.MAX_TOTAL_CHUNKS } = options;

  const startTime = Date.now();

  if (verbose) {
    console.log(`${c.bold}Embedding Calibration${c.reset}`);
    console.log(`  ${c.dim}Max chunks: ${maxTotalChunks}${c.reset}`);
    console.log(`  ${c.dim}Strategy: test min(batch×2, max) chunks per batch${c.reset}`);
    console.log();
  }

  // Generate test texts (max pool, sliced per batch)
  const texts = generateTexts(maxTotalChunks);

  // GPU Warmup (10 seconds)
  if (verbose) {
    process.stdout.write(`${c.dim}GPU warmup (10s)...${c.reset} `);
  }
  const warmupStart = Date.now();
  const warmupTexts = texts.slice(0, 512);
  while (Date.now() - warmupStart < 10000) {
    await embeddings.embedBatch(warmupTexts);
  }
  if (verbose) {
    console.log(`${c.green}done${c.reset}`);
    console.log();
  }

  // Phase 1: Find batch plateau
  const { plateauBatches, batchRates } = await findBatchPlateau(embeddings, texts, { verbose });

  // Phase 2: Test concurrency on plateau
  const { stableConfigs, discardedConfigs } = await testConcurrencyOnPlateau(embeddings, texts, plateauBatches, batchRates, { verbose });

  // Detect if remote setup (not localhost)
  const isRemote = !config.EMBEDDING_BASE_URL.includes("localhost") &&
                   !config.EMBEDDING_BASE_URL.includes("127.0.0.1");

  // Phase 3: Select optimal configuration
  const selected = selectOptimalConfiguration(stableConfigs, { verbose, isRemote });

  const totalTime = Date.now() - startTime;

  if (verbose) {
    console.log();
    console.log(`${c.dim}Total calibration time: ${formatTime(totalTime)}${c.reset}`);
  }

  return {
    EMBEDDING_BATCH_SIZE: selected.batchSize,
    EMBEDDING_CONCURRENCY: selected.concurrency,
    throughput_chunks_per_sec: selected.throughput,
    plateau_detected: true,
    calibration_time_ms: totalTime,
    stable_configs_count: stableConfigs.length,
    discarded_configs_count: discardedConfigs.length,
  };
}
