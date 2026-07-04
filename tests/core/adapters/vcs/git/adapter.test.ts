import { describe, expect, it } from "vitest";

import { VcsGitAdapter } from "../../../../../src/core/adapters/vcs/git/adapter.js";
import type {
  BlameLine,
  BlobBatchReader,
  CommitWithChangedFiles,
  FileChurnData,
  OidBatchResolver,
} from "../../../../../src/core/adapters/vcs/types.js";

class StubGitAdapter extends VcsGitAdapter {
  getHead = async (): Promise<string> => "head-sha";
  isAncestor = async (): Promise<boolean> => false;
  readNumstatLog = async (): Promise<Map<string, FileChurnData>> => new Map();
  getCommitsSince = async (): Promise<CommitWithChangedFiles[]> => [];
  getCommitsInRange = async (): Promise<CommitWithChangedFiles[]> => [];
  readBlobAsString = async (): Promise<string> => "";
  blameFile = async (): Promise<BlameLine[]> => [];
  getCommitsByPathspec = async (): Promise<CommitWithChangedFiles[]> => [];
  readNumstatLogForPaths = async (): Promise<Map<string, FileChurnData>> => new Map();
  createBlobBatchReader = (): BlobBatchReader => ({ read: async () => "", close: async () => {} });
  createOidBatchResolver = (): OidBatchResolver => ({ check: async () => null, close: async () => {} });
}

describe("VcsGitAdapter", () => {
  it("is repo-scoped: binds repoRoot at construction", () => {
    const adapter = new StubGitAdapter("/some/repo");
    expect(adapter.repoRoot).toBe("/some/repo");
  });

  it("declares the git-strength ops beyond the portable VcsAdapter contract", () => {
    const adapter = new StubGitAdapter("/some/repo");
    expect(typeof adapter.getCommitsByPathspec).toBe("function");
    expect(typeof adapter.readNumstatLogForPaths).toBe("function");
    expect(typeof adapter.createBlobBatchReader).toBe("function");
    expect(typeof adapter.createOidBatchResolver).toBe("function");
  });
});
