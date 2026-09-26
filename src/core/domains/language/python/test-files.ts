import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/** Python test files: pytest's `test_*.py` / `*_test.py` discovery, and its `conftest.py` fixtures. */
export const testFiles: TestFileConvention = {
  patterns: ["**/test_*.py", "**/*_test.py", "**/conftest.py"],
};
