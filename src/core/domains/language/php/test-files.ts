import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/** PHPUnit's `*Test.php`. PascalCase suffix, matched case-sensitively. */
export const testFiles: TestFileConvention = {
  patterns: ["**/*Test.php"],
};
