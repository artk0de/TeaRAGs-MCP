/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { CodeIndexer } from "../../../build/code/indexer.js";
import { getIndexerConfig, TEST_DIR } from "../config.mjs";
import { assert, createTestFile, hashContent, log, randomUUID, resources, section, skip, sleep } from "../helpers.mjs";

export async function testSearchAccuracy(qdrant, embeddings) {
  section("9. Search Accuracy");

  const searchTestDir = join(TEST_DIR, "search_test");
  await fs.mkdir(searchTestDir, { recursive: true });

  // Create distinct files with specific purposes
  await createTestFile(
    searchTestDir,
    "auth.ts",
    `
// Authentication module
export class AuthService {
  login(username: string, password: string) {
    return { token: "jwt-token", user: username };
  }

  logout(token: string) {
    return { success: true };
  }

  validateToken(token: string): boolean {
    return token.startsWith("jwt-");
  }
}
`,
  );

  await createTestFile(
    searchTestDir,
    "database.ts",
    `
// Database connection
export class DatabaseService {
  connect(connectionString: string) {
    return { connected: true, db: "postgres" };
  }

  query(sql: string) {
    return { rows: [], count: 0 };
  }

  disconnect() {
    return { disconnected: true };
  }
}
`,
  );

  await createTestFile(
    searchTestDir,
    "cache.ts",
    `
// Cache layer
export class CacheService {
  set(key: string, value: any, ttl: number) {
    return { cached: true };
  }

  get(key: string) {
    return null;
  }

  invalidate(pattern: string) {
    return { cleared: true };
  }
}
`,
  );

  const indexer = new CodeIndexer(
    qdrant,
    embeddings,
    getIndexerConfig({
      chunkSize: 1000,
      chunkOverlap: 100,
    }),
  );

  resources.trackIndexedPath(searchTestDir);
  await indexer.indexCodebase(searchTestDir, { forceReindex: true });

  // Semantic search tests - verify that search returns meaningful content
  const authQuery = await indexer.searchCode(searchTestDir, "user authentication login password", { limit: 5 });
  const authHasContent = authQuery.some((r) => r.content && r.content.length > 0);
  assert(authHasContent, `Auth query returns results with content: ${authQuery.length} results`);

  const dbQuery = await indexer.searchCode(searchTestDir, "database connection SQL query", { limit: 5 });
  const dbHasContent = dbQuery.some((r) => r.content && r.content.length > 0);
  assert(dbHasContent, `DB query returns results with content: ${dbQuery.length} results`);

  const cacheQuery = await indexer.searchCode(searchTestDir, "cache key value TTL", { limit: 5 });
  const cacheHasContent = cacheQuery.some((r) => r.content && r.content.length > 0);
  assert(cacheHasContent, `Cache query returns results with content: ${cacheQuery.length} results`);

  // Limit parameter
  const limitResults = await indexer.searchCode(searchTestDir, "service", { limit: 2 });
  assert(limitResults.length <= 2, `Limit respected: ${limitResults.length} <= 2`);
}
