/**
 * Shared provider contracts — domain interfaces for trajectory system.
 * Lives in contracts/ for DIP: trajectory, ingest, search all import from here.
 *
 * EnrichmentProvider is the single interface that every trajectory provider
 * must implement. It covers both the ingest side (buildFileSignals,
 * buildChunkSignals) and the query side (signals, filters, presets).
 */

import type { Ignore } from "ignore";

import type { QdrantFilterCondition } from "../../adapters/qdrant/types.js";
import type { ChunkLookupEntry, ProviderRunMetrics } from "../../types.js";
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

// --- Filter condition result ---

/** Result of converting a user param to Qdrant filter conditions. */
export interface FilterConditionResult {
  must?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

// --- Filter descriptor ---

export interface FilterDescriptor {
  /** Parameter name exposed to users (e.g. "author", "minAgeDays") */
  param: string;
  /** Human-readable description */
  description: string;
  /** Parameter type for schema generation */
  type: "string" | "number" | "boolean" | "string[]";
  /** Convert user param value to Qdrant filter condition(s) */
  toCondition: (value: unknown, level?: FilterLevel) => FilterConditionResult;
}

// --- File signal transform ---

export type FileSignalTransform = (data: FileSignalOverlay, maxEndLine: number) => FileSignalOverlay;

// --- Payload builder ---

/** Builds the base Qdrant payload from a chunk. Injected into the pipeline. */
export interface PayloadBuilder {
  buildPayload: (
    chunk: { content: string; startLine: number; endLine: number; metadata: Record<string, unknown> },
    codebasePath: string,
  ) => Record<string, unknown>;
}

// --- Chunk signal options ---

/**
 * Options for buildChunkSignals — allows coordinator to inject shared
 * concurrency and opt out of HEAD-based caching for partial streaming calls.
 */
export interface ChunkSignalOptions {
  /**
   * External semaphore to use instead of the provider's internal concurrency
   * limiter. Lets a coordinator share one limit across many per-batch calls.
   */
  concurrencySemaphore?: { acquire: () => Promise<() => void> };
  /**
   * Skip HEAD-based caching. Required for streaming partial calls, since a
   * subset of the chunk map would corrupt the cache for the next full call.
   */
  skipCache?: boolean;
  /**
   * Active Qdrant collection name the chunks belong to. Threaded from
   * EnrichmentCoordinator.prefetch so collection-scoped providers
   * (codegraph) can route writes to their per-collection backing store
   * (per-collection DuckDB file). Optional: providers that don't care
   * about collection scope (git) ignore it.
   */
  collectionName?: string;
}

/**
 * Options for buildFileSignals — symmetric to ChunkSignalOptions but the
 * shape is simpler (no concurrency / cache concerns at file level today).
 * Carries the active collection name so collection-scoped providers
 * (codegraph) can pick their per-collection store before walking files.
 */
export interface FileSignalOptions {
  /** Optional path subset for backfill / incremental reindex callers. */
  paths?: string[];
  /** Active Qdrant collection name — see ChunkSignalOptions.collectionName. */
  collectionName?: string;
  /**
   * Shared `Ignore` instance from FileScanner — the same filter that
   * `EnrichmentCoordinator` already holds in `ProviderContext.ignoreFilter`.
   * Carries BUILTIN_IGNORE_PATTERNS + user `.gitignore` / `.contextignore`
   * rules. Providers that walk the file tree themselves (codegraph) read
   * this to stay aligned with the main ingest path's file selection.
   * Providers that don't walk the tree (git) ignore it.
   */
  ignoreFilter?: Ignore;
}

/**
 * Options for handleDeletedPaths — carries the active collection so the
 * provider routes deletion to the correct per-collection store. Optional
 * for callers that haven't been threaded yet (legacy paths fall back to
 * the provider's default routing).
 */
export interface DeletedPathOptions {
  collectionName?: string;
}

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
  buildFileSignals: (root: string, options?: FileSignalOptions) => Promise<Map<string, FileSignalOverlay>>;
  /** Chunk-level signal enrichment (streaming per-batch or post-flush). */
  buildChunkSignals: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ) => Promise<Map<string, Map<string, ChunkSignalOverlay>>>;
  /**
   * Optional per-run counters surfaced via
   * `EnrichmentMetrics.byProvider[provider.key]`. Returned shape is
   * provider-defined; coordinator stores it verbatim. Called once per
   * enrichment cycle by `CompletionRunner.run`; provider is expected to
   * reset internal counters after each call (or return values aggregated
   * since the last reset).
   */
  getRunMetrics?: () => ProviderRunMetrics | undefined;
  /**
   * Optional deletion hook — invoked by `EnrichmentCoordinator.notifyDeletions`
   * before sync removes the corresponding Qdrant points. Provider clears
   * its provider-owned state for those paths (e.g. codegraph deletes graph
   * edges + symbol-table entries; future providers might clear per-file
   * caches). Calling order is sync → coordinator → all providers →
   * qdrant.deletePoints, so if Qdrant deletion fails the provider state
   * is already consistent — preferable to the inverse: orphan graph
   * edges are silent corruption, orphan Qdrant points are just clutter.
   *
   * `paths` are repo-relative POSIX (same shape as buildFileSignals
   * `options.paths`). Provider is expected to be idempotent: receiving a
   * path it never enriched must be a no-op, not an error.
   */
  handleDeletedPaths?: (paths: string[], options?: DeletedPathOptions) => Promise<void>;
}

// Re-export for convenience
export type { ChunkLookupEntry, ProviderRunMetrics } from "../../types.js";
