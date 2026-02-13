import { defineConfig } from "vitest/config";

const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // CI: retry flaky tests up to 2 times, increase timeout for slow runners
    ...(isCI && { retry: 2, testTimeout: 30_000 }),
    // Give worker_threads (ChunkerPool) time to terminate before fork exits
    teardownTimeout: isCI ? 10_000 : 5_000,
    // Setup file mocks tree-sitter native modules to prevent crashes
    setupFiles: ["./tests/vitest.setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/build/**",
      "**/dist/**",
      "**/.worktrees/**",
      // Exclude integration tests - they require real external services
      "**/tests/integration/**",
      // Exclude legacy integration test files
      "test-*.mjs",
      "test-*.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "build/",
        "dist/",
        "**/*.test.ts",
        "**/*.spec.ts",
        "vitest.config.ts",
        "commitlint.config.js",
        "src/index.ts",
        "scripts/**",
        "tests/**/fixtures/**",
        "tests/integration/**",
        // Re-export files (no executable code to test)
        "src/code/git/index.ts",
        "src/code/pipeline/index.ts",
        "src/prompts/index.ts",
        "src/qdrant/filters/index.ts",
        // Type-only files (no executable code to test)
        "src/prompts/types.ts",
        "src/code/types.ts",
        "src/code/git/types.ts",
        // Test utilities (not production code)
        "tests/**/test-helpers.ts",
      ],
      thresholds: {
        // Global thresholds
        lines: 92,
        functions: 90,
        branches: 80,
        statements: 92,
        // File-specific thresholds
        "src/qdrant/client.ts": {
          lines: 90,
          functions: 100,
          branches: 80,
          statements: 90,
        },
        "src/embeddings/openai.ts": {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 100,
        },
      },
    },
  },
});
