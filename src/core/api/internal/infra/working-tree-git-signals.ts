/**
 * On-demand git signals for working-tree delta rows (bd tea-rags-mcp-xi2r9,
 * D12) — the `WorkingTreeGitSignalSource` the delta signals ask for what no
 * base point answers: `git.file` of a file the base never chunked (`src/cyc/c.ts`,
 * 3 lines, below the chunk floor; a file committed after the index) and
 * `git.chunk` of a row whose symbol the base never held. Without it such rows
 * rank as code with no history under every git preset.
 *
 * Lives in `api/internal` because it bridges what explore may not see: the git
 * trajectory's own computation (`buildOnDemandGitSignals`).
 *
 * - Paths arrive relative to the TREE root, which may sit below its git
 *   toplevel; git is asked at the toplevel, the answer named back.
 * - A row's lines are the tree file's (`treePath`); its history is the history
 *   path's (a move's old path), read at HEAD.
 * - Cached per (toplevel, HEAD, path, line extent) for `git.file` and per
 *   (toplevel, HEAD, path, tree-file content sha, range) for `git.chunk`:
 *   history moves only with HEAD, a row's attribution also with the working
 *   content it is read against. "No history" is cached too.
 * - Never rejects: a failed read answers nothing, the next request retries.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { VcsAdapterFactory } from "../../../adapters/vcs/factory.js";
import type { GitAdapterKind } from "../../../adapters/vcs/types.js";
import type {
  WorkingTreeGitSignals,
  WorkingTreeGitSignalSource,
  WorkingTreeGitSignalTarget,
} from "../../../contracts/types/working-tree.js";
import {
  buildOnDemandGitSignals,
  type OnDemandGitSignalOptions,
  type OnDemandGitSignalTarget,
  type SquashOptions,
} from "../../../domains/trajectory/git/index.js";
import { findGitToplevel, gitPathFromRoot, gitPathPrefix, readRepoGitState } from "../../../infra/repo-git-state.js";

/** Computed blocks kept per process; a miss costs a `git log`, a `git blame` and a chunk walk. */
const SIGNAL_CACHE_SIZE = 4_000;

export interface WorkingTreeGitSignalSourceDeps {
  /** The git adapter kind ingest runs (`GIT_ADAPTER`). */
  vcsAdapter: GitAdapterKind;
  /** Per git-call stall budget of the file walk (`TRAJECTORY_GIT_LOG_TIMEOUT_MS`). */
  timeoutMs: number;
  /** Squash-aware session grouping, as ingest computes `commitCount`. */
  squashOpts?: SquashOptions;
  /** The chunk walk's window and budgets (`TRAJECTORY_GIT_CHUNK_*`). */
  chunk: OnDemandGitSignalOptions["chunk"];
}

type CachedBlock = Record<string, unknown> | null;

/** One target's misses, ready for the trajectory call. */
interface PendingTarget {
  target: WorkingTreeGitSignalTarget;
  gitPath: string;
  fileKey: string;
  wantFile: boolean;
  chunkKeys: Map<string, string>;
  workingContent?: string;
}

