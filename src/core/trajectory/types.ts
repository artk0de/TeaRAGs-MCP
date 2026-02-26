/**
 * Shared trajectory contract types.
 *
 * These types define the query-layer contracts that each enrichment trajectory
 * (git, code-graph, etc.) must implement. The ingest-side EnrichmentProvider
 * interface remains in enrichment/types.ts — TrajectoryQueryContract extends
 * it with signal extractors, filters, presets, and payload field documentation.
 */

// --- Overlay base types ---

export interface FileMetadataOverlay {
  [key: string]: unknown;
}

export interface ChunkMetadataOverlay {
  [key: string]: unknown;
}

// --- Qdrant filter primitives ---

export interface QdrantMatchCondition {
  key: string;
  match: { value: unknown } | { any: unknown[] };
}

export interface QdrantRangeCondition {
  key: string;
  range: { gte?: number; lte?: number };
}

export type QdrantFilterCondition = QdrantMatchCondition | QdrantRangeCondition;

export interface QdrantFilter {
  must?: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

// --- Scoring weights ---

export interface ScoringWeights {
  [signal: string]: number | undefined;
}

// --- Signal descriptor ---

export interface SignalDescriptor {
  /** Signal name used in presets and custom weights (e.g. "recency", "churn") */
  name: string;
  /** Human-readable description for docs */
  description: string;
  /** Extract normalized signal value (0-1) from a search result payload */
  extract: (payload: Record<string, unknown>) => number;
  /** Default normalization bound (max value for 0-1 mapping) */
  defaultBound?: number;
  /** Whether signal needs statistical confidence dampening */
  needsConfidence?: boolean;
  /** Field path used to determine confidence (e.g. "git.file.commitCount") */
  confidenceField?: string;
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

// --- Payload field doc ---

export interface FieldDoc {
  /** Qdrant payload path (e.g. "git.file.commitCount") */
  key: string;
  /** Data type */
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  /** Human-readable description for MCP schema */
  description: string;
}

// --- Trajectory query contract ---

export interface TrajectoryQueryContract {
  /** Reranker signal extractors with normalization bounds */
  readonly signals: SignalDescriptor[];
  /** Typed filter parameters → Qdrant conditions */
  readonly filters: FilterDescriptor[];
  /** Trajectory-owned presets (weight configurations) */
  readonly presets: Record<string, ScoringWeights>;
  /** Payload field documentation for dynamic MCP schema */
  readonly payloadFields: FieldDoc[];
}
