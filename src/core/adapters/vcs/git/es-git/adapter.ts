/**
 * In-process git adapter over the es-git binding (napi-rs / libgit2) — the
 * `GIT_ADAPTER=es-git` implementation, validated against the `GitCliAdapter`
 * oracle by the equivalence suites in `tests/core/adapters/vcs/git/es-git/`.
 *
 * API mapping (es-git 0.7 — names read from `node_modules/es-git/index.d.ts`):
 *
 * | VcsGitAdapter op       | git CLI (oracle)                        | es-git                                                                   |
 * | ---------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
 * | open                   | —                                       | `openRepository(repoRoot)` — ONCE; the handle is owned by the adapter     |
 * | getHead                | `git rev-parse HEAD`                    | `repo.revparseSingle("HEAD")`                                             |
 * | isAncestor             | `git merge-base --is-ancestor A D`      | `repo.getMergeBase(a, d) === a` on `^{commit}`-peeled oids; throw → false |
 * | blameFile              | `git blame --porcelain HEAD -- <f>`     | `repo.blameFile(f, { newestCommit, useMailmap: true })`, hunks expanded   |
 * |                        |                                         | per line via `getHunkByIndex` (`finalCommitId` + author `finalSignature`) |
 * | readBlobAsString       | `git cat-file blob <oid>:<path>`        | `revparseSingle("<oid>:<path>")` → `getObject(..).peelToBlob().content()` |
 * | createBlobBatchReader  | persistent `git cat-file --batch`       | closure over the SAME open repo handle + closed flag                      |
 * | createOidBatchResolver | persistent `git cat-file --batch-check` | `revparseSingle(rev)`; throw → null; closed flag                          |
 * | readNumstatLog         | `git log HEAD --numstat [--since]`      | revwalk in default order + per-commit tree diff (history-walk.ts)         |
 * | readNumstatLogForPaths | `git log HEAD --numstat -- <paths>`     | manual simplify-history pathspec walk (history-walk.ts)                   |
 * | getCommitsSince        | `git log --since --numstat`             | revwalk + committer-date bound                                            |
 * | getCommitsInRange      | `git log --since from..to --numstat`    | revwalk `push(to)` + `hide(from)` + committer-date bound                  |
 * | getCommitsByPathspec   | `git log --since --numstat -- <paths>`  | manual simplify-history pathspec walk + committer-date bound              |
 * | commit parents (`%P`)  | `--format=%P`                           | `revparseSingle("<sha>^<n>")` probing — 0.7 has no parent accessor        |
 * | per-file +/- counts    | `--numstat` columns                     | `diff.print({format:"Patch"})` with `contextLines: 0`; counts read from   |
 * |                        |                                         | `@@ -a,b +c,d @@` headers (es-git print strips content origin prefixes)   |
 * | rename detection       | `diff.renames` config (default ON)      | `diff.findSimilar({renames,...})` toggled by the SAME config; combined    |
 * |                        |                                         | `pfx{old => new}sfx` numstat path is a port of git's `pprint_rename`      |
 *
 * `timeoutMs` parameters are intentionally NOT declared on the overrides:
 * every operation is an in-process libgit2 call with no child process to
 * bound — the CLI timeouts exist solely to reap hung `git` spawns. Extra
 * arguments are ignored by the JS calling convention.
 *
 * Merge-commit numstat semantics (empirically pinned by the fixture):
 * `git log --numstat` without `-m` emits merge headers with NO file rows and
 * the CLI parsers drop row-less commits — merges never surface in any history
 * op output, so the walks skip diffing them entirely.
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
import { readRenameDetectionMode, type RenameDetectionMode } from "./diff-numstat.js";
import {
  aggregateCommitsWithChangedFiles,
  aggregateFileChurn,
  collectPathspecLogEntries,
  collectPlainLogEntries,
} from "./history-walk.js";

/** `--since` bounds compare committer dates at whole-second precision. */
const toSinceSec = (sinceDate: Date): number => Math.floor(sinceDate.getTime() / 1000);

export class EsGitAdapter extends VcsGitAdapter {
  private constructor(
    repoRoot: string,
    private readonly repo: Repository,
    private readonly renameMode: RenameDetectionMode,
  ) {
    super(repoRoot);
  }

  /** Opens the repository ONCE; the handle lives as long as the adapter. */
  static async open(repoRoot: string): Promise<EsGitAdapter> {
    const repo = await openRepository(repoRoot);
    return new EsGitAdapter(repoRoot, repo, readRenameDetectionMode(repo));
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

  async readNumstatLog(sinceDate?: Date): Promise<Map<string, FileChurnData>> {
    return aggregateFileChurn(
      collectPlainLogEntries(this.repo, this.renameMode, {
        toRev: "HEAD",
        sinceSec: sinceDate === undefined ? undefined : toSinceSec(sinceDate),
      }),
    );
  }

  async getCommitsSince(sinceDate: Date): Promise<CommitWithChangedFiles[]> {
    return aggregateCommitsWithChangedFiles(
      collectPlainLogEntries(this.repo, this.renameMode, { toRev: "HEAD", sinceSec: toSinceSec(sinceDate) }),
    );
  }

  async getCommitsInRange(fromSha: string, toSha: string, sinceDate: Date): Promise<CommitWithChangedFiles[]> {
    return aggregateCommitsWithChangedFiles(
      collectPlainLogEntries(this.repo, this.renameMode, {
        toRev: toSha,
        fromRev: fromSha,
        sinceSec: toSinceSec(sinceDate),
      }),
    );
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

  async getCommitsByPathspec(sinceDate: Date, filePaths: string[]): Promise<CommitWithChangedFiles[]> {
    if (filePaths.length === 0) return [];
    return aggregateCommitsWithChangedFiles(
      collectPathspecLogEntries(this.repo, this.renameMode, filePaths, toSinceSec(sinceDate)),
    );
  }

  async readNumstatLogForPaths(paths: string[]): Promise<Map<string, FileChurnData>> {
    if (paths.length === 0) return new Map();
    // CLI parity: per-batch failures are swallowed there — absent paths and
    // walk failures yield an empty map, never a rejection.
    try {
      return aggregateFileChurn(collectPathspecLogEntries(this.repo, this.renameMode, paths));
    } catch {
      return new Map();
    }
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
