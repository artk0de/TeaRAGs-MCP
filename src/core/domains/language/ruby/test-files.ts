import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/** Ruby test files: Minitest's `*_test.rb`, RSpec's `*_spec.rb`. */
export const testFiles: TestFileConvention = {
  patterns: ["**/*_test.rb", "**/*_spec.rb"],
};
