/**
 * Benchmark Functions
 *
 * All benchmark functions for testing different parameters.
 */

import { randomUUID } from "crypto";
import { config, CRITERIA, MEDIAN_CODE_CHUNK_SIZE, EMBEDDING_CALIBRATION } from "./config.mjs";

// Track all created collections for cleanup
export const createdCollections = new Set();

export async function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Calculate median of an array
 */
export function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Generate realistic code chunks for benchmarking
 * Each chunk matches MEDIAN_CODE_CHUNK_SIZE to simulate real GPU load
 */
export function generateTexts(count) {
  const targetSize = MEDIAN_CODE_CHUNK_SIZE;

  return Array.from({ length: count }, (_, i) => {
    // Base code template (~200 chars)
    let chunk = `/**
 * Module ${i}: Data processing utilities
 * @module processor_${i}
 */

import { validateInput, transformData } from './utils';
import { Logger } from '../logging';

const logger = new Logger('processor_${i}');

export class DataProcessor_${i} {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
  }

  async process(data) {
    logger.debug('Processing batch', { size: data.length });

    const validated = data.filter(item => validateInput(item));
    const results = validated.map(item => ({
      id: item.id * ${i},
      value: Math.sqrt(item.value) + ${i % 100},
      timestamp: Date.now()
    }));

    return results.filter(r => r.value > 0);
  }
`;

    // Pad with realistic code to reach target size
    while (chunk.length < targetSize) {
      const methodNum = Math.floor((chunk.length - 200) / 300);
      chunk += `
  async helper_${methodNum}(input) {
    const processed = transformData(input);
    this.cache.set(input.id, processed);
    return processed;
  }
`;
    }

    chunk += `}\n`;
    return chunk.slice(0, targetSize);
  });
}

/**
 * Benchmark embedding batch size with FIXED sample count
 *
 * KEY PRINCIPLE: Same number of samples for ALL batch sizes.
 * This ensures apples-to-apples comparison.
 *
 * @param {Object} embeddings - Embeddings client
 * @param {string[]} texts - Test texts (should have FIXED_SAMPLES count)
 * @param {number} batchSize - Batch size to test
 * @param {number} runs - Number of runs (default from config)
 * @param {Object} options - Additional options
 * @param {number} options.plateauTimeout - Max time before degradation (ms)
 * @returns {Promise<{batchSize, time, rate, times[], batches, error, degraded}>}
 */
export async function benchmarkEmbeddingBatchSize(embeddings, texts, batchSize, runs = EMBEDDING_CALIBRATION.RUNS, options = {}) {
  process.env.EMBEDDING_BATCH_SIZE = String(batchSize);
  process.env.EMBEDDING_CONCURRENCY = "1"; // Isolate batch size variable

  const expectedBatches = Math.ceil(texts.length / batchSize);
  const { plateauTimeout } = options;

  // Use plateau timeout if provided, otherwise default
  const timeout = plateauTimeout
    ? Math.min(plateauTimeout, CRITERIA.TEST_TIMEOUT_MS * 4)
    : CRITERIA.TEST_TIMEOUT_MS * 4;

  try {
    const times = [];

    for (let i = 0; i < runs; i++) {
      const start = Date.now();
      await withTimeout(
        embeddings.embedBatch(texts),
        timeout,
        `batch size ${batchSize} run ${i + 1}`
      );
      times.push(Date.now() - start);
    }

    const medianTime = median(times);
    const rate = Math.round(texts.length * 1000 / medianTime);

    return {
      batchSize,
      time: medianTime,
      rate,
      times,
      batches: expectedBatches,
      error: null,
      degraded: false
    };
  } catch (error) {
    // Check if timeout was due to plateau degradation
    const isDegradation = plateauTimeout && error.message.includes("Timeout");
    return {
      batchSize,
      time: 0,
      rate: 0,
      times: [],
      batches: expectedBatches,
      error: isDegradation ? "degradation" : error.message,
      degraded: isDegradation
    };
  }
}

