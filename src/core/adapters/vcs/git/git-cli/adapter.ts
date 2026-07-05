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
  buildViaCliForPaths,
  createCatFileBatch,
  createCatFileBatchCheck,
  getCommitsByPathspec,
  getCommitsInRange,
  getCommitsSince,
  getHead,
  isAncestor,
  readBlobAsString,
  writeCommitGraph,
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

  async blameFile(filePath: string, timeoutMs?: number, _historyDepthHint?: number): Promise<BlameLine[]> {
    // The CLI adapter always shells out to native `git blame`; the depth hint is
    // an es-git-hybrid concern (in-process vs CLI routing) with nothing to do here.
    return blameFile(this.repoRoot, filePath, timeoutMs);
  }

  async writeCommitGraph(timeoutMs?: number): Promise<void> {
    return writeCommitGraph(this.repoRoot, timeoutMs);
  }

  async getCommitsByPathspec(
    sinceDate: Date,
    filePaths: string[],
    timeoutMs?: number,
  ): Promise<CommitWithChangedFiles[]> {
    return getCommitsByPathspec(this.repoRoot, sinceDate, filePaths, timeoutMs);
  }

  async readNumstatLogForPaths(paths: string[], timeoutMs?: number): Promise<Map<string, FileChurnData>> {
    return buildViaCliForPaths(this.repoRoot, paths, timeoutMs);
  }

  createBlobBatchReader(): BlobBatchReader {
    return createCatFileBatch(this.repoRoot);
  }

  createOidBatchResolver(): OidBatchResolver {
    return createCatFileBatchCheck(this.repoRoot);
  }
}
