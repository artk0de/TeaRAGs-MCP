#!/usr/bin/env node
/**
 * Integration Test Runner
 *
 * Runs all integration test suites against real external services.
 * Requires: Qdrant server, Ollama with embedding model
 *
 * Run: npm run test-integration
 * 
 * Environment variables:
 *   QDRANT_URL        - Qdrant server URL (default: http://192.168.1.71:6333)
 *   EMBEDDING_BASE_URL - Ollama URL (default: http://192.168.1.71:11434)
 *   EMBEDDING_MODEL   - Embedding model
 *   TEST_SUITE        - Run specific suite only (e.g., TEST_SUITE=embeddings)
 *   SKIP_CLEANUP      - Skip cleanup for debugging (SKIP_CLEANUP=1)
 */

import { promises as fs } from "node:fs";
import { c, counters, printSummary, section, log, resources, timing } from "./helpers.mjs";
import { config, TEST_DIR, getIndexerConfig } from "./config.mjs";

// Import from build
import { OllamaEmbeddings } from "../../build/embeddings/ollama.js";
import { QdrantManager } from "../../build/qdrant/client.js";
import { CodeIndexer } from "../../build/code/indexer.js";

// Import all test suites
import { testEmbeddings } from "./suites/01-embeddings.mjs";
import { testQdrantOperations } from "./suites/02-qdrant-operations.mjs";
import { testPointsAccumulator } from "./suites/03-points-accumulator.mjs";
import { testFileIndexing } from "./suites/04-file-indexing.mjs";
import { testHashConsistency } from "./suites/05-hash-consistency.mjs";
import { testIgnorePatterns } from "./suites/06-ignore-patterns.mjs";
import { testChunkBoundaries } from "./suites/07-chunk-boundaries.mjs";
import { testMultiLanguage } from "./suites/08-multi-language.mjs";
import { testRubyASTChunking } from "./suites/09-ruby-ast-chunking.mjs";
import { testSearchAccuracy } from "./suites/10-search-accuracy.mjs";
import { testEdgeCases } from "./suites/11-edge-cases.mjs";
import { testBatchPipeline } from "./suites/12-batch-pipeline.mjs";
import { testConcurrentSafety } from "./suites/13-concurrent-safety.mjs";
import { testParallelSync } from "./suites/14-parallel-sync.mjs";
import { testPipelineWorkerpool } from "./suites/15-pipeline-workerpool.mjs";
import { testSchemaAndDeleteOptimization } from "./suites/16-schema-delete-optimization.mjs";
import { testForceReindexBehavior } from "./suites/17-force-reindex.mjs";
import { testGitMetadata } from "./suites/18-git-metadata.mjs";

// Available test suites (ordered)
const suites = [
  { name: "embeddings", fn: testEmbeddings, args: ["embeddings"] },
  { name: "qdrant", fn: testQdrantOperations, args: ["qdrant"] },
  { name: "accumulator", fn: testPointsAccumulator, args: ["qdrant"] },
  { name: "indexing", fn: testFileIndexing, args: ["qdrant", "embeddings"] },
  { name: "hash", fn: testHashConsistency, args: ["qdrant", "embeddings"] },
  { name: "ignore", fn: testIgnorePatterns, args: ["qdrant", "embeddings"] },
  { name: "chunks", fn: testChunkBoundaries, args: ["qdrant", "embeddings"] },
  { name: "multilang", fn: testMultiLanguage, args: ["qdrant", "embeddings"] },
  { name: "ruby", fn: testRubyASTChunking, args: ["qdrant", "embeddings"] },
  { name: "search", fn: testSearchAccuracy, args: ["qdrant", "embeddings"] },
  { name: "edge", fn: testEdgeCases, args: ["qdrant", "embeddings"] },
  { name: "batch", fn: testBatchPipeline, args: ["qdrant", "embeddings"] },
  { name: "concurrent", fn: testConcurrentSafety, args: ["qdrant", "embeddings"] },
  { name: "parallel", fn: testParallelSync, args: [] },
  { name: "pipeline", fn: testPipelineWorkerpool, args: ["qdrant"] },
  { name: "schema", fn: testSchemaAndDeleteOptimization, args: ["qdrant"] },
  { name: "reindex", fn: testForceReindexBehavior, args: ["qdrant", "embeddings"] },
  { name: "git", fn: testGitMetadata, args: ["qdrant", "embeddings"] },
];

/**
 * Comprehensive cleanup of all resources
 */
