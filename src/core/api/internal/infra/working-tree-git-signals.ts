/**
 * On-demand git signals for working-tree delta rows (bd tea-rags-mcp-xi2r9,
 * D12) — the `WorkingTreeGitSignalSource` the delta signals ask for what no
 * base point answers: `git.file` of a file the base never chunked (`src/cyc/c.ts`,
 * 3 lines, below the chunk floor; a file committed after the index), every
 * block of a file a commit touched since the index (live G1), and `git.chunk`
 * of a row whose symbol the base never held. Without it such rows rank as code
 * with no history — or the index's stale history — under every git preset.
 *
 * Lives in `api/internal` because it bridges what explore may not see: the git
 * trajectory's own computation (`buildOnDemandGitSignals`).
 *
 * - Paths arrive relative to the TREE root, which may sit below its git
 *   toplevel; git is asked at the toplevel, the answer named back.
 * - A row's lines are the tree file's (`treePath`); its history is the history
 *   path's (a move's old path), read at HEAD.
 * - Cached per (toplevel, HEAD, path, signal fingerprint, UTC day) and within
 *   it per line extent for `git.file` and per (tree-file content sha, range)
 *   for `git.chunk`: history moves only with HEAD, a row's attribution also with
 *   the working content it is read against, and the blocks' time-relative
 *   values with the day. "No history" is cached too. The cache is a process
 *   map in front of an optional persistent store (`WorkingTreeGitSignalStore`,
 *   live G2), so a second process computes nothing for unchanged inputs.
 * - Misses are computed one batch at a time per source: a request that waited
 *   re-reads the cache first, so concurrent requests over one delta spawn its
 *   git work once, and the spawns stay within the trajectory's own budgets.
 * - `pathsCommittedSince` is one `git log` per (toplevel, stamp, HEAD).
 * - Never rejects: a failed read answers nothing, the next request retries.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { VcsAdapterFactory } from "../../../adapters/vcs/factory.js";
import { listPathsCommittedSince } from "../../../adapters/vcs/git/git-cli/client.js";
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
import {
  findGitToplevel,
  gitPathFromRoot,
  gitPathPrefix,
  readRepoGitState,
  rebaseGitPathsOntoRoot,
} from "../../../infra/repo-git-state.js";
import type {
  WorkingTreeGitSignalBlock,
  WorkingTreeGitSignalRecord,
  WorkingTreeGitSignalStore,
} from "./working-tree-git-signal-store.js";

/** Records kept per process; a miss costs a `git log`, a `git blame` and a chunk walk. */
const RECORD_CACHE_SIZE = 2_000;
/** Committed-since answers kept per process — one per recent (tree, stamp, HEAD). */
const COMMITTED_CACHE_SIZE = 16;
const DAY_MS = 86_400_000;

export interface WorkingTreeGitSignalSourceDeps {
  /** The git adapter kind ingest runs (`GIT_ADAPTER`). */
  vcsAdapter: GitAdapterKind;
  /** Per git-call stall budget of the file walk (`TRAJECTORY_GIT_LOG_TIMEOUT_MS`). */
  timeoutMs: number;
  /** Squash-aware session grouping, as ingest computes `commitCount`. */
  squashOpts?: SquashOptions;
  /** The chunk walk's window and budgets (`TRAJECTORY_GIT_CHUNK_*`). */
  chunk: OnDemandGitSignalOptions["chunk"];
  /** Keeps computed blocks across processes. Absent → the process map only. */
  store?: WorkingTreeGitSignalStore;
  /** The build that computes the blocks — a new build never reads an older one's records. */
  builderVersion?: string;
  now?: () => number;
}

/** One target's record and what of it the request still misses. */
interface PendingTarget {
  target: WorkingTreeGitSignalTarget;
  gitPath: string;
  recordKey: string;
  record: WorkingTreeGitSignalRecord;
  fileSlot?: string;
  /** Row key → chunk slot in the record. */
  chunkSlots: Map<string, string>;
  workingContent?: string;
}

