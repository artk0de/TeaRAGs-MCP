/**
 * Shared mock for @qdrant/js-client-rest
 *
 * Mocks the low-level HTTP client, allowing tests to use the real QdrantManager.
 * This eliminates the need to duplicate QdrantManager methods in test mocks.
 */

import { vi } from "vitest";

export interface MockCollectionData {
  vectorSize: number;
  distance: string;
  hybridEnabled: boolean;
}

export interface MockPointData {
  id: string | number;
  vector: number[] | Record<string, any>;
  payload?: Record<string, any>;
}

/**
 * In-memory storage for mock Qdrant data
 */
export class MockQdrantStorage {
  collections = new Map<string, MockCollectionData>();
  points = new Map<string, MockPointData[]>();

  clear(): void {
    this.collections.clear();
    this.points.clear();
  }

  getPoints(collectionName: string): MockPointData[] {
    return this.points.get(collectionName) || [];
  }

  hasCollection(name: string): boolean {
    return this.collections.has(name);
  }
}

/**
 * Creates a mock QdrantClient class that stores data in memory
 */
export function createMockQdrantClient(storage: MockQdrantStorage) {
  return vi.fn().mockImplementation(() => ({
    getCollections: vi.fn().mockImplementation(async () => ({
      collections: Array.from(storage.collections.keys()).map((name) => ({ name })),
    })),

    getCollection: vi.fn().mockImplementation(async (name: string) => {
      const collection = storage.collections.get(name);
      if (!collection) {
        throw { status: 404, data: { status: { error: "Collection not found" } } };
      }
      const points = storage.points.get(name) || [];
      return {
        points_count: points.length,
        config: {
          params: {
            vectors: collection.hybridEnabled
              ? { dense: { size: collection.vectorSize, distance: collection.distance } }
              : { size: collection.vectorSize, distance: collection.distance },
            sparse_vectors: collection.hybridEnabled ? { text: {} } : undefined,
          },
        },
      };
    }),

    createCollection: vi.fn().mockImplementation(async (name: string, config: any) => {
      const vectorConfig = config.vectors;
      let vectorSize = 0;
      let distance = "Cosine";
      let hybridEnabled = false;

      if (vectorConfig?.dense) {
        vectorSize = vectorConfig.dense.size;
        distance = vectorConfig.dense.distance;
        hybridEnabled = true;
      } else if (vectorConfig?.size) {
        vectorSize = vectorConfig.size;
        distance = vectorConfig.distance;
      }

      storage.collections.set(name, { vectorSize, distance, hybridEnabled });
      storage.points.set(name, []);
      return {};
    }),

    deleteCollection: vi.fn().mockImplementation(async (name: string) => {
      storage.collections.delete(name);
      storage.points.delete(name);
      return {};
    }),

    upsert: vi.fn().mockImplementation(async (collectionName: string, { points }: { points: MockPointData[] }) => {
      const existing = storage.points.get(collectionName) || [];
      const newIds = new Set(points.map((p) => p.id));
      const filtered = existing.filter((p) => !newIds.has(p.id));
      storage.points.set(collectionName, [...filtered, ...points]);
      return {};
    }),

    delete: vi.fn().mockImplementation(async (collectionName: string, { points, filter }: any) => {
      const existing = storage.points.get(collectionName) || [];

      if (points) {
        // Delete by IDs
        const idsToDelete = new Set(points);
        storage.points.set(
          collectionName,
          existing.filter((p) => !idsToDelete.has(p.id)),
        );
      } else if (filter) {
        // Delete by filter
        let filtered = existing;

        // Handle "should" filter (OR condition for multiple paths)
        if (filter.should) {
          const pathsToDelete = new Set(
            filter.should
              .filter((c: any) => c.key === "relativePath")
              .map((c: any) => c.match?.value),
          );
          filtered = existing.filter((p) => !pathsToDelete.has(p.payload?.relativePath));
        }

        // Handle "must" filter
        if (filter.must) {
          for (const condition of filter.must) {
            if (condition.key === "relativePath") {
              filtered = filtered.filter(
                (p) => p.payload?.relativePath !== condition.match?.value,
              );
            }
          }
        }

        storage.points.set(collectionName, filtered);
      }

      return {};
    }),

    search: vi.fn().mockImplementation(async (collectionName: string, { limit, filter }: any) => {
      let points = storage.points.get(collectionName) || [];

      // Apply filter
      if (filter?.must) {
        for (const condition of filter.must) {
          if (condition.key && condition.match?.any) {
            points = points.filter((p) =>
              condition.match.any.includes(p.payload?.[condition.key]),
            );
          } else if (condition.key && condition.match?.value) {
            points = points.filter(
              (p) => p.payload?.[condition.key] === condition.match.value,
            );
          }
        }
      }

      return points.slice(0, limit || 5).map((p, idx) => ({
        id: p.id,
        score: 0.95 - idx * 0.05,
        payload: p.payload,
      }));
    }),

    query: vi.fn().mockImplementation(async (collectionName: string, { limit }: any) => {
      const points = storage.points.get(collectionName) || [];
      return {
        points: points.slice(0, limit || 5).map((p, idx) => ({
          id: p.id,
          score: 0.95 - idx * 0.05,
          payload: p.payload,
        })),
      };
    }),

    retrieve: vi.fn().mockImplementation(async (collectionName: string, { ids }: { ids: (string | number)[] }) => {
      const points = storage.points.get(collectionName) || [];
      return points.filter((p) => ids.includes(p.id));
    }),

    updateCollection: vi.fn().mockResolvedValue({}),
  }));
}

/**
 * Setup mock for @qdrant/js-client-rest module
 * Call this in vi.mock() at the top of test file
 */
export function setupQdrantClientMock(storage: MockQdrantStorage) {
  return {
    QdrantClient: createMockQdrantClient(storage),
  };
}
