/**
 * Hybrid git adapter for `GIT_ADAPTER=es-git`: PER-FILE ops run in-process
 * over the es-git binding (napi-rs / libgit2), BULK HISTORY sweeps delegate
 * to the git CLI. Validated against the `GitCliAdapter` oracle by the
 * equivalence suites in `tests/core/adapters/vcs/git/es-git/`.
 *
 * Why hybrid (measured on the taxdome monolith, 2026-07-05):
 * - blame is thousands of per-file operations per run — the CLI pays one
 *   process SPAWN each, and EDR throttles spawns machine-wide (~10/s):
 *   112ms/file CLI vs 43ms/file in-process → es-git wins 2.6x.
 * - a whole-history numstat sweep is ONE spawn per run — EDR-irrelevant —
 *   and `git log --numstat` streams at C speed, while a JS-side revwalk with
 *   a per-commit tree diff took 306.5s vs the CLI's 29.5s (10.4x): the
 *   in-process walk lost on merit and was deleted.
 *
 * API mapping (es-git 0.7 — names read from `node_modules/es-git/index.d.ts`):
 *
 * | VcsGitAdapter op       | Implementation                                                             |
 * | ---------------------- | -------------------------------------------------------------------------- |
 * | open                   | `openRepository(repoRoot)` — ONCE; the handle is owned by the adapter      |
 * | getHead                | `repo.revparseSingle("HEAD")`                                               |
 * | isAncestor             | `repo.getMergeBase(a, d) === a` on `^{commit}`-peeled oids; throw → false  |
 * | blameFile              | `repo.blameFile(f, { newestCommit, useMailmap: true })`, hunks expanded    |
 * |                        | per line via `getHunkByIndex` (`finalCommitId` + author `finalSignature`)  |
 * | readBlobAsString       | `revparseSingle("<oid>:<path>")` → `getObject(..).peelToBlob().content()`  |
 * | createBlobBatchReader  | closure over the SAME open repo handle + closed flag                       |
 * | createOidBatchResolver | `revparseSingle(rev)`; throw → null; closed flag                           |
 * | readNumstatLog         | DELEGATED → GitCliAdapter (`git log HEAD --numstat [--since]`, one spawn)  |
 * | readNumstatLogForPaths | DELEGATED → GitCliAdapter (`git log HEAD --numstat -- <paths>`)            |
 * | getCommitsSince        | DELEGATED → GitCliAdapter (`git log --since --numstat`)                    |
 * | getCommitsInRange      | DELEGATED → GitCliAdapter (`git log --since from..to --numstat`)           |
 * | getCommitsByPathspec   | DELEGATED → GitCliAdapter (`git log --since --numstat -- <paths>`)         |
 *
 * `timeoutMs` parameters are intentionally NOT declared on the in-process
 * overrides — no child process to bound. The delegated history ops inherit
 * the CLI defaults (the base-class optional args pass through untouched).
 */

import { openRepository, type Repository } from "es-git";

import type {
  BlameLine,
  BlobBatchReader,
  CommitWithChangedFiles,
  FileChurnData,
  OidBatchResolver,
} from "../../types.js";
import { VcsGitAdapter } from "../adapter.js";
import { GitCliAdapter } from "../git-cli/adapter.js";

export class EsGitAdapter extends VcsGitAdapter {
  /** Bulk-history delegate — one `git log` spawn per sweep (see module doc). */
  private readonly cliHistory: GitCliAdapter;

  private constructor(
    repoRoot: string,
    private readonly repo: Repository,
  ) {
    super(repoRoot);
    this.cliHistory = new GitCliAdapter(repoRoot);
  }

  /** Opens the repository ONCE; the handle lives as long as the adapter. */
  static async open(repoRoot: string): Promise<EsGitAdapter> {
    const repo = await openRepository(repoRoot);
    return new EsGitAdapter(repoRoot, repo);
  }

