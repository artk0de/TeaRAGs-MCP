/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { getIndexerConfig, TEST_DIR } from "../config.mjs";
import { assert, createTestFacades, createTestFile, resources, searchCode, section } from "../helpers.mjs";

export async function testConcurrentSafety(qdrant, embeddings) {
  section("12. Concurrent Operations");

  const concTestDir = join(TEST_DIR, "conc_test");
  await fs.mkdir(concTestDir, { recursive: true });

  for (let i = 0; i < 5; i++) {
    await createTestFile(concTestDir, `file${i}.ts`, `export const FILE_${i} = ${i};`);
  }

  const { ingest, explore } = createTestFacades(qdrant, embeddings, { config: getIndexerConfig() });

  // Index first
  resources.trackIndexedPath(concTestDir);
  await ingest.indexCodebase(concTestDir, { forceReindex: true });

  // Concurrent searches should not interfere
  const searches = await Promise.all([
    searchCode(explore, concTestDir, "FILE_0"),
    searchCode(explore, concTestDir, "FILE_1"),
    searchCode(explore, concTestDir, "FILE_2"),
    searchCode(explore, concTestDir, "FILE_3"),
    searchCode(explore, concTestDir, "FILE_4"),
  ]);

  assert(
    searches.every((s) => s.length > 0),
    `All concurrent searches returned results`,
  );

  // Concurrent status checks
  const statuses = await Promise.all([
    ingest.getIndexStatus(concTestDir),
    ingest.getIndexStatus(concTestDir),
    ingest.getIndexStatus(concTestDir),
  ]);

  assert(
    statuses.every((s) => s.status === "indexed" || s.isIndexed),
    "Concurrent status checks consistent",
  );
}
