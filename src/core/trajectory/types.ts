/**
 * Trajectory types — re-exports from contracts for backward compatibility.
 * New code should import directly from core/contracts.
 */

// Re-export all provider types from contracts
export type {
  Signal,
  FilterDescriptor,
  FilterLevel,
  ScoringWeights,
  TrajectoryQueryContract,
  EnrichmentProvider,
  FileSignalTransform,
  FileSignalOverlay,
  ChunkSignalOverlay,
  ChunkLookupEntry,
} from "../contracts/index.js";

// Qdrant types — re-export from adapters (canonical source)
export type {
  QdrantMatchCondition,
  QdrantRangeCondition,
  QdrantFilterCondition,
  QdrantFilter,
} from "../adapters/qdrant/types.js";

// Backward compat aliases — remove after full migration

/** @deprecated Use Signal instead */
export type { Signal as FieldDoc } from "../contracts/index.js";

/** @deprecated Use FileSignalOverlay instead */
export type { FileSignalOverlay as FileMetadataOverlay } from "../contracts/index.js";

/** @deprecated Use ChunkSignalOverlay instead */
export type { ChunkSignalOverlay as ChunkMetadataOverlay } from "../contracts/index.js";