export function createWorkingTreeGitSignalSource(deps: WorkingTreeGitSignalSourceDeps): WorkingTreeGitSignalSource {
  const now = deps.now ?? Date.now;
  const fingerprint = signalFingerprintOf(deps);
  const records = new Map<string, WorkingTreeGitSignalRecord>();
  const committed = new Map<string, Promise<string[] | undefined>>();
  let computing: Promise<unknown> = Promise.resolve();

  const remember = (key: string, record: WorkingTreeGitSignalRecord): void => {
    records.delete(key);
    records.set(key, record);
    while (records.size > RECORD_CACHE_SIZE) records.delete(records.keys().next().value as string);
  };

  /** The record under `key`: the process map, else the store; a fresh empty one on a miss. */
  const recordOf = async (key: string): Promise<WorkingTreeGitSignalRecord> => {
    let record = records.get(key);
    if (!record) {
      record = (await deps.store?.read(key).catch(() => undefined)) ?? { file: {}, chunks: {} };
      remember(key, record);
    }
    return record;
  };

  /** Reads what the cache answers into `answered`; returns what it still misses. */
  const lookup = async (
    root: string,
    toplevel: string,
    head: string,
    targets: readonly WorkingTreeGitSignalTarget[],
    answered: Map<string, WorkingTreeGitSignals & { chunks: Map<string, Record<string, unknown>> }>,
  ): Promise<PendingTarget[]> => {
    const prefix = gitPathPrefix(toplevel, root);
    const day = Math.floor(now() / DAY_MS);
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
      const recordKey = JSON.stringify([toplevel, head, gitPath, fingerprint, day]);
      const record = await recordOf(recordKey);
      const entry: PendingTarget = { target, gitPath, recordKey, record, chunkSlots: new Map() };
      if (target.fileSignals) {
        const slot = String(target.maxEndLine);
        const cached = record.file[slot];
        if (cached === undefined) entry.fileSlot = slot;
        else if (cached !== null) answerOf(target.relativePath).file = cached;
      }
      if (target.chunks.length > 0) {
        const workingContent = await fs.readFile(join(root, target.treePath), "utf8").catch(() => undefined);
        if (workingContent !== undefined) {
          const sha = createHash("sha1").update(workingContent).digest("hex");
          for (const chunk of target.chunks) {
            const slot = `${sha}:${chunk.startLine}-${chunk.endLine}`;
            const cached = record.chunks[slot];
            if (cached === undefined) entry.chunkSlots.set(chunk.key, slot);
            else if (cached !== null) answerOf(target.relativePath).chunks.set(chunk.key, cached);
          }
          if (entry.chunkSlots.size > 0) entry.workingContent = workingContent;
        }
      }
      if (entry.fileSlot !== undefined || entry.chunkSlots.size > 0) pending.push(entry);
    }
    return pending;
  };

  /** Computes the misses, stores them, and reads them into `answered`. */
  const compute = async (
    toplevel: string,
    pending: readonly PendingTarget[],
    answered: Map<string, WorkingTreeGitSignals & { chunks: Map<string, Record<string, unknown>> }>,
  ): Promise<void> => {
    const computed = await computeSignals(deps, toplevel, pending);
    const touched = new Map<string, WorkingTreeGitSignalRecord>();
    pending.forEach((entry, index) => {
      const signals = computed.get(entry.gitPath);
      const record = touched.get(entry.recordKey) ?? {
        file: { ...entry.record.file },
        chunks: { ...entry.record.chunks },
      };
      touched.set(entry.recordKey, record);
      const answerOf = () => {
        let answer = answered.get(entry.target.relativePath);
        if (!answer) {
          answer = { chunks: new Map() };
          answered.set(entry.target.relativePath, answer);
        }
        return answer;
      };
      if (entry.fileSlot !== undefined) {
        const file: WorkingTreeGitSignalBlock = signals?.file ? { ...signals.file } : null;
        record.file[entry.fileSlot] = file;
        if (file) answerOf().file = file;
      }
      for (const [rowKey, slot] of entry.chunkSlots) {
        const overlay = signals?.chunks.get(chunkIdOf(index, rowKey));
        const block: WorkingTreeGitSignalBlock = overlay ? { ...overlay } : null;
        record.chunks[slot] = block;
        if (block) answerOf().chunks.set(rowKey, block);
      }
    });
    await Promise.all(
      [...touched].map(async ([key, record]) => {
        remember(key, record);
        await deps.store?.write(key, record).catch(() => undefined);
      }),
    );
  };

  return {
    signalsOf: async (root, targets) => {
      const answered = new Map<string, WorkingTreeGitSignals & { chunks: Map<string, Record<string, unknown>> }>();
      if (targets.length === 0) return answered;
      const toplevel = findGitToplevel(root);
      const head = toplevel ? readRepoGitState(toplevel)?.commit : undefined;
      if (!toplevel || !head) return answered;

      try {
        if ((await lookup(root, toplevel, head, targets, answered)).length === 0) return answered;
        // One batch of misses at a time: a request that waited finds what the
        // one before it computed, and computes only what is still missing.
        const turn = computing.then(async () => {
          answered.clear();
          const pending = await lookup(root, toplevel, head, targets, answered);
          if (pending.length > 0) await compute(toplevel, pending, answered);
        });
        computing = turn.catch(() => undefined);
        await turn;
      } catch {
        // Best-effort: the rows keep what they had, and the next request retries.
      }
      return answered;
    },

    pathsCommittedSince: async (root, sinceCommit) => {
      const toplevel = findGitToplevel(root);
      const head = toplevel ? readRepoGitState(toplevel)?.commit : undefined;
      if (!toplevel || !head) return undefined;
      const key = `${toplevel}\0${sinceCommit}\0${head}`;
      let paths = committed.get(key);
      if (!paths) {
        paths = listPathsCommittedSince(toplevel, sinceCommit, head).catch(() => undefined);
        committed.set(key, paths);
        void paths.then((answer) => {
          if (answer === undefined) committed.delete(key);
        });
        while (committed.size > COMMITTED_CACHE_SIZE) committed.delete(committed.keys().next().value as string);
      }
      const answer = await paths;
      return answer ? new Set(rebaseGitPathsOntoRoot(answer, gitPathPrefix(toplevel, root))) : undefined;
    },
  };
}

/**
 * What the blocks depend on besides the record's own key: the computing build
 * and the configuration that shapes the values — squash sessions, the chunk
 * walk's window and line limit. Stall budgets are left out: they decide
 * whether a value is computed, never what it is.
 */
function signalFingerprintOf(deps: WorkingTreeGitSignalSourceDeps): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        deps.builderVersion ?? "",
        deps.vcsAdapter,
        deps.squashOpts ?? null,
        deps.chunk.maxAgeMonths,
        deps.chunk.maxFileLines,
      ]),
    )
    .digest("hex");
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
      fileSignals: entry.fileSlot !== undefined,
      ...(entry.workingContent !== undefined ? { workingContent: entry.workingContent } : {}),
      chunks: [...entry.chunkSlots.keys()].flatMap((rowKey) => {
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
