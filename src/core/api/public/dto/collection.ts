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
