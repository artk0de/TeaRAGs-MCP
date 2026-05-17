/**
 * Integration Test Helpers
 * Shared utilities for all test suites
 */

import { createHash, randomUUID as cryptoRandomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Facade composition for post-SOLID architecture.
// CodeIndexer was split into IngestFacade (write side) + ExploreFacade (read side).
import { createComposition } from "../../build/core/api/internal/composition.js";
import { ExploreFacade } from "../../build/core/api/internal/facades/explore-facade.js";
import { IngestFacade } from "../../build/core/api/internal/facades/ingest-facade.js";
import { CollectionRegistry } from "../../build/core/infra/registry/index.js";
import { StatsCache } from "../../build/core/infra/stats-cache.js";

// ANSI colors
export const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

// ═══════════════════════════════════════════════════════════════
// TIMING TRACKING
// ═══════════════════════════════════════════════════════════════

export const timing = {
  globalStart: null,
  sectionStart: null,

  // Start global timer
  start() {
    this.globalStart = Date.now();
    this.sectionStart = Date.now();
  },

  // Start new section
  startSection() {
    this.sectionStart = Date.now();
  },

  // Get elapsed time since global start
  getElapsed() {
    if (!this.globalStart) return "0.0s";
    const elapsed = (Date.now() - this.globalStart) / 1000;
    return `${elapsed.toFixed(1)}s`;
  },

  // Get section duration
  getSectionDuration() {
    if (!this.sectionStart) return "0.0s";
    const duration = (Date.now() - this.sectionStart) / 1000;
    return `${duration.toFixed(1)}s`;
  },

  // Get total duration
  getTotalDuration() {
    if (!this.globalStart) return "0.0s";
    const duration = (Date.now() - this.globalStart) / 1000;
    if (duration >= 60) {
      const mins = Math.floor(duration / 60);
      const secs = (duration % 60).toFixed(1);
      return `${mins}m ${secs}s`;
    }
    return `${duration.toFixed(1)}s`;
  },
};

// Test counters (shared state)
export const counters = {
  passed: 0,
  failed: 0,
  skipped: 0,
  reset() {
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
  },
  get total() {
    return this.passed + this.failed + this.skipped;
  },
};

// ═══════════════════════════════════════════════════════════════
// RESOURCE TRACKING FOR CLEANUP
// ═══════════════════════════════════════════════════════════════

/**
 * Tracks all resources created during tests for cleanup
 */
export const resources = {
  // Paths indexed in Qdrant (for clearIndex)
  indexedPaths: new Set(),

  // Qdrant collections created directly (for deleteCollection)
  collections: new Set(),

  // Temporary directories created (for rm -rf)
  tempDirs: new Set(),

  // Snapshot directories (for cleanup)
  snapshotDirs: new Set(),

  // Cache directories (for cleanup)
  cacheDirs: new Set(),

  // Track indexed path
  trackIndexedPath(path) {
    this.indexedPaths.add(path);
  },

  // Track collection
  trackCollection(name) {
    this.collections.add(name);
  },

  // Track temp directory
  trackTempDir(path) {
    this.tempDirs.add(path);
  },

  // Track snapshot directory
  trackSnapshotDir(path) {
    this.snapshotDirs.add(path);
  },

  // Track cache directory
  trackCacheDir(path) {
    this.cacheDirs.add(path);
  },

  // Get summary for logging
  getSummary() {
    return {
      indexedPaths: this.indexedPaths.size,
      collections: this.collections.size,
      tempDirs: this.tempDirs.size,
      snapshotDirs: this.snapshotDirs.size,
      cacheDirs: this.cacheDirs.size,
    };
  },

  // Clear all tracking (after cleanup)
  clear() {
    this.indexedPaths.clear();
    this.collections.clear();
    this.tempDirs.clear();
    this.snapshotDirs.clear();
    this.cacheDirs.clear();
  },
};

// ═══════════════════════════════════════════════════════════════
// TEST UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Log test result with elapsed time
 */
export function log(status, message) {
  const icons = { pass: "✓", fail: "✗", skip: "○", info: "→", warn: "⚠" };
  const colors = { pass: c.green, fail: c.red, skip: c.yellow, info: c.blue, warn: c.yellow };
  const elapsed = timing.globalStart ? `${c.dim}[${timing.getElapsed()}]${c.reset} ` : "";
  console.log(`${elapsed}${colors[status] || c.dim}  ${icons[status] || "→"}${c.reset} ${message}`);
}

/**
 * Assert condition and track result
 */
export function assert(condition, message) {
  if (condition) {
    log("pass", message);
    counters.passed++;
  } else {
    log("fail", message);
    counters.failed++;
  }
  return condition;
}

/**
 * Skip test
 */
export function skip(message) {
  log("skip", message);
  counters.skipped++;
}

/**
 * Print section header with timing
 */
export function section(title) {
  // Show previous section duration if not first section
  const sectionDuration =
    timing.sectionStart && timing.sectionStart !== timing.globalStart
      ? ` ${c.dim}(${timing.getSectionDuration()})${c.reset}`
      : "";

  // Start timing for new section
  timing.startSection();

  const elapsed = timing.globalStart ? `${c.dim}[${timing.getElapsed()}]${c.reset} ` : "";
  console.log(`\n${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${elapsed}${c.bold}${title}${c.reset}${sectionDuration}`);
  console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
}

/**
 * Create test file helper (auto-tracks parent dir)
 */
export async function createTestFile(dir, name, content) {
  const path = join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, content);
  return path;
}

