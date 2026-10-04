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
 * - Computed with the config of the INDEX the tree is read against
 *   (`configFor(indexRoot)` — its project's registry env), never merely the
 *   serving process's: the blocks are the ones a reindex of the tree would
 *   write, and they sit beside base rows that index wrote (round-4 P1).
 *   Every computed block carries `enrichedAt`, as ingest's applier stamps it;
 *   a level ingest's enrichment policy declines carries its `skippedAs` stamp
 *   instead, and is never computed (`partitionByEnrichmentPolicy`).
 * - Cached per (toplevel, path HISTORY, path, signal fingerprint, UTC day) and
 *   within it per line extent for `git.file` and per (tree-file content sha,
 *   range) for `git.chunk`: a path's blocks move only with the commits that
 *   touched it, a row's attribution also with the working content it is read
 *   against, and the blocks' time-relative values with the day. "No history"
 *   is cached too. The cache is a process map in front of an optional
 *   persistent store (`WorkingTreeGitSignalStore`, live G2), so a second
 *   process computes nothing for unchanged inputs.
 * - A path's HISTORY key, given the index stamp: the stamp, plus the commits
 *   HEAD's history adds or lacks against it that touched the path (one
 *   symmetric `git log` per (toplevel, stamp, HEAD), shared with
 *   `pathsCommittedSince`). A commit pins every commit behind it, so a
 *   committed move's history is pinned by the move's own commit, which touches
 *   the new path. A commit touching one file leaves every other file's record
 *   valid (live C2: keyed by HEAD, the first cold call after any commit re-blamed
 *   all 159 delta files). Without a stamp, or when git cannot list the range,
 *   the key is HEAD.
 * - Misses are computed one batch at a time per source: a request that waited
 *   re-reads the cache first, so concurrent requests over one delta spawn its
 *   git work once, and the spawns stay within the trajectory's own budgets.
 * - Never rejects: a failed read answers nothing, the next request retries.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { VcsAdapterFactory } from "../../../adapters/vcs/factory.js";
