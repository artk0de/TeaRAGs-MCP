#!/usr/bin/env node
/**
 * Embedding Diagnostic Benchmark
 *
 * Automatically calibrates EMBEDDING_BATCH_SIZE and EMBEDDING_CONCURRENCY
 * using a three-phase plateau-detection algorithm.
 *
 * Phase 1: Find batch size plateau (CONCURRENCY=1)
 * Phase 2: Test concurrency on plateau batches
 * Phase 3: Select robust configuration (within 2% of max, prefer lower concurrency/batch)
 *
 * Run: npm run benchmark-embeddings
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { config, MEDIAN_CODE_CHUNK_SIZE, AVG_LOC_PER_CHUNK } from "./lib/config.mjs";
import { c, printBox } from "./lib/colors.mjs";
import { calibrateEmbeddings } from "./lib/embedding-calibration.mjs";

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
 * Check Ollama connectivity and model availability
 */
async function checkOllama() {
  try {
    const response = await fetch(`${config.EMBEDDING_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

    const { models } = await response.json();
    const modelNames = (models || []).map(m => m.name.replace(/:latest$/, ""));
    const target = config.EMBEDDING_MODEL.replace(/:latest$/, "");

    if (!modelNames.some(n => n === target || n === config.EMBEDDING_MODEL)) {
      return { ok: false, error: `Model "${config.EMBEDDING_MODEL}" not found` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  console.clear();
  printBox("EMBEDDING CALIBRATION BENCHMARK", "Three-phase plateau detection");

  // Show configuration
  console.log(`${c.bold}Configuration:${c.reset}`);
  console.log(`  ${c.dim}Ollama:${c.reset}        ${config.EMBEDDING_BASE_URL}`);
  console.log(`  ${c.dim}Model:${c.reset}         ${config.EMBEDDING_MODEL}`);
  console.log(`  ${c.dim}Chunk size:${c.reset}    ${MEDIAN_CODE_CHUNK_SIZE} chars (median from production)`);
  console.log();

  // Check Ollama
  process.stdout.write(`${c.dim}Checking Ollama...${c.reset} `);
  const ollamaCheck = await checkOllama();
  if (!ollamaCheck.ok) {
    console.log(`${c.red}FAILED${c.reset}`);
    console.log(`\n${c.red}Error:${c.reset} ${ollamaCheck.error}`);
    process.exit(1);
  }
  console.log(`${c.green}OK${c.reset}`);

  // Initialize embeddings
  const embeddings = new OllamaEmbeddings(config.EMBEDDING_MODEL, undefined, undefined, config.EMBEDDING_BASE_URL);
  console.log(`  ${c.green}✓${c.reset} Vector dimension: ${embeddings.getDimensions()}`);
  console.log();

  // Run calibration
  const result = await calibrateEmbeddings(embeddings, { verbose: true });

  // ========== OUTPUT ==========
  console.log();

  // Detect setup type
  const isRemote = !config.EMBEDDING_BASE_URL.includes("localhost") &&
                   !config.EMBEDDING_BASE_URL.includes("127.0.0.1");
  const setupIcon = isRemote ? "🌐" : "🏠";
  const setupName = isRemote ? "Remote GPU" : "Local GPU";

  printBox(`${setupIcon} ${setupName.toUpperCase()} - OPTIMAL CONFIGURATION`, "");

  // Main result
  console.log(`  ${c.bold}EMBEDDING_BATCH_SIZE${c.reset}   = ${c.green}${c.bold}${result.EMBEDDING_BATCH_SIZE}${c.reset}`);
  console.log(`  ${c.bold}EMBEDDING_CONCURRENCY${c.reset}  = ${c.green}${c.bold}${result.EMBEDDING_CONCURRENCY}${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Throughput:${c.reset} ${c.cyan}${result.throughput_chunks_per_sec} chunks/s${c.reset}`);
  console.log();

  // Explain the choice
  console.log(`${c.bold}Why this configuration?${c.reset}`);
  if (isRemote) {
    console.log(`  ${c.dim}•${c.reset} Remote GPU detected (${config.EMBEDDING_BASE_URL})`);
    console.log(`  ${c.dim}•${c.reset} Lower batch + higher concurrency hides network latency`);
    console.log(`  ${c.dim}•${c.reset} While one batch transfers, GPU processes another`);
    if (result.EMBEDDING_CONCURRENCY > 1) {
      console.log(`  ${c.dim}•${c.reset} CONCURRENCY=${result.EMBEDDING_CONCURRENCY} overlaps network I/O with GPU compute`);
    }
  } else {
    console.log(`  ${c.dim}•${c.reset} Local GPU detected (minimal network latency)`);
    console.log(`  ${c.dim}•${c.reset} Higher batch + lower concurrency minimizes overhead`);
    if (result.EMBEDDING_CONCURRENCY === 1) {
      console.log(`  ${c.dim}•${c.reset} CONCURRENCY=1 indicates GPU-bound workload`);
    }
  }
  console.log();

  // Environment export
  console.log(`${c.bold}Add to your environment:${c.reset}`);
  console.log();
  console.log(`  ${c.cyan}export EMBEDDING_BATCH_SIZE=${result.EMBEDDING_BATCH_SIZE}${c.reset}`);
  console.log(`  ${c.cyan}export EMBEDDING_CONCURRENCY=${result.EMBEDDING_CONCURRENCY}${c.reset}`);
  console.log();

  // Time estimates
  console.log(`${c.bold}Estimated indexing times:${c.reset}`);
  const projects = [
    { name: "10K LoC", loc: 10_000 },
    { name: "100K LoC", loc: 100_000 },
    { name: "1M LoC", loc: 1_000_000 },
    { name: "VS Code (3.5M)", loc: 3_500_000 },
  ];
  for (const p of projects) {
    const chunks = Math.ceil(p.loc / AVG_LOC_PER_CHUNK);
    const seconds = Math.ceil(chunks / result.throughput_chunks_per_sec);
    console.log(`  ${c.dim}${p.name.padEnd(20)}${c.reset} ${c.bold}${formatTime(seconds * 1000)}${c.reset}`);
  }
  console.log();

  // Stats
  console.log(`${c.dim}────────────────────────────────────────${c.reset}`);
  console.log(`${c.dim}Configs tested: ${result.stable_configs_count} stable, ${result.discarded_configs_count} discarded${c.reset}`);
  console.log(`${c.bold}Total benchmark time: ${formatTime(result.calibration_time_ms)}${c.reset}`);
}

main().catch(err => {
  console.error(`${c.red}Fatal error:${c.reset}`, err.message);
  console.error(err.stack);
  process.exit(1);
});
