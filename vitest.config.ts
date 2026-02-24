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
      // Exclude website tests — require website/node_modules (@docusaurus/tsconfig)
      "**/tests/website/**",
      // Exclude legacy integration test files
      "test-*.mjs",
      "test-*.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov", "html"],
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
        "tests/**/__fixtures__/**",
        "tests/integration/**",
        // Re-export files (no executable code to test)
        "src/core/ingest/pipeline/index.ts",
        "src/core/adapters/qdrant/filters/index.ts",
        "src/mcp/prompts/index.ts",
        // Type-only files (no executable code to test)
        "src/core/types.ts",
        "src/core/ingest/pipeline/enrichment/types.ts",
        "src/core/ingest/pipeline/enrichment/trajectory/git/types.ts",
        "src/core/ingest/pipeline/types.ts",
        "src/core/ingest/pipeline/chunker/hooks/types.ts",
        // Test utilities (not production code)
        "tests/**/test-helpers.ts",
      ],
      thresholds: {
        // Global thresholds
        lines: 95,
        functions: 93,
        branches: 85,
        statements: 95,
        // File-specific thresholds
        "src/core/adapters/qdrant/client.ts": {
          lines: 90,
          functions: 100,
          branches: 80,
          statements: 90,
        },
        "src/core/adapters/embeddings/openai.ts": {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 100,
        },
      },
    },
  },
});
