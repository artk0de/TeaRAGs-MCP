/**
 * Hybrid git adapter for `GIT_ADAPTER=es-git`: single-object / ref lookups run
 * in-process over the es-git binding (napi-rs / libgit2); the bulk numstat
 * sweeps always delegate to the git CLI; per-file blame is DEPTH-ROUTED —
 * shallow in-process, deep to the CLI. Validated against the `GitCliAdapter`
 * oracle by the equivalence suites in `tests/core/adapters/vcs/git/es-git/`.
 *
 * Why hybrid (measured on the taxdome monolith, 2026-07-05):
 * - in-process WINS for O(1)-ish object reads — revparse, blob read, merge-base.
 *   No history walk, so libgit2 is fast, and it dodges the per-call process
 *   SPAWN that EDR throttles machine-wide (~10/s).
 * - in-process LOSES for history walks: libgit2 has no commit-graph/bitmap
 *   acceleration. `git_blame__like_git` runs a per-commit `git_diff_tree_to_tree`
 *   — fine on shallow files (444ms at 6 commits) but 16-124s PER FILE past a few
 *   dozen commits vs a flat ~300ms native (48-400x). A whole-history numstat
 *   revwalk took 306.5s vs the CLI's 29.5s (10.4x).
 * - so blame is depth-routed by commit count: shallow stays in-process (light,
 *   spawn-free), deep goes to native `git blame` under a concurrency cap (each
 *   spawn resident-sets ~1GB on this monolith — an uncapped pool OOM-kills the
 *   worker). Numstat always delegates (one spawn, EDR-irrelevant).
 *
 * API mapping (es-git 0.7 — names read from `node_modules/es-git/index.d.ts`):
 *
 * | VcsGitAdapter op       | Implementation                                                             |
 * | ---------------------- | -------------------------------------------------------------------------- |
 * | open                   | `openRepository(repoRoot)` — ONCE; the handle is owned by the adapter      |
 * | getHead                | `repo.revparseSingle("HEAD")`                                               |
 * | isAncestor             | `repo.getMergeBase(a, d) === a` on `^{commit}`-peeled oids; throw → false  |
 * | blameFile              | DEPTH-ROUTED: <min-commits in-process es-git; ≥ → CLI (capped concurrency) |
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

/** Read a positive-integer env knob, else the default. */
function envPositiveInt(key: string, fallback: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Commit-count at/above which a file's blame goes to native `git blame`
 *  instead of in-process es-git — past a few dozen commits libgit2's blame both
 *  stalls (16-124s) and balloons memory. Env-tunable. */
const BLAME_CLI_MIN_COMMITS = envPositiveInt("TRAJECTORY_GIT_BLAME_CLI_MIN_COMMITS", 30);
/** Max concurrent native `git blame` spawns. Each resident-sets ~1GB on a
 *  deep-history monolith file; 10 in parallel OOM-killed a run, so cap it low.
 *  Shallow in-process blames are unbounded by this. Env-tunable. */
const BLAME_CLI_MAX_CONCURRENCY = envPositiveInt("TRAJECTORY_GIT_BLAME_CLI_CONCURRENCY", 2);

/** Minimal counting semaphore — bounds concurrent CLI-blame spawns so the
 *  enrichment pool can't OOM by launching one 1GB `git blame` per worker. */
class BlameConcurrencyGate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export class EsGitAdapter extends VcsGitAdapter {
  /** Bulk-history delegate — one `git log` spawn per sweep (see module doc). */
  private readonly cliHistory: GitCliAdapter;
  /** Caps concurrent native `git blame` spawns for deep-history files (OOM guard). */
  private readonly cliBlameSemaphore = new BlameConcurrencyGate(BLAME_CLI_MAX_CONCURRENCY);

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

  async blameFile(filePath: string, timeoutMs?: number, historyDepthHint?: number): Promise<BlameLine[]> {
    // DEPTH-ROUTED HYBRID. libgit2's `git_blame__like_git` runs a per-commit
    // `git_diff_tree_to_tree` — O(commits × tree-diff), no commit-graph/bitmap.
    // Measured on the taxdome monolith (2026-07-05): fine for shallow files
    // (444ms at 6 commits) but 16-124s PER FILE past a few dozen commits — a SYNC
    // napi call that stalls the enrichment worker. So deep-history files go to
    // native `git blame` (flat ~300ms), which is also memory-heavy (~1GB resident
    // per spawn on this monolith — 10 in parallel OOM-killed a run), hence a
    // concurrency cap on the CLI path. Shallow files stay in-process:
    // allocation-light and spawn-free (EDR-immune).
    if (historyDepthHint !== undefined && historyDepthHint >= BLAME_CLI_MIN_COMMITS) {
      return this.cliBlameSemaphore.run(async () => this.cliHistory.blameFile(filePath, timeoutMs));
    }
    return this.blameFileInProcess(filePath);
  }

  /** In-process es-git blame for shallow-history files — fast and spawn-free.
   *  Untracked / missing / unblameable paths yield [] (CLI parity). */
  private blameFileInProcess(filePath: string): BlameLine[] {
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
