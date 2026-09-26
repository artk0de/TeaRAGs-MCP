/**
 * The changes leg of an incremental reindex: delete stale chunks and ingest the
 * delta, as a two-level parallel pipeline (bd tea-rags-mcp-7njy).
 *
 *   Level 1: delete old chunks AND process added files concurrently.
 *   Level 2: after delete settles, process modified files (gated by the
 *            ReindexCoordinator on per-path delete success) concurrently with
 *            the still-running add pipeline.
 *
 * The caller owns the processing context (it needs the pipeline base to build
 * it) and the run's close; this module owns bucketing, the optimizer pause
 * window, the two levels, and the partial-outcome assessment.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { isDebug } from "../../../infra/runtime.js";
import type { ChunkLookupEntry, FileChanges, ProgressCallback } from "../../../types.js";
import type { ProcessingContext } from "../pipeline/base.js";
import { processRelativeFiles } from "../pipeline/file-processor.js";
import { pipelineLog } from "../pipeline/infra/debug-logger.js";
import type { DeletionOutcome } from "../sync/deletion/outcome.js";
import { ReindexCoordinator } from "../sync/deletion/reindex-coordinator.js";
import { performDeletion, type DeletionConfig } from "../sync/deletion/strategy.js";
import type { QuarantineStore } from "../sync/index.js";

export interface ReindexExecutionParams {
  qdrant: QdrantManager;
  /** Physical collection the delta is written into. */
  targetCollection: PhysicalCollectionName;
  absolutePath: string;
  changes: FileChanges;
  /** Quarantined paths re-attempted this pass; they join the added bucket. */
  retryPaths: string[];
  quarantineStore: QuarantineStore;
  processingCtx: ProcessingContext;
  deleteConfig: DeletionConfig;
  enableGitMetadata: boolean;
  fileConcurrency: number;
  /**
   * Provider deletion hook. Receives ONLY paths genuinely removed from disk
   * (deleted + newly ignored) — never modified ones, which are re-walked in
   * this same run.
   */
  notifyDeletions: (paths: string[]) => Promise<void>;
  progressCallback?: ProgressCallback;
}

export interface ReindexExecutionResult {
  chunksAdded: number;
  chunksDeleted: number;
  chunkMap: Map<string, ChunkLookupEntry[]>;
  deletionOutcome?: DeletionOutcome;
  /** Count of modified files whose upsert was skipped due to delete failure (Phase 3.2). */
  filesSkippedDueToDeleteFailure?: number;
  /** Count of removed (deleted / newly ignored) files whose old chunks could not be deleted. */
  filesFailedToDelete?: number;
}

/**
 * Plan assembled by Phase A and consumed by Phase B: the per-bucket file lists,
 * the chunk map accumulator, processOpts, and the wall clock Phase C reads.
 */
interface ReindexExecutionPlan {
  chunkMap: Map<string, ChunkLookupEntry[]>;
  /** Paths Qdrant deletes — includes modified (chunker re-ingests them). */
  filesToDelete: string[];
  /**
   * Paths that are GENUINELY removed from disk (deleted + newly
   * ignored) — modified files are NOT included. Used as the provider
   * deletion-notification scope so codegraph and other providers
   * don't wipe state for files about to be re-walked.
   */
  providerDeletedOnly: string[];
  addedFiles: string[];
  modifiedFiles: string[];
  processOpts: {
    enableGitMetadata: boolean;
    concurrency: number;
    quarantineStore?: QuarantineStore;
    quarantinedRetry?: Set<string>;
  };
  parallelStart: number;
}

/** Output of Phase B (parallel pipelines). Phase C interprets the coordinator. */
interface ReindexLevelsResult {
  addedChunks: number;
  modifiedChunks: number;
  chunksDeleted: number;
  deletionOutcome: DeletionOutcome | undefined;
  coordinator: ReindexCoordinator;
}

export async function executeReindexPipelines(params: ReindexExecutionParams): Promise<ReindexExecutionResult> {
  const plan = planReindexExecution(params);

  // Pause HNSW indexing + segment vacuum for the whole reindex window.
  // Without this, a large delete (>20% tombstones) triggers optimizer repack
  // that blocks concurrent upserts for minutes on embedded Qdrant and makes
  // them hit the client's requestTimeoutMs. Resumed in `finally`; if the
  // process dies between pause and resume, the next reindex's `pauseOptimizer`
  // is idempotent and the subsequent `resumeOptimizer` heals the collection.
  await params.qdrant.pauseOptimizer(params.targetCollection);

  try {
    const exec = await runReindexLevels(params, plan);
    const { filesSkippedDueToDeleteFailure, filesFailedToDelete } = assessReindexOutcome(params, plan, exec);
    return {
      chunksAdded: exec.addedChunks + exec.modifiedChunks,
      chunksDeleted: exec.chunksDeleted,
      chunkMap: plan.chunkMap,
      deletionOutcome: exec.deletionOutcome,
      filesSkippedDueToDeleteFailure,
      filesFailedToDelete,
    };
  } finally {
    // Reverting deleted_threshold to 0.2 naturally triggers one optimizer
    // pass for all accumulated tombstones — a single repack instead of
    // continuous reactive ones during ingest. Failure here is non-fatal:
    // next reindex's pause/resume cycle heals the collection.
    await params.qdrant.resumeOptimizer(params.targetCollection).catch((err) => {
      if (isDebug()) console.error(`[Reindex] resumeOptimizer failed (next reindex will heal):`, err);
    });
  }
}