  async getHead(): Promise<string> {
    return this.repo.revparseSingle("HEAD");
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    // CLI semantics: ANY failure (bad rev, unknown oid, not a repo state)
    // resolves false — callers treat it as "cannot top up, rebuild fully".
    try {
      const ancestorOid = this.repo.revparseSingle(`${ancestor}^{commit}`);
      const descendantOid = this.repo.revparseSingle(`${descendant}^{commit}`);
      return this.repo.getMergeBase(ancestorOid, descendantOid) === ancestorOid;
    } catch {
      return false;
    }
  }

  async readNumstatLog(sinceDate?: Date, timeoutMs?: number): Promise<Map<string, FileChurnData>> {
    return this.cliHistory.readNumstatLog(sinceDate, timeoutMs);
  }

  async getCommitsSince(sinceDate: Date, timeoutMs?: number): Promise<CommitWithChangedFiles[]> {
    return this.cliHistory.getCommitsSince(sinceDate, timeoutMs);
  }

  async getCommitsInRange(
    fromSha: string,
    toSha: string,
    sinceDate: Date,
    timeoutMs?: number,
  ): Promise<CommitWithChangedFiles[]> {
    return this.cliHistory.getCommitsInRange(fromSha, toSha, sinceDate, timeoutMs);
  }

  async readBlobAsString(commitOid: string, filepath: string): Promise<string> {
    try {
      const blobOid = this.repo.revparseSingle(`${commitOid}:${filepath}`);
      const blob = this.repo.getObject(blobOid).peelToBlob();
      return Buffer.from(blob.content()).toString("utf8");
    } catch {
      return ""; // path absent at that commit / not a blob — CLI cat-file parity
    }
  }

  async blameFile(filePath: string): Promise<BlameLine[]> {
    // Untracked / missing / unblameable paths yield [] — absence of blame
    // data is "no ownership signal", never an error (CLI parity).
    try {
      const head = this.repo.revparseSingle("HEAD");
      // git blame applies .mailmap by default (empirically pinned) — mirror it.
      const blame = this.repo.blameFile(filePath, { newestCommit: head, useMailmap: true });
      const lines: BlameLine[] = [];
      for (let index = 0; index < blame.getHunkCount(); index++) {
        const hunk = blame.getHunkByIndex(index);
        const signature = hunk.finalSignature;
        if (signature === undefined) continue; // CLI parser also drops author-less entries
        for (let offset = 0; offset < hunk.linesInHunk; offset++) {
          lines.push({
            lineNumber: hunk.finalStartLineNumber + offset,
            sha: hunk.finalCommitId,
            author: signature.name,
            authorEmail: signature.email,
            timestamp: signature.timestamp,
          });
        }
      }
      lines.sort((a, b) => a.lineNumber - b.lineNumber);
      return lines;
    } catch {
      return [];
    }
  }

  async getCommitsByPathspec(
    sinceDate: Date,
    filePaths: string[],
    timeoutMs?: number,
  ): Promise<CommitWithChangedFiles[]> {
    return this.cliHistory.getCommitsByPathspec(sinceDate, filePaths, timeoutMs);
  }

  async readNumstatLogForPaths(paths: string[], timeoutMs?: number): Promise<Map<string, FileChurnData>> {
    return this.cliHistory.readNumstatLogForPaths(paths, timeoutMs);
  }

  createBlobBatchReader(): BlobBatchReader {
    // Reads go through the SAME open repository handle — there is no per-batch
    // resource to spawn; the closed flag alone enforces the lifecycle contract.
    let closed = false;
    return {
      read: async (commitOid: string, filepath: string): Promise<string> => {
        if (closed) throw new Error("EsGit blob batch reader is closed");
        return this.readBlobAsString(commitOid, filepath);
      },
      close: async (): Promise<void> => {
        closed = true; // the repo handle stays owned by the adapter
      },
    };
  }

  createOidBatchResolver(): OidBatchResolver {
    let closed = false;
    return {
      check: async (rev: string): Promise<string | null> => {
        if (closed) throw new Error("EsGit oid batch resolver is closed");
        try {
          return this.repo.revparseSingle(rev);
        } catch {
          return null; // `<rev> missing` on the CLI batch-check
        }
      },
      close: async (): Promise<void> => {
        closed = true;
      },
    };
  }
}
