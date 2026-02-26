import { describe, expect, it } from "vitest";

import { extractTaskIds } from "../../../../../src/core/trajectory/git/infra/utils.js";

describe("extractTaskIds", () => {
  it("extracts JIRA-style IDs", () => {
    expect(extractTaskIds("fix: resolve TD-1234 issue")).toEqual(["TD-1234"]);
  });

  it("extracts GitHub-style IDs", () => {
    expect(extractTaskIds("closes #123")).toEqual(["#123"]);
  });

  it("extracts Azure DevOps IDs", () => {
    const result = extractTaskIds("AB#456 done");
    expect(result).toContain("AB#456");
  });

  it("extracts GitLab MR IDs", () => {
    expect(extractTaskIds("merged !789")).toEqual(["!789"]);
  });

  it("returns empty for empty input", () => {
    expect(extractTaskIds("")).toEqual([]);
  });

  it("extracts multiple IDs", () => {
    const result = extractTaskIds("TD-1 #2 AB#3 !4");
    expect(result).toContain("TD-1");
    expect(result).toContain("#2");
    expect(result).toContain("AB#3");
    expect(result).toContain("!4");
  });
});
