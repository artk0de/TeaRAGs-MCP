/**
 * Working-tree rows carried onto HEAD (bd tea-rags-mcp-xi2r9).
 *
 * The chunk walk addresses HEAD rows: it diffs commits newest → oldest and
 * carries each range back from HEAD (`infra/offset-tracker.ts`). A chunker
 * reading the working tree hands it the WORKING file's rows, which are HEAD's
 * only while the file is clean. Uncommitted lines above a symbol shift it onto
 * another symbol's HEAD rows, and the walk then credits it with that symbol's
 * commits.
 *
 * So a dirty file's rows are carried onto HEAD first, through the zero-context
 * HEAD → working hunks (`headRowSpanOfWorkingRows`): a row keeps the span from
 * its first to its last committed row, in HEAD coordinates. A row made only of
 * lines the working file added was never committed and holds no history: the
 * walk would reach it with no commit, so it gets the walk's zero overlay
 * (`zeroOverlaysOfUncommittedRows`) — `assembleOverlays` over an accumulator no
 * commit touched, with the file's churn as denominator and unknown ownership
 * (no HEAD blame line attributes an uncommitted line).
 *
 * One computation for both readers of a working tree: ingest's chunk phase
 * (`carryDirtyChunkMapOntoHead`, `GitEnrichmentProvider#buildChunkSignals`) and
 * the working-tree overlay's on-demand rows (`buildOnDemandGitSignals`), so a
 * delta row and a reindex of the same dirty tree agree.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { structuredPatch } from "diff";

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { BlobBatchReader, FileChurnData } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkChurnOverlay } from "../types.js";
import { assembleOverlays } from "./assemble-overlays.js";
import { buildAccumulators } from "./build-accumulators.js";
import type { SquashOptions } from "./metrics.js";
import { headRowSpanOfWorkingRows } from "./offset-tracker.js";

/** One file's rows in its WORKING lines, with the working content they address. */
export interface WorkingRowsOfFile {
  /** Repo-relative. */
  relPath: string;
  workingContent: string;
  chunks: readonly ChunkLookupEntry[];
}

/**
 * `carryWorkingRowsOntoHead` keys both maps by absolute path
 * (`<repoRoot>/<relPath>`); `carryDirtyChunkMapOntoHead` keeps `chunkMap` under
 * the caller's own keys (repo-relative or absolute). Consumers relativize them
 * as `relativizeChunkMap` does.
 */
export interface WorkingRowsAtHead {
  /** Rows holding at least one committed line, in HEAD lines — what the walk is handed. */
  chunkMap: Map<string, ChunkLookupEntry[]>;
  /** Rows made only of uncommitted lines, in their working lines — the walk's zero overlay. */
  uncommittedRows: Map<string, ChunkLookupEntry[]>;
}

/** Concurrent HEAD blob reads per call. */
const HEAD_READ_CONCURRENCY = 4;

/**
 * Each file's rows carried onto the HEAD rows they still hold, and apart the
 * rows made only of uncommitted lines. A path absent at HEAD (its HEAD blob
 * reads empty) contributes nothing to either map — the caller decides what such
 * a path means. Reads HEAD blobs through `blobReader` when given (the run's
 * reader, which the caller keeps open), else through one this call opens and
 * closes.
 */
export async function carryWorkingRowsOntoHead(
  adapter: VcsGitAdapter,
  files: readonly WorkingRowsOfFile[],
  blobReader?: BlobBatchReader,
): Promise<WorkingRowsAtHead> {
  const chunkMap = new Map<string, ChunkLookupEntry[]>();
  const uncommittedRows = new Map<string, ChunkLookupEntry[]>();
  const wanted = files.filter((file) => file.chunks.length > 0);
  if (wanted.length === 0) return { chunkMap, uncommittedRows };
  const head = await adapter.getHead();
  const reader = blobReader ?? adapter.createBlobBatchReader();
  const carry = async (file: WorkingRowsOfFile): Promise<void> => {
    const headContent = await reader.read(head, file.relPath);
    if (headContent === "") return;
    const { hunks } = structuredPatch(file.relPath, file.relPath, headContent, file.workingContent, "", "", {
      context: 0,
    });
    const atHead: ChunkLookupEntry[] = [];
    const uncommitted: ChunkLookupEntry[] = [];
    for (const chunk of file.chunks) {
      const span = headRowSpanOfWorkingRows(hunks, chunk.startLine, chunk.endLine);
      if (span) atHead.push({ ...chunk, startLine: span.start, endLine: span.end });
      else uncommitted.push(chunk);
    }
    const absolutePath = `${adapter.repoRoot}/${file.relPath}`;
    if (atHead.length > 0) chunkMap.set(absolutePath, atHead);
    if (uncommitted.length > 0) uncommittedRows.set(absolutePath, uncommitted);
  };
  try {
    for (let i = 0; i < wanted.length; i += HEAD_READ_CONCURRENCY) {
      await Promise.all(wanted.slice(i, i + HEAD_READ_CONCURRENCY).map(carry));
    }
  } finally {
    if (!blobReader) await reader.close();
  }
  return { chunkMap, uncommittedRows };
}

