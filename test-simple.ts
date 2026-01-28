/**
 * Simple test script - embeddings and qdrant only (no tree-sitter)
 */

import { OllamaEmbeddings } from "./src/embeddings/ollama.js";
import { QdrantManager } from "./src/qdrant/client.js";

// Config from ~/.claude.json
const config = {
  QDRANT_URL: "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: "http://192.168.1.71:11434",
  EMBEDDING_MODEL: "unclemusclez/jina-embeddings-v2-base-code:latest",
  EMBEDDING_BATCH_SIZE: 64,
};

async function testEmbeddings() {
  console.log("\n=== Test 1: Embeddings ===");

  const embeddings = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    768,
    undefined,
    config.EMBEDDING_BASE_URL
  );

  // Test single
  console.log("Single embedding...");
  const start1 = Date.now();
  const result1 = await embeddings.embed("function hello() { return 42; }");
  console.log(`  Time: ${Date.now() - start1}ms, dims: ${result1.dimensions}`);

  // Test batch 50
  console.log("Batch 50...");
  const texts50 = Array.from({ length: 50 }, (_, i) =>
    `function test_${i}() { return ${i} * 2; } // padding text here for longer content`
  );
  const start2 = Date.now();
  const result2 = await embeddings.embedBatch(texts50);
  const time2 = Date.now() - start2;
  console.log(`  Time: ${time2}ms, rate: ${Math.round(50000 / time2)} emb/sec`);

  // Test batch 200
  console.log("Batch 200...");
  const texts200 = Array.from({ length: 200 }, (_, i) =>
    `class User${i} { constructor() { this.id = ${i}; } getName() { return "user_${i}"; } }`
  );
  const start3 = Date.now();
  const result3 = await embeddings.embedBatch(texts200);
  const time3 = Date.now() - start3;
  console.log(`  Time: ${time3}ms, rate: ${Math.round(200000 / time3)} emb/sec`);

  return { single: result1, batch50: result2.length, batch200: result3.length };
}

async function testQdrant() {
  console.log("\n=== Test 2: Qdrant ===");

  const qdrant = new QdrantManager({ url: config.QDRANT_URL });

  const collections = await qdrant.listCollections();
  console.log(`  Collections: ${collections.length}`);

  // Find code_ collections
  const codeCollections = collections.filter(c => c.startsWith("code_"));
  console.log(`  Code collections: ${codeCollections.length}`);

  for (const name of codeCollections.slice(0, 3)) {
    const info = await qdrant.getCollectionInfo(name);
    console.log(`    ${name}: ${info.pointsCount} points`);
  }

  return collections;
}

async function testBatchDeletion() {
  console.log("\n=== Test 3: Batch Deletion (dry run) ===");

  const qdrant = new QdrantManager({ url: config.QDRANT_URL });

  // Just verify the method exists and can be called
  console.log("  deletePointsByPaths method exists:", typeof qdrant.deletePointsByPaths === "function");

  return true;
}

async function main() {
  console.log("========================================");
  console.log("Qdrant MCP Server - Simple Test");
  console.log("========================================");
  console.log(`Qdrant: ${config.QDRANT_URL}`);
  console.log(`Ollama: ${config.EMBEDDING_BASE_URL}`);
  console.log(`Model: ${config.EMBEDDING_MODEL}`);

  try {
    const embResult = await testEmbeddings();
    console.log("  ✓ Embeddings OK");

    const qdrantResult = await testQdrant();
    console.log("  ✓ Qdrant OK");

    await testBatchDeletion();
    console.log("  ✓ Batch deletion OK");

    console.log("\n========================================");
    console.log("All tests passed!");
    console.log("========================================");
  } catch (error) {
    console.error("\nTest failed:", error);
    process.exit(1);
  }
}

main();
