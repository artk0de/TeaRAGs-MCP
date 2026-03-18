import type { QdrantManager } from "../../adapters/qdrant/client.js";

/**
 * Deletes versioned collections that are no longer pointed to by an alias.
 * Handles cleanup after crashes between alias switch and old collection deletion.
 *
 * @returns Number of orphaned collections deleted.
 */
export async function cleanupOrphanedVersions(qdrant: QdrantManager, collectionName: string): Promise<number> {
  const aliases = await qdrant.aliases.listAliases();
  const activeCollection = aliases.find((a) => a.aliasName === collectionName)?.collectionName;
  if (!activeCollection) return 0;

  const allCollections = await qdrant.listCollections();
  const orphans = allCollections.filter((c) => c.startsWith(`${collectionName}_v`) && c !== activeCollection);

  for (const orphan of orphans) {
    await qdrant.deleteCollection(orphan);
  }

  return orphans.length;
}
