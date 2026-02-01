import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Setup file mocks tree-sitter native modules to prevent crashes
    setupFiles: ["./tests/vitest.setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/build/**",
      "**/dist/**",
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
        // Type-only files (no executable code to test)
        "src/prompts/types.ts",
        "src/code/types.ts",
        "src/code/git/types.ts",
      ],
      thresholds: {
        // Global thresholds
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
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
