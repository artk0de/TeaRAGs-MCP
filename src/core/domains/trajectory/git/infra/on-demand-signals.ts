/**
 * On-demand git signals (bd tea-rags-mcp-xi2r9, D12): the `git.file` and
 * `git.chunk` blocks an index run would have written, computed outside any run
 * for a few working-tree delta files no base point answers.
 *
 * The SAME computation ingest runs, not a parallel one, over the same commits:
 * - file — the file walk's window (`TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`) read
 *   as the run-scoped `FileChurnDiscovery` slices it
 *   (`buildWindowedFileSignalsForPaths`), and for a path the window holds
 *   nothing for the zero observation with whole-history age stamps
 *   (`readFileLifetimeStamps`) — the live file phase's dormant entry; then
 *   `git blame HEAD`, the merge-branch bug-fix rule, assembled by
 *   `assembleFileSignals`;
 * - chunk — the chunk walk itself (`buildChunkChurnMapUncached`: the chunk
 *   window's commits as the run-scoped commit matrix slices them — a
 *   full-history pathspec log, `pathspecCommitDiscovery` — zero-context hunks
 *   mapped onto ranges with offset tracking, `assembleOverlays` with the
 *   file's churn and HEAD blame).
 *
 * The walk addresses HEAD rows, a delta row the WORKING file's. The row is
 * carried onto HEAD exactly as ingest's chunk phase carries a dirty file's
 * rows (`infra/working-rows.ts`): rows the working file added were never
 * committed and hold no history, and a row made only of them gets the walk's
 * zero overlay (live G4). A path no commit ever touched (an
 * untracked file) is walked as ingest walks it: every row gets the walk's zero
 * overlay, and there is no file block.
 *
 * What it deliberately does NOT share is the provider's run state — chunk-phase
 * blame holds, the run-scoped bug-fix set and discovery matrix, the blame pool
 * and OID cache: a query-time read must never perturb an index run in flight.
 * Bug-fix commits are therefore resolved over the file's own commits.
 */

import type {
  BlameLine,
  BlobBatchReader,
  CommitWithChangedFiles,
  FileChurnData,
  VcsGitAdapter,
} from "../../../../adapters/vcs/index.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import {
  buildAuthorNameDirectory,
  buildBugFixShaSet,
  canonicalizeAuthorNames,
  historyWindowSince,
  resolveHistoryAnchorSec,
  type AuthorNameDirectory,
  type GitHistoryAnchorMode,
} from "../history/index.js";
import type { ChunkChurnOverlay, GitFileSignals } from "../types.js";
import { buildChunkChurnMapUncached, type WalkCommitDiscovery } from "./chunk-reader.js";
import { FileChurnDiscoveryStore } from "./file-churn-discovery-store.js";
import { fileChurnWindowOf, type FileChurnDiscoveryPersistence } from "./file-churn-discovery.js";
import {
  addDormantFileChurn,
  anchorFileChurn,
  readFileLifetimeStamps,
  type FileLifetimeStamps,
  type WindowedFileChurn,
} from "./file-lifetime.js";
import { buildFileSignalsForPaths, buildWindowedFileSignalsForPaths } from "./file-reader.js";
import type { SquashOptions } from "./metrics.js";
import { assembleFileSignals } from "./metrics/file-assembler.js";
import { createPathspecNumstatReads, type PathspecNumstatReads } from "./pathspec-numstat-reads.js";
import { carryWorkingRowsOntoHead, zeroOverlaysOfUncommittedRows } from "./working-rows.js";

/** One row to attribute, in the working file's lines; `chunkId` unique across the call. */
export interface OnDemandGitChunkTarget {
  chunkId: string;
  startLine: number;
  endLine: number;
}

/** One history path to compute, toplevel-relative. */
export interface OnDemandGitSignalTarget {
  relPath: string;
  /** The line count file signals are computed over. */
  lineCount: number;
  /** Whether `git.file` is wanted. */
  fileSignals: boolean;
  /** The working file's content the `chunks` lines address; absent → no chunks. */
  workingContent?: string;
  chunks: readonly OnDemandGitChunkTarget[];
}