// ── Phase A: plan ────────────────────────────────────────

/**
 * Phase A: bucket the changes into delete/add/modified file lists and emit the
 * PARALLEL_START log line. Pure setup — no async work and no optimizer state
 * changes.
 */
function planReindexExecution(params: ReindexExecutionParams): ReindexExecutionPlan {
  const { changes, retryPaths } = params;
  const chunkMap = new Map<string, ChunkLookupEntry[]>();

  const filesToDelete = [...changes.modified, ...changes.deleted, ...changes.newlyIgnored];
  const providerDeletedOnly = [...changes.deleted, ...changes.newlyIgnored];
  // Retry files join the "added" bucket: they failed before, so they have no
  // committed chunks to collide with and need no delete-gate coordinator.
  const addedFiles = [...changes.added, ...retryPaths];
  const modifiedFiles = [...changes.modified];

  const processOpts = {
    enableGitMetadata: params.enableGitMetadata,
    concurrency: params.fileConcurrency,
    quarantineStore: params.quarantineStore,
    quarantinedRetry: new Set(retryPaths),
  };

  const parallelStart = Date.now();
  logParallelStart(filesToDelete, addedFiles, modifiedFiles);

  return { chunkMap, filesToDelete, providerDeletedOnly, addedFiles, modifiedFiles, processOpts, parallelStart };
}

// ── Phase B: execute ─────────────────────────────────────

/** Phase B: run the two levels. Returns the raw counters + coordinator for Phase C. */
async function runReindexLevels(
  params: ReindexExecutionParams,
  plan: ReindexExecutionPlan,
): Promise<ReindexLevelsResult> {
  const { processingCtx: pCtx } = params;
  // Level 1: delete old chunks + process added files in parallel
  const deleteStartTime = Date.now();
  let chunksDeleted = 0;
  let deletionOutcome: DeletionOutcome | undefined;
  // Providers' deletion hook must NOT fire for files in
  // `changes.modified` — those files are being re-walked by the
  // chunker / codegraph in this same run. The walker's upsert
  // already does DELETE+INSERT atomically (clears old edges and
  // re-inserts new ones inside a single transaction). Forwarding
  // modified paths to notifyDeletions races with the walker's
  // upsert on the shared graphDb connection and the loser wipes
  // the winner — see the 2026-05-21 self-test regression that
  // surfaced this. `plan.providerDeletedOnly` already excludes
  // modified for the same reason.
  const deletePromise = performDeletion(
    params.qdrant,
    params.targetCollection,
    plan.filesToDelete,
    params.deleteConfig,
    params.progressCallback,
    // A4d — notify providers (codegraph, …) BEFORE Qdrant deletion
    // so graph-edge / symbol-table state stays consistent with disk
    // truth even when Qdrant rejects the delete downstream. Only
    // delivered-as-removed paths flow through; modified files are
    // re-walked by the codegraph upsert below. The caller's hook
    // addresses the physical collection, so collection-scoped
    // providers (codegraph) prune the right per-collection DuckDB.
    async () => params.notifyDeletions(plan.providerDeletedOnly),
  ).then((outcome) => {
    deletionOutcome = outcome;
    ({ chunksDeleted } = outcome);
    return outcome;
  });
  const addPromise = processRelativeFiles(
    plan.addedFiles,
    params.absolutePath,
    pCtx.chunkerPool,
    pCtx.chunkPipeline,
    plan.processOpts,
    plan.chunkMap,
    "added",
  );

  pipelineLog.reindexPhase("DELETE_AND_ADD_STARTED", {
    deleteFiles: plan.filesToDelete.length,
    addFiles: plan.addedFiles.length,
  });

  await deletePromise;

  pipelineLog.reindexPhase("DELETE_COMPLETE", {
    durationMs: Date.now() - deleteStartTime,
    deleted: plan.filesToDelete.length,
  });

  logDeleteSettled(deletionOutcome);

  // Phase 3.2: gate modified-file upsert on per-file delete success. Added
  // files have no old chunks to collide with, so they never see the
  // coordinator.
  const coordinator = new ReindexCoordinator();
  if (deletionOutcome) coordinator.applyDeletionOutcome(deletionOutcome);

  // Level 2: process modified files (after delete completes)
  const modifiedStartTime = Date.now();
  const modifiedOpts = { ...plan.processOpts, coordinator };
  const modifiedPromise = processRelativeFiles(
    plan.modifiedFiles,
    params.absolutePath,
    pCtx.chunkerPool,
    pCtx.chunkPipeline,
    modifiedOpts,
    plan.chunkMap,
    "modified",
  );

  pipelineLog.reindexPhase("MODIFIED_STARTED", {
    modifiedFiles: plan.modifiedFiles.length,
    addStillRunning: true,
  });

  const [addedChunks, modifiedChunks] = await Promise.all([addPromise, modifiedPromise]);

  pipelineLog.reindexPhase("ADD_AND_MODIFIED_COMPLETE", {
    addedChunks,
    modifiedChunks,
    addDurationMs: Date.now() - plan.parallelStart,
    modifiedDurationMs: Date.now() - modifiedStartTime,
  });

  return { addedChunks, modifiedChunks, chunksDeleted, deletionOutcome, coordinator };
}