import { readPathCommitsSince, type PathCommitsSince } from "../../../adapters/vcs/git/git-cli/client.js";
import type { GitAdapterKind } from "../../../adapters/vcs/types.js";
import type { FileClassification } from "../../../contracts/types/file-classification.js";
import type {
  WorkingTreeGitSignals,
  WorkingTreeGitSignalSource,
  WorkingTreeGitSignalTarget,
} from "../../../contracts/types/working-tree.js";
import { enrichmentSkipReason } from "../../../domains/ingest/index.js";
import {
  buildOnDemandGitSignals,
  gitEnrichmentScope,
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
/** Path histories since a stamp kept per process — one per recent (toplevel, stamp, HEAD). */
const HISTORY_CACHE_SIZE = 16;
const DAY_MS = 86_400_000;

/** The git configuration blocks are computed with — the one an index was written with. */
export interface WorkingTreeGitSignalConfig {
  /** The git adapter kind ingest runs (`GIT_ADAPTER`). */
  vcsAdapter: GitAdapterKind;
  /** Per git-call stall budget of the file walk (`TRAJECTORY_GIT_LOG_TIMEOUT_MS`). */
  timeoutMs: number;
  /** Squash-aware session grouping, as ingest computes `commitCount`. */
  squashOpts?: SquashOptions;
  /** The file walk's window (`TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`); absent → whole histories. */
  file?: OnDemandGitSignalOptions["file"];
  /** The chunk walk's window and budgets (`TRAJECTORY_GIT_CHUNK_*`). */
  chunk: OnDemandGitSignalOptions["chunk"];
  /** The history clock (`TRAJECTORY_GIT_ANCHOR`); absent → `now`. */
  anchor?: OnDemandGitSignalOptions["anchor"];
}

export interface WorkingTreeGitSignalSourceDeps extends WorkingTreeGitSignalConfig {
  /**
   * The config the index whose checkout is `indexRoot` was written with — its
   * project's registry env over the serving process's (round-4 P1: a server
   * started without the self-index's squash flag mixed session and commit
   * counts in one answer). Undefined, or no such hook → this source's own.
   */
  configFor?: (indexRoot: string) => WorkingTreeGitSignalConfig | undefined;
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
  const configOf = (indexRoot: string | undefined): WorkingTreeGitSignalConfig =>
    (indexRoot === undefined ? undefined : deps.configFor?.(indexRoot)) ?? deps;
  const records = new Map<string, WorkingTreeGitSignalRecord>();
  const histories = new Map<string, Promise<PathCommitsSince | undefined>>();
  let computing: Promise<unknown> = Promise.resolve();

  /** Which commits on either side of the stamp touched which paths — one `git log` per (toplevel, stamp, HEAD). */
  const historySince = async (
    toplevel: string,
    sinceCommit: string,
    head: string,
  ): Promise<PathCommitsSince | undefined> => {
    const key = `${toplevel}\0${sinceCommit}\0${head}`;
    let history = histories.get(key);
    if (!history) {
      history = readPathCommitsSince(toplevel, sinceCommit, head).catch(() => undefined);
      histories.set(key, history);
      void history.then((answer) => {
        if (answer === undefined) histories.delete(key);
      });
      while (histories.size > HISTORY_CACHE_SIZE) histories.delete(histories.keys().next().value as string);
    }
    return history;
  };

  /** The history key of each git path: see the module comment. */
  const historyKeyOf = async (
    toplevel: string,
    head: string,
    sinceCommit: string | undefined,
  ): Promise<(gitPath: string) => string> => {
    const history = sinceCommit ? await historySince(toplevel, sinceCommit, head) : undefined;
    if (!sinceCommit || !history) return () => `head:${head}`;
    return (gitPath) => {
      const added = history.headSide.get(gitPath) ?? [];
      const lacked = history.stampSide.get(gitPath) ?? [];
      if (added.length === 0 && lacked.length === 0) return `since:${sinceCommit}`;
      const commits = JSON.stringify([[...added].sort(), [...lacked].sort()]);
      return `since:${sinceCommit}:${createHash("sha1").update(commits).digest("hex")}`;
    };
  };

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
    historyKey: (gitPath: string) => string,
    fingerprint: string,
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
      const recordKey = JSON.stringify([toplevel, historyKey(gitPath), gitPath, fingerprint, day]);
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

  /**
   * Computes the misses, stores them, and reads them into `answered`. Every
   * block carries `enrichedAt` — the computation time, as ingest's applier
   * stamps its run's — and a file block asked for with no history to give is
   * that bare stamp, what the applier writes for a file it found none for
   * (round-4 P4).
   */
  const compute = async (
    config: WorkingTreeGitSignalConfig,
    toplevel: string,
    pending: readonly PendingTarget[],
    answered: Map<string, WorkingTreeGitSignals & { chunks: Map<string, Record<string, unknown>> }>,
  ): Promise<void> => {
    const computed = await computeSignals(config, toplevel, pending);
    const enrichedAt = new Date(now()).toISOString();
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
        const file = { ...signals?.file, enrichedAt };
        record.file[entry.fileSlot] = file;
        answerOf().file = file;
      }
      for (const [rowKey, slot] of entry.chunkSlots) {
        const overlay = signals?.chunks.get(chunkIdOf(index, rowKey));
        const block: WorkingTreeGitSignalBlock = overlay ? { ...overlay, enrichedAt } : null;
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
    signalsOf: async (root, targets, sinceCommit, indexRoot) => {
      const answered = new Map<string, WorkingTreeGitSignals & { chunks: Map<string, Record<string, unknown>> }>();
      if (targets.length === 0) return answered;
      const toplevel = findGitToplevel(root);
      const head = toplevel ? readRepoGitState(toplevel)?.commit : undefined;
      if (!toplevel || !head) return answered;

      const config = configOf(indexRoot);
      const { owed, declined } = partitionByEnrichmentPolicy(targets, config.chunk.maxFileLines);
      try {
        const fingerprint = signalFingerprintOf(deps.builderVersion, config);
        const historyKey = await historyKeyOf(toplevel, head, sinceCommit);
        if ((await lookup(root, toplevel, historyKey, fingerprint, owed, answered)).length > 0) {
          // One batch of misses at a time: a request that waited finds what the
          // one before it computed, and computes only what is still missing.
          const turn = computing.then(async () => {
            answered.clear();
            const pending = await lookup(root, toplevel, historyKey, fingerprint, owed, answered);
            if (pending.length > 0) await compute(config, toplevel, pending, answered);
          });
          computing = turn.catch(() => undefined);
          await turn;
        }
      } catch {
        // Best-effort: the rows keep what they had, and the next request retries.
      }
      for (const [path, stamps] of declined) {
        const answer: WorkingTreeGitSignals & { chunks: Map<string, Record<string, unknown>> } = answered.get(path) ?? {
          chunks: new Map<string, Record<string, unknown>>(),
        };
        if (stamps.file) answer.file = stamps.file;
        for (const [rowKey, block] of stamps.chunks) answer.chunks.set(rowKey, block);
        answered.set(path, answer);
      }
      return answered;
    },

    pathsCommittedSince: async (root, sinceCommit) => {
      const toplevel = findGitToplevel(root);
      const head = toplevel ? readRepoGitState(toplevel)?.commit : undefined;
      if (!toplevel || !head) return undefined;
      const history = await historySince(toplevel, sinceCommit, head);
      if (!history) return undefined;
      // Either side moved the path's history: what HEAD adds, and what HEAD
      // lacks when it does not descend from the stamp (a worktree branched
      // from an older main than the index's tip).
      const moved = new Set([...history.headSide.keys(), ...history.stampSide.keys()]);
      return new Set(rebaseGitPathsOntoRoot([...moved].sort(), gitPathPrefix(toplevel, root)));
    },
  };
}

/**
 * Splits the targets by the enrichment policy an index run applies
 * (`gitEnrichmentScope` under the index's `chunkMaxFileLines`, read through
 * ingest's own `enrichmentSkipReason`): a level the policy declines gets the
 * skip stamp ingest writes — `{ skippedAs }` and nothing else, no
 * `enrichedAt` — and is not computed; what it owes stays a target. The file
 * level is asked without a line count, the chunk level with the tree file's,
 * as the file and chunk phases ask (a file past the chunk walk's line limit:
 * `git.file` computed, every row `skippedAs: "oversized"`). Classified by the
 * TREE path — the path a reindex of the tree would classify.
 */
function partitionByEnrichmentPolicy(
  targets: readonly WorkingTreeGitSignalTarget[],
  chunkMaxFileLines: number,
): {
  owed: WorkingTreeGitSignalTarget[];
  declined: Map<string, { file?: Record<string, unknown>; chunks: Map<string, Record<string, unknown>> }>;
} {
  const policy = {
    shouldEnrich: (file: { classification: FileClassification; fileLines?: number }) =>
      gitEnrichmentScope(file, chunkMaxFileLines),
  };
  const owed: WorkingTreeGitSignalTarget[] = [];
  const declined = new Map<string, { file?: Record<string, unknown>; chunks: Map<string, Record<string, unknown>> }>();
  for (const target of targets) {
    const fileReason = target.fileSignals ? enrichmentSkipReason(policy, target.treePath, "file") : null;
    const chunkReason =
      target.chunks.length > 0
        ? enrichmentSkipReason(
            policy,
            target.treePath,
            "chunk",
            target.fileLines !== undefined ? { fileLines: target.fileLines } : {},
          )
        : null;
    if (fileReason === null && chunkReason === null) {
      owed.push(target);
      continue;
    }
    const stamps: { file?: Record<string, unknown>; chunks: Map<string, Record<string, unknown>> } = {
      chunks: new Map(),
    };
    if (fileReason !== null) stamps.file = { skippedAs: fileReason };
    if (chunkReason !== null) {
      for (const chunk of target.chunks) stamps.chunks.set(chunk.key, { skippedAs: chunkReason });
    }
    declined.set(target.relativePath, stamps);
    const rest: WorkingTreeGitSignalTarget = {
      ...target,
      fileSignals: target.fileSignals && fileReason === null,
      chunks: chunkReason === null ? target.chunks : [],
    };
    if (rest.fileSignals || rest.chunks.length > 0) owed.push(rest);
  }
  return { owed, declined };
}

/**
 * What the blocks depend on besides the record's own key: the computing build
 * and the configuration that shapes the values — squash sessions, the file and
 * chunk walks' windows, the chunk walk's line limit. Stall budgets and
 * concurrency are left out: they decide whether a value is computed, never what
 * it is. Two indexes written with different configs never share a record.
 */
function signalFingerprintOf(builderVersion: string | undefined, config: WorkingTreeGitSignalConfig): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        builderVersion ?? "",
        config.vcsAdapter,
        config.squashOpts ?? null,
        config.file?.maxAgeMonths ?? null,
        config.chunk.maxAgeMonths,
        config.chunk.maxFileLines,
        // The history clock moves every age and window. Written only when
        // anchored at HEAD, so a `now` fingerprint keeps its pre-anchor value.
        ...(config.anchor === "head" ? ["anchor:head"] : []),
      ]),
    )
    .digest("hex");
}

/** Walk-wide chunk ids: the target's index keeps two targets' row keys apart. */
function chunkIdOf(targetIndex: number, rowKey: string): string {
  return `${targetIndex}\0${rowKey}`;
}

async function computeSignals(
  config: WorkingTreeGitSignalConfig,
  toplevel: string,
  pending: readonly PendingTarget[],
): ReturnType<typeof buildOnDemandGitSignals> {
  const adapter = await VcsAdapterFactory.create(config.vcsAdapter, toplevel);
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
    timeoutMs: config.timeoutMs,
    chunk: config.chunk,
    ...(config.file ? { file: config.file } : {}),
    ...(config.squashOpts ? { squashOpts: config.squashOpts } : {}),
    ...(config.anchor ? { anchor: config.anchor } : {}),
  });
}
