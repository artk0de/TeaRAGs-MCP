import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root,
  test: {
    globals: true,
    environment: "node",
    clearMocks: false,
    pool: "forks",
    isolate: true,
    fsModuleCache: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 5_000,
    setupFiles: ["./tests/vitest.setup.ts"],
    globalSetup: ["./tests/worktree-head-guard.ts"],
    include: [
      "tests/cli/prime/qdrant-ping.test.ts",
    ],
  },
});
