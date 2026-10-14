/**
 * Role ports over the Qdrant adapter's facade (bd tea-rags-mcp-89k7k.35, 6oah1 Q1).
 *
 * `QdrantManager` (client.ts) is the adapter's single entry point, and the
 * foundation it sits in is stable by design — `domain-boundaries.md` declares
 * adapters the layer everything else may depend on. SAP: a component this
 * stable must also be ABSTRACT, so consumers (from Q2 on) type their
 * dependency as the NARROWEST role they call instead of the 55-method concrete
 * facade.
 *
 * One interface per collaborator concern, mirroring the seven-collaborator
 * split inside `QdrantManager` (the cut documented in client.ts): what the
 * facade delegates to `QdrantCollectionAdmin` lands here as three roles
 * (catalog read / lifecycle write / optimizer control), the point store splits
 * on the same read/write line the store itself draws, and each of scroller,
 * search executor, payload-index manager, snapshot store and connection keeps
 * one role. The alias manager the facade hands out through its `aliases`
 * accessor gets the alias role, and the accessor its own one-member role. Member sets are the facade surface AS DELEGATED — every member is
 * a `QdrantManager` method that forwards to the collaborator owning that
 * concern; nothing speculative is declared.
 *
 * This file is a LEAF over its own declarations: it may type-import the shared
 * result/option types from the collaborator modules that own them, but never
 * from `client.ts` or `embedding-model-guard.ts` — the arrow runs one way,
 * concrete class → port (pinned by tests/core/adapters/qdrant/qdrant-ports-direction.test.ts).
 */
import type { CollectionAliasEntry, PhysicalCollectionName } from "../../contracts/types/collection-identity.js";
import type { EmbeddingCallOptions } from "../embeddings/base.js";
import type {
  CollectionInfo,
  PayloadFieldIndex,
  QdrantCollectionMemoryUsage,
  QdrantUpdateStatus,
  SearchResult,
  SparseVector,
} from "./types.js";
import type { PayloadWriteBarrierOutcome } from "./write-barrier.js";

/** Read side of `QdrantCollectionAdmin`: what collections exist and the state each is in. */
export interface QdrantCollectionCatalog {
  collectionExists: (name: string) => Promise<boolean>;
  listCollections: () => Promise<PhysicalCollectionName[]>;
  getCollectionInfo: (name: string) => Promise<CollectionInfo>;
  /** Live health status, or "unknown" on ANY failure (never throws). */
  getCollectionStatus: (name: string) => Promise<"green" | "yellow" | "red" | "unknown">;
  getQuantizationConfig: (name: string) => Promise<unknown>;
  getStrictModeConfig: (name: string) => Promise<unknown>;
  /** On-disk bytes for an EMBEDDED collection; `undefined` for external Qdrant or on any error. */
  getCollectionDiskBytes: (collectionName: string) => Promise<number | undefined>;
  /** Server-side memory report (disk / RAM / page cache per component); `undefined` when unavailable. */
  getCollectionMemoryUsage: (collectionName: string) => Promise<QdrantCollectionMemoryUsage | undefined>;
}

