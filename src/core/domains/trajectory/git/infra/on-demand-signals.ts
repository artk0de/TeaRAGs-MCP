/**
 * On-demand git signals (bd tea-rags-mcp-xi2r9, D12): the `git.file` and
 * `git.chunk` blocks an index run would have written, computed outside any run
 * for a few working-tree delta files no base point answers.
 *
 * The SAME computation ingest runs, not a parallel one:
 * - file — the backfill's rename-following per-path history
 *   (`buildFileSignalsForPaths`), `git blame HEAD`, the merge-branch bug-fix
 *   rule, assembled by `assembleFileSignals`;
 * - chunk — the chunk walk itself (`buildChunkChurnMapUncached`: commit
 *   discovery in the chunk window, zero-context hunks mapped onto ranges with
 *   offset tracking, `assembleOverlays` with the file's churn and HEAD blame).
 *
 * The walk addresses HEAD rows, a delta row the WORKING file's. The row is
 * carried onto HEAD by the HEAD → working hunks (`headRowSpanOfWorkingRows`):
 * rows the working file added were never committed and hold no history, and a
 * row made only of them gets no chunk block.
 *
 * What it deliberately does NOT share is the provider's run state — chunk-phase
 * blame holds, the run-scoped bug-fix set and discovery matrix, the blame pool
 * and OID cache: a query-time read must never perturb an index run in flight.
 * Bug-fix commits are therefore resolved over the file's own commits.
 */

import { structuredPatch } from "diff";

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { BlameLine, FileChurnData } from "../../../../adapters/vcs/types.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkChurnOverlay, GitFileSignals } from "../types.js";
import { buildChunkChurnMapUncached } from "./chunk-reader.js";
import { buildFileSignalsForPaths } from "./file-reader.js";
import { buildBugFixShaSet } from "./merge-branch-resolver.js";
import type { SquashOptions } from "./metrics.js";
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
  /** The chunk walk's window and budgets, as ingest configures them. */
  chunk: { maxAgeMonths: number; timeoutMs: number; maxFileLines: number; concurrency: number };
}

export interface OnDemandGitSignals {
  file?: GitFileSignals;
  /** By `chunkId`; a row with no committed history is absent. */
  chunks: Map<string, ChunkChurnOverlay>;
}

/** Concurrent `git blame` spawns per call. */
const BLAME_CONCURRENCY = 4;

/** Signals per target with commit history; a path no commit touched is absent. */
export async function buildOnDemandGitSignals(
  adapter: VcsGitAdapter,
  targets: readonly OnDemandGitSignalTarget[],
  options: OnDemandGitSignalOptions,
): Promise<Map<string, OnDemandGitSignals>> {
  const result = new Map<string, OnDemandGitSignals>();
  if (targets.length === 0) return result;
  const churn = await buildFileSignalsForPaths(
    adapter,
    targets.map((target) => target.relPath),
    options.timeoutMs,
  );
  const withHistory = targets.filter((target) => (churn.get(target.relPath)?.commits.length ?? 0) > 0);
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

  const chunkMap = await headChunkMap(adapter, withHistory);
  if (chunkMap.size === 0) return result;
  const overlays = await buildChunkChurnMapUncached(
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
  );
  for (const [relPath, byChunk] of overlays) {
    const answer = result.get(relPath);
    if (!answer) continue;
    for (const [chunkId, overlay] of byChunk) answer.chunks.set(chunkId, overlay);
  }
  return result;
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
 * The walk's chunk map: each row carried onto the HEAD rows it still holds,
 * keyed by absolute path as ingest keys it. A path absent at HEAD, or a row of
 * only uncommitted lines, contributes nothing.
 */
async function headChunkMap(
  adapter: VcsGitAdapter,
  targets: readonly OnDemandGitSignalTarget[],
): Promise<Map<string, ChunkLookupEntry[]>> {
  const chunkMap = new Map<string, ChunkLookupEntry[]>();
  const wanted = targets.filter((target) => target.workingContent !== undefined && target.chunks.length > 0);
  if (wanted.length === 0) return chunkMap;
  const head = await adapter.getHead();
  for (const target of wanted) {
    const headContent = await adapter.readBlobAsString(head, target.relPath);
    if (headContent === "") continue;
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
    for (const chunk of target.chunks) {
      const span = headRowSpanOfWorkingRows(hunks, chunk.startLine, chunk.endLine);
      if (span) entries.push({ chunkId: chunk.chunkId, startLine: span.start, endLine: span.end });
    }
    if (entries.length > 0) chunkMap.set(`${adapter.repoRoot}/${target.relPath}`, entries);
  }
  return chunkMap;
}