export function createWorkingTreeGitSignalSource(deps: WorkingTreeGitSignalSourceDeps): WorkingTreeGitSignalSource {
  const cache = new Map<string, CachedBlock>();

  const remember = (key: string, value: CachedBlock): void => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > SIGNAL_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  };

  return {
    signalsOf: async (root, targets) => {
      const answered = new Map<string, WorkingTreeGitSignals & { chunks: Map<string, Record<string, unknown>> }>();
      if (targets.length === 0) return answered;
      const toplevel = findGitToplevel(root);
      const head = toplevel ? readRepoGitState(toplevel)?.commit : undefined;
      if (!toplevel || !head) return answered;
      const prefix = gitPathPrefix(toplevel, root);
      const answerOf = (path: string) => {
        let answer = answered.get(path);
        if (!answer) {
          answer = { chunks: new Map() };
          answered.set(path, answer);
        }
        return answer;
      };

      const pending: PendingTarget[] = [];
      for (const target of targets) {
        const gitPath = gitPathFromRoot(target.relativePath, prefix);
        const fileKey = `${toplevel}\0${head}\0${gitPath}\0file\0${target.maxEndLine}`;
        let wantFile = false;
        if (target.fileSignals) {
          const cached = cache.get(fileKey);
          if (cached === undefined) wantFile = true;
          else if (cached !== null) answerOf(target.relativePath).file = cached;
        }
        const chunkKeys = new Map<string, string>();
        let workingContent: string | undefined;
        if (target.chunks.length > 0) {
          workingContent = await fs.readFile(join(root, target.treePath), "utf8").catch(() => undefined);
        }
        if (workingContent !== undefined) {
          const sha = createHash("sha1").update(workingContent).digest("hex");
          for (const chunk of target.chunks) {
            const key = `${toplevel}\0${head}\0${gitPath}\0chunk\0${sha}\0${chunk.startLine}-${chunk.endLine}`;
            const cached = cache.get(key);
            if (cached === undefined) chunkKeys.set(chunk.key, key);
            else if (cached !== null) answerOf(target.relativePath).chunks.set(chunk.key, cached);
          }
        }
        if (wantFile || chunkKeys.size > 0) {
          pending.push({
            target,
            gitPath,
            fileKey,
            wantFile,
            chunkKeys,
            ...(workingContent !== undefined ? { workingContent } : {}),
          });
        }
      }
      if (pending.length === 0) return answered;

      try {
        const computed = await computeSignals(deps, toplevel, pending);
        pending.forEach((entry, index) => {
          const signals = computed.get(entry.gitPath);
          if (entry.wantFile) {
            const file = signals?.file ? { ...signals.file } : null;
            remember(entry.fileKey, file);
            if (file) answerOf(entry.target.relativePath).file = file;
          }
          for (const [rowKey, cacheKey] of entry.chunkKeys) {
            const overlay = signals?.chunks.get(chunkIdOf(index, rowKey));
            const block = overlay ? { ...overlay } : null;
            remember(cacheKey, block);
            if (block) answerOf(entry.target.relativePath).chunks.set(rowKey, block);
          }
        });
      } catch {
        // Best-effort: the rows keep what they had, and the next request retries.
      }
      return answered;
    },
  };
}

/** Walk-wide chunk ids: the target's index keeps two targets' row keys apart. */
function chunkIdOf(targetIndex: number, rowKey: string): string {
  return `${targetIndex}\0${rowKey}`;
}

async function computeSignals(
  deps: WorkingTreeGitSignalSourceDeps,
  toplevel: string,
  pending: readonly PendingTarget[],
): ReturnType<typeof buildOnDemandGitSignals> {
  const adapter = await VcsAdapterFactory.create(deps.vcsAdapter, toplevel);
  const targets: OnDemandGitSignalTarget[] = pending.map((entry, index) => {
    const ranges = new Map(entry.target.chunks.map((chunk) => [chunk.key, chunk]));
    return {
      relPath: entry.gitPath,
      lineCount: entry.target.maxEndLine,
      fileSignals: entry.wantFile,
      ...(entry.workingContent !== undefined ? { workingContent: entry.workingContent } : {}),
      chunks: [...entry.chunkKeys.keys()].flatMap((rowKey) => {
        const range = ranges.get(rowKey);
        return range ? [{ chunkId: chunkIdOf(index, rowKey), startLine: range.startLine, endLine: range.endLine }] : [];
      }),
    };
  });
  return buildOnDemandGitSignals(adapter, targets, {
    timeoutMs: deps.timeoutMs,
    chunk: deps.chunk,
    ...(deps.squashOpts ? { squashOpts: deps.squashOpts } : {}),
  });
}
