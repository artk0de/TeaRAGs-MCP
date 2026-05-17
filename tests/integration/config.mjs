/**
 * Integration Test Configuration
 */

export const config = {
  QDRANT_URL: process.env.QDRANT_URL || "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://192.168.1.71:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "unclemusclez/jina-embeddings-v2-base-code:latest",
};

export const TEST_DIR = `/tmp/qdrant_integration_test_${Date.now()}`;

// Track all indexed paths for cleanup
export const indexedPaths = new Set();

/**
 * Default IngestCodeConfig for createTestFacades().
 *
 * Post-SOLID: CodeIndexer-era fields like `batchSize`, `defaultSearchLimit`,
 * `enableASTChunking` are no longer part of the ingest config (batching is
 * controlled via pipelineTuning, AST chunking is always-on, search limit is
 * per-request). Suites that need small-batch behavior pass `pipelineTuning`
 * to createTestFacades() directly.
 */
export function getIndexerConfig(overrides = {}) {
  return {
    chunkSize: 500,
    chunkOverlap: 50,
    supportedExtensions: [".ts"],
    ignorePatterns: [],
    enableHybridSearch: false,
    quantizationScalar: false,
    enableGitMetadata: false,
    ...overrides,
  };
}
