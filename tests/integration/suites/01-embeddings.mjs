/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";

export async function testEmbeddings(embeddings) {
  section("1. Embeddings");

  // Basic functionality
  const single = await embeddings.embed("function hello() { return 42; }");
  assert(single.embedding?.length === 768, `Single embedding dimensions: ${single.dimensions}`);

  const batch = await embeddings.embedBatch(["fn foo() {}", "fn bar() {}", "fn baz() {}"]);
  assert(batch.length === 3, `Batch returns correct count: ${batch.length}`);
  assert(batch.every(b => b.embedding.length === 768), "All embeddings have correct dimensions");

  const empty = await embeddings.embedBatch([]);
  assert(empty.length === 0, "Empty batch returns empty array");

  // Semantic similarity
  const cosineSim = (a, b) => {
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    return dot / (magA * magB);
  };

  const jsCode = await embeddings.embed("function calculateSum(a, b) { return a + b; }");
  const pyCode = await embeddings.embed("def calculate_sum(a, b): return a + b");
  const recipe = await embeddings.embed("Mix flour with eggs and bake for 30 minutes");

  const simCode = cosineSim(jsCode.embedding, pyCode.embedding);
  const simUnrelated = cosineSim(jsCode.embedding, recipe.embedding);
  assert(simCode > simUnrelated, `Similar code more similar than unrelated (${simCode.toFixed(3)} > ${simUnrelated.toFixed(3)})`);

  // Edge cases
  const longText = "x".repeat(10000);
  const longResult = await embeddings.embed(longText);
  assert(longResult.embedding.length === 768, "Long text (10k chars) handled");

  const unicode = "функция привет() { return '世界'; } // コメント";
  const unicodeResult = await embeddings.embed(unicode);
  assert(unicodeResult.embedding.length === 768, "Unicode/multilingual text handled");

  const special = 'fn() { "test": true, \'escape\': `backtick`, <tag/>, &amp; }';
  const specialResult = await embeddings.embed(special);
  assert(specialResult.embedding.length === 768, "Special characters handled");

  // Determinism
  const text = "consistent embedding test";
  const emb1 = await embeddings.embed(text);
  const emb2 = await embeddings.embed(text);
  const similarity = cosineSim(emb1.embedding, emb2.embedding);
  assert(similarity > 0.99, `Same text produces consistent embeddings (sim=${similarity.toFixed(4)})`);

  // Large batch (tests internal batching)
  log("info", "Testing large batch (50 texts)...");
  const largeBatch = Array.from({ length: 50 }, (_, i) =>
    `function test_${i}() { const value = ${i} * 2; return value + ${i % 10}; }`
  );
  const largeBatchStart = Date.now();
  const largeBatchResult = await embeddings.embedBatch(largeBatch);
  const largeBatchTime = Date.now() - largeBatchStart;
  assert(largeBatchResult.length === 50, `Large batch returns all embeddings: ${largeBatchResult.length}`);
  log("info", `Large batch completed in ${largeBatchTime}ms (${Math.round(50000 / largeBatchTime)} emb/sec)`);

  // Parallel embedding requests
  log("info", "Testing parallel embedding requests (3 x 20 texts)...");
  const createBatch = (id) => Array.from({ length: 20 }, (_, i) =>
    `function batch${id}_${i}() { return ${i} * ${id}; }`
  );
  const parallelStart = Date.now();
  const parallelResults = await Promise.all([
    embeddings.embedBatch(createBatch(1)),
    embeddings.embedBatch(createBatch(2)),
    embeddings.embedBatch(createBatch(3)),
  ]);
  const parallelTime = Date.now() - parallelStart;
  assert(parallelResults.every(r => r.length === 20), `Parallel batches all complete: ${parallelResults.map(r => r.length).join(", ")}`);
  log("info", `Parallel requests completed in ${parallelTime}ms`);
}
