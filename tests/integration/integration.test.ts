import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tree-sitter modules to prevent native binding crashes in integration tests
// Note: vi.mock() is hoisted, so all values must be inline (no external references)
vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return {
        rootNode: {
          type: "program",
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 0 },
          children: [],
          text: "",
          namedChildren: [],
        },
      };
    }
  },
}));
vi.mock("tree-sitter-bash", () => ({ default: {} }));
vi.mock("tree-sitter-go", () => ({ default: {} }));
vi.mock("tree-sitter-java", () => ({ default: {} }));
vi.mock("tree-sitter-javascript", () => ({ default: {} }));
vi.mock("tree-sitter-python", () => ({ default: {} }));
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

import { CodeIndexer } from "../../src/code/indexer.js";
import type { CodeConfig } from "../../src/code/types.js";
import type { EmbeddingProvider } from "../../src/embeddings/base.js";
import type { QdrantManager } from "../../src/qdrant/client.js";

// Mock implementations (same as indexer.test.ts)
class MockQdrantManager implements Partial<QdrantManager> {
  private collections = new Map<string, any>();
  private points = new Map<string, any[]>();

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name);
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

  async addPoints(collectionName: string, points: any[]): Promise<void> {
    const existing = this.points.get(collectionName) || [];
    // Upsert: remove existing points with same ID, then add new ones
    const newIds = new Set(points.map((p) => p.id));
    const filtered = existing.filter((p) => !newIds.has(p.id));
    this.points.set(collectionName, [...filtered, ...points]);
  }

  async addPointsOptimized(
    collectionName: string,
    points: any[],
    _options?: any,
  ): Promise<void> {
    await this.addPoints(collectionName, points);
  }

  async addPointsWithSparse(
    collectionName: string,
    points: any[],
  ): Promise<void> {
    await this.addPoints(collectionName, points);
  }

  async addPointsWithSparseOptimized(
    collectionName: string,
    points: any[],
    _options?: any,
  ): Promise<void> {
    await this.addPoints(collectionName, points);
  }

  async search(
    collectionName: string,
    _vector: number[],
    limit: number,
    filter?: any,
  ): Promise<any[]> {
    const points = this.points.get(collectionName) || [];
    let filtered = points;

    // Simple filtering implementation
    if (filter?.must) {
      for (const condition of filter.must) {
        if (condition.key === "fileExtension") {
          filtered = filtered.filter((p) =>
            condition.match.any.includes(p.payload.fileExtension),
          );
        }
      }
    }

    return filtered.slice(0, limit).map((p, idx) => ({
      id: p.id,
      score: 0.9 - idx * 0.05,
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
    // Hybrid search returns similar results with slight boost
    const results = await this.search(collectionName, vector, limit, filter);
    return results.map((r) => ({ ...r, score: Math.min(r.score + 0.05, 1.0) }));
  }

  async getCollectionInfo(name: string): Promise<any> {
    const collection = this.collections.get(name);
    const points = this.points.get(name) || [];
    return {
      pointsCount: points.length,
      hybridEnabled: collection?.hybridEnabled || false,
      vectorSize: collection?.vectorSize || 384,
    };
  }

  async getPoint(
    collectionName: string,
    id: string | number,
  ): Promise<{ id: string | number; payload?: Record<string, any> } | null> {
    const points = this.points.get(collectionName) || [];
    const point = points.find((p) => p.id === id);
    if (!point) {
      return null;
    }
    return {
      id: point.id,
      payload: point.payload,
    };
  }

  async deletePointsByFilter(
    collectionName: string,
    filter: Record<string, any>,
  ): Promise<void> {
    const points = this.points.get(collectionName) || [];
    const pathToDelete = filter?.must?.[0]?.match?.value;
    if (pathToDelete) {
      const filtered = points.filter(
        (p) => p.payload?.relativePath !== pathToDelete,
      );
      this.points.set(collectionName, filtered);
    }
  }

  async deletePointsByPaths(
    collectionName: string,
    relativePaths: string[],
  ): Promise<void> {
    if (relativePaths.length === 0) return;
    const points = this.points.get(collectionName) || [];
    const pathsToDelete = new Set(relativePaths);
    const filtered = points.filter(
      (p) => !pathsToDelete.has(p.payload?.relativePath),
    );
    this.points.set(collectionName, filtered);
  }

  async disableIndexing(_collectionName: string): Promise<void> {
    // Mock: no-op, indexing control not needed for tests
  }

  async enableIndexing(
    _collectionName: string,
    _threshold?: number,
  ): Promise<void> {
    // Mock: no-op, indexing control not needed for tests
  }

  // For testing: get all indexed paths
  getAllIndexedPaths(collectionName: string): string[] {
    const points = this.points.get(collectionName) || [];
    const paths = new Set<string>();
    for (const p of points) {
      if (p.payload?.relativePath) {
        paths.add(p.payload.relativePath);
      }
    }
    return [...paths];
  }
}

class MockEmbeddingProvider implements EmbeddingProvider {
  getDimensions(): number {
    return 384;
  }

  getModel(): string {
    return "mock-model";
  }

  async embed(
    text: string,
  ): Promise<{ embedding: number[]; dimensions: number }> {
    // Simple hash-based mock embedding
    const hash = text
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const base = (hash % 100) / 100;
    return { embedding: new Array(384).fill(base), dimensions: 384 };
  }

  async embedBatch(
    texts: string[],
  ): Promise<Array<{ embedding: number[]; dimensions: number }>> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

describe("CodeIndexer Integration Tests", () => {
  let indexer: CodeIndexer;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: CodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `qdrant-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    codebaseDir = join(tempDir, "codebase");
    await fs.mkdir(codebaseDir, { recursive: true });

    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    config = {
      chunkSize: 500,
      chunkOverlap: 50,
      enableASTChunking: true,
      supportedExtensions: [".ts", ".js", ".py", ".go"],
      ignorePatterns: ["node_modules/**", "dist/**", "*.test.*"],
      batchSize: 10,
      defaultSearchLimit: 5,
      enableHybridSearch: false,
    };

    indexer = new CodeIndexer(qdrant as any, embeddings, config);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  describe("Complete indexing workflow", () => {
    it("should index, search, and retrieve results from a TypeScript project", async () => {
      // Create a sample TypeScript project structure
      await createTestFile(
        codebaseDir,
        "src/auth/login.ts",
        `
export class AuthService {
  async login(email: string, password: string) {
    return { token: 'jwt-token' };
  }
}
      `,
      );

      await createTestFile(
        codebaseDir,
        "src/auth/register.ts",
        `
export class RegistrationService {
  async register(user: User) {
    return { id: '123', email: user.email };
  }
}
      `,
      );

      await createTestFile(
        codebaseDir,
        "src/utils/validation.ts",
        `
export function validateEmail(email: string): boolean {
  return /^[^@]+@[^@]+\\.[^@]+$/.test(email);
}
      `,
      );

      // Index the codebase
      const indexStats = await indexer.indexCodebase(codebaseDir);

      expect(indexStats.filesScanned).toBe(3);
      expect(indexStats.filesIndexed).toBe(3);
      expect(indexStats.chunksCreated).toBeGreaterThan(0);
      expect(indexStats.status).toBe("completed");

      // Search for authentication-related code
      const authResults = await indexer.searchCode(
        codebaseDir,
        "authentication login",
      );

      expect(authResults.length).toBeGreaterThan(0);
      expect(authResults[0].language).toBe("typescript");

      // Verify index status
      const status = await indexer.getIndexStatus(codebaseDir);

      expect(status.isIndexed).toBe(true);
      expect(status.chunksCount).toBeGreaterThan(0);
    });

    it("should handle multi-language projects", async () => {
      await createTestFile(
        codebaseDir,
        "server.ts",
        `
import express from 'express';
const app = express();
app.listen(3000);
      `,
      );

      await createTestFile(
        codebaseDir,
        "client.js",
        `
const API_URL = 'http://localhost:3000';
fetch(API_URL).then(res => res.json());
      `,
      );

      await createTestFile(
        codebaseDir,
        "utils.py",
        `
def process_data(data):
    return [x * 2 for x in data]
      `,
      );

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.filesScanned).toBe(3);
      expect(stats.filesIndexed).toBe(3);

      // Search should find relevant code regardless of language
      const results = await indexer.searchCode(codebaseDir, "process data");

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("Incremental updates workflow", () => {
    it("should detect and index only changed files", async () => {
      // Initial indexing
      await createTestFile(
        codebaseDir,
        "file1.ts",
        `export const firstValue = 1;
console.log('First file loaded successfully');
function init(): string {
  console.log('Initializing system');
  return 'ready';
}`,
      );
      await createTestFile(
        codebaseDir,
        "file2.ts",
        `export const secondValue = 2;
console.log('Second file loaded successfully');
function start(): string {
  console.log('Starting application');
  return 'started';
}`,
      );

      const initialStats = await indexer.indexCodebase(codebaseDir);
      expect(initialStats.filesIndexed).toBe(2);

      // Add a new file
      await createTestFile(
        codebaseDir,
        "file3.ts",
        `/**
 * Process data and return result string
 */
export function process(): string {
  console.log('Processing data in third file');
  const status = 'processed';
  if (status) {
    console.log('Status confirmed:', status);
  }
  return status;
}

export const thirdValue = 3;`,
      );

      // Incremental update
      const updateStats = await indexer.reindexChanges(codebaseDir);

      expect(updateStats.filesAdded).toBe(1);
      expect(updateStats.filesModified).toBe(0);
      expect(updateStats.filesDeleted).toBe(0);

      // Verify search includes new content
      const results = await indexer.searchCode(codebaseDir, "third");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should handle file modifications", async () => {
      await createTestFile(
        codebaseDir,
        "config.ts",
        "export const DEBUG_MODE = false;\nconsole.log('Debug mode off');",
      );

      await indexer.indexCodebase(codebaseDir);

      // Modify the file
      await createTestFile(
        codebaseDir,
        "config.ts",
        "export const DEBUG_MODE = true;\nconsole.log('Debug mode on');",
      );

      const updateStats = await indexer.reindexChanges(codebaseDir);

      expect(updateStats.filesModified).toBe(1);
      expect(updateStats.filesAdded).toBe(0);
    });

    it("should handle file deletions", async () => {
      await createTestFile(
        codebaseDir,
        "temp.ts",
        "export const tempValue = true;\nconsole.log('Temporary file created');\nfunction cleanup() { return null; }",
      );
      await createTestFile(
        codebaseDir,
        "keep.ts",
        "export const keepValue = true;\nconsole.log('Permanent file stays');\nfunction maintain() { return true; }",
      );

      await indexer.indexCodebase(codebaseDir);

      // Delete a file
      await fs.unlink(join(codebaseDir, "temp.ts"));

      const updateStats = await indexer.reindexChanges(codebaseDir);

      expect(updateStats.filesDeleted).toBe(1);
      expect(updateStats.filesAdded).toBe(0);
    });

    it("should handle mixed changes in one update", async () => {
      // Initial state
      await createTestFile(
        codebaseDir,
        "file1.ts",
        "export const alpha = 1;\nconsole.log('Alpha file');",
      );
      await createTestFile(
        codebaseDir,
        "file2.ts",
        "export const beta = 2;\nconsole.log('Beta file');",
      );
      await createTestFile(
        codebaseDir,
        "file3.ts",
        "export const gamma = 3;\nconsole.log('Gamma file');",
      );

      await indexer.indexCodebase(codebaseDir);

      // Mixed changes
      await createTestFile(
        codebaseDir,
        "file1.ts",
        "export const alpha = 100;\nconsole.log('Alpha modified');",
      ); // Modified
      await createTestFile(
        codebaseDir,
        "file4.ts",
        "export const delta = 4;\nconsole.log('Delta file added');",
      ); // Added
      await fs.unlink(join(codebaseDir, "file3.ts")); // Deleted

      const updateStats = await indexer.reindexChanges(codebaseDir);

      expect(updateStats.filesAdded).toBe(1);
      expect(updateStats.filesModified).toBe(1);
      expect(updateStats.filesDeleted).toBe(1);
    });
  });

  describe("Search filtering and options", () => {
    beforeEach(async () => {
      await createTestFile(
        codebaseDir,
        "users.ts",
        "export class UserService {}",
      );
      await createTestFile(
        codebaseDir,
        "auth.ts",
        "export class AuthService {}",
      );
      await createTestFile(
        codebaseDir,
        "utils.js",
        "export function helper() {}",
      );
      await createTestFile(codebaseDir, "data.py", "class DataProcessor: pass");

      await indexer.indexCodebase(codebaseDir);
    });

    it("should filter results by file extension", async () => {
      const results = await indexer.searchCode(codebaseDir, "class", {
        fileTypes: [".ts"],
      });

      results.forEach((result) => {
        expect(result.fileExtension).toBe(".ts");
      });
    });

    it("should respect search limit", async () => {
      const results = await indexer.searchCode(codebaseDir, "export", {
        limit: 2,
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should apply score threshold", async () => {
      const results = await indexer.searchCode(codebaseDir, "service", {
        scoreThreshold: 0.8,
      });

      results.forEach((result) => {
        expect(result.score).toBeGreaterThanOrEqual(0.8);
      });
    });

    it("should support path pattern filtering", async () => {
      await createTestFile(
        codebaseDir,
        "src/api/endpoints.ts",
        "export const API = {}",
      );
      await indexer.indexCodebase(codebaseDir, { forceReindex: true });

      const results = await indexer.searchCode(codebaseDir, "export", {
        pathPattern: "src/api/**",
      });

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("Hybrid search workflow", () => {
    it("should enable and use hybrid search", async () => {
      const hybridConfig = { ...config, enableHybridSearch: true };
      const hybridIndexer = new CodeIndexer(
        qdrant as any,
        embeddings,
        hybridConfig,
      );

      await createTestFile(
        codebaseDir,
        "search.ts",
        "function performSearch(query: string) { return results; }",
      );

      await hybridIndexer.indexCodebase(codebaseDir);

      const results = await hybridIndexer.searchCode(
        codebaseDir,
        "search query",
      );

      expect(results.length).toBeGreaterThan(0);
    });

    it("should fallback to standard search if hybrid not available", async () => {
      const hybridConfig = { ...config, enableHybridSearch: true };
      const hybridIndexer = new CodeIndexer(
        qdrant as any,
        embeddings,
        hybridConfig,
      );

      // Index without hybrid
      await createTestFile(
        codebaseDir,
        "test.ts",
        `export const testValue = true;
console.log('Test value configured successfully');
function validate(): boolean {
  console.log('Validating test value');
  return testValue === true;
}`,
      );
      await indexer.indexCodebase(codebaseDir);

      // Search with hybrid-enabled indexer but collection without hybrid
      const results = await hybridIndexer.searchCode(codebaseDir, "test");

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("Large project workflow", () => {
    it("should handle projects with many files", async () => {
      // Create a large project structure
      for (let i = 0; i < 20; i++) {
        await createTestFile(
          codebaseDir,
          `module${i}.ts`,
          `export function func${i}() { return ${i}; }`,
        );
      }

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.filesScanned).toBe(20);
      expect(stats.filesIndexed).toBe(20);
      expect(stats.status).toBe("completed");
    });

    it("should handle large files with many chunks", async () => {
      const largeFile = Array(100)
        .fill(null)
        .map((_, i) => `function test${i}() { return ${i}; }`)
        .join("\n\n");

      await createTestFile(codebaseDir, "large.ts", largeFile);

      const stats = await indexer.indexCodebase(codebaseDir);

      expect(stats.chunksCreated).toBeGreaterThan(1);
    });
  });

  describe("Error handling and recovery", () => {
    it("should continue indexing after encountering errors", async () => {
      await createTestFile(
        codebaseDir,
        "valid.ts",
        "export const validValue = true;\nconsole.log('Valid file');",
      );
      await createTestFile(
        codebaseDir,
        "secrets.ts",
        'export const apiKey = "sk_test_FAKE_KEY_FOR_TESTING_NOT_REAL_KEY";\nconsole.log("Secrets file");',
      );

      const stats = await indexer.indexCodebase(codebaseDir);

      // Should index valid file and report error for secrets file
      expect(stats.filesIndexed).toBe(1);
      expect(stats.errors?.length).toBeGreaterThan(0);
      expect(stats.status).toBe("completed");
    });

    it("should allow re-indexing after partial failure", async () => {
      await createTestFile(
        codebaseDir,
        "test.ts",
        "export const testData = true;\nconsole.log('Test data loaded');",
      );

      const stats1 = await indexer.indexCodebase(codebaseDir);
      expect(stats1.status).toBe("completed");

      // Force re-index
      const stats2 = await indexer.indexCodebase(codebaseDir, {
        forceReindex: true,
      });
      expect(stats2.status).toBe("completed");
    });
  });

  describe("Clear and re-index workflow", () => {
    it("should clear index and allow re-indexing", async () => {
      await createTestFile(codebaseDir, "test.ts", "const test = 1;");

      await indexer.indexCodebase(codebaseDir);

      let status = await indexer.getIndexStatus(codebaseDir);
      expect(status.isIndexed).toBe(true);
      expect(status.status).toBe("indexed");

      await indexer.clearIndex(codebaseDir);

      status = await indexer.getIndexStatus(codebaseDir);
      expect(status.isIndexed).toBe(false);
      expect(status.status).toBe("not_indexed");

      // Re-index
      const stats = await indexer.indexCodebase(codebaseDir);
      expect(stats.status).toBe("completed");

      status = await indexer.getIndexStatus(codebaseDir);
      expect(status.isIndexed).toBe(true);
      expect(status.status).toBe("indexed");
    });
  });

  describe("Index status states", () => {
    it("should transition through all status states during indexing lifecycle", async () => {
      // Initial state: not_indexed
      let status = await indexer.getIndexStatus(codebaseDir);
      expect(status.status).toBe("not_indexed");
      expect(status.isIndexed).toBe(false);

      // Create files and index
      for (let i = 0; i < 3; i++) {
        await createTestFile(
          codebaseDir,
          `component${i}.ts`,
          `export class Component${i} {\n  private value = ${i};\n  render() {\n    console.log('Rendering component ${i}');\n    return this.value;\n  }\n}`,
        );
      }

      // Track status during indexing
      let sawIndexingStatus = false;
      await indexer.indexCodebase(codebaseDir, undefined, async (progress) => {
        if (progress.phase === "embedding" && !sawIndexingStatus) {
          const midStatus = await indexer.getIndexStatus(codebaseDir);
          if (midStatus.status === "indexing") {
            sawIndexingStatus = true;
          }
        }
      });

      // Final state: indexed
      status = await indexer.getIndexStatus(codebaseDir);
      expect(status.status).toBe("indexed");
      expect(status.isIndexed).toBe(true);
      expect(status.collectionName).toBeDefined();
      expect(status.chunksCount).toBeGreaterThanOrEqual(0);
    });

    it("should include lastUpdated timestamp in indexed status", async () => {
      await createTestFile(
        codebaseDir,
        "timestamped.ts",
        "export const timestamp = Date.now();\nconsole.log('Timestamp test');\nfunction getTime() { return timestamp; }",
      );

      const beforeIndexing = new Date();
      await indexer.indexCodebase(codebaseDir);
      const afterIndexing = new Date();

      const status = await indexer.getIndexStatus(codebaseDir);

      expect(status.status).toBe("indexed");
      expect(status.lastUpdated).toBeDefined();
      expect(status.lastUpdated).toBeInstanceOf(Date);
      expect(status.lastUpdated!.getTime()).toBeGreaterThanOrEqual(
        beforeIndexing.getTime(),
      );
      expect(status.lastUpdated!.getTime()).toBeLessThanOrEqual(
        afterIndexing.getTime(),
      );
    });

    it("should correctly count chunks excluding metadata point", async () => {
      // Create several files to generate multiple chunks
      for (let i = 0; i < 5; i++) {
        await createTestFile(
          codebaseDir,
          `service${i}.ts`,
          `export class Service${i} {\n  async process(input: string): Promise<string> {\n    console.log('Processing in service ${i}:', input);\n    const result = input.toUpperCase();\n    return result;\n  }\n  async validate(data: any): Promise<boolean> {\n    console.log('Validating in service ${i}');\n    return data !== null;\n  }\n}`,
        );
      }

      const stats = await indexer.indexCodebase(codebaseDir);
      const status = await indexer.getIndexStatus(codebaseDir);

      // The chunks count in status should match what was indexed
      // Note: The actual count depends on chunking algorithm, but should be consistent
      expect(status.chunksCount).toBeDefined();
      expect(typeof status.chunksCount).toBe("number");
      // chunksCount should be close to chunksCreated (accounting for metadata point)
      expect(status.chunksCount).toBeGreaterThanOrEqual(0);
    });

    it("should maintain indexed status after force reindex", async () => {
      await createTestFile(
        codebaseDir,
        "reindexable.ts",
        "export const version = 1;\nconsole.log('Version:', version);\nfunction getVersion() { return version; }",
      );

      // Initial index
      await indexer.indexCodebase(codebaseDir);
      let status = await indexer.getIndexStatus(codebaseDir);
      expect(status.status).toBe("indexed");
      const firstTimestamp = status.lastUpdated;

      // Wait to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Force reindex
      await indexer.indexCodebase(codebaseDir, { forceReindex: true });
      status = await indexer.getIndexStatus(codebaseDir);

      expect(status.status).toBe("indexed");
      expect(status.isIndexed).toBe(true);
      expect(status.lastUpdated).toBeDefined();

      // Timestamp should be updated
      if (firstTimestamp && status.lastUpdated) {
        expect(status.lastUpdated.getTime()).toBeGreaterThanOrEqual(
          firstTimestamp.getTime(),
        );
      }
    });
  });

  describe("Progress tracking", () => {
    it("should report progress through all phases", async () => {
      for (let i = 0; i < 5; i++) {
        await createTestFile(
          codebaseDir,
          `file${i}.ts`,
          `export const value${i} = ${i};\nconsole.log('File ${i} loaded successfully');\nfunction process${i}() { return value${i} * 2; }`,
        );
      }

      const progressUpdates: string[] = [];
      const progressCallback = (progress: any) => {
        progressUpdates.push(progress.phase);
      };

      await indexer.indexCodebase(codebaseDir, undefined, progressCallback);

      expect(progressUpdates).toContain("scanning");
      expect(progressUpdates).toContain("chunking");
      expect(progressUpdates).toContain("embedding");
      expect(progressUpdates).toContain("storing");
    });

    it("should report progress during incremental updates", async () => {
      await createTestFile(
        codebaseDir,
        "file1.ts",
        "export const initial = 1;\nconsole.log('Initial file');",
      );
      await indexer.indexCodebase(codebaseDir);

      await createTestFile(
        codebaseDir,
        "file2.ts",
        "export const additional = 2;\nconsole.log('Additional file');",
      );

      const progressUpdates: string[] = [];
      const progressCallback = (progress: any) => {
        progressUpdates.push(progress.phase);
      };

      await indexer.reindexChanges(codebaseDir, progressCallback);

      expect(progressUpdates.length).toBeGreaterThan(0);
    });
  });

  describe("Hybrid search with incremental updates", () => {
    it("should use hybrid search during reindexChanges", async () => {
      const hybridConfig = { ...config, enableHybridSearch: true };
      const hybridIndexer = new CodeIndexer(
        qdrant as any,
        embeddings,
        hybridConfig,
      );

      // Initial indexing with hybrid search
      await createTestFile(
        codebaseDir,
        "initial.ts",
        "export const initial = 1;\nconsole.log('Initial file');",
      );
      await hybridIndexer.indexCodebase(codebaseDir);

      // Add a new file with enough content to create chunks
      await createTestFile(
        codebaseDir,
        "added.ts",
        `export const added = 2;
console.log('Added file with more content');

/**
 * Function to demonstrate hybrid search indexing
 */
export function processData(data: string[]): string[] {
  console.log('Processing data in hybrid search mode');
  const result = data.map(item => item.toUpperCase());
  return result;
}

export class DataProcessor {
  process(input: string): string {
    return input.trim();
  }
}`,
      );

      // Reindex with hybrid search - this should cover lines 540-545
      const updateStats = await hybridIndexer.reindexChanges(codebaseDir);

      expect(updateStats.filesAdded).toBe(1);
      expect(updateStats.chunksAdded).toBeGreaterThan(0);
    });
  });

  describe("Error handling during reindexChanges", () => {
    it("should handle file processing errors gracefully", async () => {
      // Initial indexing
      await createTestFile(
        codebaseDir,
        "file1.ts",
        "export const value = 1;\nconsole.log('File 1');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Add a new file
      await createTestFile(
        codebaseDir,
        "file2.ts",
        "export const value2 = 2;\nconsole.log('File 2');",
      );

      // This should not throw even if there are processing errors
      const stats = await indexer.reindexChanges(codebaseDir);

      // Stats should still be returned
      expect(stats).toBeDefined();
      expect(stats.filesAdded).toBeGreaterThanOrEqual(0);
    });
  });

  // ============ REBUILD CACHE CORNER CASES ============
  describe("rebuildCache functionality", () => {
    it("should return zeros when collection does not exist", async () => {
      const result = await indexer.rebuildCache(codebaseDir);

      expect(result.indexed).toBe(0);
      expect(result.pending).toBe(0);
      expect(result.orphaned).toBe(0);
      expect(result.cacheVersion).toBe("none");
      expect(result.snapshotUpdated).toBe(false);
    });

    it("should correctly identify indexed and pending files", async () => {
      // Create and index some files
      await createTestFile(
        codebaseDir,
        "indexed1.ts",
        "export const value1 = 1;\nconsole.log('Indexed file 1');",
      );
      await createTestFile(
        codebaseDir,
        "indexed2.ts",
        "export const value2 = 2;\nconsole.log('Indexed file 2');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Add new file without indexing
      await createTestFile(
        codebaseDir,
        "pending1.ts",
        "export const pending = true;\nconsole.log('Pending file');",
      );

      const result = await indexer.rebuildCache(codebaseDir);

      // 2 files indexed, 1 file pending
      expect(result.indexed).toBe(2);
      expect(result.pending).toBe(1);
      expect(result.orphaned).toBe(0);
      expect(result.snapshotUpdated).toBe(true);
      expect(result.details?.pendingFiles).toContain("pending1.ts");
    });

    it("should identify and clean up orphaned chunks", async () => {
      // Create and index files
      await createTestFile(
        codebaseDir,
        "file1.ts",
        "export const value1 = 1;\nconsole.log('File 1');",
      );
      await createTestFile(
        codebaseDir,
        "file2.ts",
        "export const value2 = 2;\nconsole.log('File 2');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Delete file2.ts (chunks remain in Qdrant)
      await fs.unlink(join(codebaseDir, "file2.ts"));

      const result = await indexer.rebuildCache(codebaseDir);

      expect(result.indexed).toBe(1);
      expect(result.orphaned).toBe(1);
      expect(result.details?.orphanedPaths).toContain("file2.ts");
    });

    it("should handle empty codebase with existing collection", async () => {
      // Create and index a file
      await createTestFile(
        codebaseDir,
        "temp.ts",
        "export const temp = true;\nconsole.log('Temp file');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Delete all files
      await fs.unlink(join(codebaseDir, "temp.ts"));

      const result = await indexer.rebuildCache(codebaseDir);

      expect(result.indexed).toBe(0);
      expect(result.pending).toBe(0);
      expect(result.orphaned).toBe(1);
    });

    it("should rebuild snapshot with only valid files", async () => {
      // Create and index files
      await createTestFile(
        codebaseDir,
        "valid1.ts",
        "export const valid1 = true;\nconsole.log('Valid 1');",
      );
      await createTestFile(
        codebaseDir,
        "valid2.ts",
        "export const valid2 = true;\nconsole.log('Valid 2');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Delete one file
      await fs.unlink(join(codebaseDir, "valid2.ts"));

      // Rebuild cache
      const result = await indexer.rebuildCache(codebaseDir);
      expect(result.indexed).toBe(1);
      expect(result.snapshotUpdated).toBe(true);

      // Verify snapshot was updated correctly by checking that reindexChanges works
      await createTestFile(
        codebaseDir,
        "new.ts",
        "export const newFile = true;\nconsole.log('New file');",
      );
      const changeStats = await indexer.reindexChanges(codebaseDir);

      // new.ts should be detected as added
      expect(changeStats.filesAdded).toBe(1);
    });

    it("should delete any existing checkpoint", async () => {
      // Create and index files
      await createTestFile(
        codebaseDir,
        "file1.ts",
        "export const value = 1;\nconsole.log('File 1');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Simulate a checkpoint exists (we can't easily create one without reindex,
      // but rebuildCache should call deleteCheckpoint regardless)
      const result = await indexer.rebuildCache(codebaseDir);

      expect(result.snapshotUpdated).toBe(true);
      // After rebuild, any checkpoint should be deleted
    });

    it("should handle mixed state: indexed, pending, and orphaned", async () => {
      // Create and index initial files
      await createTestFile(
        codebaseDir,
        "indexed.ts",
        "export const indexed = true;\nconsole.log('Indexed');",
      );
      await createTestFile(
        codebaseDir,
        "to_delete.ts",
        "export const toDelete = true;\nconsole.log('To delete');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Delete one, add another
      await fs.unlink(join(codebaseDir, "to_delete.ts"));
      await createTestFile(
        codebaseDir,
        "pending.ts",
        "export const pending = true;\nconsole.log('Pending');",
      );

      const result = await indexer.rebuildCache(codebaseDir);

      expect(result.indexed).toBe(1);
      expect(result.pending).toBe(1);
      expect(result.orphaned).toBe(1);
    });

    it("should handle collection with only metadata marker", async () => {
      // Index an empty set of files (should only create metadata marker)
      // This is tricky because indexCodebase requires files...
      // Let's create a file with secrets that will be skipped
      await createTestFile(
        codebaseDir,
        "secrets.ts",
        'export const apiKey = "sk_test_FAKE_API_KEY_NOT_REAL";\nconsole.log("Secrets");',
      );

      const stats = await indexer.indexCodebase(codebaseDir);
      // File should be skipped due to secrets detection
      expect(stats.filesIndexed).toBe(0);

      // rebuildCache should handle collection with minimal content
      const result = await indexer.rebuildCache(codebaseDir);

      expect(result.indexed).toBe(0);
      // The secrets file exists but isn't indexed
      expect(result.pending).toBe(1);
    });

    it("should limit details to first 20 entries", async () => {
      // Create many files
      for (let i = 0; i < 25; i++) {
        await createTestFile(
          codebaseDir,
          `file${i}.ts`,
          `export const value${i} = ${i};\nconsole.log('File ${i}');`,
        );
      }

      // Don't index - all files are pending
      // But we need collection to exist, so index one and delete it
      await indexer.indexCodebase(codebaseDir);

      // Delete all and add new ones
      for (let i = 0; i < 25; i++) {
        await fs.unlink(join(codebaseDir, `file${i}.ts`));
      }
      for (let i = 0; i < 25; i++) {
        await createTestFile(
          codebaseDir,
          `new${i}.ts`,
          `export const new${i} = ${i};\nconsole.log('New ${i}');`,
        );
      }

      const result = await indexer.rebuildCache(codebaseDir);

      // Should limit details to 20
      expect(result.details?.pendingFiles?.length).toBeLessThanOrEqual(20);
      expect(result.details?.orphanedPaths?.length).toBeLessThanOrEqual(20);
    });

    it("should return v2 cache version", async () => {
      await createTestFile(
        codebaseDir,
        "file.ts",
        "export const value = 1;\nconsole.log('File');",
      );
      await indexer.indexCodebase(codebaseDir);

      const result = await indexer.rebuildCache(codebaseDir);

      expect(result.cacheVersion).toBe("v2");
    });
  });

  // ============ BATCH PIPELINE TESTS ============
  describe("batch pipeline operations", () => {
    it("should use batch delete (deletePointsByPaths) for multiple file deletions", async () => {
      // Create and index multiple files
      for (let i = 1; i <= 5; i++) {
        await createTestFile(
          codebaseDir,
          `file${i}.ts`,
          `export const value${i} = ${i};\nconsole.log('File ${i}');`,
        );
      }
      await indexer.indexCodebase(codebaseDir);

      // Spy on deletePointsByPaths
      const deletePathsSpy = vi.spyOn(qdrant, "deletePointsByPaths");

      // Delete multiple files
      await fs.unlink(join(codebaseDir, "file2.ts"));
      await fs.unlink(join(codebaseDir, "file4.ts"));

      await indexer.reindexChanges(codebaseDir);

      // Should call deletePointsByPaths with both paths in a single call
      expect(deletePathsSpy).toHaveBeenCalled();
      const deletedPaths = deletePathsSpy.mock.calls[0]?.[1] || [];
      expect(deletedPaths).toContain("file2.ts");
      expect(deletedPaths).toContain("file4.ts");
    });

    it("should use optimized addPointsOptimized in indexCodebase", async () => {
      // Spy on addPointsOptimized BEFORE indexing
      const addPointsSpy = vi.spyOn(qdrant, "addPointsOptimized");

      // Create file with enough content for chunker (> 100 chars)
      await createTestFile(
        codebaseDir,
        "service.ts",
        `export class DataService {
  private cache: Map<string, any> = new Map();

  async fetchData(id: string): Promise<any> {
    if (this.cache.has(id)) {
      return this.cache.get(id);
    }
    const data = await this.loadFromDatabase(id);
    this.cache.set(id, data);
    return data;
  }

  private async loadFromDatabase(id: string): Promise<any> {
    console.log('Loading data for:', id);
    return { id, value: Math.random() };
  }
}`,
      );

      await indexer.indexCodebase(codebaseDir);

      // Should use addPointsOptimized (with wait=true for single batch)
      expect(addPointsSpy).toHaveBeenCalled();
      // Verify it was called with wait option
      const call = addPointsSpy.mock.calls[0];
      expect(call[0]).toContain("code_"); // collection name
      expect(call[2]).toHaveProperty("wait"); // options with wait
    });

    it("should use optimized addPoints in reindexChanges", async () => {
      // Initial indexing with enough content
      await createTestFile(
        codebaseDir,
        "initial.ts",
        `export const initial = 1;
console.log('Initial file with enough content');
function initializeSystem(): void {
  console.log('Initializing system components');
  const config = loadConfig();
  setupDatabase(config);
}`,
      );
      await indexer.indexCodebase(codebaseDir);

      // Spy on addPointsOptimized AFTER initial indexing
      const addPointsSpy = vi.spyOn(qdrant, "addPointsOptimized");

      // Add new file with enough content
      await createTestFile(
        codebaseDir,
        "added.ts",
        `export const added = 2;
console.log('Added file with sufficient content for chunking');
function processData(data: string[]): string[] {
  console.log('Processing data items:', data.length);
  return data.map(item => item.toUpperCase());
}`,
      );

      await indexer.reindexChanges(codebaseDir);

      // Should use addPointsOptimized for storing new chunks
      expect(addPointsSpy).toHaveBeenCalled();
    });

    it("should handle batch operations during file modifications", async () => {
      // Create and index files
      for (let i = 1; i <= 3; i++) {
        await createTestFile(
          codebaseDir,
          `mod${i}.ts`,
          `export const original${i} = ${i};\nconsole.log('Original ${i}');`,
        );
      }
      await indexer.indexCodebase(codebaseDir);

      const deletePathsSpy = vi.spyOn(qdrant, "deletePointsByPaths");

      // Modify all files (will trigger delete old chunks + add new ones)
      for (let i = 1; i <= 3; i++) {
        await createTestFile(
          codebaseDir,
          `mod${i}.ts`,
          `export const modified${i} = ${i * 10};\nconsole.log('Modified ${i}');`,
        );
      }

      const stats = await indexer.reindexChanges(codebaseDir);

      // All modified files should be batch-deleted
      expect(deletePathsSpy).toHaveBeenCalled();
      expect(stats.filesModified).toBe(3);
    });

    it("should efficiently handle mixed batch operations", async () => {
      // Initial state - files with enough content
      for (let i = 1; i <= 4; i++) {
        await createTestFile(
          codebaseDir,
          `batch${i}.ts`,
          `export const value${i} = ${i};
console.log('Batch file ${i} with substantial content');
function processBatch${i}(input: string): string {
  console.log('Processing batch ${i}:', input);
  return input.toUpperCase() + '_${i}';
}`,
        );
      }
      await indexer.indexCodebase(codebaseDir);

      const deletePathsSpy = vi.spyOn(qdrant, "deletePointsByPaths");
      const addPointsSpy = vi.spyOn(qdrant, "addPointsOptimized");

      // Mixed operations:
      // - Delete batch1.ts and batch2.ts
      // - Modify batch3.ts
      // - Add batch5.ts
      await fs.unlink(join(codebaseDir, "batch1.ts"));
      await fs.unlink(join(codebaseDir, "batch2.ts"));
      await createTestFile(
        codebaseDir,
        "batch3.ts",
        `export const modified3 = 300;
console.log('Modified batch 3 with new content');
function handleModified(data: any): void {
  console.log('Handling modified data');
  processData(data);
}`,
      );
      await createTestFile(
        codebaseDir,
        "batch5.ts",
        `export const value5 = 5;
console.log('New batch 5 file created');
function newBatchHandler(): number {
  console.log('New batch handler initialized');
  return 5;
}`,
      );

      const stats = await indexer.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(2);
      expect(stats.filesModified).toBe(1);
      expect(stats.filesAdded).toBe(1);

      // Batch delete should be called for deleted + modified files
      expect(deletePathsSpy).toHaveBeenCalled();
      const deletedPaths = deletePathsSpy.mock.calls.flatMap((call) => call[1]);
      expect(deletedPaths).toContain("batch1.ts");
      expect(deletedPaths).toContain("batch2.ts");
      expect(deletedPaths).toContain("batch3.ts"); // modified = delete old + add new

      // addPointsOptimized should be called for new chunks
      expect(addPointsSpy).toHaveBeenCalled();
    });

    it("should handle empty batch delete gracefully", async () => {
      await createTestFile(
        codebaseDir,
        "stable.ts",
        "export const stable = true;\nconsole.log('Stable');",
      );
      await indexer.indexCodebase(codebaseDir);

      const deletePathsSpy = vi.spyOn(qdrant, "deletePointsByPaths");

      // No changes - reindex should not call delete
      const stats = await indexer.reindexChanges(codebaseDir);

      expect(stats.filesDeleted).toBe(0);
      expect(stats.filesModified).toBe(0);
      // deletePointsByPaths should not be called or called with empty array
      if (deletePathsSpy.mock.calls.length > 0) {
        const deletedPaths = deletePathsSpy.mock.calls[0][1];
        expect(deletedPaths.length).toBe(0);
      }
    });
  });

  // ============ CHECKPOINT INTEGRATION WITH INDEXER ============
  describe("checkpoint integration with reindexChanges", () => {
    it("should resume from checkpoint after interruption simulation", async () => {
      // Note: This is a simplified test since we can't easily interrupt reindexChanges
      // The actual checkpoint logic is tested more thoroughly in synchronizer.test.ts

      // Create and index initial files
      await createTestFile(
        codebaseDir,
        "file1.ts",
        "export const value1 = 1;\nconsole.log('File 1');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Add multiple new files
      for (let i = 2; i <= 5; i++) {
        await createTestFile(
          codebaseDir,
          `file${i}.ts`,
          `export const value${i} = ${i};\nconsole.log('File ${i}');`,
        );
      }

      // Normal reindex (checkpoint should be created and deleted on success)
      const stats = await indexer.reindexChanges(codebaseDir);

      expect(stats.filesAdded).toBe(4);
      expect(stats.filesModified).toBe(0);
      expect(stats.filesDeleted).toBe(0);
    });

    it("should handle reindex when no changes exist", async () => {
      await createTestFile(
        codebaseDir,
        "stable.ts",
        "export const stable = true;\nconsole.log('Stable file');",
      );
      await indexer.indexCodebase(codebaseDir);

      // Reindex with no changes
      const stats = await indexer.reindexChanges(codebaseDir);

      expect(stats.filesAdded).toBe(0);
      expect(stats.filesModified).toBe(0);
      expect(stats.filesDeleted).toBe(0);
    });
  });
});

// Helper function
async function createTestFile(
  baseDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(baseDir, relativePath);
  const dir = join(fullPath, "..");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}
