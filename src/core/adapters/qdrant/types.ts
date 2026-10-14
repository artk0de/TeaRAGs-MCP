/**
 * Qdrant wire primitives.
 *
 * These are infrastructure-level types describing the shape of
 * Qdrant filter conditions and vectors. Domain code (trajectory, search, etc.)
 * imports from here rather than defining its own duplicates.
 */

/**
 * What Qdrant says about an update it accepted (`UpdateResult.status`).
 *
 * `completed` — applied and visible to reads. `acknowledged` — accepted into
 * the WAL, not yet applied (the answer to `wait: false`). `wait_timeout` — a
 * `wait: true` update whose server-side wait ran out before the update was
 * applied: Qdrant 1.18 returns it as a SUCCESSFUL response after its default
 * ~60 s, so only this status tells the caller the queue is still undrained
 * (bd tea-rags-mcp-yf4je).
 */
export type QdrantUpdateStatus = "completed" | "acknowledged" | "wait_timeout";

/**
 * A Qdrant sparse vector: parallel index/value arrays. Produced by the BM25
 * generator in `sparse.ts`, written by `QdrantPointStore`, queried by
 * `QdrantSearchExecutor` — declared here because it is shared by all three and
 * owned by none of them.
 */
export interface SparseVector {
  indices: number[];
  values: number[];
}

export interface QdrantMatchCondition {
  key: string;
  match: { value: unknown } | { any: unknown[] } | { text: string };
}

export interface QdrantRangeCondition {
  key: string;
  range: { gt?: number; gte?: number; lt?: number; lte?: number };
}

export interface QdrantIsEmptyCondition {
  is_empty: { key: string };
}

/**
 * Nested filter condition — Qdrant supports recursive filter composition
 * (e.g. `must: [{ should: [a, b] }]` means "AND with (a OR b)").
 * Using a nested filter wherever a leaf condition is accepted lets a
 * single FilterDescriptor express "match X OR match Y" without forcing
 * `should` into `FilterConditionResult` (which would lose AND-semantics
 * across multiple registered filters).
 */
export type QdrantFilterCondition = QdrantMatchCondition | QdrantRangeCondition | QdrantIsEmptyCondition | QdrantFilter;

export interface QdrantFilter {
  must?: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

/*
 * Result shapes the Qdrant collaborators return and the role ports in
 * ports.ts name. They live here, not beside their collaborator, so ports.ts
 * depends on no collaborator module: a port importing a collaborator file
 * reached connection.ts -> aliases.ts, and the alias collaborator implementing
 * its port closed that into a cycle. The collaborators re-export them.
 */

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
  /** Qdrant collection health status. `yellow` indicates background optimization. */
  status: "green" | "yellow" | "red";
  /**
   * Optimizer state from Qdrant: `"ok"`, `"error: <message>"` when the
   * optimizer failed (Qdrant's `{ error }` arm), or `"unknown"` when absent.
   */
  optimizerStatus: string;
  /**
   * Vector quantization mode derived from `config.quantization_config`:
   * `turbo` (TurboQuant 8x), `scalar` (int8), or `none` (unquantized or an
   * unrecognized quantization variant).
   */
  quantization: "turbo" | "scalar" | "none";
  /**
   * Application JSON stored on the collection itself (`config.metadata`,
   * written at creation). Absent when the collection carries none.
   */
  metadata?: Record<string, unknown>;
  /**
   * Operations Qdrant has accepted but not yet applied (`update_queue.length`,
   * Qdrant >= 1.18). Absent when the server does not report a queue — an older
   * server, or a build that omits it — which is not the same as an empty one.
   */
  updateQueueLength?: number;
}

/**
 * One cell of Qdrant's per-collection memory report, in bytes — the four ways
 * the server accounts a part of a collection.
 */
export interface QdrantMemoryUsage {
  /**
   * Sum of the part's FILE SIZES (`disk_bytes`) — apparent size. Qdrant
   * preallocates its mmap files sparsely, so this counts space never written and
   * runs well above the blocks the filesystem actually allocated.
   */
  diskBytes: number;
  /** Non-evictable heap memory (`ram_bytes`). */
  ramBytes: number;
  /** Evictable mmap pages currently resident in the OS page cache (`cached_bytes`). */
  cachedBytes: number;
  /** Bytes Qdrant wants resident in page cache for full-speed search (`expected_cache_bytes`). */
  expectedCacheBytes: number;
}

/** Qdrant's `GET /collections/{name}/memory` report, camel-cased; named parts keep their names. */
export interface QdrantCollectionMemoryUsage {
  total: QdrantMemoryUsage;
  /** Dense vectors, one entry per named vector (`""` = the unnamed default vector). */
  vectors: { name: string; storage: QdrantMemoryUsage; index: QdrantMemoryUsage; quantized?: QdrantMemoryUsage }[];
  sparseVectors: { name: string; storage: QdrantMemoryUsage; index: QdrantMemoryUsage }[];
  payload: QdrantMemoryUsage;
  /** One entry per payload FIELD index, in server order. */
  payloadIndexes: { name: string; usage: QdrantMemoryUsage }[];
  /** Remaining structures the server accounts separately (e.g. `id_tracker`). */
  other: { name: string; usage: QdrantMemoryUsage }[];
}

/** One scored point a Qdrant search returns. */
export interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

/**
 * One payload field index as Qdrant reports it in a collection's
 * `payload_schema`. `points` counts the points whose payload carries a value
 * under the key — zero for an index nothing writes into, which is NOT the same
 * as an index nothing needs (`git.file.skippedAs` is legitimately empty).
 */
export interface PayloadFieldIndex {
  field: string;
  dataType: string;
  points: number;
}
