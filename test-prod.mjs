/**
 * Production test script - uses compiled build
 */

import { OllamaEmbeddings } from "./build/embeddings/ollama.js";
import { QdrantManager } from "./build/qdrant/client.js";
import { CodeIndexer } from "./build/code/indexer.js";

// Config from ~/.claude.json
const config = {
  QDRANT_URL: "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
  CODE_CHUNK_SIZE: 4500,
  CODE_CHUNK_OVERLAP: 450,
  EMBEDDING_BATCH_SIZE: 64, // Optimal for AMD GPU (from benchmark)
  CODE_BATCH_SIZE: 384, // Chunks per Qdrant upsert
};

async function testEmbeddings() {
  console.log("\n=== Test 1: Embeddings ===");
  console.log(`  Batch size: ${config.EMBEDDING_BATCH_SIZE}`);

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    config.EMBEDDING_BATCH_SIZE,
    config.EMBEDDING_BASE_URL
  );

  // Test single
  console.log("Single embedding...");
  const start1 = Date.now();
  const result1 = await embeddings.embed("function hello() { return 42; }");
  console.log(`  Time: ${Date.now() - start1}ms, dims: ${result1.dimensions}`);

  // Test batch 500 (to trigger multiple EMBEDDING_BATCH_SIZE batches)
  // With EMBEDDING_BATCH_SIZE=64, this will be ~8 batches
  console.log("Batch 500 (tests multiple internal batches)...");
  const texts = Array.from({ length: 500 }, (_, i) =>
    `function test_${i}() {
      const value = ${i} * 2;
      console.log("Processing item", ${i});
      return value + ${i % 10};
    } // This is a longer code sample to simulate real code chunks`
  );
  const start2 = Date.now();
  const result2 = await embeddings.embedBatch(texts);
  const time2 = Date.now() - start2;
  console.log(`  Time: ${time2}ms, rate: ${Math.round(500000 / time2)} emb/sec, count: ${result2.length}`);

  return true;
}

async function testQdrant() {
  console.log("\n=== Test 2: Qdrant ===");

  // QdrantManager takes URL string directly, not object
  const qdrant = new QdrantManager(config.QDRANT_URL);

  const collections = await qdrant.listCollections();
  console.log(`  Total collections: ${collections.length}`);

  const codeCollections = collections.filter(c => c.startsWith("code_"));
  console.log(`  Code collections: ${codeCollections.length}`);

  return true;
}

async function testParallelEmbeddings() {
  console.log("\n=== Test 2.5: Parallel Large Requests (5 x 500 texts) ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    config.EMBEDDING_BATCH_SIZE,
    config.EMBEDDING_BASE_URL
  );

  // Create 5 batches of 500 texts each
  const createBatch = (batchId) =>
    Array.from({ length: 500 }, (_, i) =>
      `function batch${batchId}_test_${i}() {
        const value = ${i} * ${batchId};
        console.log("Processing batch ${batchId} item", ${i});
        return value + ${i % 10} + Math.random();
      } // Longer code sample for realistic chunk size`
    );

  console.log("  Starting 5 parallel large batch requests...");
  const start = Date.now();

  // Run 5 large batches in parallel
  const results = await Promise.all([
    embeddings.embedBatch(createBatch(1)),
    embeddings.embedBatch(createBatch(2)),
    embeddings.embedBatch(createBatch(3)),
    embeddings.embedBatch(createBatch(4)),
    embeddings.embedBatch(createBatch(5)),
  ]);

  const time = Date.now() - start;
  const totalTexts = 5 * 500;
  console.log(`  Time: ${time}ms for ${totalTexts} texts`);
  console.log(`  Rate: ${Math.round(totalTexts * 1000 / time)} emb/sec`);
  console.log(`  Results: ${results.map(r => r.length).join(", ")} embeddings`);

  return true;
}

async function testPartialIndexing() {
  console.log("\n=== Test 3: Partial Indexing ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    config.EMBEDDING_BATCH_SIZE,
    config.EMBEDDING_BASE_URL
  );

  const qdrant = new QdrantManager(config.QDRANT_URL);

  const indexer = new CodeIndexer(qdrant, embeddings, {
    chunkSize: config.CODE_CHUNK_SIZE,
    chunkOverlap: config.CODE_CHUNK_OVERLAP,
    supportedExtensions: [".ts", ".js"],
    ignorePatterns: ["node_modules", "build", "dist", ".git", "test-*.ts", "test-*.mjs"],
  });

  // Test on small folder
  const testPath = "/Users/artk0re/Dev/Tools/qdrant-mcp-server/src/embeddings";

  console.log(`  Path: ${testPath}`);
  console.log("  Starting indexing...");

  const start = Date.now();
  const stats = await indexer.indexCodebase(testPath, {
    force: true,
    progressCallback: (progress) => {
      console.log(`    ${progress.phase}: ${progress.current}/${progress.total} (${progress.percentage}%)`);
    },
  });

  console.log(`  Done in ${(Date.now() - start) / 1000}s`);
  console.log(`  Files scanned: ${stats.filesScanned}`);
  console.log(`  Files indexed: ${stats.filesIndexed}`);
  console.log(`  Chunks created: ${stats.chunksCreated}`);

  return stats;
}

async function testReindexChanges() {
  console.log("\n=== Test 4: Reindex Changes ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    config.EMBEDDING_BATCH_SIZE,
    config.EMBEDDING_BASE_URL
  );

  const qdrant = new QdrantManager(config.QDRANT_URL);

  const indexer = new CodeIndexer(qdrant, embeddings, {
    chunkSize: config.CODE_CHUNK_SIZE,
    chunkOverlap: config.CODE_CHUNK_OVERLAP,
    supportedExtensions: [".ts", ".js"],
    ignorePatterns: ["node_modules", "build", "dist", ".git"],
  });

  const testPath = "/Users/artk0re/Dev/Tools/qdrant-mcp-server/src/embeddings";

  console.log(`  Path: ${testPath}`);
  const start = Date.now();
  const stats = await indexer.reindexChanges(testPath);

  console.log(`  Done in ${(Date.now() - start) / 1000}s`);
  console.log(`  Added: ${stats.filesAdded}, Modified: ${stats.filesModified}, Deleted: ${stats.filesDeleted}`);

  return stats;
}

async function main() {
  console.log("========================================");
  console.log("Qdrant MCP Server - Production Test");
  console.log("========================================");
  console.log(`Qdrant: ${config.QDRANT_URL}`);
  console.log(`Ollama: ${config.EMBEDDING_BASE_URL}`);
  console.log(`Model: ${config.EMBEDDING_MODEL}`);

  try {
    await testEmbeddings();
    await testParallelEmbeddings();
    await testQdrant();
    await testPartialIndexing();
    await testReindexChanges();

    console.log("\n========================================");
    console.log("All tests passed!");
    console.log("========================================");
  } catch (error) {
    console.error("\nTest failed:", error);
    process.exit(1);
  }
}

main();