export async function benchmarkCodeBatchSize(qdrant, points, batchSize) {
  const collection = `tune_batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdCollections.add(collection);

  try {
    await qdrant.createCollection(collection, config.EMBEDDING_DIMENSION, "Cosine");

    const start = Date.now();
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await withTimeout(
        qdrant.addPointsOptimized(collection, batch, {
          wait: i + batchSize >= points.length,
          ordering: "weak",
        }),
        CRITERIA.TEST_TIMEOUT_MS,
        `code batch ${batchSize}`
      );
    }
    const time = Date.now() - start;
    const rate = Math.round(points.length * 1000 / time);

    return { batchSize, time, rate, error: null };
  } catch (error) {
    return { batchSize, time: 0, rate: 0, error: error.message };
  } finally {
    try {
      await qdrant.deleteCollection(collection);
      createdCollections.delete(collection);
    } catch {}
  }
}

/**
 * Benchmark embedding concurrency with FIXED sample count
 *
 * KEY PRINCIPLE: Same number of samples for ALL concurrency levels.
 * This ensures apples-to-apples comparison.
 *
 * Concurrency affects HOW batches are processed (parallel vs sequential),
 * not HOW MANY samples we test.
 *
 * @param {Object} embeddings - Embeddings client
 * @param {string[]} texts - Test texts (should have FIXED_SAMPLES count)
 * @param {number} concurrency - Concurrency level to test
 * @param {number} batchSize - Batch size to use
 * @param {number} runs - Number of runs (default from config)
 * @param {Object} options - Additional options
 * @param {number} options.plateauTimeout - Max time before degradation (ms)
 * @returns {Promise<{concurrency, time, rate, times[], batches, error, degraded}>}
 */
export async function benchmarkConcurrency(embeddings, texts, concurrency, batchSize, runs = EMBEDDING_CALIBRATION.RUNS, options = {}) {
  process.env.EMBEDDING_BATCH_SIZE = String(batchSize);
  process.env.EMBEDDING_CONCURRENCY = String(concurrency);

  const expectedBatches = Math.ceil(texts.length / batchSize);
  const expectedGroups = Math.ceil(expectedBatches / concurrency);
  const { plateauTimeout } = options;

  // Use plateau timeout if provided, otherwise default
  const timeout = plateauTimeout
    ? Math.min(plateauTimeout, CRITERIA.TEST_TIMEOUT_MS * 4)
    : CRITERIA.TEST_TIMEOUT_MS * 4;

  try {
    const times = [];

    for (let i = 0; i < runs; i++) {
      const start = Date.now();
      await withTimeout(
        embeddings.embedBatch(texts),
        timeout,
        `concurrency ${concurrency} run ${i + 1}`
      );
      times.push(Date.now() - start);
    }

    const medianTime = median(times);
    const rate = Math.round(texts.length * 1000 / medianTime);

    return {
      concurrency,
      time: medianTime,
      rate,
      times,
      batches: expectedBatches,
      groups: expectedGroups,
      error: null,
      degraded: false
    };
  } catch (error) {
    const isDegradation = plateauTimeout && error.message.includes("Timeout");
    return {
      concurrency,
      time: 0,
      rate: 0,
      times: [],
      batches: expectedBatches,
      groups: expectedGroups,
      error: isDegradation ? "degradation" : error.message,
      degraded: isDegradation
    };
  }
}

export async function benchmarkOrdering(qdrant, points, ordering) {
  const collection = `tune_ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const batchSize = 256;
  createdCollections.add(collection);

  try {
    await qdrant.createCollection(collection, config.EMBEDDING_DIMENSION, "Cosine");

    const start = Date.now();
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await withTimeout(
        qdrant.addPointsOptimized(collection, batch, {
          wait: i + batchSize >= points.length,
          ordering,
        }),
        CRITERIA.TEST_TIMEOUT_MS,
        `ordering ${ordering}`
      );
    }
    const time = Date.now() - start;
    const rate = Math.round(points.length * 1000 / time);

    return { ordering, time, rate, error: null };
  } catch (error) {
    return { ordering, time: 0, rate: 0, error: error.message };
  } finally {
    try {
      await qdrant.deleteCollection(collection);
      createdCollections.delete(collection);
    } catch {}
  }
}