/** Write side of `QdrantCollectionAdmin`: the collection as an object — create, configure, delete. */
export interface QdrantCollectionLifecycle {
  createCollection: (
    name: string,
    vectorSize: number,
    distance?: "Cosine" | "Euclid" | "Dot",
    enableSparse?: boolean,
    quantizationScalar?: boolean,
    turboQuant?: boolean,
    strictMode?: { maxResidentMemoryPercent?: number; searchMaxBatchsize?: number },
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
  deleteCollection: (name: string) => Promise<void>;
  updateCollectionSparseConfig: (collectionName: string) => Promise<void>;
  updateCollectionQuantization: (collectionName: string) => Promise<void>;
  updateCollectionStrictMode: (
    collectionName: string,
    strictMode: { maxResidentMemoryPercent?: number; searchMaxBatchsize?: number },
  ) => Promise<void>;
}

/**
 * Optimizer lifecycle for bulk reindex windows — the concern the ingest side of
 * the facade isolates from collection CRUD. NOT named `OptimizerLifecycle`:
 * that name already means the ingest wrapper around pause/resume.
 */
export interface QdrantOptimizerControl {
  /** Re-send the live optimizer config unchanged — Qdrant 1.18 recreates the optimizer, clearing its error. */
  reapplyOptimizerConfig: (collectionName: string) => Promise<void>;
  /** Pause HNSW indexing and segment vacuum for the duration of a bulk reindex. */
  pauseOptimizer: (collectionName: string) => Promise<void>;
  /** Restore optimizer thresholds, which also triggers the single post-index pass. */
  resumeOptimizer: (
    collectionName: string,
    options?: { indexingThreshold?: number; deletedThreshold?: number },
  ) => Promise<void>;
}

/** Payload FIELD indexes (not point payloads — those are `QdrantPointWriter`'s). */
export interface QdrantPayloadIndexAdmin {
  createPayloadIndex: (
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ) => Promise<void>;
  hasPayloadIndex: (collectionName: string, fieldName: string) => Promise<boolean>;
  /** Idempotent create — true when the index was missing and got created. */
  ensurePayloadIndex: (
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ) => Promise<boolean>;
  /** Every payload field index on the collection; a read failure propagates. */
  listPayloadIndexes: (collectionName: string) => Promise<PayloadFieldIndex[]>;
  deletePayloadIndex: (collectionName: string, fieldName: string) => Promise<void>;
}

/** Read side of the point store + the whole scroller: points and unranked traversal. */
export interface QdrantPointReader {
  countPoints: (collectionName: string, filter?: Record<string, unknown>) => Promise<number>;
  /** One point, or `null` for absent OR unreadable — only a lost connection throws. */
  getPoint: (
    collectionName: string,
    id: string | number,
  ) => Promise<{ id: string | number; payload?: Record<string, unknown> } | null>;
  /** {@link QdrantPointReader.getPoint} where `null` means only "absent": every failed read throws an `InfraError`. */
  getPointOrThrow: (
    collectionName: string,
    id: string | number,
  ) => Promise<{ id: string | number; payload?: Record<string, unknown> } | null>;
  retrieveDenseVectors: (
    collectionName: string,
    ids: readonly (string | number)[],
    payloadInclude: string[],
  ) => Promise<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }[]>;
  /**
   * Whether path-membership filters on this collection may match the
   * keyword-indexed `relativePathExact` — the read-shaping gate every filtered
   * path reader asks before building its filter (bd tea-rags-mcp-ejio7).
   */
  servesRelativePathExact: (collectionName: string) => Promise<boolean>;
  /** Scroll every point with payload AND vectors, yielding batches. */
  scrollWithVectors: (
    collectionName: string,
    batchSize?: number,
  ) => AsyncGenerator<{ id: string | number; payload: Record<string, unknown>; vector: unknown }[]>;
  /** Scroll every point (or every point `filter` admits) with the named payload keys only, no vectors, yielding pages. */
  scrollPayloadPages: (
    collectionName: string,
    payloadInclude: string[],
    batchSize?: number,
    filter?: Record<string, unknown>,
  ) => AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]>;
  /** Distinct values of one payload field across the collection. */
  scrollFieldValues: (collectionName: string, fieldName: string) => Promise<string[]>;
  /** Scroll ordered by a payload field (Qdrant 1.8+; index the field). */
  scrollOrdered: (
    collectionName: string,
    orderBy: { key: string; direction: "asc" | "desc" },
    limit: number,
    filter?: Record<string, unknown>,
  ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
  /** Paginated filtered scroll, hard-capped at `limit`, optionally payload-narrowed. */
  scrollFiltered: (
    collectionName: string,
    filter: Record<string, unknown>,
    limit: number,
    pageSize?: number,
    payloadInclude?: string[],
  ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
  /** Hydrate an exact set of symbolIds in one scroll — backs trace_path. */
  scrollBySymbolIds: (
    collectionName: string,
    symbolIds: string[],
    limit?: number,
  ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
}

/** Write side of the point store: upserts, deletes, payload writes and the barriers that confirm them. */
export interface QdrantPointWriter {
  addPoints: (
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      payload?: Record<string, unknown>;
    }[],
  ) => Promise<void>;
  /** Bulk variant of {@link QdrantPointWriter.addPoints}: `wait: false` + weak ordering by default. */
  addPointsOptimized: (
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      payload?: Record<string, unknown>;
    }[],
    options?: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    },
  ) => Promise<void>;
  /** Adds points with both dense and sparse vectors for hybrid search. */
  addPointsWithSparse: (
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      sparseVector: SparseVector;
      payload?: Record<string, unknown>;
    }[],
  ) => Promise<void>;
  /** Bulk variant of {@link QdrantPointWriter.addPointsWithSparse}: `wait: false` + weak ordering by default. */
  addPointsWithSparseOptimized: (
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      sparseVector: SparseVector;
      payload?: Record<string, unknown>;
    }[],
    options?: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    },
  ) => Promise<void>;
  deletePoints: (collectionName: string, ids: (string | number)[]) => Promise<void>;
  deletePointsByFilter: (collectionName: string, filter: Record<string, unknown>) => Promise<void>;
  /** Delete every point of N paths in grouped membership filters. */
  deletePointsByPaths: (collectionName: string, relativePaths: string[]) => Promise<void>;
  /** Phase-separated delete: one read pass to collect IDs, then parallel ID deletes. */
  deletePointsByPathsBatched: (
    collectionName: string,
    relativePaths: string[],
    options: {
      batchSize: number;
      concurrency: number;
      onProgress?: (deleted: number, total: number) => void;
    },
  ) => Promise<{ deletedPaths: number; batchCount: number; durationMs: number }>;
  /** Update payload fields on existing points WITHOUT re-uploading vectors. */
  setPayload: (
    collectionName: string,
    payload: Record<string, unknown>,
    options: {
      points?: (string | number)[];
      filter?: Record<string, unknown>;
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    },
  ) => Promise<QdrantUpdateStatus>;
  /** Fold multiple setPayload operations into batched `batchUpdate` requests. */
  batchSetPayload: (
    collectionName: string,
    operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key?: string;
    }[],
    options?: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    },
  ) => Promise<QdrantUpdateStatus>;
  /** Remove payload keys from explicit points — one `delete_payload` operation per key set. */
  batchDeletePayload: (
    collectionName: string,
    operations: { keys: string[]; points: (string | number)[] }[],
    options?: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    },
  ) => Promise<void>;
  /** Delete payload keys from all points (or filtered subset). */
  deletePayloadKeys: (collectionName: string, keys: string[], filter?: Record<string, unknown>) => Promise<void>;
  /**
   * Resolve once every update queued on the collection before this call is
   * visible to reads — or once Qdrant's own wait ran out (bd tea-rags-mcp-yf4je).
   */
  awaitQueuedUpdates: (collectionName: string) => Promise<QdrantUpdateStatus>;
  /**
   * Wait for every queued update to apply, repeating `wait_timeout` rounds
   * under the manager's write-barrier budget (bd tea-rags-mcp-wjyaf).
   */
  awaitWriteBarrier: (collectionName: string) => Promise<PayloadWriteBarrierOutcome>;
}

