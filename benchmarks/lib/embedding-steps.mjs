/**
 * Shared Embedding Benchmark Steps
 *
 * Used by both tune.mjs and benchmark-embeddings.mjs
 * Ensures consistent testing methodology
 */

import { CRITERIA, TEST_VALUES, SMART_STEPPING, BATCH_TEST_SAMPLES } from "./config.mjs";
import { c, bar, formatRate } from "./colors.mjs";
import { smartSteppingSearch } from "./smart-stepping.mjs";
import { benchmarkEmbeddingBatchSize, benchmarkConcurrency } from "./benchmarks.mjs";

/**
 * Format time in human readable format
 */
export function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Run EMBEDDING_BATCH_SIZE benchmark
 *
 * @param {Object} embeddings - Embeddings client
 * @param {string[]} texts - Test texts
 * @param {Object} options - Display options
 * @returns {Promise<{bestValue, bestRate, results}>}
 */
export async function runBatchSizeBenchmark(embeddings, texts, options = {}) {
  const { verbose = true } = options;
  let bestRate = 0;

  const result = await smartSteppingSearch({
    start: SMART_STEPPING.EMBEDDING_BATCH_SIZE.start,
    max: SMART_STEPPING.EMBEDDING_BATCH_SIZE.max,
    testFn: async (size) => {
      return await benchmarkEmbeddingBatchSize(embeddings, texts, size);
    },
    onResult: (size, testResult, isMidpoint) => {
      if (!verbose) return;

      const prefix = isMidpoint ? `  ${c.cyan}↳ Midpoint${c.reset} ` : "  Testing ";
      process.stdout.write(`${prefix}EMBEDDING_BATCH_SIZE=${c.bold}${size.toString().padStart(4)}${c.reset} `);

      if (testResult.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${testResult.error}${c.reset}`);
      } else {
        if (testResult.rate > bestRate) bestRate = testResult.rate;
        const batchCount = Math.ceil(BATCH_TEST_SAMPLES / size);
        console.log(
          `${bar(testResult.rate, bestRate)} ${formatRate(testResult.rate, "emb/s")} ` +
          `${c.dim}(${formatTime(testResult.time)}, ${batchCount} batches)${c.reset}`
        );
      }
    },
    onStop: (reason) => {
      if (verbose) {
        console.log(`\n  ${c.yellow}↳ Stopping: ${reason}${c.reset}`);
      }
    },
  });

  return result;
}

/**
 * Run EMBEDDING_CONCURRENCY benchmark
 *
 * IMPORTANT: Each concurrency level processes MORE total work:
 * - concurrency=1: baseBatchCount batches (baseline)
 * - concurrency=2: 2× baseBatchCount batches (each worker = baseBatchCount)
 * - concurrency=4: 4× baseBatchCount batches
 *
 * This measures TRUE parallel scaling. If time stays ~same but work increases,
 * higher concurrency gives real throughput gains.
 *
 * @param {Object} embeddings - Embeddings client
 * @param {string[]} texts - Test texts
 * @param {Object} batchSizeResult - Result from batch size benchmark (used as concurrency=1)
 * @param {number} optimalBatchSize - Optimal batch size from previous step
 * @param {Object} options - Display options
 * @returns {Promise<{bestValue, bestRate, results}>}
 */
export async function runConcurrencyBenchmark(embeddings, texts, batchSizeResult, optimalBatchSize, options = {}) {
  const { verbose = true } = options;
  const results = [];

  // Base batch count from batch size test (this is what each worker will process)
  const baseBatchCount = Math.ceil(BATCH_TEST_SAMPLES / optimalBatchSize);
  const baseSamples = baseBatchCount * optimalBatchSize;

  // Use batch size result as concurrency=1 baseline (already tested!)
  const conc1Result = {
    concurrency: 1,
    time: batchSizeResult.results.find(r => r.value === optimalBatchSize)?.time || 0,
    rate: batchSizeResult.bestRate,
    totalBatches: baseBatchCount,
    totalSamples: baseSamples,
    error: null,
  };
  results.push(conc1Result);

  let bestRate = conc1Result.rate;

  if (verbose) {
    console.log(
      `  ${c.dim}CONCURRENCY= 1${c.reset}  ${bar(conc1Result.rate, bestRate)} ` +
      `${formatRate(conc1Result.rate, "emb/s")} ` +
      `${c.dim}(${baseBatchCount} batches × 1 worker = ${baseBatchCount} total, from batch test)${c.reset}`
    );
  }

  // Test concurrency > 1
  // Each level processes MORE batches: baseBatchCount * concurrency
  for (const conc of TEST_VALUES.EMBEDDING_CONCURRENCY.filter(c => c > 1)) {
    const testResult = await benchmarkConcurrency(embeddings, texts, conc, optimalBatchSize);
    results.push({ concurrency: conc, ...testResult });

    if (verbose) {
      process.stdout.write(`  Testing CONCURRENCY=${c.bold}${conc.toString().padStart(2)}${c.reset} `);

      if (testResult.error) {
        console.log(`${c.red}ERROR${c.reset} ${c.dim}${testResult.error}${c.reset}`);
      } else {
        if (testResult.rate > bestRate) bestRate = testResult.rate;

        // Show scaling factor vs baseline
        const scaling = (testResult.rate / conc1Result.rate).toFixed(2);

        console.log(
          `${bar(testResult.rate, bestRate)} ${formatRate(testResult.rate, "emb/s")} ` +
          `${c.dim}(${baseBatchCount}×${conc}=${testResult.totalBatches} batches, ` +
          `${formatTime(testResult.time)}, ${scaling}x scaling)${c.reset}`
        );
      }
    }

    // Early stopping - diminishing returns (scaling factor < 0.8 of theoretical)
    if (!testResult.error && results.length >= 2) {
      const theoreticalScaling = conc;
      const actualScaling = testResult.rate / conc1Result.rate;
      const efficiency = actualScaling / theoreticalScaling;

      if (efficiency < 0.5) {
        if (verbose) {
          console.log(`\n  ${c.yellow}↳ Stopping: Poor scaling efficiency (${(efficiency * 100).toFixed(0)}% of theoretical)${c.reset}`);
        }
        break;
      }
    }

    // Also stop if rate drops compared to previous
    if (results.length >= 2) {
      const prev = results[results.length - 2];
      if (!testResult.error && !prev.error && testResult.rate < prev.rate * 0.9) {
        if (verbose) {
          console.log(`\n  ${c.yellow}↳ Stopping: Performance degradation (${testResult.rate} < ${prev.rate})${c.reset}`);
        }
        break;
      }
    }
  }

  const best = results.reduce((b, r) => (!r.error && r.rate > (b?.rate || 0)) ? r : b, null);

  return {
    bestValue: best?.concurrency || 1,
    bestRate: best?.rate || 0,
    results,
  };
}
