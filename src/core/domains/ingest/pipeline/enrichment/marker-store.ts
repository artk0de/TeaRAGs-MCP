/**
 * EnrichmentMarkerStore — sole owner of payload.enrichment.<provider>.{file,chunk}.
 *
 * Replaces scattered updateEnrichmentMarker calls with 5 domain-specific write
 * methods. Deep-merge of partial updates is an internal detail.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkFinalInput, FileFinalInput, RecoveryResultInput } from "./types.js";

interface ProviderMarkerSlice {
  runId?: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}

export class EnrichmentMarkerStore {
  constructor(private readonly qdrant: QdrantManager) {}

  /** Initial marker for all providers at run start. file=in_progress, chunk=pending. */
  async markStart(coll: string, providerKeys: Iterable<string>, runId: string, startedAt: string): Promise<void> {
    const updates: Record<string, ProviderMarkerSlice> = {};
    for (const key of providerKeys) {
      updates[key] = {
        runId,
        file: { status: "in_progress", startedAt, unenrichedChunks: 0 },
        chunk: { status: "pending", unenrichedChunks: 0 },
      };
    }
    await this.write(coll, updates);
  }

  /** Single-provider failure marker for prefetch error path. */
  async markPrefetchFailed(
    coll: string,
    providerKey: string,
    runId: string,
    startedAt: string,
    durationMs: number,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.write(coll, {
      [providerKey]: {
        runId,
        file: {
          status: "failed",
          startedAt,
          completedAt,
          durationMs,
          unenrichedChunks: 0,
        },
        chunk: { status: "failed", unenrichedChunks: 0 },
      },
    });
  }

  /** Recovery finalization — both levels written together. */
  async markRecoveryResult(coll: string, providerKey: string, input: RecoveryResultInput): Promise<void> {
    await this.write(coll, {
      [providerKey]: {
        file: {
          status: input.fileStatus,
          unenrichedChunks: input.fileUnenriched,
        },
        chunk: {
          status: input.chunkStatus,
          unenrichedChunks: input.chunkUnenriched,
        },
      },
    });
  }

  /** File-level final marker (called from CompletionRunner step 4). */
  async markFileFinal(coll: string, providerKey: string, input: FileFinalInput): Promise<void> {
    await this.write(coll, {
      [providerKey]: {
        file: {
          status: input.status,
          completedAt: new Date().toISOString(),
          durationMs: input.durationMs,
          unenrichedChunks: input.unenrichedChunks,
          matchedFiles: input.matchedFiles,
          missedFiles: input.missedFiles,
        },
      },
    });
  }

  /** Chunk-level final marker (called from CompletionRunner step 7). */
  async markChunkFinal(coll: string, providerKey: string, input: ChunkFinalInput): Promise<void> {
    await this.write(coll, {
      [providerKey]: {
        chunk: {
          status: input.status,
          completedAt: new Date().toISOString(),
          durationMs: input.durationMs,
          unenrichedChunks: input.unenrichedChunks,
        },
      },
    });
  }

  /** Read the full marker record (or null if missing). */
  async read(coll: string): Promise<Record<string, unknown> | null> {
    try {
      const point = await this.qdrant.getPoint(coll, INDEXING_METADATA_ID);
      const e = point?.payload?.enrichment;
      if (e && typeof e === "object") return e as Record<string, unknown>;
    } catch {
      // marker may not exist yet
    }
    return null;
  }

  /** Read runId for a specific provider. */
  async getRunId(coll: string, providerKey: string): Promise<string | undefined> {
    const marker = await this.read(coll);
    const entry = marker?.[providerKey] as Record<string, unknown> | undefined;
    return typeof entry?.runId === "string" ? entry.runId : undefined;
  }

  /** Internal deep-merge writer. Surfaces failures via pipelineLog. */
  private async write(coll: string, updates: Record<string, ProviderMarkerSlice>): Promise<void> {
    try {
      const existing = (await this.read(coll)) ?? {};
      const enrichment: Record<string, unknown> = { ...existing };

      for (const [providerKey, slice] of Object.entries(updates)) {
        const prev = (enrichment[providerKey] as Record<string, unknown>) ?? {};
        const merged: Record<string, unknown> = { ...prev };
        if (slice.runId !== undefined) merged.runId = slice.runId;
        if (slice.file) {
          merged.file = {
            ...(prev.file as Record<string, unknown> | undefined),
            ...slice.file,
          };
        }
        if (slice.chunk) {
          merged.chunk = {
            ...(prev.chunk as Record<string, unknown> | undefined),
            ...slice.chunk,
          };
        }
        enrichment[providerKey] = merged;
      }

      await this.qdrant.setPayload(coll, { enrichment }, { points: [INDEXING_METADATA_ID] });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Enrichment] Failed to update marker for collection ${coll}:`, msg);
      pipelineLog.enrichmentPhase("MARKER_UPDATE_FAILED", {
        collection: coll,
        providers: Object.keys(updates),
        error: msg,
      });
    }
  }
}
