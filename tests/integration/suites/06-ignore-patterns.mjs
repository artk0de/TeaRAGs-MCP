/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { CodeIndexer } from "../../../build/code/indexer.js";
import { getIndexerConfig, TEST_DIR } from "../config.mjs";
import { assert, createTestFile, hashContent, log, randomUUID, resources, section, skip, sleep } from "../helpers.mjs";

export async function testIgnorePatterns(qdrant, embeddings) {
  section("6. Ignore Patterns");

  const ignoreTestDir = join(TEST_DIR, "ignore_test");
  await fs.mkdir(join(ignoreTestDir, "node_modules/pkg"), { recursive: true });
  await fs.mkdir(join(ignoreTestDir, "src"), { recursive: true });
  await fs.mkdir(join(ignoreTestDir, ".git"), { recursive: true });
  await fs.mkdir(join(ignoreTestDir, "dist"), { recursive: true });

  // Create files in various locations
  await createTestFile(ignoreTestDir, "src/app.ts", "export const APP = 'main';");
  await createTestFile(ignoreTestDir, "node_modules/pkg/index.ts", "export const PKG = 'dep';");
  await createTestFile(ignoreTestDir, ".git/config.ts", "export const GIT = 'ignore';");
  await createTestFile(ignoreTestDir, "dist/bundle.ts", "export const DIST = 'build';");
  await createTestFile(ignoreTestDir, "test.spec.ts", "describe('test', () => {});");

  const indexer = new CodeIndexer(
    qdrant,
    embeddings,
    getIndexerConfig({
      ignorePatterns: ["node_modules", ".git", "dist", "*.spec.ts"],
    }),
  );

  resources.trackIndexedPath(ignoreTestDir);
  const stats = await indexer.indexCodebase(ignoreTestDir, { forceReindex: true });

  // Should only index src/app.ts
  assert(stats.filesIndexed === 1, `Only non-ignored files indexed: ${stats.filesIndexed}`);

  // Verify ignored content not searchable by checking result paths
  // Note: Semantic search may return results, but they should NOT be from ignored paths
  // CodeSearchResult interface uses filePath, not relativePath
  const allResults = await indexer.searchCode(ignoreTestDir, "export const", { limit: 10 });

  // Helper to check if any result is from ignored path
  const hasIgnoredPath = (results, pattern) => results.some((r) => r.filePath && r.filePath.includes(pattern));

  assert(!hasIgnoredPath(allResults, "node_modules"), "node_modules content not indexed");
  assert(!hasIgnoredPath(allResults, ".git"), ".git content not indexed");
  assert(!hasIgnoredPath(allResults, "dist"), "dist content not indexed");
  assert(!allResults.some((r) => r.filePath?.endsWith(".spec.ts")), "*.spec.ts content not indexed");

  // But main app should be searchable
  const appResults = await indexer.searchCode(ignoreTestDir, "APP main");
  assert(appResults.length > 0, `Main app indexed and searchable: ${appResults.length}`);
}
