#!/usr/bin/env node
/**
 * Unified Performance Tuning Benchmark
 *
 * Automatically finds optimal values for all performance parameters:
 * - EMBEDDING_BATCH_SIZE
 * - EMBEDDING_CONCURRENCY
 * - CODE_BATCH_SIZE
 * - QDRANT_BATCH_ORDERING
 *
 * Strong stopping criteria:
 * - Degradation threshold (20% drop from best)
 * - Consecutive degradations (3 in a row)
 * - Absolute timeout per test (30s)
 * - Error rate threshold (>10% failures)
 * - No improvement threshold (<5% gain)
 *
 * Run: npm run tune
 * Output: tuned_environment_variables.env
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ============ CONFIGURATION ============

const config = {
  QDRANT_URL: process.env.QDRANT_URL || "http://localhost:6333",
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://localhost:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "nomic-embed-text",
  EMBEDDING_DIMENSION: parseInt(process.env.EMBEDDING_DIMENSION || "768", 10),
};

// ============ STOPPING CRITERIA ============

const CRITERIA = {
  DEGRADATION_THRESHOLD: 0.20,      // 20% drop from best = stop
  CONSECUTIVE_DEGRADATIONS: 3,      // 3 drops in a row = stop
  TEST_TIMEOUT_MS: 30000,           // 30s max per single test
  ERROR_RATE_THRESHOLD: 0.10,       // >10% errors = stop
  NO_IMPROVEMENT_THRESHOLD: 0.05,   // <5% improvement = stop
  WARMUP_RUNS: 1,
  TEST_RUNS: 2,
};

// ============ TEST VALUES ============

const TEST_VALUES = {
  EMBEDDING_BATCH_SIZE: [32, 64, 128, 256, 512, 1024, 2048],
  CODE_BATCH_SIZE: [64, 128, 256, 384, 512, 768, 1024],
  EMBEDDING_CONCURRENCY: [1, 2, 4, 8],
  QDRANT_BATCH_ORDERING: ["weak", "medium", "strong"],
};

// Sample sizes
const SAMPLE_SIZE = 512;

// ============ COLORS ============

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
};

// ============ UTILITIES ============

function bar(current, best, width = 20) {
  const ratio = Math.min(current / best, 1);
  const filled = Math.round(ratio * width);
  const clr = ratio >= 0.95 ? c.green : ratio >= 0.8 ? c.yellow : c.gray;
  return `${clr}${"█".repeat(filled)}${"░".repeat(width - filled)}${c.reset}`;
}

function formatRate(value, unit) {
  const clr = value >= 1000 ? c.green : value >= 500 ? c.yellow : c.gray;
  return `${clr}${c.bold}${value}${c.reset} ${c.dim}${unit}${c.reset}`;
}

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

function printHeader(title, subtitle = "") {
  console.log();
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}${title}${c.reset}`);
  if (subtitle) console.log(`${c.dim}${subtitle}${c.reset}`);
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log();
}

// ============ STOPPING LOGIC ============

class StoppingDecision {
  constructor() {
    this.results = [];
    this.bestRate = 0;
    this.consecutiveDegradations = 0;
    this.errors = 0;
    this.totalTests = 0;
  }

  addResult(result) {
    this.results.push(result);
    this.totalTests++;

    if (result.error) {
      this.errors++;
      return this.checkStop("error");
    }

    if (result.rate > this.bestRate) {
      this.bestRate = result.rate;
      this.consecutiveDegradations = 0;
    } else {
      const degradation = (this.bestRate - result.rate) / this.bestRate;
      if (degradation >= CRITERIA.DEGRADATION_THRESHOLD) {
        this.consecutiveDegradations++;
      } else {
        this.consecutiveDegradations = 0;
      }
    }

    return this.checkStop();
  }

  checkStop(reason = null) {
    // Error rate too high
    if (this.errors / this.totalTests > CRITERIA.ERROR_RATE_THRESHOLD && this.totalTests >= 3) {
      return { stop: true, reason: `Error rate exceeded ${CRITERIA.ERROR_RATE_THRESHOLD * 100}%` };
    }

    // Consecutive degradations
    if (this.consecutiveDegradations >= CRITERIA.CONSECUTIVE_DEGRADATIONS) {
      return { stop: true, reason: `${CRITERIA.CONSECUTIVE_DEGRADATIONS} consecutive degradations` };
    }

    // Single large degradation
    if (this.results.length >= 2) {
      const last = this.results[this.results.length - 1];
      const degradation = (this.bestRate - last.rate) / this.bestRate;
      if (degradation >= CRITERIA.DEGRADATION_THRESHOLD) {
        return { stop: true, reason: `Performance dropped ${Math.round(degradation * 100)}% from best` };
      }
    }

    // No improvement (for concurrency tests)
    if (this.results.length >= 2) {
      const prev = this.results[this.results.length - 2];
      const curr = this.results[this.results.length - 1];
      const improvement = (curr.rate - prev.rate) / prev.rate;
      if (improvement < CRITERIA.NO_IMPROVEMENT_THRESHOLD && curr.rate <= this.bestRate) {
        return { stop: true, reason: `No significant improvement (<${CRITERIA.NO_IMPROVEMENT_THRESHOLD * 100}%)` };
      }
    }

    return { stop: false };
  }

  getBest() {
    return this.results.reduce((best, r) =>
      (!r.error && r.rate > (best?.rate || 0)) ? r : best, null);
  }
}

// ============ BENCHMARK FUNCTIONS ============

async function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

async function benchmarkEmbeddingBatchSize(embeddings, texts, batchSize) {
  process.env.EMBEDDING_BATCH_SIZE = String(batchSize);

  const testTexts = texts.slice(0, Math.min(batchSize, texts.length));

  try {
    // Warmup
    for (let i = 0; i < CRITERIA.WARMUP_RUNS; i++) {
      await withTimeout(
        embeddings.embedBatch(testTexts.slice(0, 32)),
        CRITERIA.TEST_TIMEOUT_MS,
        "warmup"
      );
    }

    // Test runs
    const times = [];
    for (let i = 0; i < CRITERIA.TEST_RUNS; i++) {
      const start = Date.now();
      await withTimeout(
        embeddings.embedBatch(testTexts),
        CRITERIA.TEST_TIMEOUT_MS,
        `batch size ${batchSize}`
      );
      times.push(Date.now() - start);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const rate = Math.round(testTexts.length * 1000 / avgTime);

    return { batchSize, time: Math.round(avgTime), rate, error: null };
  } catch (error) {
    return { batchSize, time: 0, rate: 0, error: error.message };
  }
}

async function benchmarkCodeBatchSize(qdrant, points, batchSize) {
  const collection = `tune_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
    try { await qdrant.deleteCollection(collection); } catch {}
  }
}

async function benchmarkConcurrency(embeddings, texts, concurrency) {
  process.env.EMBEDDING_CONCURRENCY = String(concurrency);

  try {
    const start = Date.now();
    await withTimeout(
      embeddings.embedBatch(texts),
      CRITERIA.TEST_TIMEOUT_MS * 2,
      `concurrency ${concurrency}`
    );
    const time = Date.now() - start;
    const rate = Math.round(texts.length * 1000 / time);

    return { concurrency, time, rate, error: null };
  } catch (error) {
    return { concurrency, time: 0, rate: 0, error: error.message };
  }
}

async function benchmarkOrdering(qdrant, points, ordering) {
  const collection = `tune_ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const batchSize = 256;

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
    try { await qdrant.deleteCollection(collection); } catch {}
  }
}

// ============ MAIN ============

async function main() {
  console.clear();
  console.log();
  console.log(`${c.cyan}${c.bold}╔══════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}${c.bold}║${c.reset}     ${c.bold}TEA RAGS MCP — PERFORMANCE TUNING${c.reset}                  ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`${c.cyan}${c.bold}║${c.reset}     ${c.dim}Automatic parameter optimization${c.reset}                     ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`${c.cyan}${c.bold}╚══════════════════════════════════════════════════════════╝${c.reset}`);
  console.log();

  console.log(`${c.bold}Configuration:${c.reset}`);
  console.log(`  ${c.dim}Qdrant:${c.reset}    ${config.QDRANT_URL}`);
  console.log(`  ${c.dim}Ollama:${c.reset}    ${config.EMBEDDING_BASE_URL}`);
  console.log(`  ${c.dim}Model:${c.reset}     ${config.EMBEDDING_MODEL}`);
  console.log(`  ${c.dim}Dimension:${c.reset} ${config.EMBEDDING_DIMENSION}`);
  console.log();

  console.log(`${c.bold}Stopping criteria:${c.reset}`);
  console.log(`  ${c.dim}Degradation threshold:${c.reset} ${CRITERIA.DEGRADATION_THRESHOLD * 100}%`);
  console.log(`  ${c.dim}Consecutive drops:${c.reset}     ${CRITERIA.CONSECUTIVE_DEGRADATIONS}`);
  console.log(`  ${c.dim}Test timeout:${c.reset}          ${CRITERIA.TEST_TIMEOUT_MS / 1000}s`);
  console.log(`  ${c.dim}Error rate limit:${c.reset}      ${CRITERIA.ERROR_RATE_THRESHOLD * 100}%`);
  console.log();

  // Initialize clients
  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIMENSION,
    undefined,
    config.EMBEDDING_BASE_URL
  );
  const qdrant = new QdrantManager(config.QDRANT_URL);

  // Generate test data
  console.log(`${c.dim}Generating ${SAMPLE_SIZE} test samples...${c.reset}`);
  const texts = generateTexts(SAMPLE_SIZE);

  console.log(`${c.dim}Warming up embedding service...${c.reset}`);
  process.env.EMBEDDING_BATCH_SIZE = "32";
  process.env.EMBEDDING_CONCURRENCY = "1";
  await embeddings.embedBatch(texts.slice(0, 32));

  const optimal = {};
  const startTime = Date.now();

  // ============ PHASE 1: EMBEDDING_BATCH_SIZE ============

  printHeader("Phase 1: Embedding Batch Size", "Finding optimal EMBEDDING_BATCH_SIZE");

  const embDecision = new StoppingDecision();

  for (const size of TEST_VALUES.EMBEDDING_BATCH_SIZE) {
    process.stdout.write(`  Testing EMBEDDING_BATCH_SIZE=${c.bold}${size.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkEmbeddingBatchSize(embeddings, texts, size);
    const decision = embDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${bar(result.rate, embDecision.bestRate)} ${formatRate(result.rate, "emb/s")} ${c.dim}(${result.time}ms)${c.reset}`);
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestEmb = embDecision.getBest();
  optimal.EMBEDDING_BATCH_SIZE = bestEmb?.batchSize || 64;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE}${c.reset}`);
  if (bestEmb) console.log(`    ${c.dim}Speed: ${bestEmb.rate} embeddings/sec${c.reset}`);

  process.env.EMBEDDING_BATCH_SIZE = String(optimal.EMBEDDING_BATCH_SIZE);

  // ============ PHASE 2: EMBEDDING_CONCURRENCY ============

  printHeader("Phase 2: Embedding Concurrency", "Finding optimal EMBEDDING_CONCURRENCY");

  const concDecision = new StoppingDecision();

  for (const conc of TEST_VALUES.EMBEDDING_CONCURRENCY) {
    process.stdout.write(`  Testing EMBEDDING_CONCURRENCY=${c.bold}${conc}${c.reset} `);

    const result = await benchmarkConcurrency(embeddings, texts, conc);
    const decision = concDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${bar(result.rate, concDecision.bestRate)} ${formatRate(result.rate, "emb/s")} ${c.dim}(${result.time}ms)${c.reset}`);
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestConc = concDecision.getBest();
  optimal.EMBEDDING_CONCURRENCY = bestConc?.concurrency || 1;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY}${c.reset}`);
  if (bestConc) console.log(`    ${c.dim}Speed: ${bestConc.rate} embeddings/sec${c.reset}`);

  // ============ PHASE 3: CODE_BATCH_SIZE ============

  printHeader("Phase 3: Qdrant Batch Size", "Finding optimal CODE_BATCH_SIZE");

  console.log(`  ${c.dim}Pre-generating embeddings for Qdrant tests...${c.reset}`);
  const embeddingResults = await embeddings.embedBatch(texts);
  const points = embeddingResults.map((r, i) => ({
    id: randomUUID(),
    vector: r.embedding,
    payload: { content: texts[i], index: i },
  }));
  console.log(`  ${c.dim}Done. Testing batch sizes...${c.reset}\n`);

  const codeDecision = new StoppingDecision();

  for (const size of TEST_VALUES.CODE_BATCH_SIZE) {
    process.stdout.write(`  Testing CODE_BATCH_SIZE=${c.bold}${size.toString().padStart(4)}${c.reset} `);

    const result = await benchmarkCodeBatchSize(qdrant, points, size);
    const decision = codeDecision.addResult(result);

    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(`${bar(result.rate, codeDecision.bestRate)} ${formatRate(result.rate, "chunks/s")} ${c.dim}(${result.time}ms)${c.reset}`);
    }

    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }

  const bestCode = codeDecision.getBest();
  optimal.CODE_BATCH_SIZE = bestCode?.batchSize || 100;
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: CODE_BATCH_SIZE=${optimal.CODE_BATCH_SIZE}${c.reset}`);
  if (bestCode) console.log(`    ${c.dim}Speed: ${bestCode.rate} chunks/sec${c.reset}`);

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

  // ============ SUMMARY ============

  const totalTime = Math.round((Date.now() - startTime) / 1000);

  console.log();
  console.log(`${c.cyan}${c.bold}╔══════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}${c.bold}║${c.reset}                  ${c.bold}TUNING COMPLETE${c.reset}                        ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`${c.cyan}${c.bold}╚══════════════════════════════════════════════════════════╝${c.reset}`);
  console.log();

  console.log(`${c.bold}Optimal configuration:${c.reset}`);
  console.log();
  console.log(`  EMBEDDING_BATCH_SIZE   = ${c.green}${c.bold}${optimal.EMBEDDING_BATCH_SIZE}${c.reset}`);
  console.log(`  EMBEDDING_CONCURRENCY  = ${c.green}${c.bold}${optimal.EMBEDDING_CONCURRENCY}${c.reset}`);
  console.log(`  CODE_BATCH_SIZE        = ${c.green}${c.bold}${optimal.CODE_BATCH_SIZE}${c.reset}`);
  console.log(`  QDRANT_BATCH_ORDERING  = ${c.green}${c.bold}${optimal.QDRANT_BATCH_ORDERING}${c.reset}`);
  console.log();

  // Write to env file
  const envContent = `# Tea Rags MCP - Tuned Environment Variables
# Generated: ${new Date().toISOString()}
# Hardware: ${config.EMBEDDING_BASE_URL} (${config.EMBEDDING_MODEL})
# Duration: ${totalTime}s

# Embedding configuration
EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE}
EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY}

# Qdrant batch configuration
CODE_BATCH_SIZE=${optimal.CODE_BATCH_SIZE}
QDRANT_BATCH_ORDERING=${optimal.QDRANT_BATCH_ORDERING}

# Performance metrics (for reference)
# Embedding rate: ${bestEmb?.rate || "N/A"} emb/s
# Storage rate: ${bestCode?.rate || "N/A"} chunks/s
`;

  const envPath = join(PROJECT_ROOT, "tuned_environment_variables.env");
  writeFileSync(envPath, envContent);

  console.log(`${c.bold}Output file:${c.reset}`);
  console.log(`  ${c.dim}${envPath}${c.reset}`);
  console.log();

  console.log(`${c.bold}Usage:${c.reset}`);
  console.log(`  ${c.dim}# Add to Claude Code MCP config:${c.reset}`);
  console.log(`  ${c.dim}claude mcp add tea-rags ... \\${c.reset}`);
  console.log(`    -e EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE} \\`);
  console.log(`    -e EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY} \\`);
  console.log(`    -e CODE_BATCH_SIZE=${optimal.CODE_BATCH_SIZE} \\`);
  console.log(`    -e QDRANT_BATCH_ORDERING=${optimal.QDRANT_BATCH_ORDERING}`);
  console.log();

  console.log(`${c.dim}Total tuning time: ${totalTime}s${c.reset}`);
  console.log();
}

main().catch((error) => {
  console.error(`${c.red}${c.bold}Fatal error:${c.reset}`, error.message);
  process.exit(1);
});
