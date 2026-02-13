/**
 * Vitest setup file
 *
 * Note: Tree-sitter mocks are now applied per-test-file in tests that need them
 * (e.g., integration.test.ts) to avoid breaking tree-sitter-chunker unit tests.
 */

// Set test-specific environment variables
// Enable DEBUG to cover debug logging branches across all modules
process.env.DEBUG = process.env.DEBUG || "true";
// Limit chunk processing to prevent slow tests and ensure consistent behavior
process.env.MAX_TOTAL_CHUNKS = process.env.MAX_TOTAL_CHUNKS || "1000";
// Reduce ChunkerPool worker threads to 1 in tests to prevent fork termination hangs.
// ChunkerPool spawns real worker_threads inside vitest fork processes; multiple workers
// can prevent the fork from exiting cleanly when tree-sitter native modules are loaded.
process.env.CHUNKER_POOL_SIZE = process.env.CHUNKER_POOL_SIZE || "1";