/**
 * Sleep helper
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Hash content helper
 */
export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Create a random UUID
 */
export function randomUUID() {
  return cryptoRandomUUID();
}

// ═══════════════════════════════════════════════════════════════
// FACADE CONSTRUCTION FOR INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════

/**
 * Build minimal IngestCodeConfig for tests. Suites can pass overrides.
 */
export function buildTestIngestConfig(overrides = {}) {
  return {
    chunkSize: 500,
    chunkOverlap: 50,
    supportedExtensions: [".ts"],
    ignorePatterns: [],
    enableHybridSearch: false,
    quantizationScalar: false,
    enableGitMetadata: false,
    ...overrides,
  };
}

/**
 * Build minimal TrajectoryIngestConfig for tests.
 */
export function buildTestTrajectoryConfig(overrides = {}) {
  return {
    enableGitMetadata: false,
    ...overrides,
  };
}

/**
 * Construct IngestFacade + ExploreFacade sharing a single composition graph.
 *
 * Replaces `new CodeIndexer(qdrant, embeddings, config)` from the pre-SOLID era.
 *
 * @param qdrant       Already-constructed QdrantManager (from runner).
 * @param embeddings   Already-constructed EmbeddingProvider.
 * @param overrides    Optional: { config, trajectoryConfig, snapshotDir, pipelineTuning, syncTuning }.
 * @returns            { ingest, explore, statsCache, collectionRegistry, composition, snapshotDir }
 */
export function createTestFacades(qdrant, embeddings, overrides = {}) {
  const composition = createComposition();
  const dataDir = process.env.TEA_RAGS_DATA_DIR || join(homedir(), ".tea-rags");
  const snapshotDir = overrides.snapshotDir || join(dataDir, "snapshots");

  const statsCache = new StatsCache(snapshotDir);
  const collectionRegistry = new CollectionRegistry(dataDir);

  const ingest = new IngestFacade({
    qdrant,
    embeddings,
    config: buildTestIngestConfig(overrides.config),
    trajectoryConfig: buildTestTrajectoryConfig(overrides.trajectoryConfig),
    statsCache,
    allPayloadSignals: composition.allPayloadSignalDescriptors,
    statsAccumulators: composition.allStatsAccumulators,
    reranker: composition.reranker,
    snapshotDir,
    collectionRegistry,
    ...(overrides.pipelineTuning ? { pipelineTuning: overrides.pipelineTuning } : {}),
    ...(overrides.syncTuning ? { syncTuning: overrides.syncTuning } : {}),
  });

  const essentialKeys = composition.registry.getEssentialPayloadKeys();
  const explore = new ExploreFacade({
    qdrant,
    embeddings,
    reranker: composition.reranker,
    registry: composition.registry,
    collectionRegistry,
    statsCache,
    payloadSignals: composition.allPayloadSignalDescriptors,
    essentialKeys,
  });

  return { ingest, explore, statsCache, collectionRegistry, composition, snapshotDir };
}