/** Ranked retrieval only (dense, recommend, groups, RRF) — everything else is a scroll. */
export interface QdrantSearchReader {
  search: (
    collectionName: string,
    vector: number[],
    limit?: number,
    filter?: Record<string, unknown>,
  ) => Promise<SearchResult[]>;
  /** Universal query() with a recommend sub-query — backs find_similar. */
  query: (
    collectionName: string,
    options: {
      positive: (string | number | number[])[];
      negative?: (string | number | number[])[];
      strategy?: "best_score" | "average_vector" | "sum_scores";
      limit: number;
      offset?: number;
      filter?: Record<string, unknown>;
    },
  ) => Promise<{ id: string | number; score: number; payload?: Record<string, unknown> }[]>;
  /** Server-side grouping by a payload field (file-level dedup). */
  queryGroups: (
    collectionName: string,
    vector: number[],
    options: {
      groupBy: string;
      groupSize?: number;
      limit: number;
      filter?: Record<string, unknown>;
    },
  ) => Promise<SearchResult[]>;
  /**
   * Dense + sparse retrieval fused server-side by RRF, optionally weighted;
   * no dense vector → the sparse prefetch alone (the provider could not embed).
   */
  hybridSearch: (
    collectionName: string,
    denseVector: number[] | undefined,
    sparseVector: SparseVector,
    fetchLimit: number,
    filter?: Record<string, unknown>,
    semanticWeight?: number,
    identityPrefetchFilter?: Record<string, unknown>,
  ) => Promise<SearchResult[]>;
}

