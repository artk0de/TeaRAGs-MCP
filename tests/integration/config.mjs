/**
 * Integration Test Configuration
 */

export const config = {
  QDRANT_URL: process.env.QDRANT_URL || "http://192.168.1.71:6333",
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://192.168.1.71:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "unclemusclez/jina-embeddings-v2-base-code:latest",
};

export const TEST_DIR = "/tmp/qdrant_integration_test_" + Date.now();

// Track all indexed paths for cleanup
export const indexedPaths = new Set();

/**
 * Default config for CodeIndexer
 */
export function getIndexerConfig(overrides = {}) {
  return {
    chunkSize: 500,
    chunkOverlap: 50,
    enableASTChunking: true,
    supportedExtensions: [".ts"],
    ignorePatterns: [],
    batchSize: 100,
    defaultSearchLimit: 10,
    enableHybridSearch: false,
    ...overrides,
  };
}
