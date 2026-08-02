/**
 * Versioned-collection number resolution from Qdrant truth.
 *
 * The next version for a (force) reindex MUST be derived from Qdrant reality,
 * not from a snapshot file that can lag or be lost. A stale snapshot can hand
 * back a version number that collides with the live alias target or with an
 * orphan collection left by an interrupted run.
 *
 * Source of truth:
 *   newVersion = max(versionFromAliasTarget, maxExistingVersionedCollection) + 1
 *
 * - versionFromAliasTarget: the `_vN` the alias currently points to (0 if the
 *   alias is absent or points to an unversioned collection).
 * - maxExistingVersionedCollection: highest `_vN` among all collections matching
 *   `^${collectionName}_v(\d+)$` (covers orphans from interrupted runs so the
 *   new version can never re-collide with a leftover).
 */

/**
 * Parse the `_vN` suffix of a collection name relative to a base collection.
 * Returns 0 when `name` is undefined, not versioned, or for a different base.
 */
export function parseCollectionVersion(collectionName: string, name: string | undefined): number {
  if (!name) return 0;
  const match = name.match(new RegExp(`^${collectionName}_v(\\d+)$`));
  return match ? parseInt(match[1], 10) : 0;
}

/** One alias entry as Qdrant reports it. */
export interface CollectionAliasEntry {
  aliasName: string;
  collectionName: string;
}

/**
 * The collection an alias points at, or `undefined` when the name is not an
 * alias. The single lookup both pipelines share.
 *
 * `undefined` is load-bearing and distinct from "points at itself": the force
 * path feeds it to `computeNewVersion` and uses it as the alias's previous
 * target, where absence means "no alias yet" and must not collapse to the base
 * name.
 */
export function findAliasTarget(collectionName: string, aliases: readonly CollectionAliasEntry[]): string | undefined {
  return aliases.find((a) => a.aliasName === collectionName)?.collectionName;
}

/**
 * The physical collection to address by LITERAL name: the alias target when
 * there is one, the name itself otherwise.
 *
 * Qdrant resolves aliases server-side, so Qdrant calls work either way. Anything
 * opened by literal name does not — above all the codegraph DuckDB file, which
 * `GraphDbClientPool.pathFor()` derives straight from the string it is handed.
 * Addressing that by the alias produced a shadow `<alias>.duckdb` that no reader
 * ever opened (bd tea-rags-mcp-6goqa).
 */
export function resolveAliasTargetCollection(collectionName: string, aliases: readonly CollectionAliasEntry[]): string {
  return findAliasTarget(collectionName, aliases) ?? collectionName;
}

/**
 * Highest `_vN` among `allCollections` for the given base. 0 if none exist.
 * Mirrors the regex approach in status-module's findLatestVersionedCollection.
 */
export function maxVersionedCollection(collectionName: string, allCollections: readonly string[]): number {
  const versionedPattern = new RegExp(`^${collectionName}_v(\\d+)$`);
  let max = 0;
  for (const c of allCollections) {
    const match = c.match(versionedPattern);
    if (match) {
      const version = parseInt(match[1], 10);
      if (version > max) max = version;
    }
  }
  return max;
}

/**
 * Compute the version number for the next versioned collection from Qdrant truth.
 *
 * @param collectionName base alias name (e.g. "code_abc")
 * @param aliasTargetCollection collection the alias currently points to (undefined if no alias)
 * @param allCollections every collection name reported by Qdrant
 * @param isMigration true when converting a real unversioned collection to the alias scheme
 *
 * Migration is special-cased: the pre-existing real collection counts as v1, so
 * the first versioned collection minted by a migration is v2 (preserves the
 * historical migration contract).
 */
export function computeNewVersion(args: {
  collectionName: string;
  aliasTargetCollection: string | undefined;
  allCollections: readonly string[];
  isMigration: boolean;
}): number {
  const { collectionName, aliasTargetCollection, allCollections, isMigration } = args;

  const versionFromAliasTarget = parseCollectionVersion(collectionName, aliasTargetCollection);
  const maxExistingVersionedCollection = maxVersionedCollection(collectionName, allCollections);
  const qdrantDerived = Math.max(versionFromAliasTarget, maxExistingVersionedCollection) + 1;

  // Migration converts a real (unversioned) collection: it counts as v1, so the
  // minted versioned collection is at least v2.
  return isMigration ? Math.max(qdrantDerived, 2) : qdrantDerived;
}
