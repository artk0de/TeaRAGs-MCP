import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../src/core/adapters/git/types.js";
import { buildBugFixShaSet } from "../../../../../../src/core/domains/trajectory/git/infra/merge-branch-resolver.js";

function commit(sha: string, parents: string[], body: string): CommitInfo {
  return { sha, author: "A", authorEmail: "a@a.com", timestamp: 0, body, parents };
}

describe("buildBugFixShaSet", () => {
  it("marks child of fix/ merge as bug fix", () => {
    const M = commit("m000", ["base", "c000"], "Merge branch 'fix/TD-123-bug' into 'master'");
    const C = commit("c000", ["base"], "[TD-123] Restore sorting param");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
    expect(result.has("m000")).toBe(false);
  });

  it("marks child of hotfix/ merge as bug fix", () => {
    const M = commit("m000", ["base", "c000"], "Merge branch 'hotfix/urgent-patch' into 'master'");
    const C = commit("c000", ["base"], "[HOTFIX] Return retry");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
  });

  it("marks child of bugfix/ merge as bug fix", () => {
    const M = commit("m000", ["base", "c000"], "Merge branch 'bugfix/TD-456-seat-decrease' into 'master'");
    const C = commit("c000", ["base"], "[TD-456] Fix seat targeting");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
  });

  it("marks GitHub PR merge with fix/ branch as bug fix", () => {
    const M = commit("m000", ["base", "c000"], "Merge pull request #42 from user/fix-auth-bypass");
    const C = commit("c000", ["base"], "Patch auth bypass vulnerability");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
  });

  it("does NOT mark children of feature/ merge", () => {
    const M = commit("m000", ["base", "c000"], "Merge branch 'feature/TD-789-new-ui' into 'master'");
    const C = commit("c000", ["base"], "[TD-789] New dashboard UI");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(false);
  });

  it("handles multi-commit fix branch via parent traversal", () => {
    const M = commit("m000", ["base", "c003"], "Merge branch 'fix/TD-100-multi' into 'master'");
    const C3 = commit("c003", ["c002"], "Final cleanup");
    const C2 = commit("c002", ["c001"], "Add test");
    const C1 = commit("c001", ["base"], "Initial fix attempt");
    const result = buildBugFixShaSet([M, C3, C2, C1]);
    expect(result.has("c001")).toBe(true);
    expect(result.has("c002")).toBe(true);
    expect(result.has("c003")).toBe(true);
  });

  it("does not traverse beyond mainline parent", () => {
    const M = commit("m000", ["prev", "c000"], "Merge branch 'fix/TD-200' into 'master'");
    const C = commit("c000", ["prev"], "[TD-200] Fix");
    const prev = commit("prev", ["older"], "feat: unrelated feature");
    const result = buildBugFixShaSet([M, C, prev]);
    expect(result.has("c000")).toBe(true);
    expect(result.has("prev")).toBe(false);
  });

  it("handles feature/ branch with fix in description (not a bug fix)", () => {
    const M = commit("m000", ["base", "c000"], "Merge branch 'feature/TD-999-fix-badges-in-comparison-page' into 'master'");
    const C = commit("c000", ["base"], "[TD-999] Fix badges");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(false);
  });

  it("returns empty set when no merges", () => {
    const C1 = commit("c001", ["c000"], "fix: direct commit");
    const C2 = commit("c000", [], "Initial");
    const result = buildBugFixShaSet([C1, C2]);
    expect(result.size).toBe(0);
  });
});
