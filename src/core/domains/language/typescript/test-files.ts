import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/**
 * TypeScript test files: `*.test.*` / `*.spec.*` over every extension indexed
 * as TypeScript. `.mts` / `.cts` are TypeScript too (bd tea-rags-mcp-1y13c);
 * without them `worker.test.mts` entered the codegraph as production code.
 */
export const testFiles: TestFileConvention = {
  patterns: [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.test.mts",
    "**/*.test.cts",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.spec.mts",
    "**/*.spec.cts",
  ],
};