/**
 * The walk's chunk map for a chunk batch read from the working tree: every
 * file HEAD holds whose working content differs from it carried onto HEAD
 * (`carryWorkingRowsOntoHead`), every other file as it is. Clean batches — the
 * common case — come back as the SAME map, with no blob read. A failed listing
 * or working-file read leaves the files it covers as they are: the walk then
 * reads working rows as HEAD rows, which is exact for every clean file.
 */
export async function carryDirtyChunkMapOntoHead(
  adapter: VcsGitAdapter,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  timeoutMs: number,
  blobReader?: BlobBatchReader,
): Promise<WorkingRowsAtHead> {
  const prefix = `${adapter.repoRoot}/`;
  // The walk's chunk map comes keyed either way — repo-relative from ingest
  // (`ChunkPhase`, the recompute scroll), absolute from other callers — so each
  // key is resolved to its repo-relative path the way `relativizeChunkMap`
  // does, and the carried rows are written back under the caller's key.
  const keyOfRelPath = new Map<string, string>();
  for (const [key, chunks] of chunkMap) {
    if (chunks.length === 0) continue;
    if (key.startsWith(prefix)) keyOfRelPath.set(key.slice(prefix.length), key);
    else if (!isAbsolute(key)) keyOfRelPath.set(key, key);
  }
  const relPaths = [...keyOfRelPath.keys()];
  const unchanged: WorkingRowsAtHead = { chunkMap, uncommittedRows: new Map() };
  if (relPaths.length === 0) return unchanged;

  let modified: string[];
  try {
    modified = await adapter.listWorktreeModifications(relPaths, timeoutMs);
  } catch (error) {
    if (isDebug()) {
      console.error(
        "[ChunkChurn] working-tree diff failed, walking rows as read:",
        error instanceof Error ? error.message : error,
      );
    }
    return unchanged;
  }
  if (modified.length === 0) return unchanged;

  const files: WorkingRowsOfFile[] = [];
  for (const relPath of modified) {
    const key = keyOfRelPath.get(relPath);
    const chunks = key === undefined ? undefined : chunkMap.get(key);
    if (!chunks) continue;
    const workingContent = await readFile(`${prefix}${relPath}`, "utf8").catch(() => undefined);
    if (workingContent !== undefined) files.push({ relPath, workingContent, chunks });
  }
  if (files.length === 0) return unchanged;

  const carried = await carryWorkingRowsOntoHead(adapter, files, blobReader);
  const walkMap = new Map(chunkMap);
  for (const { relPath } of files) {
    const carriedKey = `${prefix}${relPath}`;
    // Absent from both maps: HEAD reads empty for it, so there are no HEAD rows
    // to carry onto — left as read.
    if (!carried.chunkMap.has(carriedKey) && !carried.uncommittedRows.has(carriedKey)) continue;
    const callerKey = keyOfRelPath.get(relPath) ?? carriedKey;
    const atHead = carried.chunkMap.get(carriedKey);
    if (atHead) walkMap.set(callerKey, atHead);
    else walkMap.delete(callerKey);
  }
  return { chunkMap: walkMap, uncommittedRows: carried.uncommittedRows };
}

/**
 * The walk's zero overlay for rows made only of uncommitted lines, by
 * repo-relative path. Rows of a file past `maxFileLines` get nothing, as the
 * walk walks none (`buildAccumulators`).
 */
export function zeroOverlaysOfUncommittedRows(
  repoRoot: string,
  uncommittedRows: ReadonlyMap<string, ChunkLookupEntry[]>,
  options: { fileChurnDataMap?: Map<string, FileChurnData>; maxFileLines: number; squashOpts?: SquashOptions },
): Map<string, Map<string, ChunkChurnOverlay>> {
  if (uncommittedRows.size === 0) return new Map();
  const { relativeChunkMap, accumulators } = buildAccumulators(
    repoRoot,
    new Map(uncommittedRows),
    options.maxFileLines,
  );
  return assembleOverlays({
    relativeChunkMap,
    accumulators,
    ...(options.fileChurnDataMap ? { fileChurnDataMap: options.fileChurnDataMap } : {}),
    ...(options.squashOpts ? { squashOpts: options.squashOpts } : {}),
  });
}
