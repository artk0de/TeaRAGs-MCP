/**
 * Collection domain DTOs — collection CRUD types.
 */

export interface CreateCollectionRequest {
  name: string;
  distance?: "Cosine" | "Euclid" | "Dot";
  enableHybrid?: boolean;
}

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
  /** Qdrant collection health status. `yellow` indicates background optimization. */
  status: "green" | "yellow" | "red";
  /** Optimizer state string from Qdrant (`"ok"` or `"unknown"` when absent). */
  optimizerStatus: string;
}

/** Bytes the Qdrant server attributes to one part of a collection. */
export interface CollectionMemoryBytes {
  /**
   * Sum of the part's FILE SIZES — apparent size. Qdrant preallocates its mmap
   * files sparsely, so this counts space never written and runs well above the
   * blocks the filesystem allocated. The allocated figure is
   * `IndexStatus.infraHealth.qdrant.indexSizeBytes` (embedded Qdrant only); the
   * two are different measures and must not be shown under one label.
   */
  apparentDiskBytes: number;
  /** Non-evictable heap memory. */
  ramBytes: number;
  /** Evictable mmap pages currently resident in the OS page cache. */
  cachedBytes: number;
  /** Page-cache bytes the server wants resident for full-speed search. */
  expectedCacheBytes: number;
}

/**
 * A collection's memory and storage as the Qdrant server accounts them
 * (`GET /collections/{name}/memory`, Qdrant 1.18+). Returned by
 * `App.getCollectionMemory`; null there when the server cannot report it.
 */
export interface CollectionMemoryMetrics {
  /** The collection (or alias) the report was requested for. */
  collection: string;
  total: CollectionMemoryBytes;
  /** Dense vectors, one row per named vector (`""` = the unnamed default vector). */
  vectors: {
    name: string;
    storage: CollectionMemoryBytes;
    index: CollectionMemoryBytes;
    /** Absent when the vector is not quantized. */
    quantized?: CollectionMemoryBytes;
  }[];
  sparseVectors: { name: string; storage: CollectionMemoryBytes; index: CollectionMemoryBytes }[];
  payload: CollectionMemoryBytes;
  /** Every payload field index summed, plus each one, largest apparent size first. */
  payloadIndexes: {
    count: number;
    total: CollectionMemoryBytes;
    byField: { field: string; bytes: CollectionMemoryBytes }[];
  };
  /** The server's remaining structures (id tracker, …) summed. */
  other: CollectionMemoryBytes;
}
