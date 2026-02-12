/**
 * EnrichmentModule - Background git metadata enrichment for indexed chunks.
 *
 * Extracted from CodeIndexer to isolate the fire-and-forget git enrichment logic.
 */

import { relative } from "node:path";
import type { QdrantManager } from "../../qdrant/client.js";
import { GitLogReader, computeFileMetadata } from "../git/git-log-reader.js";
import { pipelineLog } from "../pipeline/debug-logger.js";
import type { ChunkLookupEntry, EnrichmentInfo } from "../types.js";
import { INDEXING_METADATA_ID } from "./shared.js";

export class EnrichmentModule {
  private activeEnrichments = new Map<string, Promise<void>>();

  constructor(private qdrant: QdrantManager) {}

  /**
   * Fire-and-forget background git enrichment using isomorphic-git.
   * Reads entire git log in a single pass (0 blame spawns),
   * then applies file-level churn metrics to all chunks via batchSetPayload.
   */
  startBackgroundEnrichment(
    collectionName: string,
    absolutePath: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    config: { enableGitMetadata: boolean },
  ): void {
    // Prevent duplicate enrichments for the same collection
    if (this.activeEnrichments.has(collectionName)) {
      console.error(`[BackgroundEnrichment] Already running for ${collectionName}, skipping`);
      return;
    }

    const startTime = Date.now();

    const enrichment = (async () => {
      try {
        // 1. Mark enrichment in progress
        await this.updateEnrichmentMarker(collectionName, {
          status: "in_progress",
          totalFiles: chunkMap.size,
          processedFiles: 0,
          startedAt: new Date().toISOString(),
        });

        pipelineLog.enrichmentPhase("BACKGROUND_START", {
          files: chunkMap.size,
          totalChunks: Array.from(chunkMap.values()).reduce((sum, e) => sum + e.length, 0),
        });
        const gitLogStart = Date.now();

        // 2. Read entire git history via isomorphic-git (single pass, 0 process spawns)
        const logReader = new GitLogReader();
        const fileMetadataMap = await logReader.buildFileMetadataMap(absolutePath);

        pipelineLog.addStageTime("gitLog", Date.now() - gitLogStart);
        pipelineLog.enrichmentPhase("GIT_LOG_COMPLETE", {
          filesInLog: fileMetadataMap.size,
          durationMs: Date.now() - gitLogStart,
        });

        // 3. For each file: compute churn metrics → batchSetPayload
        let processedFiles = 0;
        let enrichedChunks = 0;
        let failedFiles = 0;
        const BATCH_SIZE = 100;
        let batch: Array<{ payload: Record<string, any>; points: (string | number)[] }> = [];

        for (const [filePath, chunkEntries] of chunkMap) {
          const relativePath = relative(absolutePath, filePath);
          const churnData = fileMetadataMap.get(relativePath);

          if (churnData) {
            // Estimate current line count from max endLine of chunks
            const maxEndLine = chunkEntries.reduce((max, e) => Math.max(max, e.endLine), 0);
            const metadata = computeFileMetadata(churnData, maxEndLine);

            // All chunks of the file get the SAME payload (file-level metrics)
            const gitPayload = { git: metadata };
            for (const entry of chunkEntries) {
              batch.push({ payload: gitPayload, points: [entry.chunkId] });
            }
          } else {
            failedFiles++;
          }

          // Flush batch when it reaches BATCH_SIZE
          if (batch.length >= BATCH_SIZE) {
            try {
              await this.qdrant.batchSetPayload(collectionName, batch);
              enrichedChunks += batch.length;
            } catch (error) {
              if (process.env.DEBUG) {
                console.error("[BackgroundEnrichment] Batch flush failed:", error);
              }
            }
            batch = [];
          }

          processedFiles++;

          // Update progress marker every 50 files
          if (processedFiles % 50 === 0) {
            await this.updateEnrichmentMarker(collectionName, {
              status: "in_progress",
              processedFiles,
              totalFiles: chunkMap.size,
            }).catch(() => {});
          }
        }

        // Flush remaining batch
        if (batch.length > 0) {
          try {
            await this.qdrant.batchSetPayload(collectionName, batch);
            enrichedChunks += batch.length;
          } catch (error) {
            if (process.env.DEBUG) {
              console.error("[BackgroundEnrichment] Final batch flush failed:", error);
            }
          }
        }

        // 3b. Chunk-level churn overlay (Phase 2b)
        let chunkOverlaysApplied = 0;
        if (process.env.GIT_CHUNK_ENABLED !== "false") {
          const chunkChurnStart = Date.now();
          const chunkConcurrency = parseInt(process.env.GIT_CHUNK_CONCURRENCY ?? "10", 10);
          const chunkMaxAgeMonths = parseFloat(process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6");

          pipelineLog.enrichmentPhase("CHUNK_CHURN_START", {
            concurrency: chunkConcurrency,
            maxAgeMonths: chunkMaxAgeMonths,
            files: chunkMap.size,
          });

          try {
            const chunkChurnMap = await logReader.buildChunkChurnMap(
              absolutePath,
              chunkMap,
              chunkConcurrency,
              chunkMaxAgeMonths,
            );

            // Apply chunk-level overlays via batchSetPayload with key:"git" for nested merge
            let chunkBatch: Array<{ payload: Record<string, any>; points: (string | number)[]; key?: string }> = [];

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
                    await this.qdrant.batchSetPayload(collectionName, chunkBatch);
                    chunkOverlaysApplied += chunkBatch.length;
                  } catch (error) {
                    if (process.env.DEBUG) {
                      console.error("[BackgroundEnrichment] Chunk churn batch failed:", error);
                    }
                  }
                  chunkBatch = [];
                }
              }
            }

            // Flush remaining chunk batch
            if (chunkBatch.length > 0) {
              try {
                await this.qdrant.batchSetPayload(collectionName, chunkBatch);
                chunkOverlaysApplied += chunkBatch.length;
              } catch (error) {
                if (process.env.DEBUG) {
                  console.error("[BackgroundEnrichment] Chunk churn final batch failed:", error);
                }
              }
            }

            pipelineLog.enrichmentPhase("CHUNK_CHURN_COMPLETE", {
              overlaysApplied: chunkOverlaysApplied,
              durationMs: Date.now() - chunkChurnStart,
            });
          } catch (error) {
            console.error("[BackgroundEnrichment] Chunk churn failed:", error);
            pipelineLog.enrichmentPhase("CHUNK_CHURN_FAILED", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const durationMs = Date.now() - startTime;

        // 4. Mark enrichment complete
        await this.updateEnrichmentMarker(collectionName, {
          status: failedFiles > 0 ? "partial" : "completed",
          processedFiles: chunkMap.size,
          totalFiles: chunkMap.size,
          completedAt: new Date().toISOString(),
          durationMs,
          failedFiles,
        });

        pipelineLog.enrichmentPhase("BACKGROUND_COMPLETE", {
          enrichedChunks,
          chunkOverlaysApplied,
          failedFiles,
          durationMs,
        });

        if (process.env.DEBUG) {
          console.error(
            `[BackgroundEnrichment] Completed: ${enrichedChunks} chunks, ` +
            `${failedFiles} files without git data, ${(durationMs / 1000).toFixed(1)}s`,
          );
        }
      } catch (error) {
        console.error("[BackgroundEnrichment] Failed:", error);
        await this.updateEnrichmentMarker(collectionName, {
          status: "failed",
        }).catch(() => {});
      }
    })();

    this.activeEnrichments.set(collectionName, enrichment);
    enrichment.finally(() => this.activeEnrichments.delete(collectionName));
  }

  /**
   * Update enrichment progress marker in Qdrant (merge into __indexing_metadata__ point).
   */
  private async updateEnrichmentMarker(
    collectionName: string,
    info: Partial<EnrichmentInfo>,
  ): Promise<void> {
    try {
      const enrichment: Record<string, any> = { ...info };
      if (info.totalFiles && info.processedFiles !== undefined) {
        enrichment.percentage = Math.round((info.processedFiles / info.totalFiles) * 100);
      }
      await this.qdrant.setPayload(
        collectionName,
        { enrichment },
        { points: [INDEXING_METADATA_ID] },
      );
    } catch (error) {
      // Non-fatal
      if (process.env.DEBUG) {
        console.error("[BackgroundEnrichment] Failed to update marker:", error);
      }
    }
  }
}