// ── Phase C: assess ──────────────────────────────────────

/**
 * Phase C: interpret the coordinator and decide whether this reindex is
 * "partial". RED tests in `reindexing-block.test.ts` pin this contract:
 *   coordinator.hasBlockedPaths() -> filesSkippedDueToDeleteFailure: N
 *   AND caller marks stats.status = "partial" when N > 0.
 * Drift in this counter silently leaves stale chunks in the index.
 *
 * A removed path (deleted / newly ignored) has no upsert for the coordinator
 * to gate, so its failed delete never reaches `skippedFiles()` — yet its old
 * chunks stay in the index all the same (bd tea-rags-mcp-fa9k). Those are
 * counted separately as `filesFailedToDelete`, and the caller downgrades to
 * "partial" on either counter.
 */
function assessReindexOutcome(
  params: ReindexExecutionParams,
  plan: ReindexExecutionPlan,
  exec: ReindexLevelsResult,
): { filesSkippedDueToDeleteFailure?: number; filesFailedToDelete?: number } {
  let filesSkippedDueToDeleteFailure: number | undefined;
  let filesFailedToDelete: number | undefined;
  if (exec.coordinator.hasBlockedPaths()) {
    const skipped = exec.coordinator.skippedFiles();
    filesSkippedDueToDeleteFailure = skipped.length;
    filesFailedToDelete = plan.providerDeletedOnly.filter((path) => exec.deletionOutcome?.failed.has(path)).length;
    pipelineLog.step({ component: "Reindex" }, "REINDEX_PARTIAL_COMPLETE", {
      skippedFilesCount: skipped.length,
      skippedSample: skipped.slice(0, 20),
      removedFilesFailedCount: filesFailedToDelete,
      blockedPathsCount: exec.deletionOutcome?.failed.size ?? 0,
    });
  }

  logPipelineStats(params.processingCtx, plan.parallelStart);

  return { filesSkippedDueToDeleteFailure, filesFailedToDelete };
}

// ── Logging ──────────────────────────────────────────────

function logParallelStart(filesToDelete: string[], addedFiles: string[], modifiedFiles: string[]): void {
  pipelineLog.reindexPhase("PARALLEL_START", {
    deleted: filesToDelete.length,
    added: addedFiles.length,
    modified: modifiedFiles.length,
  });

  if (isDebug()) {
    console.error(
      `[Reindex] Starting parallel pipelines: ` +
        `delete=${filesToDelete.length}, added=${addedFiles.length}, modified=${modifiedFiles.length}`,
    );
  }
}

function logDeleteSettled(deletionOutcome: DeletionOutcome | undefined): void {
  if (deletionOutcome && !deletionOutcome.isFullSuccess()) {
    pipelineLog.step({ component: "Reindex" }, "DELETE_PARTIAL_FAILURE", {
      failedFiles: deletionOutcome.failed.size,
      succeededFiles: deletionOutcome.succeeded.size,
      failedSample: [...deletionOutcome.failed].slice(0, 20),
    });
  }

  if (isDebug()) {
    console.error(`[Reindex] Delete complete, starting modified indexing (add still running in parallel)`);
  }
}

function logPipelineStats(pCtx: ProcessingContext, parallelStart: number): void {
  if (isDebug()) {
    const pipelineStats = pCtx.chunkPipeline.getStats();
    console.error(
      `[Reindex] ChunkPipeline before flush: ` +
        `pending=${pCtx.chunkPipeline.getPendingCount()}, ` +
        `processed=${pipelineStats.itemsProcessed}, ` +
        `batches=${pipelineStats.batchesProcessed}`,
    );
    console.error(
      `[Reindex] Parallel pipelines completed in ${Date.now() - parallelStart}ms ` +
        `(pipeline: ${pipelineStats.itemsProcessed} chunks in ${pipelineStats.batchesProcessed} batches, ` +
        `${pipelineStats.throughput.toFixed(1)} chunks/s)`,
    );
  }
}
