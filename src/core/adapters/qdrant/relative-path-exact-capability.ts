/**
 * Whether a collection's path-membership filters may match the keyword-indexed
 * `relativePathExact` (bd tea-rags-mcp-ejio7) — the ONE place that decides it,
 * so the point store, the working-tree base-point reader and test-setup
 * hydration cannot disagree about a collection.
 *
 * Yes exactly when the collection's schema version is at least
 * `RELATIVE_PATH_EXACT_SCHEMA_VERSION`: the schema pipeline stamps a version
 * only after every migration up to it succeeded, so that version means the v20
 * backfill finished, and a collection created at or above it was written
 * entirely by a builder that sets the key. Below it some points may lack the
 * key, and a keyword filter would miss them with no error — so the answer is
 * no, and the caller keeps the exact text+value pairs on `relativePath`.
 *
 * The version is read from the PHYSICAL collection's schema metadata point. A
 * served answer is remembered per physical name for the life of the process:
 * versions only rise and a physical collection is never re-pointed. An unserved
 * answer is not remembered, so a migration completing in a long-lived server is
 * picked up on the next call; it costs one point read. Resolving the alias is
 * one alias-list read per call, which is what keeps an alias switched onto a
 * collection an OLDER build created from inheriting the old target's answer.
 *
 * Never throws: an unreadable alias list or metadata point answers no, which is
 * always correct, only slower.
 */

import { RELATIVE_PATH_EXACT_SCHEMA_VERSION } from "../../contracts/relative-path-exact.js";

export interface RelativePathExactCapabilityDeps {
  /** The physical collection an alias names, or the name itself. */
  resolvePhysical: (collectionName: string) => Promise<string>;
  /** The stamped schema version, or `undefined` when the collection has no schema metadata. */
  readSchemaVersion: (physicalCollectionName: string) => Promise<number | undefined>;
}

/** The gate's surface, as its consumers take it. */
export interface RelativePathExactGate {
  isServed: (collectionName: string) => Promise<boolean>;
}

export class RelativePathExactCapability implements RelativePathExactGate {
  private readonly served = new Set<string>();

  constructor(private readonly deps: RelativePathExactCapabilityDeps) {}

  async isServed(collectionName: string): Promise<boolean> {
    try {
      const physical = await this.deps.resolvePhysical(collectionName);
      if (this.served.has(physical)) return true;
      const version = await this.deps.readSchemaVersion(physical);
      if (version === undefined || version < RELATIVE_PATH_EXACT_SCHEMA_VERSION) return false;
      this.served.add(physical);
      return true;
    } catch {
      return false;
    }
  }
}
