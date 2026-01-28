#!/usr/bin/env node
/**
 * Fast Diagnostic Benchmark
 *
 * Quickly finds optimal values for:
 * - EMBEDDING_BATCH_SIZE
 * - CODE_BATCH_SIZE
 * - EMBEDDING_CONCURRENCY
 *
 * Run: node benchmarks/diagnose.mjs
 */

import { OllamaEmbeddings } from "../build/embeddings/ollama.js";
import { QdrantManager } from "../build/qdrant/client.js";
import { randomUUID } from "crypto";

// Configuration - override with env vars
const config = {
  QDRANT_URL: process.env.QDRANT_URL || "http://localhost:6333",
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://localhost:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "nomic-embed-text",
};

// Benchmark parameters
const SAMPLE_SIZE = 512;
const DEGRADATION_THRESHOLD = 0.15;

// Test values
const EMBEDDING_BATCH_SIZES = [64, 256, 512, 1024, 2048];
const CODE_BATCH_SIZES = [128, 256, 384, 512, 768];
const CONCURRENCY_LEVELS = [1, 2, 4];

// Colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function bar(current, best, width = 20) {
  const ratio = Math.min(current / best, 1);
  const filled = Math.round(ratio * width);
  const clr = ratio >= 0.95 ? c.green : ratio >= 0.8 ? c.yellow : c.gray;
  return `${clr}${"█".repeat(filled)}${"░".repeat(width - filled)}${c.reset}`;
}

function rate(value, unit) {
  const clr = value >= 1000 ? c.green : c.yellow;
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

async function testEmbeddingBatch(embeddings, texts, batchSize) {
  process.env.EMBEDDING_BATCH_SIZE = String(batchSize);
  const start = Date.now();
  await embeddings.embedBatch(texts);
  const time = Date.now() - start;
  return { batchSize, time, rate: Math.round(texts.length * 1000 / time) };
}

async function testCodeBatch(qdrant, points, batchSize) {
  const collection = `bench_${Date.now()}`;
  try {
    await qdrant.createCollection(collection, 768, "Cosine");
    const start = Date.now();
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await qdrant.addPointsOptimized(collection, batch, {
        wait: i + batchSize >= points.length,
        ordering: "weak",
      });
    }
    const time = Date.now() - start;
    return { batchSize, time, rate: Math.round(points.length * 1000 / time) };
  } finally {
    try { await qdrant.deleteCollection(collection); } catch (e) {}
  }
}

async function testConcurrency(embeddings, texts, concurrency) {
  process.env.EMBEDDING_CONCURRENCY = String(concurrency);
  const start = Date.now();
  await embeddings.embedBatch(texts);
  const time = Date.now() - start;
  return { concurrency, time, rate: Math.round(texts.length * 1000 / time) };
}

function findBest(results, key) {
  return results.reduce((best, r) => r.rate > best.rate ? r : best, results[0]);
}

function shouldStop(results) {
  if (results.length < 2) return false;
  const best = Math.max(...results.map(r => r.rate));
  const last = results[results.length - 1].rate;
  return (best - last) / best >= DEGRADATION_THRESHOLD;
}

