/**
 * Shared test utilities for IngestFacade/ExploreFacade module tests.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "../../../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { ExploreCodeConfig, IngestCodeConfig, TrajectoryIngestConfig } from "../../../../../src/core/types.js";

/** Mock alias manager for QdrantManager */
class MockAliasManager {
  private aliasMap = new Map<string, string>(); // aliasName -> collectionName

  async createAlias(alias: string, collection: string): Promise<void> {
    this.aliasMap.set(alias, collection);
  }

  async switchAlias(alias: string, _fromCollection: string, toCollection: string): Promise<void> {
    this.aliasMap.set(alias, toCollection);
  }

  async deleteAlias(alias: string): Promise<void> {
    this.aliasMap.delete(alias);
  }

  async isAlias(name: string): Promise<boolean> {
    return this.aliasMap.has(name);
  }

  async listAliases(): Promise<{ aliasName: string; collectionName: string }[]> {
    return Array.from(this.aliasMap.entries()).map(([aliasName, collectionName]) => ({
      aliasName,
      collectionName,
    }));
  }

  /** Resolve alias to real collection name (sync for internal use) */
  resolve(name: string): string {
    return this.aliasMap.get(name) ?? name;
  }
}

/** Mock QdrantManager — mirrors all public methods with alias resolution */
export class MockQdrantManager implements Partial<QdrantManager> {
  private collections = new Map<string, any>();
  private points = new Map<string, any[]>();
  private payloadIndexes = new Map<string, Set<string>>();
  readonly aliases = new MockAliasManager();

  /** Resolve alias to real collection name (like real Qdrant does transparently) */
  private resolve(name: string): string {
    return this.aliases.resolve(name);
  }

  async collectionExists(name: string): Promise<boolean> {
    // Real Qdrant returns true for both collections and aliases
    if (this.collections.has(name)) return true;
    return this.aliases.isAlias(name);
  }

  async hasPayloadIndex(collectionName: string, fieldName: string): Promise<boolean> {
    const resolved = this.resolve(collectionName);
    const indexes = this.payloadIndexes.get(resolved);
    return indexes?.has(fieldName) ?? false;
  }

  async createPayloadIndex(collectionName: string, fieldName: string, _fieldSchema: string): Promise<void> {
    const resolved = this.resolve(collectionName);
    if (!this.payloadIndexes.has(resolved)) {
      this.payloadIndexes.set(resolved, new Set());
    }
    this.payloadIndexes.get(resolved)!.add(fieldName);
  }

  async ensurePayloadIndex(collectionName: string, fieldName: string, fieldSchema: string): Promise<boolean> {
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
    _quantizationScalar?: boolean,
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
    const resolved = this.resolve(name);
    const collection = this.collections.get(resolved);
    const points = this.points.get(resolved) || [];
    return {
      name: resolved,
      pointsCount: points.length,
      hybridEnabled: collection?.hybridEnabled || false,
      vectorSize: collection?.vectorSize || 384,
      distance: collection?.distance || "Cosine",
      status: "green" as const,
      optimizerStatus: "ok",
    };
  }

