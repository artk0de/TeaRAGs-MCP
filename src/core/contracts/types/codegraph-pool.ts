/**
 * The slice of the per-collection DuckDB client pool that domain code reads
 * through. The concrete pool (`adapters/duckdb/pool.ts`) implements it; domains
 * and the ingest status module type against this port so they never import the
 * adapter (DIP — `.claude/rules/domain-boundaries.md`).
 *
 * Only what domain callers actually use lives here: reader/writer acquisition,
 * the collection-name listing, the two spill-path derivations, and — since the
 * worker-side pool became bootstrap-owned (bd tea-rags-mcp-89k7k.35, S15) — the
 * runtime-lifecycle members the codegraph provider runtime and the working-tree
 * graph build drive a pool they did not construct with: the direct-mode
 * `acquire`, the disk path derivation, and the teardown. Clone/export, release
 * and daemon plumbing stay on the concrete class for the composition root.
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
  /**
   * Direct-mode open of the collection's own database (daemon-mode pools route
   * through `acquireWrite` instead) — what a runtime that holds the only
   * client, like the working-tree graph build over its private clone, uses.
   */
  acquire: (physicalCollectionName: PhysicalCollectionName) => Promise<CollectionGraphHandle>;
  /** Disk path of the collection's database file. */
  pathFor: (physicalCollectionName: PhysicalCollectionName) => string;
  /** Close every cached client — the runtime teardown at the end of a build. */
  closeAll: () => Promise<void>;
}
