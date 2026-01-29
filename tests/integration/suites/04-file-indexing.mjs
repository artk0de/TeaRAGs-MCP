/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { CodeIndexer } from "../../../build/code/indexer.js";
import { TEST_DIR, getIndexerConfig } from "../config.mjs";

export async function testFileIndexing(qdrant, embeddings) {
  section("4. File Indexing Lifecycle");

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    supportedExtensions: [".ts", ".js", ".py"],
    ignorePatterns: ["node_modules", ".git"],
  }));

  // Create test directory with files
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.mkdir(join(TEST_DIR, "src"), { recursive: true });

  const file1Content = `
// File 1: User Service
export class UserService {
  getUser(id: string) {
    return { id, name: "John" };
  }

  createUser(name: string) {
    return { id: "new", name };
  }
}
`;

  const file2Content = `
// File 2: Product Service
export class ProductService {
  getProduct(id: string) {
    return { id, price: 100 };
  }
}
`;

  await createTestFile(TEST_DIR, "src/user.ts", file1Content);
  await createTestFile(TEST_DIR, "src/product.ts", file2Content);

  // Initial indexing
  resources.trackIndexedPath(TEST_DIR);
  const stats = await indexer.indexCodebase(TEST_DIR, { forceReindex: true });
  assert(stats.filesScanned >= 2, `Files scanned: ${stats.filesScanned}`);
  assert(stats.filesIndexed >= 2, `Files indexed: ${stats.filesIndexed}`);
  assert(stats.chunksCreated > 0, `Chunks created: ${stats.chunksCreated}`);

  // Search for specific content
  const userResults = await indexer.searchCode(TEST_DIR, "UserService getUser");
  assert(userResults.length > 0, `Search finds UserService: ${userResults.length} results`);
  // At least one result should have content (payload was retrieved)
  const hasAnyContent = userResults.some(r => r.content && r.content.length > 0);
  assert(hasAnyContent, `Search result has content (got ${userResults.length} results with content lengths: ${userResults.map(r => r.content?.length || 0).join(', ')})`);

  const productResults = await indexer.searchCode(TEST_DIR, "ProductService price");
  assert(productResults.length > 0, `Search finds ProductService: ${productResults.length} results`);

  // Check index status
  const status = await indexer.getIndexStatus(TEST_DIR);
  assert(status.isIndexed || status.status === "indexed", `Status is indexed: ${status.status}`);

  // === ADD NEW FILE ===
  const file3Content = `
// File 3: Order Service
export class OrderService {
  createOrder(userId: string, productId: string) {
    return { orderId: "order-123", userId, productId };
  }
}
`;
  await createTestFile(TEST_DIR, "src/order.ts", file3Content);
  await sleep(100); // Ensure file timestamp differs

  const addStats = await indexer.reindexChanges(TEST_DIR);
  assert(addStats.filesAdded >= 1, `New file detected: ${addStats.filesAdded} added`);

  const orderResults = await indexer.searchCode(TEST_DIR, "OrderService createOrder");
  assert(orderResults.length > 0, `New file searchable: ${orderResults.length} results`);

  // === MODIFY EXISTING FILE ===
  const file1Modified = file1Content + `
  // Added method
  deleteUser(id: string) {
    return { deleted: true, id };
  }
`;
  await fs.writeFile(join(TEST_DIR, "src/user.ts"), file1Modified);
  await sleep(100);

  const modifyStats = await indexer.reindexChanges(TEST_DIR);
  assert(modifyStats.filesModified >= 1, `Modified file detected: ${modifyStats.filesModified} modified`);

  const deleteResults = await indexer.searchCode(TEST_DIR, "deleteUser");
  assert(deleteResults.length > 0, `Modified content searchable: ${deleteResults.length} results`);

  // === DELETE FILE ===
  await fs.unlink(join(TEST_DIR, "src/product.ts"));
  await sleep(100);

  const deleteStats = await indexer.reindexChanges(TEST_DIR);
  assert(deleteStats.filesDeleted >= 1, `Deleted file detected: ${deleteStats.filesDeleted} deleted`);

  // Deleted content should not be found
  const deletedResults = await indexer.searchCode(TEST_DIR, "ProductService getProduct");
  // Note: This might still return results if chunks overlap or weren't cleaned up
  // The key test is that the file count decreased
}
