/**
 * Reference `VcsGitAdapter` implementation over the git CLI — the equivalence
 * oracle every other git adapter is validated against. Methods delegate to
 * the battle-tested free functions in the sibling git-cli modules (`client.ts`
 * repo queries, `history.ts` log walks, `cat-file.ts` object reads,
 * `working-tree.ts` listings); this class only binds the repo root and adapts
 * names to the VCS contract vocabulary.
 */

import type {
  BlameLine,
  BlobBatchReader,
  CommitFileNumstat,
  CommitPathChanges,
  CommitWithChangedFiles,
  FileChurnData,
  OidBatchResolver,
} from "../../types.js";
import { VcsGitAdapter } from "../adapter.js";
import { createCatFileBatch, createCatFileBatchCheck, readBlobAsString } from "./cat-file.js";
import { getHead, isAncestor, readHeadCommitTime, writeCommitGraph } from "./client.js";
import {
  blameFile,
  buildViaCli,
  buildViaCliForPaths,
  getCommitsByPathspec,
  getCommitsInRange,
  getCommitsSince,
  readCommitFileNumstat,
  readCommitFileNumstatForPaths,
  readCommitPathChanges,
} from "./history.js";
import { listTreePaths, listWorktreeDeletions, listWorktreeModifications } from "./working-tree.js";

/** A full object name, SHA-1 or SHA-256 — never moves, unlike a ref name. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class GitCliAdapter extends VcsGitAdapter {
  async getHead(): Promise<string> {
    return getHead(this.repoRoot);
  }

  async readHeadCommitTime(timeoutMs?: number): Promise<number> {
    return readHeadCommitTime(this.repoRoot, timeoutMs);
  }

  /**
   * One `git merge-base --is-ancestor` per commit pair for the adapter's life
   * (bd tea-rags-mcp-0qaht.51): a warm run's file-churn and commit discoveries
   * both top up from the prior snapshot's head and ask the same pair. Ancestry
   * between two existing commits never changes, so a "yes" is kept, concurrent
   * asks share the in-flight child, and a "no" — which also stands for a failed
   * child — is dropped so the next ask retries. Ref names can move: only full
   * object names are kept.
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (!OBJECT_NAME.test(ancestor) || !OBJECT_NAME.test(descendant)) {
      return isAncestor(this.repoRoot, ancestor, descendant);
    }
    const key = `${ancestor}..${descendant}`;
    let answer = this.ancestryAnswers.get(key);
    if (answer === undefined) {
      answer = isAncestor(this.repoRoot, ancestor, descendant);
      this.ancestryAnswers.set(key, answer);
      void answer.then((isDescendant) => {
        if (!isDescendant) this.ancestryAnswers.delete(key);
      });
    }
    return answer;
  }

  private readonly ancestryAnswers = new Map<string, Promise<boolean>>();

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

  async readCommitFileNumstat(
    sinceDate?: Date,
    range?: { fromSha: string; toSha: string },
    timeoutMs?: number,
  ): Promise<CommitFileNumstat[]> {
    return readCommitFileNumstat(this.repoRoot, sinceDate, range, timeoutMs);
  }

  async readCommitPathChanges(timeoutMs?: number): Promise<CommitPathChanges[]> {
    return readCommitPathChanges(this.repoRoot, timeoutMs);
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

  async listTreePaths(commitOid: string, timeoutMs?: number): Promise<string[]> {
    return listTreePaths(this.repoRoot, commitOid, timeoutMs);
  }

  async listWorktreeDeletions(timeoutMs?: number): Promise<string[]> {
    return listWorktreeDeletions(this.repoRoot, timeoutMs);
  }

  async listWorktreeModifications(paths: readonly string[], timeoutMs?: number): Promise<string[]> {
    return listWorktreeModifications(this.repoRoot, paths, timeoutMs);
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

  async readCommitFileNumstatForPaths(paths: string[], timeoutMs?: number, since?: Date): Promise<CommitFileNumstat[]> {
    return readCommitFileNumstatForPaths(this.repoRoot, paths, timeoutMs, since);
  }

  createBlobBatchReader(): BlobBatchReader {
    return createCatFileBatch(this.repoRoot);
  }

  createOidBatchResolver(): OidBatchResolver {
    return createCatFileBatchCheck(this.repoRoot);
  }
}
