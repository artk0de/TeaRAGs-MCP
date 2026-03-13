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
}