async function main() {
  console.log();
  console.log(`${c.cyan}${c.bold}┌─────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.cyan}${c.bold}│${c.reset}   ${c.bold}QDRANT MCP SERVER - PERFORMANCE DIAGNOSTIC${c.reset}   ${c.cyan}${c.bold}│${c.reset}`);
  console.log(`${c.cyan}${c.bold}│${c.reset}   ${c.dim}Automatic parameter optimization${c.reset}              ${c.cyan}${c.bold}│${c.reset}`);
  console.log(`${c.cyan}${c.bold}└─────────────────────────────────────────────────┘${c.reset}`);
  console.log();

  console.log(`${c.bold}Configuration:${c.reset}`);
  console.log(`  ${c.dim}Qdrant:${c.reset}  ${config.QDRANT_URL}`);
  console.log(`  ${c.dim}Ollama:${c.reset}  ${config.EMBEDDING_BASE_URL}`);
  console.log(`  ${c.dim}Model:${c.reset}   ${config.EMBEDDING_MODEL}`);
  console.log(`  ${c.dim}Samples:${c.reset} ${SAMPLE_SIZE} texts`);
  console.log();

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL, 768, undefined, config.EMBEDDING_BASE_URL
  );
  const qdrant = new QdrantManager(config.QDRANT_URL);

  console.log(`${c.dim}Generating test data...${c.reset}`);
  const texts = generateTexts(SAMPLE_SIZE);

  console.log(`${c.dim}Warming up...${c.reset}\n`);
  process.env.EMBEDDING_BATCH_SIZE = "64";
  process.env.EMBEDDING_CONCURRENCY = "1";
  await embeddings.embedBatch(texts.slice(0, 64));

  const optimal = {};

  // Phase 1: EMBEDDING_BATCH_SIZE
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}Phase 1: Embedding Batch Size${c.reset}`);
  console.log(`${c.dim}Finding optimal EMBEDDING_BATCH_SIZE${c.reset}`);
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  const embResults = [];
  let bestEmb = 0;

  for (const size of EMBEDDING_BATCH_SIZES) {
    process.stdout.write(`  ${c.dim}Testing${c.reset} EMBEDDING_BATCH_SIZE=${c.bold}${size}${c.reset} `);
    const r = await testEmbeddingBatch(embeddings, texts, size);
    embResults.push(r);
    if (r.rate > bestEmb) bestEmb = r.rate;
    console.log(`${bar(r.rate, bestEmb)} ${rate(r.rate, "emb/s")} ${c.dim}(${r.time}ms)${c.reset}`);
    if (shouldStop(embResults)) {
      console.log(`\n  ${c.yellow}↳ Stopping: performance degradation detected${c.reset}\n`);
      break;
    }
  }

  optimal.EMBEDDING_BATCH_SIZE = findBest(embResults, "batchSize");
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE.batchSize}${c.reset}`);
  console.log(`    ${c.dim}Speed: ${optimal.EMBEDDING_BATCH_SIZE.rate} embeddings/sec${c.reset}\n`);
  process.env.EMBEDDING_BATCH_SIZE = String(optimal.EMBEDDING_BATCH_SIZE.batchSize);

  // Phase 2: CODE_BATCH_SIZE
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}Phase 2: Qdrant Batch Size${c.reset}`);
  console.log(`${c.dim}Finding optimal CODE_BATCH_SIZE${c.reset}`);
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  console.log(`  ${c.dim}Pre-generating embeddings...${c.reset}`);
  const embeddingResults = await embeddings.embedBatch(texts);
  const points = embeddingResults.map((r, i) => ({
    id: randomUUID(),
    vector: r.embedding,
    payload: { content: texts[i], index: i },
  }));
  console.log(`  ${c.dim}Done.${c.reset}\n`);

  const codeResults = [];
  let bestCode = 0;

  for (const size of CODE_BATCH_SIZES) {
    process.stdout.write(`  ${c.dim}Testing${c.reset} CODE_BATCH_SIZE=${c.bold}${size}${c.reset} `);
    const r = await testCodeBatch(qdrant, points, size);
    codeResults.push(r);
    if (r.rate > bestCode) bestCode = r.rate;
    console.log(`${bar(r.rate, bestCode)} ${rate(r.rate, "chunks/s")} ${c.dim}(${r.time}ms)${c.reset}`);
    if (shouldStop(codeResults)) {
      console.log(`\n  ${c.yellow}↳ Stopping: performance degradation detected${c.reset}\n`);
      break;
    }
  }

  optimal.CODE_BATCH_SIZE = findBest(codeResults, "batchSize");
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: CODE_BATCH_SIZE=${optimal.CODE_BATCH_SIZE.batchSize}${c.reset}`);
  console.log(`    ${c.dim}Speed: ${optimal.CODE_BATCH_SIZE.rate} chunks/sec${c.reset}\n`);

  // Phase 3: EMBEDDING_CONCURRENCY
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}Phase 3: Embedding Concurrency${c.reset}`);
  console.log(`${c.dim}Finding optimal EMBEDDING_CONCURRENCY${c.reset}`);
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  const concResults = [];
  let bestConc = 0;

  for (const conc of CONCURRENCY_LEVELS) {
    process.stdout.write(`  ${c.dim}Testing${c.reset} EMBEDDING_CONCURRENCY=${c.bold}${conc}${c.reset} `);
    const r = await testConcurrency(embeddings, texts, conc);
    concResults.push(r);
    if (r.rate > bestConc) bestConc = r.rate;
    console.log(`${bar(r.rate, bestConc)} ${rate(r.rate, "emb/s")} ${c.dim}(${r.time}ms)${c.reset}`);

    if (concResults.length >= 2) {
      const prev = concResults[concResults.length - 2].rate;
      if (r.rate <= prev * 1.05) {
        console.log(`\n  ${c.yellow}↳ Stopping: concurrency provides no speedup${c.reset}\n`);
        break;
      }
    }
  }

  optimal.EMBEDDING_CONCURRENCY = findBest(concResults, "concurrency");
  console.log(`\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY.concurrency}${c.reset}`);
  console.log(`    ${c.dim}Speed: ${optimal.EMBEDDING_CONCURRENCY.rate} embeddings/sec${c.reset}\n`);

  // Summary
  console.log(`${c.cyan}${c.bold}┌─────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.cyan}${c.bold}│${c.reset}              ${c.bold}DIAGNOSTIC RESULTS${c.reset}                ${c.cyan}${c.bold}│${c.reset}`);
  console.log(`${c.cyan}${c.bold}└─────────────────────────────────────────────────┘${c.reset}`);
  console.log();

  console.log(`${c.bold}Recommended configuration:${c.reset}\n`);
  console.log(`${c.dim}Add to ~/.claude.json under "env":${c.reset}`);
  console.log();
  console.log(`  EMBEDDING_BATCH_SIZE   = ${c.green}${c.bold}${optimal.EMBEDDING_BATCH_SIZE.batchSize}${c.reset}`);
  console.log(`  EMBEDDING_CONCURRENCY  = ${c.green}${c.bold}${optimal.EMBEDDING_CONCURRENCY.concurrency}${c.reset}`);
  console.log(`  CODE_BATCH_SIZE        = ${c.green}${c.bold}${optimal.CODE_BATCH_SIZE.batchSize}${c.reset}`);
  console.log();

  console.log(`${c.bold}Performance summary:${c.reset}`);
  console.log(`  ${c.dim}Embedding:${c.reset} ${optimal.EMBEDDING_BATCH_SIZE.rate} emb/sec`);
  console.log(`  ${c.dim}Storage:${c.reset}   ${optimal.CODE_BATCH_SIZE.rate} chunks/sec`);

  const estTime = Math.round(2000 / optimal.EMBEDDING_BATCH_SIZE.rate);
  console.log(`  ${c.dim}Est. time for 2000 chunks:${c.reset} ~${estTime}s`);
  console.log();
}

main().catch(console.error);
