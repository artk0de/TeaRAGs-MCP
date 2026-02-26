/**
 * Shared provider contracts — domain interfaces for trajectory system.
 * Lives in contracts/ for DIP: trajectory, ingest, search all import from here.
 */

// TODO(task-2): Update import to ../../adapters/qdrant/types.js after Qdrant type migration
import type { QdrantFilterCondition } from "../../trajectory/types.js";
import type { ChunkLookupEntry } from "../../types.js";

// --- Overlay base types ---

export interface FileSignalOverlay {
  [key: string]: unknown;
}

export interface ChunkSignalOverlay {
  [key: string]: unknown;
}

// --- Scoring weights ---

export interface ScoringWeights {
  [signal: string]: number | undefined;
}

// --- Signal (raw payload field, no normalization) ---

export interface Signal {
  /** Qdrant payload path (e.g. "git.file.commitCount") */
  key: string;
  /** Signal name for reranker/preset reference (e.g. "commitCount") */
  name: string;
  /** Data type */
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  /** Human-readable description for MCP schema */
  description: string;
  /** Hint for Reranker: default normalization upper bound */
  defaultBound?: number;
}

// --- Filter level ---

/** Payload level for level-aware filters ("file" or "chunk"). */
export type FilterLevel = "file" | "chunk";

// --- Filter descriptor ---

export interface FilterDescriptor {
  /** Parameter name exposed to users (e.g. "author", "minAgeDays") */
  param: string;
  /** Human-readable description */
  description: string;
  /** Parameter type for schema generation */
  type: "string" | "number" | "boolean" | "string[]";
  /** Convert user param value to Qdrant filter condition(s) */
  toCondition: (value: unknown, level?: FilterLevel) => QdrantFilterCondition[];
}

// --- File signal transform ---

export type FileSignalTransform = (data: Record<string, unknown>, maxEndLine: number) => Record<string, unknown>;

// --- Enrichment provider ---

export interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string;
  /** Resolve the effective root for this provider (e.g. git repo root). */
  resolveRoot: (absolutePath: string) => string;
  /** Optional per-file transform applied at write time. */
  readonly fileSignalTransform?: FileSignalTransform;
  /** File-level signal enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileSignals: (root: string, options?: { paths?: string[] }) => Promise<Map<string, Record<string, unknown>>>;
  /** Chunk-level signal enrichment (post-flush) */
  buildChunkSignals: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, Record<string, unknown>>>>;
}

// --- Trajectory query contract ---

export interface TrajectoryQueryContract {
  /** Signal definitions (raw payload fields) */
  readonly signals: Signal[];
  /** Typed filter parameters → Qdrant conditions */
  readonly filters: FilterDescriptor[];
  /** Trajectory-owned presets (weight configurations) */
  readonly presets: Record<string, ScoringWeights>;
}

// Re-export for convenience
export type { ChunkLookupEntry } from "../../types.js";
