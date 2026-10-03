/**
 * On-demand git signals (bd tea-rags-mcp-xi2r9, D12): the `git.file` and
 * `git.chunk` blocks an index run would have written, computed outside any run
 * for a few working-tree delta files no base point answers.
 *
 * The SAME computation ingest runs, not a parallel one, over the same commits:
 * - file — the file walk's window (`TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`) read
 *   as the run-scoped `FileChurnDiscovery` slices it
 *   (`buildWindowedFileSignalsForPaths`), and for a path the window holds
 *   nothing for the backfill's whole rename-following history
 *   (`buildFileSignalsForPaths`) — ingest's own fallback; then `git blame
 *   HEAD`, the merge-branch bug-fix rule, assembled by `assembleFileSignals`;
 * - chunk — the chunk walk itself (`buildChunkChurnMapUncached`: the chunk
 *   window's commits as the run-scoped commit matrix slices them — a
 *   full-history pathspec log, `pathspecCommitDiscovery` — zero-context hunks
 *   mapped onto ranges with offset tracking, `assembleOverlays` with the
 *   file's churn and HEAD blame).
 *
 * The walk addresses HEAD rows, a delta row the WORKING file's. The row is
 * carried onto HEAD by the HEAD → working hunks (`headRowSpanOfWorkingRows`):
 * rows the working file added were never committed and hold no history, and a
 * row made only of them gets the walk's zero overlay — what ingest writes for a
 * chunk no commit reached (live G4). A path no commit ever touched (an
 * untracked file) is walked as ingest walks it: every row gets the walk's zero
 * overlay, and there is no file block.
 *
 * What it deliberately does NOT share is the provider's run state — chunk-phase
 * blame holds, the run-scoped bug-fix set and discovery matrix, the blame pool
 * and OID cache: a query-time read must never perturb an index run in flight.
 * Bug-fix commits are therefore resolved over the file's own commits.
 */

