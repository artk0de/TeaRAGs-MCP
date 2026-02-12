/**
 * Shared test utilities for CodeIndexer module tests.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodeConfig } from "../../../src/code/types.js";
import type { EmbeddingProvider } from "../../../src/embeddings/base.js";
import type { QdrantManager } from "../../../src/qdrant/client.js";

/** Mock QdrantManager — mirrors all public methods */
export class MockQdrantManager implements Partial<QdrantManager> {
  private collections = new Map<string, any>();
  private points = new Map<string, any[]>();
  private payloadIndexes = new Map<string, Set<string>>();

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name);
  }

  async hasPayloadIndex(collectionName: string, fieldName: string): Promise<boolean> {
    const indexes = this.payloadIndexes.get(collectionName);
    return indexes?.has(fieldName) ?? false;
  }

  async createPayloadIndex(
    collectionName: string,
    fieldName: string,
    _fieldSchema: string,
  ): Promise<void> {
    if (!this.payloadIndexes.has(collectionName)) {
      this.payloadIndexes.set(collectionName, new Set());
    }
    this.payloadIndexes.get(collectionName)!.add(fieldName);
  }

  async ensurePayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: string,
  ): Promise<boolean> {
    const exists = await this.hasPayloadIndex(collectionName, fieldName);
    if (!exists) {
      await this.createPayloadIndex(collectionName, fieldName, fieldSchema);
      return true;
    }
    return false;
  }

  async listCollections(): Promise<string[]> {
    return Array.from(this.collections.keys());
  }

  async createCollection(
    name: string,
    vectorSize: number,
    distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
    enableHybrid?: boolean,
  ): Promise<void> {
    this.collections.set(name, {
      vectorSize,
      distance,
      hybridEnabled: enableHybrid || false,
    });
    this.points.set(name, []);
  }

  async deleteCollection(name: string): Promise<void> {
    this.collections.delete(name);
    this.points.delete(name);
  }

  async getCollectionInfo(name: string): Promise<any> {
    const collection = this.collections.get(name);
    const points = this.points.get(name) || [];
    return {
      name,
      pointsCount: points.length,
      hybridEnabled: collection?.hybridEnabled || false,
      vectorSize: collection?.vectorSize || 384,
      distance: collection?.distance || "Cosine",
    };
  }

  async addPoints(collectionName: string, points: any[]): Promise<void> {
    if (points.length === 0) return;
    const existing = this.points.get(collectionName) || [];
    const newIds = new Set(points.map((p) => p.id));
    const filtered = existing.filter((p) => !newIds.has(p.id));
    this.points.set(collectionName, [...filtered, ...points]);
  }

  async addPointsOptimized(
    collectionName: string,
    points: any[],
    _options?: { wait?: boolean; ordering?: string },
  ): Promise<void> {
    await this.addPoints(collectionName, points);
  }

  async addPointsWithSparse(collectionName: string, points: any[]): Promise<void> {
    await this.addPoints(collectionName, points);
  }

  async addPointsWithSparseOptimized(
    collectionName: string,
    points: any[],
    _options?: { wait?: boolean; ordering?: string },
  ): Promise<void> {
    await this.addPoints(collectionName, points);
  }

  async search(
    collectionName: string,
    _vector: number[],
    limit: number,
    filter?: any,
  ): Promise<any[]> {
    let points = this.points.get(collectionName) || [];

    if (filter?.must) {
      for (const condition of filter.must) {
        if (condition.key && condition.match?.any) {
          points = points.filter((p) =>
            condition.match.any.includes(p.payload?.[condition.key]),
          );
        }
      }
    }

    return points.slice(0, limit).map((p, idx) => ({
      id: p.id,
      score: 0.95 - idx * 0.05,
      payload: p.payload,
    }));
  }

  async hybridSearch(
    collectionName: string,
    vector: number[],
    _sparseVector: any,
    limit: number,
    filter?: any,
  ): Promise<any[]> {
    return this.search(collectionName, vector, limit, filter);
  }

  async getPoint(
    collectionName: string,
    id: string | number,
  ): Promise<{ id: string | number; payload?: Record<string, any> } | null> {
    const points = this.points.get(collectionName) || [];
    const point = points.find((p) => p.id === id);
    return point ? { id: point.id, payload: point.payload } : null;
  }

  async deletePoints(collectionName: string, ids: (string | number)[]): Promise<void> {
    const points = this.points.get(collectionName) || [];
    const idsSet = new Set(ids);
    this.points.set(collectionName, points.filter((p) => !idsSet.has(p.id)));
  }

  async deletePointsByFilter(collectionName: string, filter: Record<string, any>): Promise<void> {
    const points = this.points.get(collectionName) || [];
    const pathToDelete = filter?.must?.[0]?.match?.value;
    if (pathToDelete) {
      this.points.set(
        collectionName,
        points.filter((p) => p.payload?.relativePath !== pathToDelete),
      );
    }
  }

  async deletePointsByPaths(collectionName: string, relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const points = this.points.get(collectionName) || [];
    const pathsSet = new Set(relativePaths);
    this.points.set(
      collectionName,
      points.filter((p) => !pathsSet.has(p.payload?.relativePath)),
    );
  }

  async deletePointsByPathsBatched(
    collectionName: string,
    relativePaths: string[],
    _options?: { batchSize?: number; concurrency?: number },
    _progressCallback?: (progress: { processed: number; total: number; batchNumber: number }) => void,
  ): Promise<{ deletedCount: number; batchesProcessed: number }> {
    await this.deletePointsByPaths(collectionName, relativePaths);
    return { deletedCount: relativePaths.length, batchesProcessed: 1 };
  }

  batchSetPayloadCalls: Array<{ collectionName: string; operations: any[] }> = [];

  async setPayload(
    collectionName: string,
    payload: Record<string, any>,
    options: any,
  ): Promise<void> {
    const points = this.points.get(collectionName);
    if (!points || !options?.points) return;
    for (const id of options.points) {
      const point = points.find((p) => p.id === id);
      if (point) {
        point.payload = { ...point.payload, ...payload };
      }
    }
  }

  async batchSetPayload(
    collectionName: string,
    operations: Array<{ payload: Record<string, any>; points: (string | number)[] }>,
    _options?: any,
  ): Promise<void> {
    this.batchSetPayloadCalls.push({ collectionName, operations });
  }

  async disableIndexing(_collectionName: string): Promise<void> {}

  async enableIndexing(_collectionName: string, _threshold?: number): Promise<void> {}
}

