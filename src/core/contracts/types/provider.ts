/**
 * Shared provider contracts — domain interfaces for trajectory system.
 * Lives in contracts/ for DIP: trajectory, ingest, search all import from here.
 *
 * EnrichmentProvider is the single interface that every trajectory provider
 * must implement. It covers both the ingest side (buildFileSignals,
 * buildChunkSignals) and the query side (signals, filters, presets).
 */

import type { QdrantFilterCondition } from "../../adapters/qdrant/types.js";
import type { ChunkLookupEntry } from "../../types.js";
import type { DerivedSignalDescriptor, RerankPreset } from "./reranker.js";
import type { PayloadSignalDescriptor } from "./trajectory.js";

// --- Signal overlay base types ---

/** Base type for file-level signal payload. All providers extend this. */
export interface FileSignalOverlay {
  [key: string]: unknown;
}

/** Base type for chunk-level signal payload. All providers extend this. */
export interface ChunkSignalOverlay {
  [key: string]: unknown;
}

// --- Scoring weights ---

export interface ScoringWeights {
  [signal: string]: number | undefined;
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

export type FileSignalTransform = (data: FileSignalOverlay, maxEndLine: number) => FileSignalOverlay;

// --- Enrichment provider ---

export interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string;

  // ── Query-side contract ──

  /** Payload signal descriptors (raw payload field docs for MCP schema generation) */
  readonly signals: PayloadSignalDescriptor[];
  /** Derived signal descriptors for reranking (normalized transforms of raw signals) */
  readonly derivedSignals: DerivedSignalDescriptor[];
  /** Typed filter parameters → Qdrant conditions */
  readonly filters: FilterDescriptor[];
  /** Trajectory-owned presets (weight configurations) */
  readonly presets: RerankPreset[];

  // ── Ingest-side contract ──

  /** Resolve the effective root for this provider (e.g. git repo root). */
  resolveRoot: (absolutePath: string) => string;
  /** Optional per-file transform applied at write time. */
  readonly fileSignalTransform?: FileSignalTransform;
  /** File-level signal enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileSignals: (root: string, options?: { paths?: string[] }) => Promise<Map<string, FileSignalOverlay>>;
  /** Chunk-level signal enrichment (post-flush) */
  buildChunkSignals: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, ChunkSignalOverlay>>>;
}

// Re-export for convenience
export type { ChunkLookupEntry } from "../../types.js";
