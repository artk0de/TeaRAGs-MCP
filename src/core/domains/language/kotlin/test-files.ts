import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/** JUnit-style `*Test.kt`. PascalCase suffix, matched case-sensitively. */
export const testFiles: TestFileConvention = {
  patterns: ["**/*Test.kt"],
};
