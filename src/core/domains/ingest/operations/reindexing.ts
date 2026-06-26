/**
 * ReindexPipeline - Incremental re-indexing of changed files.
 *
 * Orchestrates: scan → detect changes → classify ignore changes →
 * delete old → process new/modified → snapshot.
 * File processing logic is delegated to FileProcessor.
 */

import type { ChangeStats, ChunkLookupEntry, FileChanges, ProgressCallback } from "../../../types.js";
import { NotIndexedError, PartialDeletionError, ReindexFailedError, SnapshotMissingError } from "../errors.js";
import {
  BaseIndexingPipeline,
  type PipelineRegistryDeps,
  type PipelineTuning,
  type ProcessingContext,
} from "../pipeline/base.js";
import { processRelativeFiles } from "../pipeline/file-processor.js";
import { storeIndexingMarker } from "../pipeline/indexing-marker.js";
import { pipelineLog } from "../pipeline/infra/debug-logger.js";
import { isDebug } from "../pipeline/infra/runtime.js";
import type { FileScanner } from "../pipeline/scanner.js";
import type { DeletionOutcome } from "../sync/deletion/outcome.js";
import { ReindexCoordinator } from "../sync/deletion/reindex-coordinator.js";
import { performDeletion, type DeletionConfig } from "../sync/deletion/strategy.js";
import { QuarantineStore } from "../sync/index.js";
import type { ParallelFileSynchronizer } from "../sync/parallel-synchronizer.js";
import { SnapshotCleaner } from "../sync/snapshot/snapshot-cleaner.js";

interface ReindexContext {
  absolutePath: string;
  collectionName: string;
  synchronizer: ParallelFileSynchronizer;
  scanner: FileScanner;
  currentFiles: string[];
}

/**
 * Plan assembled by Phase A and consumed by Phase B. Holds the per-bucket file
 * lists, processing context, chunk map accumulator, processOpts, and the wall
 * clock used by Phase C to compute durations.
 */
interface ParallelExecutionPlan {
  pCtx: ProcessingContext;
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
interface ParallelExecutionResult {
  addedChunks: number;
  modifiedChunks: number;
  chunksDeleted: number;
  deletionOutcome: DeletionOutcome | undefined;
  coordinator: ReindexCoordinator;
}

export class ReindexPipeline extends BaseIndexingPipeline {
  constructor(
    qdrant: ConstructorParameters<typeof BaseIndexingPipeline>[0],
    embeddings: ConstructorParameters<typeof BaseIndexingPipeline>[1],
    config: ConstructorParameters<typeof BaseIndexingPipeline>[2],
    enrichment: ConstructorParameters<typeof BaseIndexingPipeline>[3],
    deps: ConstructorParameters<typeof BaseIndexingPipeline>[4],
    private readonly deleteConfig: DeletionConfig = { batchSize: 500, concurrency: 8 },
    tuning?: PipelineTuning,
    registryDeps?: PipelineRegistryDeps,
  ) {
    super(qdrant, embeddings, config, enrichment, deps, tuning, registryDeps);
  }

