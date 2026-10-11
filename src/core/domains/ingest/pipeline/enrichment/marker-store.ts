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
import { DEFAULT_PAYLOAD_WRITE_BARRIER_BUDGET_MS, INDEXING_METADATA_ID } from "../../../../contracts/constants.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkFinalInput, FileFinalInput, RecoveryResultInput } from "./types.js";

/**
 * What waiting for a collection's queued payload writes established
 * (`EnrichmentMarkerStore#awaitQueuedPayloadWrites`, bd tea-rags-mcp-yf4je).
 *
 * - `drained` — Qdrant confirmed (`completed`) the queue applied.
 * - `timedOut` — every round answered `wait_timeout` until the budget was
 *   spent: the queue is still undrained, and a read now sees stale segments.
 * - `failed` — the barrier request itself threw; best-effort, as before the
 *   barrier existed.
 */
export type PayloadWriteBarrierOutcome =
  | { readonly kind: "drained"; readonly rounds: number; readonly waitedMs: number }
  | { readonly kind: "timedOut"; readonly rounds: number; readonly waitedMs: number }
  | { readonly kind: "failed" };

export interface EnrichmentMarkerStoreOptions {
  /** Total barrier budget (ms); undefined → DEFAULT_PAYLOAD_WRITE_BARRIER_BUDGET_MS. */
  readonly payloadWriteBarrierBudgetMs?: number;
}

export class EnrichmentMarkerStore {
  private readonly payloadWriteBarrierBudgetMs: number;

  constructor(
    private readonly qdrant: QdrantManager,
    options: EnrichmentMarkerStoreOptions = {},
  ) {
    this.payloadWriteBarrierBudgetMs = options.payloadWriteBarrierBudgetMs ?? DEFAULT_PAYLOAD_WRITE_BARRIER_BUDGET_MS;
  }

  /**
   * Run-pointer — the only pre-completion write. Lives at enrichment._run and
   * carries the provider keys THIS RUN covers, so the health mapper knows which
   * providers the run's timestamps are evidence about. It is not the frame of
   * the health report: that comes from the running composition, and a provider
   * outside this list keeps its own latest terminal marker.
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
          ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
          ...(input.degradedReason !== undefined ? { degradedReason: input.degradedReason } : {}),
        },
      },
    ]);
  }

  /** Chunk-level terminal marker (CompletionRunner step 8). Carries runId. */
  /**
   * Return only once every payload write queued on `coll` before this call is
   * visible to reads (bd tea-rags-mcp-vnmj1).
   *
   * Enrichment writes are `wait: false`: Qdrant acknowledges them from the WAL
   * and applies them later, and a count or scroll issued meanwhile reads the
   * segments as they were. The barrier (`QdrantManager#awaitQueuedUpdates`)
   * changes no payload, so it can run before any read without leaving a trace.
   *
   * Qdrant 1.18 ends a waited request after its own ~60 s with a SUCCESSFUL
   * `wait_timeout` answer (bd tea-rags-mcp-yf4je), so the status is read: a
   * timed-out round is repeated until `completed`, while the time spent stays
   * under the budget. Each timed-out round logs
   * PAYLOAD_WRITE_BARRIER_TIMED_OUT. A spent budget returns `timedOut` — the
   * caller must not decide anything from a read behind that queue.
   *
   * Best-effort on a thrown barrier: it leaves the caller reading whatever is
   * applied, which is what every read did before this existed.
   */
  async awaitQueuedPayloadWrites(coll: string): Promise<PayloadWriteBarrierOutcome> {
    const startedAt = Date.now();
    let rounds = 0;
    try {
      for (;;) {
        const roundStartedAt = Date.now();
        const status = await this.qdrant.awaitQueuedUpdates(coll);
        rounds++;
        const waitedMs = Date.now() - startedAt;
        if (status !== "wait_timeout") return { kind: "drained", rounds, waitedMs };
        pipelineLog.enrichmentPhase("PAYLOAD_WRITE_BARRIER_TIMED_OUT", {
          collection: coll,
          round: rounds,
          roundMs: Date.now() - roundStartedAt,
          waitedMs,
          budgetMs: this.payloadWriteBarrierBudgetMs,
        });
        if (waitedMs >= this.payloadWriteBarrierBudgetMs) return { kind: "timedOut", rounds, waitedMs };
      }
    } catch (error) {
      pipelineLog.enrichmentPhase("PAYLOAD_WRITE_BARRIER_FAILED", {
        collection: coll,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "failed" };
    }
  }

  /**
   * Qdrant's pending-update queue length for a collection, for drain timing
   * (bd tea-rags-mcp-4ybh4). `undefined` when the server does not report a queue
   * or the read fails: an absent figure is not an empty queue, and a diagnostic
   * read must never fail the drain it describes.
   */
  async payloadUpdateQueueLength(coll: string): Promise<number | undefined> {
    try {
      return (await this.qdrant.getCollectionInfo(coll)).updateQueueLength;
    } catch {
      return undefined;
    }
  }

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
          ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
          ...(input.degradedReason !== undefined ? { degradedReason: input.degradedReason } : {}),
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
   * Read the active run pointer's runId (`enrichment._run.runId`). This is the
   * identity the health mapper compares every per-kind terminal marker against
   * (`marker.runId === _run.runId` → render terminal). Recovery stamps its
   * terminal markers with THIS, because a provider that crashed before writing
   * any terminal marker has its runId ONLY here — `getRunId` returns undefined
   * for it, and a "" stamp would never match `_run.runId`, leaving the health
   * mapper to re-derive "crashed" forever.
   */
  async getActiveRunId(coll: string): Promise<string | undefined> {
    const marker = await this.read(coll);
    const run = marker?._run as { runId?: unknown } | undefined;
    return typeof run?.runId === "string" ? run.runId : undefined;
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
      const status = await this.qdrant.batchSetPayload(
        coll,
        entries.map((e) => ({ payload: e.value, points: [INDEXING_METADATA_ID], key: e.key })),
        { wait },
      );
      if (wait && status === "wait_timeout") await this.confirmTimedOutWrite(coll, entries);
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

  /**
   * A waited marker write Qdrant answered with `wait_timeout` is queued, not
   * applied (bd tea-rags-mcp-yf4je). Updates apply in submission order, so the
   * barrier after it confirms it; a barrier that spends its budget leaves the
   * marker unconfirmed, logged as MARKER_UPDATE_UNCONFIRMED.
   */
  private async confirmTimedOutWrite(coll: string, entries: { key: string }[]): Promise<void> {
    const barrier = await this.awaitQueuedPayloadWrites(coll);
    if (barrier.kind === "drained") return;
    pipelineLog.enrichmentPhase("MARKER_UPDATE_UNCONFIRMED", {
      collection: coll,
      keys: entries.map((e) => e.key),
      barrier: barrier.kind,
      ...(barrier.kind === "timedOut" ? { waitedMs: barrier.waitedMs } : {}),
    });
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
