import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/**
 * Swift test files: XCTest's `*Tests.swift` / `*Test.swift`. PascalCase
 * suffixes, matched case-sensitively — `Latest.swift` is production code (bd
 * tea-rags-mcp-ezm9o). SwiftPM's `Tests/` directory is one of the classifier's
 * language-agnostic directory shapes.
 */
export const testFiles: TestFileConvention = {
  patterns: ["**/*Test.swift", "**/*Tests.swift"],
};
