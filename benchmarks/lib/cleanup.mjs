/**
 * Cleanup Functions
 *
 * Functions for cleaning up test collections after benchmarking.
 */

import { c } from "./colors.mjs";
import { createdCollections } from "./benchmarks.mjs";

/**
 * Remove all test collections from Qdrant
 */
export async function cleanupAllCollections(qdrant) {
  console.log(`\n${c.dim}Cleaning up test collections...${c.reset}`);

  // Delete tracked collections
  for (const collection of createdCollections) {
    try {
      await qdrant.deleteCollection(collection);
    } catch {}
  }
  createdCollections.clear();

  // Also clean up any orphaned tune_* collections
  try {
    const collections = await qdrant.client.getCollections();
    const tuneCollections = collections.collections
      .filter(col => col.name.startsWith("tune_"));

    if (tuneCollections.length > 0) {
      console.log(`${c.dim}Cleaning ${tuneCollections.length} orphaned tune_* collections...${c.reset}`);
      for (const col of tuneCollections) {
        try {
          await qdrant.deleteCollection(col.name);
        } catch {}
      }
    }
  } catch {}

  console.log(`${c.green}✓${c.reset} ${c.dim}All test collections cleaned up${c.reset}`);
}
