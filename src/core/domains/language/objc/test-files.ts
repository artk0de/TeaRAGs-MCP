import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/** XCTest implementation files. PascalCase suffixes, matched case-sensitively. */
export const testFiles: TestFileConvention = {
  patterns: ["**/*Test.m", "**/*Tests.m"],
};
