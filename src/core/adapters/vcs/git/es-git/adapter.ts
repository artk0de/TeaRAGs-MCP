/**
 * Hybrid git adapter for `GIT_ADAPTER=es-git`: single-object / ref lookups run
 * in-process over the es-git binding (napi-rs / libgit2); the bulk numstat
 * sweeps AND per-file blame always delegate to the git CLI. Validated against
 * the `GitCliAdapter` oracle by the equivalence suites in
 * `tests/core/adapters/vcs/git/es-git/`.
 *
 * Why hybrid (measured on the taxdome monolith):
 * - in-process WINS for O(1)-ish object reads — revparse, blob read, merge-base.
 *   No history walk, so libgit2 is fast (value here is unmeasured on a large
 *   repo — bd tea-rags-mcp: benchmark blob-reads vs `cat-file --batch`).
 * - in-process LOSES for history walks: libgit2 has no commit-graph/bitmap
 *   acceleration. A whole-history numstat revwalk took 306.5s vs the CLI's 29.5s
 *   (10.4x). BLAME is even worse: `git_blame__like_git` reads objects per-commit
 *   with no commit-graph, so on a large repo even a SHALLOW file costs ~12.5s
 *   vs ~0.2s native `git blame` (60x, 2026-07-06). So blame ALWAYS delegates to
 *   native `git blame`; parallel `git blame` sustains ~69-89/s (EDR does not cap
 *   aggregate), and the caller's blame worker pool bounds concurrency.
 *
 * API mapping (es-git 0.7 — names read from `node_modules/es-git/index.d.ts`):
 *
 * | VcsGitAdapter op       | Implementation                                                             |
 * | ---------------------- | -------------------------------------------------------------------------- |
 * | open                   | `openRepository(repoRoot)` — ONCE; the handle is owned by the adapter      |
 * | getHead                | `repo.revparseSingle("HEAD")`                                               |
 * | isAncestor             | `repo.getMergeBase(a, d) === a` on `^{commit}`-peeled oids; throw → false  |
 * | blameFile              | DELEGATED → GitCliAdapter (`git blame`; in-process libgit2 blame is 60x slower on large repos) |
 * | readBlobAsString       | `revparseSingle("<oid>:<path>")` → `getObject(..).peelToBlob().content()`  |
 * | createBlobBatchReader  | closure over the SAME open repo handle + closed flag                       |
 * | createOidBatchResolver | `revparseSingle(rev)`; throw → null; closed flag                           |
 * | readNumstatLog         | DELEGATED → GitCliAdapter (`git log HEAD --numstat [--since]`, one spawn)  |
 * | readNumstatLogForPaths | DELEGATED → GitCliAdapter (`git log HEAD --numstat -- <paths>`)            |
 * | getCommitsSince        | DELEGATED → GitCliAdapter (`git log --since --numstat`)                    |
 * | getCommitsInRange      | DELEGATED → GitCliAdapter (`git log --since from..to --numstat`)           |
 * | getCommitsByPathspec   | DELEGATED → GitCliAdapter (`git log --since --numstat -- <paths>`)         |
 *
 * `timeoutMs` is forwarded on the DELEGATED ops (blame + history) — each bounds
 * a real child process. The pure in-process lookups (getHead, isAncestor,
 * readBlobAsString, the batch readers) take no `timeoutMs`: no process to bound.
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
  /** Bulk-history + BLAME delegate — one `git` spawn per op (see module doc). */
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

  async blameFile(filePath: string, timeoutMs?: number, _historyDepthHint?: number): Promise<BlameLine[]> {
    // DELEGATED to native `git blame`. Measured on the taxdome monolith
    // (2026-07-06): in-process libgit2 blame has no commit-graph acceleration, so
    // even a SHALLOW file costs ~12.5s (git_odb_read pack access dominates), vs
    // ~0.2s for native `git blame` — a 60x loss. Parallel native `git blame`
    // sustains 69-89 blames/s (6-12 way), so the EDR spawn-throttle that once
    // motivated an in-process path does not cap aggregate throughput. Concurrency
    // is bounded by the caller's blame worker pool, not a per-adapter cap.
    return this.cliHistory.blameFile(filePath, timeoutMs);
  }

  async writeCommitGraph(timeoutMs?: number): Promise<void> {
    return this.cliHistory.writeCommitGraph(timeoutMs);
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