  async reindexChanges(
    path: string,
    progressCallback?: ProgressCallback,
    overrides?: { chunkSize?: number; modelInfo?: { model: string; contextLength: number; dimensions: number } },
  ): Promise<ChangeStats> {
    const startTime = Date.now();
    const { absolutePath, collectionName } = await this.resolveContext(path);
    const stats: ChangeStats = {
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      filesNewlyIgnored: 0,
      filesNewlyUnignored: 0,
      filesRetried: 0,
      chunksAdded: 0,
      chunksDeleted: 0,
      durationMs: 0,
      status: "completed",
    };

    try {
      const ctx = await this.prepareReindexContext(absolutePath, collectionName);
      const resumeFromCheckpoint = await this.checkForCheckpoint(ctx.synchronizer);

      this.reportScanProgress(progressCallback, resumeFromCheckpoint);

      const changes = await this.detectFileChanges(ctx);
      stats.filesAdded = changes.added.length;
      stats.filesModified = changes.modified.length;
      stats.filesDeleted = changes.deleted.length;
      stats.filesNewlyIgnored = changes.newlyIgnored.length;
      stats.filesNewlyUnignored = changes.newlyUnignored.length;

      // Poison-pill retry: previously-quarantined files that still exist are
      // re-attempted even when their content is unchanged (a tea-rags fix may
      // have shipped, or the file became readable). Computed BEFORE the
      // no-changes / deletion-only early returns so a pure-retry pass is not
      // short-circuited.
      const quarantineStore = new QuarantineStore(this.snapshotDir, ctx.collectionName);
      const retryPaths = await this.computeQuarantineRetry(quarantineStore, ctx, changes);
      stats.filesRetried = retryPaths.length;

      if (this.hasNoChanges(stats) && retryPaths.length === 0) {
        await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
        await ctx.synchronizer.deleteCheckpoint();
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // Deletion-only: no files to add/modify/retry → skip pipeline init and enrichment
      if (changes.added.length === 0 && changes.modified.length === 0 && retryPaths.length === 0) {
        await this.executeDeletionOnly(ctx, changes, stats, progressCallback);
        await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
        await ctx.synchronizer.updateSnapshot(ctx.currentFiles);
        await ctx.synchronizer.deleteCheckpoint();
        stats.enrichmentStatus = "skipped";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      this.startHeartbeat(ctx.collectionName);
      const { chunksAdded, chunksDeleted, processingCtx, chunkMap, filesSkippedDueToDeleteFailure } =
        await this.executeParallelPipelines(
          ctx,
          changes,
          quarantineStore,
          retryPaths,
          progressCallback,
          overrides?.chunkSize,
        );
      stats.chunksAdded = chunksAdded;
      stats.chunksDeleted = chunksDeleted;
      if (filesSkippedDueToDeleteFailure !== undefined && filesSkippedDueToDeleteFailure > 0) {
        stats.filesSkippedDueToDeleteFailure = filesSkippedDueToDeleteFailure;
        stats.status = "partial";
      }

      this.stopHeartbeat();
      await this.finalizeReindex(ctx, processingCtx, chunkMap, stats, startTime);
      return stats;
    } catch (error) {
      this.wrapUnexpectedError(error, ReindexFailedError);
    } finally {
      this.stopHeartbeat();
      const cleaner = new SnapshotCleaner(this.snapshotDir, collectionName);
      await cleaner.cleanupAfterIndexing();
    }
  }

  // ── Preparation ──────────────────────────────────────────

  private async prepareReindexContext(absolutePath: string, collectionName: string): Promise<ReindexContext> {
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new NotIndexedError(absolutePath);
    }

    // "qdrant-setup" stage (csyve) — the reindex path's pre-ingest Qdrant work
    // is the snapshot/schema/sparse migration sweep (no fresh collection create).
    const qdrantSetupStart = Date.now();
    await this.runMigrations(collectionName, absolutePath);
    pipelineLog.addStageTime("qdrant-setup", Date.now() - qdrantSetupStart);

    const synchronizer = this.deps.createSynchronizer(absolutePath, collectionName);
    const hasSnapshot = await synchronizer.initialize();
    if (!hasSnapshot) {
      throw new SnapshotMissingError(absolutePath);
    }

    const scanner = this.createScanner();
    const currentFiles = await this.scanFiles(absolutePath, scanner);

    return { absolutePath, collectionName, synchronizer, scanner, currentFiles };
  }

  private async runMigrations(collectionName: string, absolutePath: string): Promise<void> {
    const migrator = this.deps.createMigrator(collectionName, absolutePath);

    const snapshotResult = await migrator.run("snapshot");
    if (snapshotResult.steps.length > 0) {
      pipelineLog.reindexPhase("snapshot_migration", {
        fromVersion: snapshotResult.fromVersion,
        toVersion: snapshotResult.toVersion,
        steps: snapshotResult.steps.map((s) => s.applied?.join(", ") ?? s.name),
      });
    }

    const schemaResult = await migrator.run("schema");
    if (schemaResult.steps.length > 0) {
      pipelineLog.reindexPhase("schema_migration", {
        fromVersion: schemaResult.fromVersion,
        toVersion: schemaResult.toVersion,
        steps: schemaResult.steps.map((s) => s.applied?.join(", ") ?? s.name),
      });
    }

    const sparseResult = await migrator.run("sparse");
    if (sparseResult.steps.length > 0) {
      pipelineLog.reindexPhase("sparse_migration", {
        fromVersion: sparseResult.fromVersion,
        toVersion: sparseResult.toVersion,
        steps: sparseResult.steps.map((s) => s.applied?.join(", ") ?? s.name),
      });
    }
  }

  private async checkForCheckpoint(synchronizer: ParallelFileSynchronizer): Promise<boolean> {
    const checkpoint = await synchronizer.loadCheckpoint();
    if (checkpoint) {
      console.error(`[Reindex] Resuming from checkpoint: ${checkpoint.processedFiles.length} files already processed`);
      return true;
    }
    return false;
  }

  // ── Change detection ─────────────────────────────────────

  private async detectFileChanges(ctx: ReindexContext): Promise<FileChanges> {
    pipelineLog.stageStart("scan");
    const changes = await ctx.synchronizer.detectChanges(ctx.currentFiles);
    pipelineLog.stageEnd("scan");
    return changes;
  }

  /**
   * Quarantined paths to retry this pass: still on disk and not already queued
   * as added/modified (those are re-walked anyway). Excludes dead paths so a
   * deleted poison file doesn't get re-attempted forever.
   */
  private async computeQuarantineRetry(
    store: QuarantineStore,
    ctx: ReindexContext,
    changes: FileChanges,
  ): Promise<string[]> {
    const quarantined = Array.from((await store.load()).keys());
    const queued = new Set([...changes.added, ...changes.modified]);
    // ctx.currentFiles are absolute; quarantine keys + changes are relative to
    // the codebase root. Normalize to relative before intersecting.
    const base = ctx.absolutePath;
    const current = new Set(ctx.currentFiles.map((f) => (f.startsWith(base) ? f.slice(base.length + 1) : f)));
    return quarantined.filter((p) => current.has(p) && !queued.has(p));
  }

  // ── Parallel processing ──────────────────────────────────

  private async executeParallelPipelines(
    ctx: ReindexContext,
    changes: FileChanges,
    quarantineStore: QuarantineStore,
    retryPaths: string[],
    progressCallback?: ProgressCallback,
    chunkSizeOverride?: number,
  ): Promise<{
    chunksAdded: number;
    chunksDeleted: number;
    processingCtx: ProcessingContext;
    chunkMap: Map<string, ChunkLookupEntry[]>;
    deletionOutcome?: DeletionOutcome;
    /** Count of modified files whose upsert was skipped due to delete failure (Phase 3.2). */
    filesSkippedDueToDeleteFailure?: number;
  }> {
    const plan = this.prepareParallelExecution(ctx, changes, quarantineStore, retryPaths, chunkSizeOverride);

    // Pause HNSW indexing + segment vacuum for the whole reindex window.
    // Without this, a large delete (>20% tombstones) triggers optimizer repack
    // that blocks concurrent upserts for minutes on embedded Qdrant and makes
    // them hit the client's requestTimeoutMs. Resumed in `finally`; if the
    // process dies between pause and resume, the next reindex's `pauseOptimizer`
    // is idempotent and the subsequent `resumeOptimizer` heals the collection.
    await this.qdrant.pauseOptimizer(ctx.collectionName);

    try {
      const exec = await this.runParallelPipelines(ctx, plan, progressCallback);
      const filesSkippedDueToDeleteFailure = this.assessParallelOutcome(plan, exec);
      return {
        chunksAdded: exec.addedChunks + exec.modifiedChunks,
        chunksDeleted: exec.chunksDeleted,
        processingCtx: plan.pCtx,
        chunkMap: plan.chunkMap,
        deletionOutcome: exec.deletionOutcome,
        filesSkippedDueToDeleteFailure,
      };
    } finally {
      // Reverting deleted_threshold to 0.2 naturally triggers one optimizer
      // pass for all accumulated tombstones — a single repack instead of
      // continuous reactive ones during ingest. Failure here is non-fatal:
      // next reindex's pause/resume cycle heals the collection.
      await this.qdrant.resumeOptimizer(ctx.collectionName).catch((err) => {
        if (isDebug()) console.error(`[Reindex] resumeOptimizer failed (next reindex will heal):`, err);
      });
    }
  }

  // ── Phase A: prepare ─────────────────────────────────────

  /**
   * Phase A: bucket the changes into delete/add/modified file lists, init the
   * processing context, and emit the PARALLEL_START log line. Pure setup — no
   * async work and no optimizer state changes.
   */
  private prepareParallelExecution(
    ctx: ReindexContext,
    changes: FileChanges,
    quarantineStore: QuarantineStore,
    retryPaths: string[],
    chunkSizeOverride?: number,
  ): ParallelExecutionPlan {
    const quarantinedRetry = new Set(retryPaths);

    const changedPaths = [...changes.added, ...changes.modified, ...retryPaths];
    const pCtx = this.initProcessing(
      ctx.collectionName,
      ctx.absolutePath,
      ctx.scanner,
      changedPaths,
      chunkSizeOverride,
      ctx.currentFiles.length,
    );
    // Embed-phase poison-pill isolation (shares the read/parse quarantine store).
    pCtx.chunkPipeline.setQuarantineStore(quarantineStore);
    const chunkMap = new Map<string, ChunkLookupEntry[]>();

    const filesToDelete = [...changes.modified, ...changes.deleted, ...changes.newlyIgnored];
    const providerDeletedOnly = [...changes.deleted, ...changes.newlyIgnored];
    // Retry files join the "added" bucket: they failed before, so they have no
    // committed chunks to collide with and need no delete-gate coordinator.
    const addedFiles = [...changes.added, ...retryPaths];
    const modifiedFiles = [...changes.modified];

    const processOpts = {
      enableGitMetadata: this.config.enableGitMetadata === true,
      concurrency: this.tuning.fileConcurrency,
      quarantineStore,
      quarantinedRetry,
    };

    const parallelStart = Date.now();
    this.logParallelStart(filesToDelete, addedFiles, modifiedFiles);

    return {
      pCtx,
      chunkMap,
      filesToDelete,
      providerDeletedOnly,
      addedFiles,
      modifiedFiles,
      processOpts,
      parallelStart,
    };
  }

  // ── Phase B: execute ─────────────────────────────────────

  /**
   * Phase B: run the two-level parallel pipeline.
   *   Level 1: delete old chunks AND process added files concurrently.
   *   Level 2: after delete settles, process modified files (gated by the
   *            ReindexCoordinator on per-path delete success) concurrently
   *            with the still-running add pipeline.
   * Returns the raw counters + coordinator for Phase C to interpret.
   */
  private async runParallelPipelines(
    ctx: ReindexContext,
    plan: ParallelExecutionPlan,
    progressCallback?: ProgressCallback,
  ): Promise<ParallelExecutionResult> {
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
      this.qdrant,
      ctx.collectionName,
      plan.filesToDelete,
      this.deleteConfig,
      progressCallback,
      // A4d — notify providers (codegraph, …) BEFORE Qdrant deletion
      // so graph-edge / symbol-table state stays consistent with disk
      // truth even when Qdrant rejects the delete downstream. Only
      // delivered-as-removed paths flow through; modified files are
      // re-walked by the codegraph upsert below. The collection name
      // is forwarded so collection-scoped providers (codegraph) prune
      // the right per-collection DuckDB.
      async () => this.enrichment.notifyDeletions(plan.providerDeletedOnly, ctx.collectionName),
    ).then((outcome) => {
      deletionOutcome = outcome;
      ({ chunksDeleted } = outcome);
      return outcome;
    });
    const addPromise = processRelativeFiles(
      plan.addedFiles,
      ctx.absolutePath,
      plan.pCtx.chunkerPool,
      plan.pCtx.chunkPipeline,
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

    this.logDeleteSettled(deletionOutcome);

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
      ctx.absolutePath,
      plan.pCtx.chunkerPool,
      plan.pCtx.chunkPipeline,
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
   */
  private assessParallelOutcome(plan: ParallelExecutionPlan, exec: ParallelExecutionResult): number | undefined {
    let filesSkippedDueToDeleteFailure: number | undefined;
    if (exec.coordinator.hasBlockedPaths()) {
      const skipped = exec.coordinator.skippedFiles();
      filesSkippedDueToDeleteFailure = skipped.length;
      pipelineLog.step({ component: "Reindex" }, "REINDEX_PARTIAL_COMPLETE", {
        skippedFilesCount: skipped.length,
        skippedSample: skipped.slice(0, 20),
        blockedPathsCount: exec.deletionOutcome?.failed.size ?? 0,
      });
    }

    this.logPipelineStats(plan.pCtx, plan.parallelStart);

    return filesSkippedDueToDeleteFailure;
  }

  // ── Finalization ─────────────────────────────────────────

  private async finalizeReindex(
    ctx: ReindexContext,
    processingCtx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    stats: ChangeStats,
    startTime: number,
  ): Promise<void> {
    const getEnrichmentStatus = await this.finalizeProcessing(
      processingCtx,
      chunkMap,
      ctx.collectionName,
      ctx.absolutePath,
    );

    await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
    await ctx.synchronizer.updateSnapshot(ctx.currentFiles);
    await ctx.synchronizer.deleteCheckpoint();
    await this.recordRegistryEntry(ctx.collectionName, ctx.absolutePath);

    const enrichmentResult = getEnrichmentStatus();
    stats.enrichmentStatus = enrichmentResult.status;
    stats.enrichmentMetrics = enrichmentResult.metrics;
    stats.durationMs = Date.now() - startTime;

    if (isDebug()) {
      console.error(
        `[Reindex] Complete: ${stats.filesAdded} added, ` +
          `${stats.filesModified} modified, ${stats.filesDeleted} deleted${
            stats.filesNewlyIgnored > 0 ? `, ${stats.filesNewlyIgnored} newly ignored` : ""
          }${
            stats.filesNewlyUnignored > 0 ? `, ${stats.filesNewlyUnignored} newly unignored` : ""
          }. Created ${stats.chunksAdded} chunks in ${(stats.durationMs / 1000).toFixed(1)}s`,
      );
    }
  }

  // ── Deletion-only fast path ─────────────────────────────

  private async executeDeletionOnly(
    ctx: ReindexContext,
    changes: FileChanges,
    stats: ChangeStats,
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    const filesToDelete = [...changes.deleted, ...changes.newlyIgnored];

    pipelineLog.reindexPhase("DELETE_ONLY_START", { files: filesToDelete.length });

    await this.qdrant.pauseOptimizer(ctx.collectionName);

    let outcome: DeletionOutcome;
    try {
      outcome = await performDeletion(
        this.qdrant,
        ctx.collectionName,
        filesToDelete,
        this.deleteConfig,
        progressCallback,
        // Same provider-notification hook as the parallel path — the
        // deletion-only branch must not skip it.
        async (paths) => this.enrichment.notifyDeletions(paths, ctx.collectionName),
      );
    } finally {
      await this.qdrant.resumeOptimizer(ctx.collectionName).catch((err) => {
        if (isDebug()) console.error(`[Reindex] resumeOptimizer failed (next reindex will heal):`, err);
      });
    }

    if (!outcome.isFullSuccess()) {
      throw new PartialDeletionError(outcome);
    }
    stats.chunksDeleted = outcome.chunksDeleted;

    pipelineLog.reindexPhase("DELETE_ONLY_COMPLETE", {
      files: filesToDelete.length,
      chunksDeleted: outcome.chunksDeleted,
    });

    if (isDebug()) {
      console.error(
        `[Reindex] Deletion-only: removed ${filesToDelete.length} files (${outcome.chunksDeleted} chunks), skipping enrichment`,
      );
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private hasNoChanges(stats: ChangeStats): boolean {
    return (
      stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0 && stats.filesNewlyIgnored === 0
    );
  }

  private reportScanProgress(progressCallback: ProgressCallback | undefined, resume: boolean): void {
    progressCallback?.({
      phase: "scanning",
      current: 0,
      total: 100,
      percentage: 0,
      message: resume ? "Resuming from checkpoint..." : "Scanning for changes...",
    });
  }

  private logParallelStart(filesToDelete: string[], addedFiles: string[], modifiedFiles: string[]): void {
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

  private logDeleteSettled(deletionOutcome: DeletionOutcome | undefined): void {
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

  private logPipelineStats(pCtx: ProcessingContext, parallelStart: number): void {
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
}
