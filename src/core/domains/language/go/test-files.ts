import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/** Go test files: `go test` compiles exactly the `*_test.go` files. */
export const testFiles: TestFileConvention = {
  patterns: ["**/*_test.go"],
};
