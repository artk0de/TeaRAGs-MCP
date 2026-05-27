/**
 * Vitest setup file
 *
 * Note: Tree-sitter mocks are now applied per-test-file in tests that need them
 * (e.g., integration.test.ts) to avoid breaking tree-sitter-chunker unit tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

import { setDebug } from "../src/core/domains/ingest/pipeline/infra/runtime.js";

// Set test-specific environment variables
// Enable DEBUG to cover debug logging branches across all modules
process.env.DEBUG = process.env.DEBUG || "true";
setDebug(true);
// Limit chunk processing to prevent slow tests and ensure consistent behavior
process.env.MAX_TOTAL_CHUNKS = process.env.MAX_TOTAL_CHUNKS || "1000";
// Reduce ChunkerPool worker threads to 1 in tests for faster, deterministic execution.
process.env.CHUNKER_POOL_SIZE = process.env.CHUNKER_POOL_SIZE || "1";

// Strip inherited git plumbing env vars. When the suite runs INSIDE a git hook
// (husky pre-commit `npm test`), git exports GIT_DIR / GIT_INDEX_FILE / ...
// pointing at the REAL worktree. Real-git fixture tests that shell out to `git`
// (e.g. client-catfile.test.ts) would then operate on the worktree instead of
// their temp repo — silently committing fixture commits onto the project's HEAD
// (observed: HEAD hijacked to A/B/c fixtures), or failing when the worktree's
// hooks fire. Tests must never inherit the ambient git context.
for (const v of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS",
]) {
  delete process.env[v];
}

// Redirect app data to temp dir to avoid polluting user's home
const testDataDir = mkdtempSync(join(tmpdir(), "tea-rags-test-"));
process.env.TEA_RAGS_DATA_DIR = testDataDir;

afterAll(() => {
  rmSync(testDataDir, { recursive: true, force: true });
});