export interface OnDemandGitSignalOptions {
  timeoutMs: number;
  squashOpts?: SquashOptions;
  /**
   * The file walk's window (`TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`), as ingest
   * configures it. Absent → every path is read over its whole history, as the
   * backfill reads it.
   */
  file?: { maxAgeMonths: number };
  /** The chunk walk's window and budgets, as ingest configures them. */
  chunk: { maxAgeMonths: number; timeoutMs: number; maxFileLines: number; concurrency: number };
  /**
   * The history clock (`TRAJECTORY_GIT_ANCHOR`), as ingest configures it:
   * `head` measures every window and age from the HEAD commit's committer
   * time, read once per call. Absent ⇒ `now`, the wall clock.
   */
  anchor?: GitHistoryAnchorMode;
  /**
   * Where the run-scoped file-churn snapshot is read from for the canonical
   * author names (default: the on-disk `FileChurnDiscoveryStore` an index run
   * writes). Never written here.
   */
  churnStore?: FileChurnDiscoveryPersistence;
  /**
   * The HEAD commit, when the caller already holds it (the working-tree
   * source reads it off disk). Absent → resolved once per call, and only when
   * something reads it.
   */
  head?: string;
  /**
   * The history anchor of `anchor: head`, when the caller already holds it
   * (the working-tree source memoizes it per (toplevel, HEAD),
   * `OnDemandHeadGitReadMemo`). Given → no `git log -1 %ct` read; absent →
   * resolved once per call.
   */
  historyAnchorSec?: number;
  /**
   * The whole-history age stamps (`readFileLifetimeStamps`) a path the file
   * window holds nothing for is stamped from, when the caller memoizes them
   * per (toplevel, HEAD). Asked only when such a path exists. Absent → read
   * once per call that needs them.
   */
  fileLifetimeStamps?: () => Promise<ReadonlyMap<string, FileLifetimeStamps>>;
}

export interface OnDemandGitSignals {
  file?: GitFileSignals;
  /**
   * By `chunkId`. A row made only of uncommitted lines — of a committed file or
   * a never-committed one — holds the walk's zero overlay.
   */
  chunks: Map<string, ChunkChurnOverlay>;
}

/** Concurrent `git blame` spawns per call. */
const BLAME_CONCURRENCY = 4;

/**
 * Signals per target: file and chunk blocks for a path with commit history,
 * chunk blocks only (the walk's zero overlays) for one no commit touched.
 */
export async function buildOnDemandGitSignals(
  adapter: VcsGitAdapter,
  targets: readonly OnDemandGitSignalTarget[],
  callOptions: OnDemandGitSignalOptions,
): Promise<Map<string, OnDemandGitSignals>> {
  const result = new Map<string, OnDemandGitSignals>();
  if (targets.length === 0) return result;
  const historyAnchorSec =
    callOptions.historyAnchorSec ??
    (await resolveHistoryAnchorSec(adapter, callOptions.anchor ?? "now", callOptions.timeoutMs));
  const options: OnDemandGitSignalOptions =
    historyAnchorSec === undefined ? callOptions : { ...callOptions, historyAnchorSec };
  // Per-call state shared by the file walk, the HEAD carry and both chunk walks
  // (bd tea-rags-mcp-89k7k.35.22): a git process costs ~200 ms of creation at
  // load against a few ms of git's own work.
  const head = lazyHead(adapter, callOptions.head);
  const shared: OnDemandCallGitState = {
    reads: createPathspecNumstatReads(adapter),
    // Spawned on its first read only; closed here, so no walk closes it.
    reader: adapter.createBlobBatchReader(),
  };
  try {
    const names = await persistedAuthorNames(adapter, options, head);
    const churn = canonicalizeChurnNames(
      await fileChurnOf(
        adapter,
        targets.map((target) => target.relPath),
        options,
        shared.reads,
      ),
      names,
    );
    // A dormant file (no commit in the window, history before it) has history.
    const withHistory = targets.filter((target) => churn.has(target.relPath));
    const neverCommitted = targets.filter((target) => !churn.has(target.relPath));
    await walkNeverCommitted(adapter, neverCommitted, options, shared, result);
    if (withHistory.length === 0) return result;

    const carried = withHistory.flatMap(({ relPath, workingContent, chunks }) =>
      workingContent === undefined ? [] : [{ relPath, workingContent, chunks }],
    );
    // Blame and the HEAD carry are independent: one serial stage, not two.
    const [blameByPath, { chunkMap, uncommittedRows }] = await Promise.all([
      blameAtHead(adapter, withHistory, churn, options.timeoutMs, names),
      carried.some((file) => file.chunks.length > 0)
        ? head().then(async (commit) => carryWorkingRowsOntoHead(adapter, carried, shared.reader, commit))
        : carryWorkingRowsOntoHead(adapter, carried, shared.reader),
    ]);
    for (const target of withHistory) {
      const data = churn.get(target.relPath) as WindowedFileChurn;
      result.set(target.relPath, {
        ...(target.fileSignals
          ? {
              file: assembleFileSignals(
                data,
                target.lineCount,
                options.squashOpts,
                buildBugFixShaSet(data.commits),
                blameByPath.get(target.relPath),
              ),
            }
          : {}),
        chunks: new Map(),
      });
    }

    const zero = zeroOverlaysOfUncommittedRows(adapter.repoRoot, uncommittedRows, {
      fileChurnDataMap: churn,
      maxFileLines: options.chunk.maxFileLines,
      ...(options.squashOpts ? { squashOpts: options.squashOpts } : {}),
    });
    const walked =
      chunkMap.size === 0
        ? new Map<string, Map<string, ChunkChurnOverlay>>()
        : await walkChunks(adapter, chunkMap, options, shared, churn, blameByPath);
    for (const overlays of [zero, walked]) {
      for (const [relPath, byChunk] of overlays) {
        const answer = result.get(relPath);
        if (!answer) continue;
        for (const [chunkId, overlay] of byChunk) answer.chunks.set(chunkId, overlay);
      }
    }
    return result;
  } finally {
    await shared.reader.close();
  }
}

