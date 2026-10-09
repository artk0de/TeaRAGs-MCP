/**
 * The slice of the per-collection DuckDB client pool that domain code reads
 * through. The concrete pool (`adapters/duckdb/pool.ts`) implements it; domains
 * and the ingest status module type against this port so they never import the
 * adapter (DIP — `.claude/rules/domain-boundaries.md`).
 *
 * Only what domain callers actually use lives here: reader/writer acquisition,
 * the collection-name listing, and the two spill-path derivations. Pool
 * lifecycle (`closeAll`, `release`, clone/export, daemon plumbing) stays on the
 * concrete class for the composition root and the api layer.
 */

import type { GlobalSymbolTable, GraphDbClient } from "./codegraph.js";
import type { PhysicalCollectionName } from "./collection-identity.js";

/** A pooled graph client together with the symbol table shared across its acquires. */
export interface CollectionGraphHandle {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
}

export interface GraphDbClientPoolPort {
  /** Physical DuckDB names (every generation) that belong to `baseCollectionName`. */
  listCollectionDbNames: (baseCollectionName: string) => PhysicalCollectionName[];
  /** Read-only handle that does not contend with the writer. */
  acquireReader: (physicalCollectionName: PhysicalCollectionName) => Promise<CollectionGraphHandle>;
  /** Exclusive writer handle for an index run. */
  acquireWrite: (physicalCollectionName: PhysicalCollectionName) => Promise<CollectionGraphHandle>;
  /** Deterministic output-spill path for one run. */
  spillPathFor: (collectionName: string, runId: string) => string;
  /** Deterministic cross-pass input-spill path (one per collection). */
  inputSpillPathFor: (collectionName: string) => string;
}
