/**
 * EnrichmentMarkerStore — sole owner of payload.enrichment.<provider>.{file,chunk}.
 *
 * Replaces scattered updateEnrichmentMarker calls with 5 domain-specific write
 * methods. Deep-merge of partial updates is an internal detail.
 *
 * Write-path notes:
 * - `setPayload` MUST be called with `wait: true` — without it sequential
 *   read-modify-write races clobber prior writes (see comment in `write()`).
 * - All writes funnel through the private `write()` method so the deep-merge
 *   and wait-flag invariants live in exactly one place.
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

  /**
   * Single-provider failure marker for prefetch error path.
   *
   * `errorMessage` propagates the concrete failure string (e.g.
   * "Codegraph spill write failed at /tmp/...") so `get_index_status`
   * shows the cause instead of a stuck "in_progress" placeholder.
   * Optional for back-compat with older call sites that didn't carry
   * the message.
   */
  async markPrefetchFailed(
    coll: string,
    providerKey: string,
    runId: string,
    startedAt: string,
    durationMs: number,
    errorMessage?: string,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const file: Record<string, unknown> = {
      status: "failed",
      startedAt,
      completedAt,
      durationMs,
      unenrichedChunks: 0,
    };
    const chunk: Record<string, unknown> = { status: "failed", unenrichedChunks: 0 };
    if (errorMessage) {
      file.errorMessage = errorMessage;
      chunk.errorMessage = errorMessage;
    }
    await this.write(coll, {
      [providerKey]: {
        runId,
        file,
        chunk,
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

      // `wait: true` is mandatory for marker writes. Without it qdrant
      // acknowledges the write before the payload is visible to
      // subsequent `getPoint` reads — sequential read-modify-write
      // calls (markFileFinal for provider A, then provider B) race:
      // B reads STALE state (without A's write) and clobbers A's
      // status back to whatever the prior read saw. Empirically on
      // tea-rags self-test, ~90ms between markFileFinal calls was
      // not enough for qdrant to settle, and four sequential final-
      // marker writes ended with only the last provider's chunk
      // status surviving — all other levels reverted to markStart's
      // initial snapshot. Marker writes are infrequent metadata, so
      // the synchronous wait penalty is irrelevant.
      await this.qdrant.setPayload(coll, { enrichment }, { points: [INDEXING_METADATA_ID], wait: true });
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