/** The git state one call shares between its walks — per call, never run-scoped. */
interface OnDemandCallGitState {
  reads: PathspecNumstatReads;
  /** Owned by `buildOnDemandGitSignals`, which closes it. */
  reader: BlobBatchReader;
}

/** HEAD, resolved at most once per call — never when the caller handed it in. */
function lazyHead(adapter: VcsGitAdapter, known?: string): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return async () => (pending ??= known === undefined ? adapter.getHead() : Promise.resolve(known));
}

/**
 * Per-path file churn as an index run reads it: the file walk's window
 * (`FileChurnDiscovery`'s slice), and for a path the window holds nothing for
 * the zero observation with its whole-history age stamps — the live file
 * phase's dormant entry (bd tea-rags-mcp-i6tkc). No window configured → the
 * whole history.
 */
async function fileChurnOf(
  adapter: VcsGitAdapter,
  paths: string[],
  options: OnDemandGitSignalOptions,
  reads: PathspecNumstatReads,
): Promise<Map<string, WindowedFileChurn>> {
  const { historyAnchorSec } = options;
  if (!options.file) {
    return anchorFileChurn(await buildFileSignalsForPaths(adapter, paths, options.timeoutMs), historyAnchorSec);
  }
  // Through the call's reads: the chunk walk slices its window out of this read.
  const windowed: Map<string, WindowedFileChurn> = await buildWindowedFileSignalsForPaths(
    adapter,
    paths,
    options.file.maxAgeMonths,
    options.timeoutMs,
    historyAnchorSec,
    reads.read,
  );
  const dormant = paths.filter((path) => !windowed.has(path));
  if (dormant.length > 0) {
    const lifetime = options.fileLifetimeStamps
      ? await options.fileLifetimeStamps()
      : await readFileLifetimeStamps(adapter, options.timeoutMs);
    addDormantFileChurn(windowed, dormant, lifetime);
  }
  return anchorFileChurn(windowed, historyAnchorSec);
}

/**
 * The commits the chunk window holds for a set of paths, as the run-scoped
 * commit matrix (`GitCommitDiscovery`: one repo-wide `git log --since
 * --numstat`) slices them: the same `--since` window walked with full history,
 * restricted to the paths — rename rows restored — so a commit no merge
 * simplification hides is lost. The bug-fix set is built over what was read,
 * as the matrix builds it over its rows (merges carry no numstat in either).
 * When the call's file walk already read a window containing this one over
 * the same paths (a file window at least as wide as the chunk window), the
 * commits are sliced from that read (`PathspecNumstatReads#sliceFor`) instead
 * of read again; otherwise they are read here.
 */
function pathspecCommitDiscovery(
  reads: PathspecNumstatReads,
  maxAgeMonths: number,
  timeoutMs: number,
  historyAnchorSec?: number,
): WalkCommitDiscovery {
  const sinceDate = historyWindowSince(maxAgeMonths, historyAnchorSec);
  let read: CommitWithChangedFiles[] = [];
  return {
    commitsForFiles: async (paths) => {
      const entries = reads.sliceFor(paths, sinceDate) ?? (await reads.read(paths, timeoutMs, sinceDate));
      read = entries.map(({ commit, files }) => ({
        commit,
        changedFiles: files.map(({ path, previousPath }) =>
          previousPath === undefined ? { path } : { path, previousPath },
        ),
      }));
      return read;
    },
    getBugFixShas: async () => buildBugFixShaSet(read.map((entry) => entry.commit)),
  };
}

/**
 * One chunk walk over `chunkMap` (absolute-path keys), as ingest's chunk phase
 * runs it, reading blobs through the call's reader (the walk does not close it).
 */
async function walkChunks(
  adapter: VcsGitAdapter,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  options: OnDemandGitSignalOptions,
  shared: OnDemandCallGitState,
  churn?: Map<string, FileChurnData>,
  blameByPath?: Map<string, BlameLine[]>,
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
  return buildChunkChurnMapUncached(
    adapter,
    chunkMap,
    {},
    options.chunk.concurrency,
    options.chunk.maxAgeMonths,
    churn,
    options.squashOpts,
    options.chunk.timeoutMs,
    options.chunk.maxFileLines,
    undefined,
    blameByPath,
    shared.reader,
    undefined,
    pathspecCommitDiscovery(
      shared.reads,
      options.chunk.maxAgeMonths,
      options.chunk.timeoutMs,
      options.historyAnchorSec,
    ),
    undefined,
    undefined,
    options.historyAnchorSec,
  );
}

