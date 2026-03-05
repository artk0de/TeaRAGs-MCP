/**
 * Deletion Strategy - 3-level fallback cascade for removing old chunks from Qdrant.
 *
 * Level 0: Batched path deletion (fast, concurrent)
 * Level 1: Bulk path deletion (single call fallback)
 * Level 2: Individual filter-based deletion (slow, last resort)
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import type { ProgressCallback } from "../../types.js";
import { pipelineLog } from "../pipeline/infra/debug-logger.js";

export interface DeletionConfig {
  batchSize: number;
  concurrency: number;
}

/**
 * Delete chunks for a list of relative file paths using a 3-level fallback cascade.
 */
export async function performDeletion(
  qdrant: QdrantManager,
  collectionName: string,
  filesToDelete: string[],
  deleteConfig: DeletionConfig,
  progressCallback?: ProgressCallback,
): Promise<void> {
  if (filesToDelete.length === 0) return;

  progressCallback?.({
    phase: "scanning",
    current: 0,
    total: filesToDelete.length,
    percentage: 5,
    message: `Deleting old chunks for ${filesToDelete.length} files...`,
  });

  try {
    const deleteResult = await qdrant.deletePointsByPathsBatched(collectionName, filesToDelete, {
      batchSize: deleteConfig.batchSize,
      concurrency: deleteConfig.concurrency,
      onProgress: (deleted, total) => {
        progressCallback?.({
          phase: "scanning",
          current: deleted,
          total,
          percentage: 5 + Math.floor((deleted / total) * 5),
          message: `Deleting old chunks: ${deleted}/${total} files...`,
        });
      },
    });

    if (process.env.DEBUG) {
      console.error(
        `[Reindex] Deleted ${deleteResult.deletedPaths} paths in ${deleteResult.batchCount} batches (${deleteResult.durationMs}ms)`,
      );
    }
  } catch (error) {
    // FALLBACK LEVEL 1
    const errorMsg = error instanceof Error ? error.message : String(error);
    pipelineLog.fallback({ component: "Reindex" }, 1, `deletePointsByPathsBatched failed: ${errorMsg}`);
    console.error(
      `[Reindex] FALLBACK L1: deletePointsByPathsBatched failed for ${filesToDelete.length} paths:`,
      errorMsg,
    );

    try {
      const fallbackStart = Date.now();
      await qdrant.deletePointsByPaths(collectionName, filesToDelete);
      pipelineLog.step({ component: "Reindex" }, "FALLBACK_L1_SUCCESS", {
        durationMs: Date.now() - fallbackStart,
        paths: filesToDelete.length,
      });
      console.error(`[Reindex] FALLBACK L1 SUCCESS: deletePointsByPaths completed in ${Date.now() - fallbackStart}ms`);
    } catch (fallbackError) {
      // FALLBACK LEVEL 2
      const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      pipelineLog.fallback({ component: "Reindex" }, 2, `deletePointsByPaths failed: ${fallbackErrorMsg}`);
      console.error(`[Reindex] FALLBACK L2: deletePointsByPaths also failed:`, fallbackErrorMsg);
      console.error(`[Reindex] FALLBACK L2: Starting INDIVIDUAL deletions for ${filesToDelete.length} paths (SLOW!)`);

      let deleted = 0;
      let failed = 0;
      const individualStart = Date.now();

      for (const relativePath of filesToDelete) {
        try {
          const filter = {
            must: [{ key: "relativePath", match: { value: relativePath } }],
          };
          await qdrant.deletePointsByFilter(collectionName, filter);
          deleted++;
        } catch (innerError) {
          failed++;
          if (process.env.DEBUG) {
            console.error(`[Reindex] FALLBACK L2: Failed to delete ${relativePath}:`, innerError);
          }
        }
      }

      pipelineLog.step({ component: "Reindex" }, "FALLBACK_L2_COMPLETE", {
        deleted,
        failed,
        durationMs: Date.now() - individualStart,
      });
      console.error(
        `[Reindex] FALLBACK L2 COMPLETE: ${deleted} deleted, ${failed} failed in ${Date.now() - individualStart}ms`,
      );
    }
  }
}
