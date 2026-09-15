/**
 * Compile-time fixture for the collection-identity brands (bd tea-rags-mcp-39xca.1).
 *
 * Never executed. `collection-identity.test.ts` type-checks it and requires ZERO
 * diagnostics: each `@ts-expect-error` line is a call the brand must reject, so
 * a boundary that starts accepting a bare string or an alias again turns that
 * directive into TS2578 ("unused '@ts-expect-error'") and fails the test.
 */

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import type { CodegraphPayloadHealRunnerDeps } from "../../../../../src/core/api/internal/infra/codegraph-payload-heal-runner.js";
import type {
  CollectionAlias,
  PhysicalCollectionName,
} from "../../../../../src/core/contracts/types/collection-identity.js";
import type { CodegraphFootprintStore } from "../../../../../src/core/contracts/types/footprint.js";
import type { ChunkSignalOptions, FileSignalOptions } from "../../../../../src/core/contracts/types/provider.js";
import type { EnrichmentRunSpec } from "../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";

declare const pool: GraphDbClientPool;
declare const footprintStore: CodegraphFootprintStore;
declare const healDeps: CodegraphPayloadHealRunnerDeps;
declare const physical: PhysicalCollectionName;
declare const alias: CollectionAlias;
declare const unresolved: string;

export async function poolAcceptsOnlyPhysicalNames(): Promise<void> {
  await pool.acquireWrite(physical);
  await pool.acquireRead(physical);
  await pool.acquireReader(physical);
  await pool.removeCollection(physical);
  await pool.cloneDatabase(physical, physical);

  // @ts-expect-error -- an unresolved name must not reach the write path
  await pool.acquireWrite(unresolved);
  // @ts-expect-error -- an alias must not reach the write path
  await pool.acquireWrite(alias);
  // @ts-expect-error -- an alias must not reach the read-only attach
  await pool.acquireRead(alias);
  // @ts-expect-error -- an alias must not reach the mode-aware read path
  await pool.acquireReader(alias);
  // @ts-expect-error -- removing by alias deletes the shadow and leaks the generation
  await pool.removeCollection(alias);
  // @ts-expect-error -- a clone target is a new generation, never an alias
  await pool.cloneDatabase(physical, alias);
  // @ts-expect-error -- an unresolved name must not derive a DuckDB path
  pool.pathFor(unresolved);
}

export async function footprintStoreAcceptsOnlyPhysicalNames(): Promise<void> {
  await footprintStore.cloneDatabase(physical, physical);
  // @ts-expect-error -- the saga's codegraph artifact keys on the physical name
  await footprintStore.removeCollection(alias);
}

export async function healAcquiresOnlyPhysicalNames(): Promise<void> {
  await healDeps.acquireGraphDb(physical);
  // @ts-expect-error -- the heal must be handed the resolved name, never re-resolve
  await healDeps.acquireGraphDb(unresolved);
}

export const chunkSignalOptions: ChunkSignalOptions = { collectionName: physical };
// @ts-expect-error -- chunk signals write the per-generation store
export const chunkSignalOptionsFromAlias: ChunkSignalOptions = { collectionName: alias };

export const fileSignalOptions: FileSignalOptions = { collectionName: physical };
// @ts-expect-error -- file signals write the per-generation store
export const fileSignalOptionsFromUnresolved: FileSignalOptions = { collectionName: unresolved };

export const runCollection: EnrichmentRunSpec["collection"] = physical;
// @ts-expect-error -- an enrichment run is opened on the physical collection
export const runCollectionFromAlias: EnrichmentRunSpec["collection"] = alias;

// @ts-expect-error -- the brands are mutually unassignable: a physical name is not an alias
export const aliasFromPhysical: CollectionAlias = physical;
// @ts-expect-error -- the brands are mutually unassignable: an alias is not a physical name
export const physicalFromAlias: PhysicalCollectionName = alias;