/**
 * Chunk blocks of paths no commit touched (an untracked file, live round-3
 * D4): ingest finds no file history for such a path — its `git.file` gets the
 * run's stamp and no signal — but still WALKS its chunks, and the walk answers
 * every row of a file within the line limit with the zero overlay of an
 * accumulator no commit touched (`assembleOverlays`, unknown ownership: there
 * is no blame). The same walk runs here over the working rows as they are —
 * nothing was committed, so there is nothing to carry onto HEAD. No `file`
 * block: there is no signal to give.
 */
async function walkNeverCommitted(
  adapter: VcsGitAdapter,
  targets: readonly OnDemandGitSignalTarget[],
  options: OnDemandGitSignalOptions,
  shared: OnDemandCallGitState,
  result: Map<string, OnDemandGitSignals>,
): Promise<void> {
  const chunkMap = new Map<string, ChunkLookupEntry[]>();
  for (const target of targets) {
    if (target.workingContent === undefined || target.chunks.length === 0) continue;
    chunkMap.set(
      `${adapter.repoRoot}/${target.relPath}`,
      target.chunks.map(({ chunkId, startLine, endLine }) => ({ chunkId, startLine, endLine })),
    );
  }
  if (chunkMap.size === 0) return;
  const overlays = await walkChunks(adapter, chunkMap, options, shared);
  for (const [relPath, byChunk] of overlays) result.set(relPath, { chunks: new Map(byChunk) });
}

/** `git blame HEAD` per path, a few at a time; a failed blame is left out (unknown ownership, as in ingest). */
async function blameAtHead(
  adapter: VcsGitAdapter,
  targets: readonly OnDemandGitSignalTarget[],
  churn: ReadonlyMap<string, FileChurnData>,
  timeoutMs: number,
  names: AuthorNameDirectory,
): Promise<Map<string, BlameLine[]>> {
  const blameByPath = new Map<string, BlameLine[]>();
  for (let i = 0; i < targets.length; i += BLAME_CONCURRENCY) {
    await Promise.all(
      targets.slice(i, i + BLAME_CONCURRENCY).map(async ({ relPath }) => {
        const depth = churn.get(relPath)?.commits.length;
        const lines = await adapter.blameFile(relPath, timeoutMs, depth).catch(() => undefined);
        if (lines && lines.length > 0) blameByPath.set(relPath, canonicalizeAuthorNames(lines, names) as BlameLine[]);
      }),
    );
  }
  return blameByPath;
}

/**
 * The canonical author names an index run shows (`author-identity.ts`), read
 * from the repo-wide window commits of the persisted file-churn snapshot — the
 * exact-HEAD one, else the newest — with NO git log of its own: a query-time
 * read must not pay a repository walk per call. The overlay has no
 * `FileChurnDiscovery` (its churn is per path), so it reads the snapshot that
 * discovery persists; a head that moved since the snapshot only means newer
 * commits are not in the tally. No snapshot (never indexed here, no window
 * configured, unreadable store) → an empty directory: names stay per file.
 */
async function persistedAuthorNames(
  adapter: VcsGitAdapter,
  options: OnDemandGitSignalOptions,
  head: () => Promise<string>,
): Promise<AuthorNameDirectory> {
  if (!options.file) return new Map();
  try {
    const store = options.churnStore ?? new FileChurnDiscoveryStore();
    const snapshot = store.load(adapter.repoRoot, await head()) ?? store.loadLatest(adapter.repoRoot);
    if (!snapshot) return new Map();
    const { lowerBoundSec } = fileChurnWindowOf(options.file.maxAgeMonths, options.historyAnchorSec);
    return buildAuthorNameDirectory(
      snapshot.entries.filter((entry) => entry.committerTimestamp >= lowerBoundSec).map((entry) => entry.commit),
    );
  } catch {
    return new Map();
  }
}

/** The churn map with each entry's commits rewritten to the canonical names; untouched when nothing changes. */
function canonicalizeChurnNames(
  churn: Map<string, WindowedFileChurn>,
  names: AuthorNameDirectory,
): Map<string, WindowedFileChurn> {
  if (names.size === 0) return churn;
  return new Map(
    [...churn].map(([path, data]) => {
      const commits = canonicalizeAuthorNames(data.commits, names) as WindowedFileChurn["commits"];
      return [path, commits === data.commits ? data : { ...data, commits }];
    }),
  );
}
