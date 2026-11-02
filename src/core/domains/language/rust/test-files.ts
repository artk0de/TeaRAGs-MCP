import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/**
 * Rust test files by name: `*_test.rs`, and `tests.rs` — the conventional
 * body of `#[cfg(test)] mod tests;`. Integration tests live under `tests/`,
 * which the classifier's language-agnostic directory shapes already cover;
 * inline `#[cfg(test)]` items in other files are not a path fact.
 */
export const testFiles: TestFileConvention = {
  patterns: ["**/*_test.rs", "**/tests.rs"],
};