export async function benchmarkFlushInterval(qdrant, points, interval, optimalBatchSize, optimalOrdering) {
  const collection = `tune_flush_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdCollections.add(collection);

  try {
    await qdrant.createCollection(collection, config.EMBEDDING_DIMENSION, "Cosine");

    process.env.QDRANT_FLUSH_INTERVAL_MS = String(interval);

    const start = Date.now();
    for (let i = 0; i < points.length; i += optimalBatchSize) {
      const batch = points.slice(i, i + optimalBatchSize);
      const isLast = i + optimalBatchSize >= points.length;
      await withTimeout(
        qdrant.addPointsOptimized(collection, batch, {
          wait: isLast,
          ordering: optimalOrdering,
        }),
        CRITERIA.TEST_TIMEOUT_MS,
        `flush interval ${interval}ms`
      );
    }
    const time = Date.now() - start;
    const rate = Math.round(points.length * 1000 / time);

    return { interval, time, rate, error: null };
  } catch (error) {
    return { interval, time: 0, rate: 0, error: error.message };
  } finally {
    try {
      await qdrant.deleteCollection(collection);
      createdCollections.delete(collection);
    } catch {}
  }
}

export async function benchmarkDeleteBatchSize(qdrant, points, deleteBatchSize, optimalBatchSize, optimalOrdering) {
  const collection = `tune_del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdCollections.add(collection);

  try {
    await qdrant.createCollection(collection, config.EMBEDDING_DIMENSION, "Cosine");

    // First, add all points
    for (let i = 0; i < points.length; i += optimalBatchSize) {
      const batch = points.slice(i, i + optimalBatchSize);
      await qdrant.addPointsOptimized(collection, batch, {
        wait: i + optimalBatchSize >= points.length,
        ordering: optimalOrdering,
      });
    }

    // Now test deletion speed
    const pointIds = points.map(p => p.id);
    const start = Date.now();

    for (let i = 0; i < pointIds.length; i += deleteBatchSize) {
      const batch = pointIds.slice(i, i + deleteBatchSize);
      await withTimeout(
        qdrant.client.delete(collection, { points: batch, wait: true }),
        CRITERIA.TEST_TIMEOUT_MS,
        `delete batch ${deleteBatchSize}`
      );
    }
    const time = Date.now() - start;
    const rate = Math.round(pointIds.length * 1000 / time);

    return { batchSize: deleteBatchSize, time, rate, error: null };
  } catch (error) {
    return { batchSize: deleteBatchSize, time: 0, rate: 0, error: error.message };
  } finally {
    try {
      await qdrant.deleteCollection(collection);
      createdCollections.delete(collection);
    } catch {}
  }
}

export async function benchmarkDeleteConcurrency(qdrant, points, concurrency, optimalBatchSize, optimalOrdering, optimalDeleteBatch) {
  const collection = `tune_delc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdCollections.add(collection);

  try {
    await qdrant.createCollection(collection, config.EMBEDDING_DIMENSION, "Cosine");

    // First, add all points
    for (let i = 0; i < points.length; i += optimalBatchSize) {
      const batch = points.slice(i, i + optimalBatchSize);
      await qdrant.addPointsOptimized(collection, batch, {
        wait: i + optimalBatchSize >= points.length,
        ordering: optimalOrdering,
      });
    }

    // Create batches for deletion
    const pointIds = points.map(p => p.id);
    const batches = [];
    for (let i = 0; i < pointIds.length; i += optimalDeleteBatch) {
      batches.push(pointIds.slice(i, i + optimalDeleteBatch));
    }

    // Test deletion with concurrency
    const start = Date.now();
    const queue = [...batches];
    const running = [];

    const runOne = async () => {
      while (queue.length > 0) {
        const batch = queue.shift();
        if (batch) {
          await qdrant.client.delete(collection, { points: batch, wait: true });
        }
      }
    };

    for (let i = 0; i < concurrency; i++) {
      running.push(runOne());
    }
    await Promise.all(running);

    const time = Date.now() - start;
    const rate = Math.round(pointIds.length * 1000 / time);

    return { concurrency, time, rate, error: null };
  } catch (error) {
    return { concurrency, time: 0, rate: 0, error: error.message };
  } finally {
    try {
      await qdrant.deleteCollection(collection);
      createdCollections.delete(collection);
    } catch {}
  }
}

export function generatePoints(embeddingResults, texts) {
  return embeddingResults.map((r, i) => ({
    id: randomUUID(),
    vector: r.embedding,
    payload: { content: texts[i], index: i },
  }));
}