import { structuredPatch } from "diff";

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { BlameLine, CommitWithChangedFiles, FileChurnData } from "../../../../adapters/vcs/types.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkChurnOverlay, GitFileSignals } from "../types.js";
import { assembleOverlays } from "./assemble-overlays.js";
import { buildAccumulators } from "./build-accumulators.js";
import { buildChunkChurnMapUncached, type WalkCommitDiscovery } from "./chunk-reader.js";
import { buildFileSignalsForPaths, buildWindowedFileSignalsForPaths } from "./file-reader.js";
import { buildBugFixShaSet } from "./merge-branch-resolver.js";
import type { SquashOptions } from "./metrics.js";
import { computeRelativeChurn } from "./metrics/extractors.js";
import { assembleFileSignals } from "./metrics/file-assembler.js";
import { headRowSpanOfWorkingRows } from "./offset-tracker.js";

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
  options: OnDemandGitSignalOptions,
): Promise<Map<string, OnDemandGitSignals>> {
  const result = new Map<string, OnDemandGitSignals>();
  if (targets.length === 0) return result;
  const churn = await fileChurnOf(
    adapter,
    targets.map((target) => target.relPath),
    options,
  );
  const withHistory = targets.filter((target) => (churn.get(target.relPath)?.commits.length ?? 0) > 0);
  const neverCommitted = targets.filter((target) => (churn.get(target.relPath)?.commits.length ?? 0) === 0);
  await walkNeverCommitted(adapter, neverCommitted, options, result);
  if (withHistory.length === 0) return result;

  const blameByPath = await blameAtHead(adapter, withHistory, churn, options.timeoutMs);
  for (const target of withHistory) {
    const data = churn.get(target.relPath) as FileChurnData;
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

  const { chunkMap, uncommittedRows } = await headChunkMap(adapter, withHistory);
  assignUncommittedRows(adapter.repoRoot, uncommittedRows, churn, options, result);
  if (chunkMap.size === 0) return result;
  const overlays = await walkChunks(adapter, chunkMap, options, churn, blameByPath);
  for (const [relPath, byChunk] of overlays) {
    const answer = result.get(relPath);
    if (!answer) continue;
    for (const [chunkId, overlay] of byChunk) answer.chunks.set(chunkId, overlay);
  }
  return result;
}

/**
 * `git.file` with its `relativeChurn` taken over `lineCount` rows — the one
 * value of the block that depends on the file's current length rather than
 * its history (`assembleFileSignals` divides the history's churned lines by
 * the line count it is handed). A reindex of a tree whose file grew or shrank
 * recomputes exactly this, over the same history. A block without the churn
 * counts is returned as it is.
 */
export function gitFileSignalsAtLineCount(file: Record<string, unknown>, lineCount: number): Record<string, unknown> {
  const { linesAdded, linesDeleted } = file;
  if (typeof linesAdded !== "number" || typeof linesDeleted !== "number") return file;
  return { ...file, relativeChurn: computeRelativeChurn(linesAdded, linesDeleted, lineCount) };
}

/**
 * Per-path file churn as an index run reads it: the file walk's window
 * (`FileChurnDiscovery`'s slice), and for a path the window holds nothing for
 * its whole history (the backfill). No window configured → the whole history.
 */
async function fileChurnOf(
  adapter: VcsGitAdapter,
  paths: string[],
  options: OnDemandGitSignalOptions,
): Promise<Map<string, FileChurnData>> {
  const windowed = options.file
    ? await buildWindowedFileSignalsForPaths(adapter, paths, options.file.maxAgeMonths, options.timeoutMs)
    : new Map<string, FileChurnData>();
  const missing = paths.filter((path) => !windowed.has(path));
  if (missing.length === 0) return windowed;
  for (const [path, data] of await buildFileSignalsForPaths(adapter, missing, options.timeoutMs)) {
    windowed.set(path, data);
  }
  return windowed;
}

/**
 * The commits the chunk window holds for a set of paths, as the run-scoped
 * commit matrix (`GitCommitDiscovery`: one repo-wide `git log --since
 * --numstat`) slices them: the same `--since` window walked with full history,
 * restricted to the paths — rename rows restored — so a commit no merge
 * simplification hides is lost. The bug-fix set is built over what was read,
 * as the matrix builds it over its rows (merges carry no numstat in either).
 */
function pathspecCommitDiscovery(adapter: VcsGitAdapter, maxAgeMonths: number, timeoutMs: number): WalkCommitDiscovery {
  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  const sinceDate = new Date(Date.now() - effectiveMonths * 30 * 86400 * 1000);
  let read: CommitWithChangedFiles[] = [];
  return {
    commitsForFiles: async (paths) => {
      read = (await adapter.readCommitFileNumstatForPaths(paths, timeoutMs, sinceDate)).map(({ commit, files }) => ({
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

/** One chunk walk over `chunkMap` (absolute-path keys), as ingest's chunk phase runs it. */
async function walkChunks(
  adapter: VcsGitAdapter,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  options: OnDemandGitSignalOptions,
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
    undefined,
    undefined,
    pathspecCommitDiscovery(adapter, options.chunk.maxAgeMonths, options.chunk.timeoutMs),
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
  const overlays = await walkChunks(adapter, chunkMap, options);
  for (const [relPath, byChunk] of overlays) result.set(relPath, { chunks: new Map(byChunk) });
}

/** `git blame HEAD` per path, a few at a time; a failed blame is left out (unknown ownership, as in ingest). */
async function blameAtHead(
  adapter: VcsGitAdapter,
  targets: readonly OnDemandGitSignalTarget[],
  churn: ReadonlyMap<string, FileChurnData>,
  timeoutMs: number,
): Promise<Map<string, BlameLine[]>> {
  const blameByPath = new Map<string, BlameLine[]>();
  for (let i = 0; i < targets.length; i += BLAME_CONCURRENCY) {
    await Promise.all(
      targets.slice(i, i + BLAME_CONCURRENCY).map(async ({ relPath }) => {
        const depth = churn.get(relPath)?.commits.length;
        const lines = await adapter.blameFile(relPath, timeoutMs, depth).catch(() => undefined);
        if (lines && lines.length > 0) blameByPath.set(relPath, lines);
      }),
    );
  }
  return blameByPath;
}

/**
 * Chunk blocks of rows made only of lines the working file added (live G4): the
 * chunk walk reaches them with no commit, so ingest writes the walk's zero
 * overlay for them — `assembleOverlays` over an accumulator no commit touched,
 * with the file's churn as denominator. No HEAD blame line attributes an
 * uncommitted line, so their ownership is unknown, as for an untracked file.
 * Rows of a file past the walk's line limit get nothing, as ingest walks none.
 */
function assignUncommittedRows(
  repoRoot: string,
  uncommittedRows: ReadonlyMap<string, ChunkLookupEntry[]>,
  churn: Map<string, FileChurnData>,
  options: OnDemandGitSignalOptions,
  result: Map<string, OnDemandGitSignals>,
): void {
  if (uncommittedRows.size === 0) return;
  const { relativeChunkMap, accumulators } = buildAccumulators(
    repoRoot,
    new Map(uncommittedRows),
    options.chunk.maxFileLines,
  );
  const overlays = assembleOverlays({
    relativeChunkMap,
    accumulators,
    fileChurnDataMap: churn,
    ...(options.squashOpts ? { squashOpts: options.squashOpts } : {}),
  });
  for (const [relPath, byChunk] of overlays) {
    const answer = result.get(relPath);
    if (!answer) continue;
    for (const [chunkId, overlay] of byChunk) answer.chunks.set(chunkId, overlay);
  }
}

/** Concurrent HEAD blob reads per call. */
const HEAD_READ_CONCURRENCY = 4;

/**
 * The walk's chunk map: each row carried onto the HEAD rows it still holds,
 * keyed by absolute path as ingest keys it — and, apart, the rows made only of
 * uncommitted lines, in their working lines (the walk would reach them with no
 * commit). A path absent at HEAD contributes nothing.
 */
async function headChunkMap(
  adapter: VcsGitAdapter,
  targets: readonly OnDemandGitSignalTarget[],
): Promise<{ chunkMap: Map<string, ChunkLookupEntry[]>; uncommittedRows: Map<string, ChunkLookupEntry[]> }> {
  const chunkMap = new Map<string, ChunkLookupEntry[]>();
  const uncommittedRows = new Map<string, ChunkLookupEntry[]>();
  const wanted = targets.filter((target) => target.workingContent !== undefined && target.chunks.length > 0);
  if (wanted.length === 0) return { chunkMap, uncommittedRows };
  const head = await adapter.getHead();
  const carry = async (target: OnDemandGitSignalTarget): Promise<void> => {
    const headContent = await adapter.readBlobAsString(head, target.relPath);
    if (headContent === "") return;
    const { hunks } = structuredPatch(
      target.relPath,
      target.relPath,
      headContent,
      target.workingContent ?? "",
      "",
      "",
      {
        context: 0,
      },
    );
    const entries: ChunkLookupEntry[] = [];
    const uncommitted: ChunkLookupEntry[] = [];
    for (const chunk of target.chunks) {
      const span = headRowSpanOfWorkingRows(hunks, chunk.startLine, chunk.endLine);
      if (span) entries.push({ chunkId: chunk.chunkId, startLine: span.start, endLine: span.end });
      else uncommitted.push({ chunkId: chunk.chunkId, startLine: chunk.startLine, endLine: chunk.endLine });
    }
    const absolutePath = `${adapter.repoRoot}/${target.relPath}`;
    if (entries.length > 0) chunkMap.set(absolutePath, entries);
    if (uncommitted.length > 0) uncommittedRows.set(absolutePath, uncommitted);
  };
  for (let i = 0; i < wanted.length; i += HEAD_READ_CONCURRENCY) {
    await Promise.all(wanted.slice(i, i + HEAD_READ_CONCURRENCY).map(carry));
  }
  return { chunkMap, uncommittedRows };
}
