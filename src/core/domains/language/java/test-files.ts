import type { TestFileConvention } from "../../../contracts/types/file-classification.js";

/**
 * Java test files: Surefire's `*Test` / `*Tests`, Failsafe's `*IT`. PascalCase
 * suffixes, matched case-sensitively — `Latest.java` and `Audit.java` are
 * production classes (bd tea-rags-mcp-ezm9o).
 */
export const testFiles: TestFileConvention = {
  patterns: ["**/*Test.java", "**/*Tests.java", "**/*IT.java"],
};
