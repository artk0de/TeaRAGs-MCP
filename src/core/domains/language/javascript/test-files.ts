import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/** JavaScript test files: `*.test.*` / `*.spec.*` over every JavaScript extension. */
export const testFiles: TestFileConvention = {
  patterns: [
    "**/*.test.js",
    "**/*.test.jsx",
    "**/*.test.mjs",
    "**/*.test.cjs",
    "**/*.spec.js",
    "**/*.spec.jsx",
    "**/*.spec.mjs",
    "**/*.spec.cjs",
  ],
};