/** Mock EmbeddingProvider — returns fixed 384-dim vectors */
export class MockEmbeddingProvider implements EmbeddingProvider {
  getDimensions(): number {
    return 384;
  }

  getModel(): string {
    return "mock-model";
  }

  async embed(
    _text: string,
  ): Promise<{ embedding: number[]; dimensions: number }> {
    return { embedding: new Array(384).fill(0.1), dimensions: 384 };
  }

  async embedBatch(
    texts: string[],
  ): Promise<Array<{ embedding: number[]; dimensions: number }>> {
    return texts.map(() => ({
      embedding: new Array(384).fill(0.1),
      dimensions: 384,
    }));
  }
}

/** Helper to create test files in a temp directory */
export async function createTestFile(
  baseDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(baseDir, relativePath);
  const dir = join(fullPath, "..");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

/** Default test config */
export function defaultTestConfig(): CodeConfig {
  return {
    chunkSize: 500,
    chunkOverlap: 50,
    enableASTChunking: true,
    supportedExtensions: [".ts", ".js", ".py"],
    ignorePatterns: ["node_modules/**", "dist/**"],
    batchSize: 10,
    defaultSearchLimit: 5,
    enableHybridSearch: false,
  };
}

/** Create a temp directory for tests and return paths */
export async function createTempTestDir(): Promise<{ tempDir: string; codebaseDir: string }> {
  const tempDir = join(
    tmpdir(),
    `qdrant-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
  );
  const codebaseDir = join(tempDir, "codebase");
  await fs.mkdir(codebaseDir, { recursive: true });
  return { tempDir, codebaseDir };
}

/** Clean up temp directory */
export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (_error) {
    // Ignore cleanup errors
  }
}
