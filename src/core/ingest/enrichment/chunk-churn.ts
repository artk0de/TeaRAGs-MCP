/**
 * ChunkChurn - Applies chunk-level git churn overlays (Phase 2b enrichment).
 *
 * Runs after pipeline flush. Computes per-chunk commit counts, churn ratios,
 * contributor counts, and bug-fix rates, then writes them to Qdrant.
 */

import { relative } from "node:path";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { ChunkLookupEntry } from "../../types.js";
import { INDEXING_METADATA_ID } from "../constants.js";
import type { GitLogReader } from "../git/git-log-reader.js";
import type { FileChurnData } from "../git/types.js";
import { pipelineLog } from "../pipeline/debug-logger.js";

const BATCH_SIZE = 100;

export async function runChunkChurn(
  qdrant: QdrantManager,
  collectionName: string,
  absolutePath: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  logReader: GitLogReader,
  gitLogResult: Map<string, FileChurnData> | undefined,
  gitRepoRoot: string,
  ignoreFilter: Ignore | null,
): Promise<number> {
  const chunkConcurrency = parseInt(process.env.GIT_CHUNK_CONCURRENCY ?? "10", 10);
  const chunkMaxAgeMonths = parseFloat(process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6");

  if (process.env.GIT_CHUNK_ENABLED === "false") return 0;

  const repoRoot = gitRepoRoot || absolutePath;

  // Filter chunkMap by ignore patterns
  let effectiveChunkMap = chunkMap;
  if (ignoreFilter) {
    effectiveChunkMap = new Map();
    let filtered = 0;
    for (const [filePath, entries] of chunkMap) {
      const relPath = relative(repoRoot, filePath);
      if (ignoreFilter.ignores(relPath)) {
        filtered++;
      } else {
        effectiveChunkMap.set(filePath, entries);
      }
    }
    if (filtered > 0) {
      pipelineLog.enrichmentPhase("CHUNK_CHURN_FILTERED", {
        filtered,
        remaining: effectiveChunkMap.size,
      });
    }
  }

  pipelineLog.enrichmentPhase("CHUNK_CHURN_START", {
    concurrency: chunkConcurrency,
    maxAgeMonths: chunkMaxAgeMonths,
    files: effectiveChunkMap.size,
  });

  const chunkChurnStart = Date.now();

  try {
    const chunkChurnMap = await logReader.buildChunkChurnMap(
      repoRoot,
      effectiveChunkMap,
      chunkConcurrency,
      chunkMaxAgeMonths,
      gitLogResult,
    );

    // Apply chunk-level overlays
    let chunkBatch: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key?: string;
    }[] = [];
    let overlaysApplied = 0;

    for (const [, overlayMap] of chunkChurnMap) {
      for (const [chunkId, overlay] of overlayMap) {
        chunkBatch.push({
          payload: {
            chunkCommitCount: overlay.chunkCommitCount,
            chunkChurnRatio: overlay.chunkChurnRatio,
            chunkContributorCount: overlay.chunkContributorCount,
            chunkBugFixRate: overlay.chunkBugFixRate,
            chunkLastModifiedAt: overlay.chunkLastModifiedAt,
            chunkAgeDays: overlay.chunkAgeDays,
          },
          points: [chunkId],
          key: "git",
        });

        if (chunkBatch.length >= BATCH_SIZE) {
          try {
            await qdrant.batchSetPayload(collectionName, chunkBatch);
            overlaysApplied += chunkBatch.length;
          } catch (error) {
            if (process.env.DEBUG) {
              console.error("[ChunkChurn] batch failed:", error);
            }
          }
          chunkBatch = [];
        }
      }
    }

    // Flush remaining
    if (chunkBatch.length > 0) {
      try {
        await qdrant.batchSetPayload(collectionName, chunkBatch);
        overlaysApplied += chunkBatch.length;
      } catch (error) {
        if (process.env.DEBUG) {
          console.error("[ChunkChurn] final batch failed:", error);
        }
      }
    }

    const durationMs = Date.now() - chunkChurnStart;

    // Write chunk enrichment status to Qdrant
    try {
      await qdrant.setPayload(
        collectionName,
        {
          chunkEnrichment: { status: "completed", overlaysApplied, durationMs },
        },
        { points: [INDEXING_METADATA_ID] },
      );
    } catch (error) {
      if (process.env.DEBUG) {
        console.error("[ChunkChurn] Failed to update marker:", error);
      }
    }

    pipelineLog.enrichmentPhase("CHUNK_CHURN_COMPLETE", {
      overlaysApplied,
      durationMs,
    });

    return durationMs;
  } catch (error) {
    const durationMs = Date.now() - chunkChurnStart;
    console.error("[ChunkChurn] failed:", error);
    pipelineLog.enrichmentPhase("CHUNK_CHURN_FAILED", {
      error: error instanceof Error ? error.message : String(error),
    });
    return durationMs;
  }
}