async function cleanup(qdrant, embeddings) {
  section("Cleanup");
  
  const summary = resources.getSummary();
  log("info", `Resources to clean: ${JSON.stringify(summary)}`);

  let cleanedCount = 0;
  let errorCount = 0;

  // 1. Clear indexed paths (removes Qdrant collection + snapshots)
  if (resources.indexedPaths.size > 0) {
    log("info", `Clearing ${resources.indexedPaths.size} indexed codebases (Qdrant collections + snapshots)...`);
    const cleanupIndexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig());
    for (const indexPath of resources.indexedPaths) {
      try {
        await cleanupIndexer.clearIndex(indexPath);
        log("pass", `Cleared index + Qdrant collection: ${indexPath}`);
        cleanedCount++;
      } catch (e) {
        // Index might not exist, that's ok
      }
    }
  }

  // 2. Delete directly created collections
  for (const collection of resources.collections) {
    try {
      if (await qdrant.collectionExists(collection)) {
        await qdrant.deleteCollection(collection);
        log("pass", `Deleted collection: ${collection}`);
        cleanedCount++;
      }
    } catch (e) {
      log("warn", `Failed to delete collection ${collection}: ${e.message}`);
      errorCount++;
    }
  }

  // 3. Remove temporary directories
  for (const tempDir of resources.tempDirs) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("pass", `Removed temp dir: ${tempDir}`);
      cleanedCount++;
    } catch (e) {
      // Directory might not exist
    }
  }

  // 4. Remove snapshot directories
  for (const snapshotDir of resources.snapshotDirs) {
    try {
      await fs.rm(snapshotDir, { recursive: true, force: true });
      log("pass", `Removed snapshot dir: ${snapshotDir}`);
      cleanedCount++;
    } catch (e) {
      // Directory might not exist
    }
  }

  // 5. Remove cache directories
  for (const cacheDir of resources.cacheDirs) {
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
      log("pass", `Removed cache dir: ${cacheDir}`);
      cleanedCount++;
    } catch (e) {
      // Directory might not exist
    }
  }

  // 6. Remove main test directory
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    log("pass", `Removed TEST_DIR: ${TEST_DIR}`);
    cleanedCount++;
  } catch (e) {
    // Might not exist
  }

  // Clear tracking
  resources.clear();

  log("info", `Cleanup complete: ${cleanedCount} resources cleaned, ${errorCount} errors`);
}

async function main() {
  // Start global timer
  timing.start();

  console.log();
  console.log(c.bold + "╔═══════════════════════════════════════════════════════╗" + c.reset);
  console.log(c.bold + "║   QDRANT MCP SERVER - INTEGRATION TESTS               ║" + c.reset);
  console.log(c.bold + "╚═══════════════════════════════════════════════════════╝" + c.reset);
  console.log();

  console.log(c.dim + "Configuration:" + c.reset);
  console.log("  Qdrant:  " + config.QDRANT_URL);
  console.log("  Ollama:  " + config.EMBEDDING_BASE_URL);
  console.log("  Model:   " + config.EMBEDDING_MODEL);
  console.log("  TestDir: " + TEST_DIR);

  // Check for specific suite
  const targetSuite = process.env.TEST_SUITE;
  if (targetSuite) {
    console.log(c.cyan + "  Suite:   " + targetSuite + c.reset);
  }
  console.log();

  // Track TEST_DIR for cleanup
  resources.trackTempDir(TEST_DIR);

  // Initialize clients
  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL, 768, undefined, config.EMBEDDING_BASE_URL
  );
  const qdrant = new QdrantManager(config.QDRANT_URL);

  // Build args map
  const argsMap = { embeddings, qdrant };

  try {
    if (targetSuite) {
      // Run specific suite (by name or number 1-18)
      let suite;
      const suiteNum = parseInt(targetSuite, 10);
      if (!isNaN(suiteNum) && suiteNum >= 1 && suiteNum <= suites.length) {
        suite = suites[suiteNum - 1];
      } else {
        suite = suites.find(s => s.name === targetSuite);
      }
      if (!suite) {
        console.error(c.red + "Unknown test suite: " + targetSuite + c.reset);
        console.log("Available suites (by name or number 1-" + suites.length + "):");
        suites.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}`));
        process.exit(1);
      }
      const args = suite.args.map(a => argsMap[a]);
      await suite.fn(...args);
    } else {
      // Run all suites in order
      for (const suite of suites) {
        try {
          const args = suite.args.map(a => argsMap[a]);
          await suite.fn(...args);
        } catch (error) {
          console.error(c.red + "Suite " + suite.name + " failed:" + c.reset, error.message);
          console.error(error.stack);
          counters.failed++;
        }
      }
    }

    // Cleanup unless skipped
    if (process.env.SKIP_CLEANUP !== "1") {
      await cleanup(qdrant, embeddings);
    } else {
      log("warn", "Cleanup skipped (SKIP_CLEANUP=1)");
    }

  } catch (error) {
    console.error("\n" + c.red + "Fatal error:" + c.reset, error.message);
    console.error(error.stack);
    
    // Try to cleanup anyway
    try {
      await cleanup(qdrant, embeddings);
    } catch (cleanupError) {
      console.error("Cleanup also failed:", cleanupError.message);
    }
    
    process.exit(1);
  }

  // Print summary
  const success = printSummary();
  process.exit(success ? 0 : 1);
}

main();
