/**
 * Integration Test Configuration
 *
 * Qdrant resolution mirrors the production cascade from
 * src/core/adapters/qdrant/embedded/daemon.ts (also used by tea-rags
 * tune/doctor): explicit QDRANT_URL env → probe localhost:6333 → spawn
 * embedded daemon at ~/.tea-rags/qdrant. This lets integration tests
 * run on any developer machine without a pre-baked Qdrant somewhere.
 *
 * Ollama is always external; default localhost:11434. If unreachable,
 * the runner skips embedding-dependent suites with a clear message
 * rather than crashing.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveQdrantUrl } from "../../build/core/adapters/qdrant/embedded/daemon.js";

export const config = {
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://localhost:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "unclemusclez/jina-embeddings-v2-base-code:latest",
};

// TEST_DIR must be the canonical (symlink-resolved) path so it matches
// ingest's internal collection-name resolution. Ingest calls fs.realpath
// (via validatePath) before hashing the path; ExploreFacade uses raw
// resolve(). On macOS BOTH `/tmp` and `/var` are symlinks to `/private/*`,
// so a literal `/tmp/x` or `os.tmpdir()/x` produces a different hash from
// what ingest writes — every searchCode then 404s.
//
// Fix: realpath the tmpdir parent (it exists at module-import time) and join
// the unique test suffix. The result lives under /private/var/folders/... on
// macOS, /tmp on Linux (which doesn't symlink to anything).
//
// Production-side bug (filed separately): resolveCollection should canonicalize
// before hashing so it agrees with ingest's resolution regardless of caller.
export const TEST_DIR = join(realpathSync(tmpdir()), `qdrant_integration_test_${Date.now()}`);

// Track all indexed paths for cleanup
export const indexedPaths = new Set();

/**
 * Resolve the Qdrant endpoint for integration tests.
 *
 * Returns the production QdrantResolution shape, so the caller can pass
 * `reconnect` + `daemon` straight to `new QdrantManager()` (for embedded
 * mode the manager needs the reconnect hook to survive daemon respawns).
 *
 * Cascade:
 *   1. QDRANT_URL env → external mode, no daemon touch
 *   2. probe http://localhost:6333 → external mode if alive
 *   3. spawn / attach to embedded daemon (random port)
 *
 * @returns {Promise<{
 *   mode: "external" | "embedded",
 *   url: string,
 *   release?: () => void,
 *   reconnect?: () => Promise<{url: string}>,
 *   startupPhase?: string,
 *   pid?: number,
 *   storagePath?: string,
 * }>}
 */
export async function resolveTestQdrant() {
  return resolveQdrantUrl(process.env.QDRANT_URL);
}

/**
 * Probe Ollama availability. Suites depending on embeddings should
 * check this first and skip gracefully when the provider is down.
 */
export async function isOllamaReachable(url = config.EMBEDDING_BASE_URL) {
  try {
    const response = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

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
