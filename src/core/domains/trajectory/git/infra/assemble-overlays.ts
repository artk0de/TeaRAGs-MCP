/**
 * Phase 3 of buildChunkChurnMapUncached: final reduce to per-file overlay maps.
 *
 * Reads from per-chunk accumulators (populated by walkCommits) and optional
 * file-level churn/blame data to produce the public
 * Map<relativePath, Map<chunkId, ChunkChurnOverlay>>.
 */

import type { BlameLine, FileChurnData } from "../../../../adapters/vcs/index.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { authorIdentityKey } from "../history/index.js";
import type { ChunkChurnOverlay } from "../types.js";
import { computeBlameOwnership } from "./blame-ownership.js";
import type { ChunkAccumulator } from "./metrics.js";
import { assembleChunkSignals } from "./metrics/chunk-assembler.js";

export interface AssembleOverlaysOptions {
  relativeChunkMap: Map<string, ChunkLookupEntry[]>;
  accumulators: Map<string, ChunkAccumulator>;
  fileChurnDataMap?: Map<string, FileChurnData>;
  blameByPath?: Map<string, BlameLine[]>;
  /** The run's history anchor (unix seconds) — see `history-anchor.ts`; absent ⇒ the wall clock. */
  historyAnchorSec?: number;
}

export function assembleOverlays(opts: AssembleOverlaysOptions): Map<string, Map<string, ChunkChurnOverlay>> {
  const { relativeChunkMap, accumulators, fileChurnDataMap, blameByPath, historyAnchorSec } = opts;

  // Build result map
  const result = new Map<string, Map<string, ChunkChurnOverlay>>();

  for (const [relPath, entries] of relativeChunkMap) {
    // Use file-level commit count from buildFileSignalMap when available.
    // This fixes churnRatio always being ~1.0 (the old denominator was
    // recomputed as the union of chunk SHAs, which ≈ max(commitCount)
    // for tightly-coupled files).
    const fileChurnData = fileChurnDataMap?.get(relPath);
    let fileCommitCount: number;
    let fileContributorCount: number | undefined;

    if (fileChurnData) {
      fileCommitCount = Math.max(fileChurnData.commits.length, 1);
      const uniqueAuthors = new Set(fileChurnData.commits.map(authorIdentityKey));
      fileContributorCount = uniqueAuthors.size;
    } else {
      // Fallback: union of chunk commit SHAs (original behavior)
      const fileCommitShas = new Set<string>();
      for (const entry of entries) {
        const acc = accumulators.get(entry.chunkId);
        if (!acc) continue;
        for (const sha of acc.commitShas) {
          fileCommitShas.add(sha);
        }
      }
      fileCommitCount = Math.max(fileCommitShas.size, 1);
    }

    // Compute chunk-level line ownership from blame for this file's chunk ranges.
    const blameLines = blameByPath?.get(relPath);
    const chunkOwnerships =
      blameLines && blameLines.length > 0
        ? computeBlameOwnership(
            blameLines,
            entries.map((e) => ({ chunkId: e.chunkId, startLine: e.startLine, endLine: e.endLine })),
          ).chunks
        : null;

    const overlayMap = new Map<string, ChunkChurnOverlay>();

    for (const entry of entries) {
      const acc = accumulators.get(entry.chunkId);
      if (!acc) continue;
      const chunkLineCount = entry.endLine - entry.startLine + 1;
      overlayMap.set(
        entry.chunkId,
        assembleChunkSignals(
          acc,
          fileCommitCount,
          fileContributorCount,
          chunkLineCount,
          chunkOwnerships?.get(entry.chunkId),
          historyAnchorSec,
        ),
      );
    }

    if (overlayMap.size > 0) {
      result.set(relPath, overlayMap);
    }
  }

  return result;
}
