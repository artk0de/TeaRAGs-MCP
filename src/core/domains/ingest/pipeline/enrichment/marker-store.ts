/**
 * EnrichmentMarkerStore — sole owner of payload.enrichment.
 *
 * Terminal-only marker model (2026-06-01 redesign): the store NEVER persists
 * intermediate `in_progress`/`pending` per-level status. Two kinds of write:
 *
 *  - `markRunStart` / `heartbeat` write the single `_run` pointer
 *    (`{ runId, startedAt, lastProgressAt }`) — the ONLY pre-completion write.
 *  - `markFileFinal` / `markChunkFinal` / `markPrefetchFailed` /
 *    `markRecoveryResult` write TERMINAL per-kind markers
 *    (`completed`/`degraded`/`failed`), each stamped with the producing `runId`.
 *
 * Every write targets a DISJOINT nested key (`enrichment._run`,
 * `enrichment.<provider>.file`, `enrichment.<provider>.chunk`) via Qdrant
 * `set_payload`'s `key` parameter (through `batchSetPayload`). Qdrant serialises
 * payload updates per point server-side, so concurrent writes to disjoint keys
 * never lose each other — there is NO client-side read-modify-write, hence no
 * RMW race (the old deep-merge `write()` is gone). `wait: true` keeps the write
 * durable before the call returns.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkFinalInput, FileFinalInput, RecoveryResultInput } from "./types.js";

export class EnrichmentMarkerStore {
  constructor(private readonly qdrant: QdrantManager) {}

  /**
   * Run-pointer — the only pre-completion write. Lives at enrichment._run and
   * carries the active provider keys so the health mapper knows which nested
   * marker paths to navigate (markers are stored nested, not self-describing).
   */
  async markRunStart(coll: string, providerKeys: Iterable<string>, runId: string, startedAt: string): Promise<void> {
    await this.writeKeys(coll, [
      { key: "enrichment._run", value: { runId, startedAt, lastProgressAt: startedAt, providers: [...providerKeys] } },
    ]);
  }

  /**
   * Throttled heartbeat — rewrites the whole `_run` object (the coordinator
   * holds runId + startedAt + provider keys in RunState), advancing
   * `lastProgressAt`. wait:false — the heartbeat is advisory; losing one is
   * harmless.
   */
  async heartbeat(
    coll: string,
    providerKeys: Iterable<string>,
    runId: string,
    startedAt: string,
    lastProgressAt: string,
  ): Promise<void> {
    await this.writeKeys(
      coll,
      [{ key: "enrichment._run", value: { runId, startedAt, lastProgressAt, providers: [...providerKeys] } }],
      false,
    );
  }

  /** File-level terminal marker (CompletionRunner step 4). Carries runId. */
  async markFileFinal(coll: string, providerKey: string, input: FileFinalInput): Promise<void> {
    await this.writeKeys(coll, [
      {
        key: `enrichment.${providerKey}.file`,
        value: {
          runId: input.runId,
          status: input.status,
          completedAt: new Date().toISOString(),
          durationMs: input.durationMs,
          unenrichedChunks: input.unenrichedChunks,
          matchedFiles: input.matchedFiles,
          missedFiles: input.missedFiles,
          ignoredFiles: input.ignoredFiles,
        },
      },
    ]);
  }

  /** Chunk-level terminal marker (CompletionRunner step 8). Carries runId. */
  async markChunkFinal(coll: string, providerKey: string, input: ChunkFinalInput): Promise<void> {
    await this.writeKeys(coll, [
      {
        key: `enrichment.${providerKey}.chunk`,
        value: {
          runId: input.runId,
          status: input.status,
          completedAt: new Date().toISOString(),
          durationMs: input.durationMs,
          unenrichedChunks: input.unenrichedChunks,
        },
      },
    ]);
  }

  /**
   * Single-provider failure marker for the prefetch error path. Writes BOTH
   * levels terminal (`failed`) carrying `runId`. `errorMessage` propagates the
   * concrete failure so `get_index_status` shows the cause.
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
      runId,
      status: "failed",
      startedAt,
      completedAt,
      durationMs,
      unenrichedChunks: 0,
    };
    const chunk: Record<string, unknown> = { runId, status: "failed", unenrichedChunks: 0 };
    if (errorMessage) {
      file.errorMessage = errorMessage;
      chunk.errorMessage = errorMessage;
    }
    await this.writeKeys(coll, [
      { key: `enrichment.${providerKey}.file`, value: file },
      { key: `enrichment.${providerKey}.chunk`, value: chunk },
    ]);
  }

  /** Recovery finalization — both levels terminal, carrying the snapshotted runId. */
  async markRecoveryResult(coll: string, providerKey: string, input: RecoveryResultInput): Promise<void> {
    await this.writeKeys(coll, [
      {
        key: `enrichment.${providerKey}.file`,
        value: { runId: input.runId, status: input.fileStatus, unenrichedChunks: input.fileUnenriched },
      },
      {
        key: `enrichment.${providerKey}.chunk`,
        value: { runId: input.runId, status: input.chunkStatus, unenrichedChunks: input.chunkUnenriched },
      },
    ]);
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

  /**
   * Read runId for a specific provider. Markers are stored NESTED, so a dotted
   * provider key (`codegraph.symbols`) navigates `enrichment.codegraph.symbols`.
   * Reads from either level, then the legacy literal-property top-level shape.
   */
  async getRunId(coll: string, providerKey: string): Promise<string | undefined> {
    const marker = await this.read(coll);
    if (!marker) return undefined;
    const entry = (getNested(marker, providerKey) ?? marker[providerKey]) as Record<string, unknown> | undefined;
    if (!entry) return undefined;
    const file = entry.file as Record<string, unknown> | undefined;
    const chunk = entry.chunk as Record<string, unknown> | undefined;
    if (typeof file?.runId === "string") return file.runId;
    if (typeof chunk?.runId === "string") return chunk.runId;
    // Legacy shape carried runId at the provider top level.
    return typeof entry.runId === "string" ? entry.runId : undefined;
  }

  /**
   * Write one or more DISJOINT nested keys in a single Qdrant batchUpdate.
   * Each op replaces only its own sub-tree (Qdrant `set_payload` with `key`),
   * preserving siblings — no read, no merge, no RMW race.
   */
  private async writeKeys(
    coll: string,
    entries: { key: string; value: Record<string, unknown> }[],
    wait = true,
  ): Promise<void> {
    try {
      await this.qdrant.batchSetPayload(
        coll,
        entries.map((e) => ({ payload: e.value, points: [INDEXING_METADATA_ID], key: e.key })),
        { wait },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Enrichment] Failed to update marker for collection ${coll}:`, msg);
      pipelineLog.enrichmentPhase("MARKER_UPDATE_FAILED", {
        collection: coll,
        keys: entries.map((e) => e.key),
        error: msg,
      });
    }
  }
}

/**
 * Navigate a dotted path (`codegraph.symbols`) into a nested object. Returns
 * undefined if any segment is missing. Used to read nested per-provider markers
 * stored under `enrichment.<provider-as-nested-path>`.
 */
function getNested(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
