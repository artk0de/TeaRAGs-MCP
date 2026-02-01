/**
 * Benchmark Functions
 *
 * All benchmark functions for testing different parameters.
 */

import { randomUUID } from "crypto";
import { config, CRITERIA, CODE_CHUNK_SIZE, BATCH_TEST_SAMPLES } from "./config.mjs";

// Track all created collections for cleanup
export const createdCollections = new Set();

export async function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Generate realistic code chunks for benchmarking
 * Each chunk matches CODE_CHUNK_SIZE to simulate real GPU load
 */
export function generateTexts(count) {
  const targetSize = CODE_CHUNK_SIZE;

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

export async function benchmarkEmbeddingBatchSize(embeddings, texts, batchSize) {
  process.env.EMBEDDING_BATCH_SIZE = String(batchSize);

  // Use BATCH_TEST_SAMPLES for quick batch size testing (multiple batches for sustained GPU load)
  const sampleCount = Math.min(BATCH_TEST_SAMPLES, texts.length);
  const testTexts = texts.slice(0, sampleCount);
  const warmupSamples = Math.min(batchSize, sampleCount);

  try {
    // Brief warmup
    await withTimeout(
      embeddings.embedBatch(testTexts.slice(0, warmupSamples)),
      CRITERIA.TEST_TIMEOUT_MS,
      "warmup"
    );

    // Single test run with enough samples for sustained GPU load
    const start = Date.now();
    await withTimeout(
      embeddings.embedBatch(testTexts),
      CRITERIA.TEST_TIMEOUT_MS * 2,
      `batch size ${batchSize}`
    );
    const time = Date.now() - start;

    const rate = Math.round(testTexts.length * 1000 / time);

    return { batchSize, time, rate, error: null };
  } catch (error) {
    return { batchSize, time: 0, rate: 0, error: error.message };
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
 * Benchmark embedding concurrency
 *
 * IMPORTANT: For proper concurrency measurement, each worker must process
 * the SAME number of batches. This means total samples scale with concurrency:
 * - concurrency=1: baseBatchCount batches → baseSamples
 * - concurrency=2: 2 workers × baseBatchCount → 2x baseSamples
 * - concurrency=4: 4 workers × baseBatchCount → 4x baseSamples
 *
 * This measures TRUE parallel scaling: if time stays same but work doubles,
 * concurrency gives real throughput improvement.
 *
 * @param {Object} embeddings - Embeddings client
 * @param {string[]} texts - Test texts pool (should be large enough for all concurrency levels)
 * @param {number} concurrency - Concurrency level to test
 * @param {number} optimalBatchSize - Batch size from previous step (for calculating batch count)
 * @returns {Promise<{concurrency, time, rate, totalBatches, error}>}
 */
export async function benchmarkConcurrency(embeddings, texts, concurrency, optimalBatchSize) {
  process.env.EMBEDDING_CONCURRENCY = String(concurrency);

  // Base batch count from batch size test
  const baseBatchCount = Math.ceil(BATCH_TEST_SAMPLES / optimalBatchSize);

  // With concurrency, each worker processes baseBatchCount batches
  // Total batches = baseBatchCount * concurrency
  // Total samples = totalBatches * optimalBatchSize
  const totalBatches = baseBatchCount * concurrency;
  const totalSamples = totalBatches * optimalBatchSize;

  // Ensure we have enough texts (use cycling if needed)
  let testTexts;
  if (totalSamples <= texts.length) {
    testTexts = texts.slice(0, totalSamples);
  } else {
    // Cycle through texts if we need more
    testTexts = [];
    for (let i = 0; i < totalSamples; i++) {
      testTexts.push(texts[i % texts.length]);
    }
  }

  try {
    // Brief warmup with new concurrency setting
    const warmupSize = Math.min(optimalBatchSize * concurrency, testTexts.length);
    await withTimeout(
      embeddings.embedBatch(testTexts.slice(0, warmupSize)),
      CRITERIA.TEST_TIMEOUT_MS,
      "warmup"
    );

    const start = Date.now();
    await withTimeout(
      embeddings.embedBatch(testTexts),
      CRITERIA.TEST_TIMEOUT_MS * 3, // More time for higher concurrency
      `concurrency ${concurrency}`
    );
    const time = Date.now() - start;

    // Rate = total embeddings processed per second
    const rate = Math.round(testTexts.length * 1000 / time);

    return {
      concurrency,
      time,
      rate,
      totalBatches,
      totalSamples: testTexts.length,
      error: null
    };
  } catch (error) {
    return { concurrency, time: 0, rate: 0, totalBatches: 0, totalSamples: 0, error: error.message };
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
