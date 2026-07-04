/**
 * Reference `VcsGitAdapter` implementation over the git CLI — the equivalence
 * oracle every other git adapter is validated against. Methods delegate to
 * the battle-tested free functions in `client.ts`; this class only binds the
 * repo root and adapts names to the VCS contract vocabulary.
 */

import type {
  BlameLine,
  BlobBatchReader,
  CommitWithChangedFiles,
  FileChurnData,
  OidBatchResolver,
} from "../../types.js";
import { VcsGitAdapter } from "../adapter.js";
import {
  blameFile,
  buildViaCli,
  createCatFileBatch,
  createCatFileBatchCheck,
  getCommitsByPathspec,
  getCommitsInRange,
  getCommitsSince,
  getHead,
  isAncestor,
  readBlobAsString,
} from "./client.js";

export class GitCliAdapter extends VcsGitAdapter {
  async getHead(): Promise<string> {
    return getHead(this.repoRoot);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return isAncestor(this.repoRoot, ancestor, descendant);
  }

  async readNumstatLog(sinceDate?: Date, timeoutMs?: number): Promise<Map<string, FileChurnData>> {
    return buildViaCli(this.repoRoot, sinceDate, timeoutMs);
  }

  async getCommitsSince(sinceDate: Date, timeoutMs?: number): Promise<CommitWithChangedFiles[]> {
    return getCommitsSince(this.repoRoot, sinceDate, timeoutMs);
  }

  async getCommitsInRange(
    fromSha: string,
    toSha: string,
    sinceDate: Date,
    timeoutMs?: number,
  ): Promise<CommitWithChangedFiles[]> {
    return getCommitsInRange(this.repoRoot, fromSha, toSha, sinceDate, timeoutMs);
  }

  async readBlobAsString(commitOid: string, filepath: string): Promise<string> {
    return readBlobAsString(this.repoRoot, commitOid, filepath);
  }

  async blameFile(filePath: string, timeoutMs?: number): Promise<BlameLine[]> {
    return blameFile(this.repoRoot, filePath, timeoutMs);
  }

  async getCommitsByPathspec(
    sinceDate: Date,
    filePaths: string[],
    timeoutMs?: number,
  ): Promise<CommitWithChangedFiles[]> {
    return getCommitsByPathspec(this.repoRoot, sinceDate, filePaths, timeoutMs);
  }

  createBlobBatchReader(): BlobBatchReader {
    return createCatFileBatch(this.repoRoot);
  }

  createOidBatchResolver(): OidBatchResolver {
    return createCatFileBatchCheck(this.repoRoot);
  }
}
