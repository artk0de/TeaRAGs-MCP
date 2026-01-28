/**
 * Test script for indexing functionality
 * Uses configuration from ~/.claude.json
 */

import { OllamaEmbeddings } from "./src/embeddings/ollama.js";
import { QdrantManager } from "./src/qdrant/client.js";
import { CodeIndexer } from "./src/code/indexer.js";

// Config from ~/.claude.json
const config = {
  QDRANT_URL: "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
  CODE_CHUNK_SIZE: 4500,
  CODE_CHUNK_OVERLAP: 450,
  CODE_BATCH_SIZE: 384,
};

async function testEmbeddings() {
  console.log("\n=== Test 1: Embeddings ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768, // jina dimensions
    undefined,
    config.EMBEDDING_BASE_URL
  );

  // Test single
  console.log("Testing single embedding...");
  const start1 = Date.now();
  const result1 = await embeddings.embed("function hello() { return 42; }");
  console.log(`  Single: ${Date.now() - start1}ms, dims: ${result1.dimensions}`);

  // Test batch
  console.log("Testing batch embedding (50 texts)...");
  const texts = Array.from({ length: 50 }, (_, i) =>
    `function test_${i}() { return ${i} * 2; } // padding text here`
  );
  const start2 = Date.now();
  const result2 = await embeddings.embedBatch(texts);
  const time2 = Date.now() - start2;
  console.log(`  Batch 50: ${time2}ms, rate: ${Math.round(50000 / time2)} emb/sec`);

  return true;
}

async function testQdrant() {
  console.log("\n=== Test 2: Qdrant Connection ===");

  const qdrant = new QdrantManager({
    url: config.QDRANT_URL,
  });

  const collections = await qdrant.listCollections();
  console.log(`  Collections: ${collections.length}`);
  collections.slice(0, 5).forEach(c => console.log(`    - ${c}`));

  return true;
}

async function testPartialIndexing() {
  console.log("\n=== Test 3: Partial Indexing (qdrant-mcp-server itself) ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  const qdrant = new QdrantManager({
    url: config.QDRANT_URL,
  });

  const indexer = new CodeIndexer(qdrant, embeddings, {
    chunkSize: config.CODE_CHUNK_SIZE,
    chunkOverlap: config.CODE_CHUNK_OVERLAP,
    supportedExtensions: [".ts", ".js"],
    ignorePatterns: ["node_modules", "build", "dist", ".git"],
  });

  // Test on small codebase (just src/tools)
  const testPath = "/Users/artk0re/Dev/Tools/qdrant-mcp-server/src/tools";

  console.log(`  Path: ${testPath}`);
  console.log("  Starting indexing...");

  const start = Date.now();
  const stats = await indexer.indexCodebase(testPath, {
    force: true,
    progressCallback: (progress) => {
      if (progress.current % 5 === 0 || progress.current === progress.total) {
        console.log(`    ${progress.phase}: ${progress.current}/${progress.total} (${progress.percentage}%)`);
      }
    },
  });

  console.log(`  Done in ${Date.now() - start}ms`);
  console.log(`  Files: ${stats.filesScanned}, Chunks: ${stats.chunksCreated}`);

  return stats;
}

async function testReindexChanges() {
  console.log("\n=== Test 4: Reindex Changes ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  const qdrant = new QdrantManager({
    url: config.QDRANT_URL,
  });

  const indexer = new CodeIndexer(qdrant, embeddings, {
    chunkSize: config.CODE_CHUNK_SIZE,
    chunkOverlap: config.CODE_CHUNK_OVERLAP,
    supportedExtensions: [".ts", ".js"],
    ignorePatterns: ["node_modules", "build", "dist", ".git"],
  });

  const testPath = "/Users/artk0re/Dev/Tools/qdrant-mcp-server/src/tools";

  console.log(`  Path: ${testPath}`);
  console.log("  Checking for changes...");

  const start = Date.now();
  const stats = await indexer.reindexChanges(testPath);

  console.log(`  Done in ${Date.now() - start}ms`);
  console.log(`  Added: ${stats.filesAdded}, Modified: ${stats.filesModified}, Deleted: ${stats.filesDeleted}`);

  return stats;
}

async function testRebuildCache() {
  console.log("\n=== Test 5: Rebuild Cache ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  const qdrant = new QdrantManager({
    url: config.QDRANT_URL,
  });

  const indexer = new CodeIndexer(qdrant, embeddings, {
    chunkSize: config.CODE_CHUNK_SIZE,
    chunkOverlap: config.CODE_CHUNK_OVERLAP,
    supportedExtensions: [".ts", ".js"],
    ignorePatterns: ["node_modules", "build", "dist", ".git"],
  });

  const testPath = "/Users/artk0re/Dev/Tools/qdrant-mcp-server/src/tools";

  console.log(`  Path: ${testPath}`);
  console.log("  Rebuilding cache...");

  const start = Date.now();
  const result = await indexer.rebuildCache(testPath);

  console.log(`  Done in ${Date.now() - start}ms`);
  console.log(`  Indexed: ${result.indexed}, Pending: ${result.pending}, Orphaned: ${result.orphaned}`);

  return result;
}

async function main() {
  console.log("========================================");
  console.log("Qdrant MCP Server - Indexing Test Suite");
  console.log("========================================");
  console.log("\nConfig:");
  console.log(`  Qdrant: ${config.QDRANT_URL}`);
  console.log(`  Ollama: ${config.EMBEDDING_BASE_URL}`);
  console.log(`  Model: ${config.EMBEDDING_MODEL}`);
  console.log(`  Batch size: ${config.CODE_BATCH_SIZE}`);

  try {
    await testEmbeddings();
    await testQdrant();
    await testPartialIndexing();
    await testReindexChanges();
    await testRebuildCache();

    console.log("\n========================================");
    console.log("All tests passed!");
    console.log("========================================");
  } catch (error) {
    console.error("\nTest failed:", error);
    process.exit(1);
  }
}

main();
