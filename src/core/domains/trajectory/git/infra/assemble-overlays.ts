/**
 * Phase 3 of buildChunkChurnMapUncached: final reduce to per-file overlay maps.
 *
 * Reads from per-chunk accumulators (populated by walkCommits) and optional
 * file-level churn/blame data to produce the public
 * Map<relativePath, Map<chunkId, ChunkChurnOverlay>>.
 */

import type { BlameLine, FileChurnData } from "../../../../adapters/git/types.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkChurnOverlay } from "../types.js";
import { computeBlameOwnership } from "./blame-ownership.js";
import type { ChunkAccumulator, SquashOptions } from "./metrics.js";
import { assembleChunkSignals } from "./metrics/chunk-assembler.js";
import { groupIntoSessions } from "./metrics/sessions.js";

export interface AssembleOverlaysOptions {
  relativeChunkMap: Map<string, ChunkLookupEntry[]>;
  accumulators: Map<string, ChunkAccumulator>;
  fileChurnDataMap?: Map<string, FileChurnData>;
  squashOpts?: SquashOptions;
  blameByPath?: Map<string, BlameLine[]>;
}

export function assembleOverlays(opts: AssembleOverlaysOptions): Map<string, Map<string, ChunkChurnOverlay>> {
  const { relativeChunkMap, accumulators, fileChurnDataMap, squashOpts, blameByPath } = opts;

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
      // Under squash, the chunk denominator becomes a session count, so the
      // file denominator must too — otherwise churnRatio mixes units (sessions
      // over raw commits). Mirrors the chunk-level session normalization.
      const rawFileCommitCount = fileChurnData.commits.length;
      const squashedFileCommitCount =
        squashOpts?.squashAwareSessions === true
          ? groupIntoSessions(fileChurnData.commits, squashOpts.sessionGapMinutes ?? 30).length
          : rawFileCommitCount;
      fileCommitCount = Math.max(squashedFileCommitCount, 1);
      const uniqueAuthors = new Set(fileChurnData.commits.map((c) => c.author));
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
          squashOpts,
          chunkOwnerships?.get(entry.chunkId),
        ),
      );
    }

    if (overlayMap.size > 0) {
      result.set(relPath, overlayMap);
    }
  }

  return result;
}
