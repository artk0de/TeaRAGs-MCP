import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/**
 * Rust test files by name: `*_test.rs`. Integration tests live under `tests/`,
 * which the classifier's language-agnostic directory shapes already cover;
 * inline `#[cfg(test)]` modules are not a path fact.
 */
export const testFiles: TestFileConvention = {
  patterns: ["**/*_test.rs"],
};