/** Snapshot lifecycle: create / locate / recover / delete, as the facade delegates to `QdrantSnapshotStore`. */
export interface QdrantSnapshotSource {
  createSnapshot: (name: string) => Promise<string>;
  snapshotDownloadUrl: (collection: string, snapshotName: string) => string;
  recoverFromSnapshot: (targetCollection: string, location: string) => Promise<void>;
  deleteSnapshot: (collection: string, snapshotName: string) => Promise<void>;
}

/** Is the server alive and which version is it — the connection concern, nothing about collections. */
export interface QdrantHealthProbe {
  /** Lightweight health check — returns true if Qdrant is reachable. */
  checkHealth: () => Promise<boolean>;
  /** Reported version of the running server, or `undefined` on ANY failure. */
  getServerVersion: () => Promise<string | undefined>;
}

/**
 * Collection aliases: create / repoint / delete, membership, and resolving a
 * name to the collection it serves — what `QdrantAliasManager` implements
 * (bd tea-rags-mcp-89k7k.39). Every failure surfaces as `AliasOperationError`.
 */
export interface QdrantAliasAdmin {
  createAlias: (alias: string, collection: string) => Promise<void>;
  /** Repoint `alias` from `fromCollection` to `toCollection` in one atomic alias update. */
  switchAlias: (alias: string, fromCollection: string, toCollection: string) => Promise<void>;
  deleteAlias: (alias: string) => Promise<void>;
  isAlias: (name: string) => Promise<boolean>;
  listAliases: () => Promise<CollectionAliasEntry[]>;
  /** The ACTIVE collection behind `name`: its target when `name` is an alias, else `name` itself. */
  resolveActive: (name: string) => Promise<PhysicalCollectionName>;
}

/**
 * The facade's `aliases` accessor — how a `QdrantManager` holder reaches the
 * alias role without binding the concrete facade or its alias collaborator.
 */
export interface QdrantAliasAccess {
  readonly aliases: QdrantAliasAdmin;
}

/** Options for {@link EmbeddingModelGuardPort.ensureMatch} — the port owns its parameter type. */
export interface EmbeddingModelGuardCallOptions extends EmbeddingCallOptions {
  /**
   * The caller embeds right after this check (indexing, adding documents, a
   * query-embedding search). A provider that is DOWN — it gave up after
   * spending its recovery wait on the canary — is then thrown here instead of
   * swallowed, so the caller fails once instead of paying that wait a second
   * time on its own embed. So is one the canary found unreachable within a
   * budget no shorter than the caller's own `maxRecoveryWaitMs`: the caller's
   * embed would fail the same way. Callers that read the index without
   * embedding leave it off: an outage does not concern them.
   */
  failOnProviderOutage?: boolean;
  /**
   * The caller compares no freshly embedded vector against the index
   * (`rank_chunks`, `find_symbol`): weight drift cannot corrupt its answer, so
   * only the model NAME is checked — from a cached verdict, else from the
   * marker. Nothing is embedded, created or cached; the canary waits for the
   * first caller that embeds. Embedding it here made every cold call of such a
   * tool wait out the provider's endpoint failover (bd tea-rags-mcp-xi2r9, B3).
   */
  nameOnly?: boolean;
}

/**
 * Port of `EmbeddingModelGuard`: one check per collection that the embedding
 * model building the index is the one about to query it (single implementer,
 * whole class). Its creation/invalidation halves are entry points with
 * exactly the callers named in adapters/qdrant/CLAUDE.md — read that before
 * adding a member here.
 */
export interface EmbeddingModelGuardPort {
  /**
   * Ensure the current embedding model matches the one that built the
   * collection — by name, and (when an embedding provider is wired) by canary
   * vector. Throws EmbeddingModelMismatchError on either mismatch. Backfills
   * the model name and the canary when missing (legacy collections).
   */
  ensureMatch: (collectionName: string, options?: EmbeddingModelGuardCallOptions) => Promise<void>;
  /**
   * Record model for a newly created collection (cache only — marker written
   * by storeIndexingMarker).
   */
  recordModel: (collectionName: string) => void;
  /** Invalidate cache entry (force reindex, clear index) — drops the in-flight check with it. */
  invalidate: (collectionName: string) => void;
  /** Drop every cached verdict and every check still running — the provider failover hook. */
  invalidateAll: () => void;
}