  async addPoints(collectionName: string, points: any[]): Promise<void> {
    if (points.length === 0) return;
    const resolved = this.resolve(collectionName);
    const existing = this.points.get(resolved) || [];
    const newIds = new Set(points.map((p) => p.id));
    const filtered = existing.filter((p) => !newIds.has(p.id));
    this.points.set(resolved, [...filtered, ...points]);
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

  async search(collectionName: string, _vector: number[], limit: number, filter?: any): Promise<any[]> {
    const resolved = this.resolve(collectionName);
    let points = this.points.get(resolved) || [];

    if (filter?.must) {
      for (const condition of filter.must) {
        if (condition.key && condition.match?.any) {
          points = points.filter((p) => condition.match.any.includes(p.payload?.[condition.key]));
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
    const resolved = this.resolve(collectionName);
    const points = this.points.get(resolved) || [];
    const point = points.find((p) => p.id === id);
    return point ? { id: point.id, payload: point.payload } : null;
  }

  async deletePoints(collectionName: string, ids: (string | number)[]): Promise<void> {
    const resolved = this.resolve(collectionName);
    const points = this.points.get(resolved) || [];
    const idsSet = new Set(ids);
    this.points.set(
      resolved,
      points.filter((p) => !idsSet.has(p.id)),
    );
  }

  async countPoints(collectionName: string, filter?: Record<string, unknown>): Promise<number> {
    const resolved = this.resolve(collectionName);
    const points = this.points.get(resolved) || [];
    if (!filter) return points.length;
    const shouldConditions = (filter as any)?.should;
    if (shouldConditions) {
      const paths = new Set(shouldConditions.map((c: any) => c.match?.value));
      return points.filter((p) => paths.has(p.payload?.relativePath)).length;
    }
    return points.length;
  }

  async deletePointsByFilter(collectionName: string, filter: Record<string, any>): Promise<void> {
    const resolved = this.resolve(collectionName);
    const points = this.points.get(resolved) || [];
    const pathToDelete = filter?.must?.[0]?.match?.value;
    if (pathToDelete) {
      this.points.set(
        resolved,
        points.filter((p) => p.payload?.relativePath !== pathToDelete),
      );
    }
  }

  async deletePointsByPaths(collectionName: string, relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const resolved = this.resolve(collectionName);
    const points = this.points.get(resolved) || [];
    const pathsSet = new Set(relativePaths);
    this.points.set(
      resolved,
      points.filter((p) => !pathsSet.has(p.payload?.relativePath)),
    );
  }

  async deletePointsByPathsBatched(
    collectionName: string,
    relativePaths: string[],
    _options?: { batchSize?: number; concurrency?: number },
    _progressCallback?: (progress: { processed: number; total: number; batchNumber: number }) => void,
  ): Promise<{ deletedPaths: number; batchCount: number; durationMs: number }> {
    await this.deletePointsByPaths(collectionName, relativePaths);
    return { deletedPaths: relativePaths.length, batchCount: 1, durationMs: 0 };
  }

  async scrollFiltered(
    collectionName: string,
    _filter: Record<string, unknown>,
    _limit: number,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const resolved = this.resolve(collectionName);
    const points = this.points.get(resolved) || [];
    return points.map((p) => ({ id: p.id, payload: p.payload ?? {} }));
  }

  batchSetPayloadCalls: { collectionName: string; operations: any[] }[] = [];

  async setPayload(collectionName: string, payload: Record<string, any>, options: any): Promise<void> {
    const resolved = this.resolve(collectionName);
    const points = this.points.get(resolved);
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
    operations: { payload: Record<string, any>; points: (string | number)[] }[],
    _options?: any,
  ): Promise<void> {
    this.batchSetPayloadCalls.push({ collectionName, operations });
  }

  async disableIndexing(_collectionName: string): Promise<void> {}

  async enableIndexing(_collectionName: string, _threshold?: number): Promise<void> {}

  async checkHealth(): Promise<boolean> {
    return true;
  }
}

/** Mock EmbeddingProvider — returns fixed 384-dim vectors */
export class MockEmbeddingProvider implements EmbeddingProvider {
  getDimensions(): number {
    return 384;
  }

  getModel(): string {
    return "mock-model";
  }

  async embed(_text: string): Promise<{ embedding: number[]; dimensions: number }> {
    return { embedding: new Array(384).fill(0.1), dimensions: 384 };
  }

  async embedBatch(texts: string[]): Promise<{ embedding: number[]; dimensions: number }[]> {
    return texts.map(() => ({
      embedding: new Array(384).fill(0.1),
      dimensions: 384,
    }));
  }

  async checkHealth(): Promise<boolean> {
    return true;
  }

  getProviderName(): string {
    return "mock";
  }
}

/** Helper to create test files in a temp directory */
export async function createTestFile(baseDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(baseDir, relativePath);
  const dir = join(fullPath, "..");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

/** Default ingest test config */
export function defaultTestConfig(): IngestCodeConfig {
  return {
    chunkSize: 500,
    chunkOverlap: 50,
    supportedExtensions: [".ts", ".js", ".py"],
    ignorePatterns: ["node_modules/**", "dist/**"],
    enableHybridSearch: false,
  };
}

/** Default search test config */
export function defaultExploreConfig(): ExploreCodeConfig {
  return {
    enableHybridSearch: false,
    defaultSearchLimit: 5,
  };
}

/** Default trajectory test config */
export function defaultTrajectoryConfig(): TrajectoryIngestConfig {
  return {};
}

/** Create a temp directory for tests and return paths */
export async function createTempTestDir(): Promise<{ tempDir: string; codebaseDir: string }> {
  const tempDir = join(tmpdir(), `qdrant-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
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
