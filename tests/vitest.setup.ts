/**
 * Vitest setup file
 *
 * Note: Tree-sitter mocks are now applied per-test-file in tests that need them
 * (e.g., integration.test.ts) to avoid breaking tree-sitter-chunker unit tests.
 */

// Set test-specific environment variables
// Limit chunk processing to prevent slow tests and ensure consistent behavior
process.env.MAX_TOTAL_CHUNKS = process.env.MAX_TOTAL_CHUNKS || "1000";