/**
 * Pre-SOLID-compatible searchCode shim.
 *
 * Old CodeIndexer.searchCode(path, query, opts?) returned a flat array of
 * { content, filePath, score, ... }. New ExploreFacade.searchCode takes an
 * ExploreCodeRequest object and returns { results: SearchResult[], ... }
 * where content / relativePath live inside SearchResult.payload.
 *
 * This shim adapts new to old so suites keep their original assertions
 * (`r.content`, `r.filePath`, `r.score`) without rewriting every callsite.
 * It also restores `r.relativePath` and the rest of payload by spread.
 *
 * @param explore   ExploreFacade instance
 * @param path      Codebase path
 * @param query     Search query
 * @param opts      Optional ExploreCodeRequest extras (limit, rerank, pathPattern, ...)
 */
export async function searchCode(explore, path, query, opts = {}) {
  const response = await explore.searchCode({ path, query, ...opts });
  return response.results.map((r) => ({
    id: r.id,
    score: r.score,
    content: r.payload?.content,
    filePath: r.payload?.relativePath,
    ...r.payload,
  }));
}

/**
 * Same-shape wrapper over ExploreFacade.semanticSearch.
 *
 * Use this (not searchCode) when you need:
 *   - level: "file" — searchCode hardcodes level=undefined, so file-scope
 *     filters (author, taskId, maxAgeDays/minAgeDays, modifiedAfter/Before,
 *     minCommitCount) silently run at chunk-scope where git.chunk.* signals
 *     are unreliable. semanticSearch DOES expose `level`.
 *   - Explicit rerank preset — semanticSearch lets the caller override the
 *     default level/rerank resolution.
 *
 * Returns the same flattened { content, filePath, ...payload } shape as
 * searchCode so test assertions stay homogeneous.
 */
export async function semanticSearch(explore, path, query, opts = {}) {
  const response = await explore.semanticSearch({ path, query, ...opts });
  return response.results.map((r) => ({
    id: r.id,
    score: r.score,
    content: r.payload?.content,
    filePath: r.payload?.relativePath,
    ...r.payload,
  }));
}

/**
 * Print test summary with total duration
 */
export function printSummary() {
  const totalDuration = timing.getTotalDuration();

  console.log();
  console.log(`${c.bold}╔═══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}║                    TEST SUMMARY                       ║${c.reset}`);
  console.log(`${c.bold}╚═══════════════════════════════════════════════════════╝${c.reset}`);
  console.log();
  console.log(`  ${c.green}Passed:${c.reset}   ${counters.passed}`);
  console.log(`  ${c.red}Failed:${c.reset}   ${counters.failed}`);
  console.log(`  ${c.yellow}Skipped:${c.reset}  ${counters.skipped}`);
  console.log(`  ${c.dim}Total:${c.reset}    ${counters.total}`);
  console.log(`  ${c.cyan}Duration:${c.reset} ${totalDuration}`);
  console.log();

  if (counters.failed === 0) {
    console.log(`  ${c.green}${c.bold}✓ All tests passed!${c.reset}`);
  } else {
    console.log(`  ${c.red}${c.bold}✗ ${counters.failed} test(s) failed${c.reset}`);
  }
  console.log();

  return counters.failed === 0;
}
