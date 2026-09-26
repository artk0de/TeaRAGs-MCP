/**
 * ReindexPipeline - Incremental re-indexing of changed files.
 *
 * Orchestrates: scan → detect changes → classify ignore changes →
 * delete old → process new/modified → snapshot.
 * File processing logic is delegated to FileProcessor.
 */

import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { RechunkFileSelector } from "../../../contracts/types/rechunk.js";
import { isDebug } from "../../../infra/runtime.js";
import type { ChangeStats, ChunkLookupEntry, FileChanges, ProgressCallback } from "../../../types.js";
import { NotIndexedError, PartialDeletionError, ReindexFailedError, SnapshotMissingError } from "../errors.js";
import { cleanupOrphanedVersions, sweepCodegraphOrphans } from "../infra/alias-cleanup.js";
import {
  BaseIndexingPipeline,
  type IndexingRunSealSpec,
  type PipelineRegistryDeps,
  type PipelineTuning,
  type ProcessingContext,
} from "../pipeline/base.js";
import type { DeferredChunkRecoveryHandoff } from "../pipeline/enrichment/recovery.js";
import { pipelineLog } from "../pipeline/infra/debug-logger.js";
import type { FileScanner } from "../pipeline/scanner.js";
import type { DeletionOutcome } from "../sync/deletion/outcome.js";
import { performDeletion, type DeletionConfig } from "../sync/deletion/strategy.js";
import { QuarantineStore } from "../sync/index.js";
import type { ParallelFileSynchronizer } from "../sync/parallel-synchronizer.js";
import { SnapshotCleaner } from "../sync/snapshot/snapshot-cleaner.js";
import { selectRechunkWorkSet } from "./rechunk-work-set.js";
import { executeReindexPipelines } from "./reindex-parallel-executor.js";
import { resolvePhysicalCollection } from "./version-resolver.js";

interface ReindexContext {
  absolutePath: string;
  /**
   * Stable Qdrant alias. Addresses artifacts that must survive a version bump:
   * the quarantine store and the project registry entry.
   */
  collectionName: string;
  /**
   * Physical, versioned collection the alias points at (equal to
   * `collectionName` when there is no alias). Addresses everything opened by
   * LITERAL name — above all the codegraph DuckDB file, which
   * `GraphDbClientPool.pathFor()` derives from the string it is handed.
   * Qdrant resolves either name server-side, so passing the alias here looked
   * harmless while it silently wrote a shadow `<alias>.duckdb` no reader opens
   * (bd tea-rags-mcp-6goqa). Mirrors `SetupResult.targetCollection` on the
   * force path.
   */
  targetCollection: PhysicalCollectionName;
  synchronizer: ParallelFileSynchronizer;
  scanner: FileScanner;
  currentFiles: string[];
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
    overrides?: {
      chunkSize?: number;
      modelInfo?: { model: string; contextLength: number; dimensions: number };
      /**
       * Chunks pre-reindex recovery handed to this run instead of healing them
       * (bd tea-rags-mcp-fxio5). Their files join the repair walk and their
       * entries seed the run's deferred chunk map, so they settle with this
       * run's deferred-pass semantics rather than a pre-walk approximation.
       */
      deferredChunkHandoff?: DeferredChunkRecoveryHandoff;
      /**
       * Scoped force (bd tea-rags-mcp-j4oww): every indexed file this selector
       * picks joins the work set as a MODIFIED file and is re-chunked in place.
       */
      rechunk?: RechunkFileSelector;
    },
  ): Promise<ChangeStats> {
    const startTime = Date.now();
    const { absolutePath, collectionName } = await this.resolveContext(path);
    // Orphan sweep (55xk2): versioned targets left by killed runs
    // (`<base>_vN` no alias points at) used to survive every INCREMENTAL
    // reindex — only the force path cleaned them at setup, so they piled up
    // between force runs. Same cleanup here, best-effort: a sweep failure
    // must never abort an incremental reindex.
    try {
      await cleanupOrphanedVersions(this.qdrant, collectionName, this.codegraphRemover);
      if (this.codegraphLister && this.codegraphRemover) {
        await sweepCodegraphOrphans(this.qdrant, collectionName, this.codegraphLister, this.codegraphRemover);
      }
    } catch (err) {
      if (isDebug()) {
        console.error(`[Reindex] orphan sweep failed (non-fatal):`, err);
      }
    }
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
      if (overrides?.rechunk) {
        stats.filesRechunked = await this.invalidateRechunkWorkSet(ctx, overrides.rechunk);
      }
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
      // Alias, not the versioned target: quarantine survives version bumps so a
      // poison-pill file stays quarantined across a force reindex.
      const quarantineStore = new QuarantineStore(this.snapshotDir, ctx.collectionName);
      const retryPaths = await this.computeQuarantineRetry(quarantineStore, ctx, changes);
      stats.filesRetried = retryPaths.length;

      // Bring provider stores back in line with the code before the run's own
      // enrichment (bd tea-rags-mcp-6goqa). Deliberately ABOVE both early
      // returns (bd tea-rags-mcp-gvw8h): the one run that could notice a
      // drifted store — nothing changed, nothing to chunk — was the one run
      // that skipped the check, so a repository that went quiet never healed
      // and no amount of re-running the reindex fixed it.
      //
      // What a repair still needs is the finalize that rebuilds the derived
      // tables and closes the run it opened. Below, each early return drives
      // that itself through `finalizeRepairedRun`, and pays nothing when the
      // stores already matched. Silent either way: the cost shows up as time,
      // not as a message. Hashes come from the scan detectChanges just did, so
      // nothing is re-read.
      //
      // Chunks pre-reindex recovery handed to this run (bd tea-rags-mcp-fxio5)
      // are narrowed to what the repair will walk, then walked by it and seeded
      // into whichever run closes it — the finalize below or the chunk pipeline.
      // A file this run re-chunks is dropped first: its stored points are
      // replaced, so the handed-off ids are stale, and its fresh chunks reach the
      // deferred pass through the pipeline anyway. A seeded chunk whose file is
      // never walked would be stamped `enrichedAt` over an empty overlay.
      const scannedHashes = ctx.synchronizer.getCurrentFileHashes();
      const deferredChunkHandoff = this.narrowDeferredChunkHandoff(overrides?.deferredChunkHandoff, scannedHashes, [
        ...changes.added,
        ...changes.modified,
        ...retryPaths,
      ]);
      const repaired = await this.enrichment.runRepairPass(
        ctx.targetCollection,
        ctx.absolutePath,
        scannedHashes,
        deferredChunkHandoffPaths(deferredChunkHandoff),
      );

      if (this.hasNoChanges(stats) && retryPaths.length === 0) {
        // A deletion-only run prunes the derived codegraph tables and leaves
        // them stale rather than paying the recompute on its fast path (bd
        // tea-rags-mcp-dy852). This branch is the next run that has nothing to
        // chunk, so it owes that finalize even when the repair found nothing.
        const staleDerived = repaired === 0 && (await this.enrichment.hasStaleDerivedState(ctx.targetCollection));
        const finalized = await this.finalizeRepairedRun(ctx, stats, repaired, deferredChunkHandoff, staleDerived);
        await this.completeCollectionUnlessFinalized(ctx, finalized);
        // No snapshot: nothing changed, so the stored file list already matches
        // what is on disk.
        await this.sealRun(this.reindexSealSpec(ctx, { snapshot: false }));
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // Deletion-only: no files to add/modify/retry → skip pipeline init and enrichment
      if (changes.added.length === 0 && changes.modified.length === 0 && retryPaths.length === 0) {
        await this.executeDeletionOnly(ctx, changes, stats, progressCallback);
        // Removing files needs no enrichment, which is what this path is for —
        // but a repair on THIS run does, so the finalize below overwrites
        // "skipped" exactly when it had something to finalize.
        stats.enrichmentStatus = "skipped";
        const finalized = await this.finalizeRepairedRun(ctx, stats, repaired, deferredChunkHandoff);
        await this.completeCollectionUnlessFinalized(ctx, finalized);
        await this.sealRun(this.reindexSealSpec(ctx, { snapshot: true }));
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      this.startHeartbeat(ctx.targetCollection);
      const processingCtx = this.initChangesProcessing(
        ctx,
        [...changes.added, ...changes.modified, ...retryPaths].length,
        quarantineStore,
        deferredChunkHandoff,
        overrides?.chunkSize,
      );
      const {
        chunksAdded,
        chunksDeleted,
        chunkMap,
        filesSkippedDueToDeleteFailure,
        filesFailedToDelete,
        deletionOutcome,
      } = await executeReindexPipelines({
        qdrant: this.qdrant,
        targetCollection: ctx.targetCollection,
        absolutePath: ctx.absolutePath,
        changes,
        retryPaths,
        quarantineStore,
        processingCtx,
        deleteConfig: this.deleteConfig,
        enableGitMetadata: this.config.enableGitMetadata === true,
        fileConcurrency: this.tuning.fileConcurrency,
        notifyDeletions: async (paths) => this.enrichment.notifyDeletions(paths, ctx.targetCollection),
        progressCallback,
      });
      stats.chunksAdded = chunksAdded;
      stats.chunksDeleted = chunksDeleted;
      if (filesSkippedDueToDeleteFailure !== undefined && filesSkippedDueToDeleteFailure > 0) {
        stats.filesSkippedDueToDeleteFailure = filesSkippedDueToDeleteFailure;
        stats.status = "partial";
      }
      if (filesFailedToDelete !== undefined && filesFailedToDelete > 0) {
        stats.filesFailedToDelete = filesFailedToDelete;
        stats.status = "partial";
      }

      this.stopHeartbeat();
      // Every path whose delete failed still has its old chunks in the index —
      // a removed file never left it, a modified file's re-ingest was skipped
      // by the coordinator. Its snapshot entry stays as the previous run left
      // it, so the next run detects it again and retries (bd tea-rags-mcp-ti1oa).
      const unreconciled = deletionOutcome?.failed ?? new Set<string>();
      await this.finalizeReindex(ctx, processingCtx, chunkMap, stats, startTime, unreconciled);
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

    const targetCollection = resolvePhysicalCollection(collectionName, await this.qdrant.aliases.listAliases());

    return { absolutePath, collectionName, targetCollection, synchronizer, scanner, currentFiles };
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

    // Stats backfills read the collection that is already stored — no
    // re-embedding — so they belong on this sweep rather than behind a
    // reindex prompt. It runs before the change detection early-returns,
    // which is what lets a quiet repository still pick up a backfill.
    const statsResult = await migrator.run("stats");
    if (statsResult.steps.length > 0) {
      pipelineLog.reindexPhase("stats_migration", {
        fromVersion: statsResult.fromVersion,
        toVersion: statsResult.toVersion,
        steps: statsResult.steps.map((s) => s.applied?.join(", ") ?? s.name),
      });
    }

    // After the schema pipeline, so its own indexes already exist: creates the
    // declared payload indexes an existing collection lacks and names the
    // undeclared ones (bd tea-rags-mcp-mimq0). A clean collection costs one read.
    const payloadIndexResult = await migrator.run("payloadIndexes");
    if (payloadIndexResult.steps.length > 0) {
      pipelineLog.reindexPhase("payload_index_reconcile", {
        fromVersion: payloadIndexResult.fromVersion,
        toVersion: payloadIndexResult.toVersion,
        steps: payloadIndexResult.steps.map((s) => s.applied?.join(", ") ?? s.name),
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

  // ── Scoped force ─────────────────────────────────────────

  /**
   * Turn a scoped force's selector into snapshot entries marked stale, so the
   * change detection below reports those files as MODIFIED and the ordinary
   * modified-file path re-chunks them: points deleted by path, new chunks
   * embedded and upserted, codegraph rows replaced by the walker's
   * DELETE+INSERT, enrichment run for their chunks only. Nothing outside the
   * selection is touched and no new collection is built.
   *
   * The marks are persisted BEFORE any point is deleted — that is the crash
   * safety. A run that dies after this leaves the files stale on disk, so the
   * next run of any kind, auto-update included, re-chunks them; a delete that
   * fails keeps its stale mark through `retainPrevious`. Returns how many
   * indexed files the selector picked.
   */
  private async invalidateRechunkWorkSet(ctx: ReindexContext, selector: RechunkFileSelector): Promise<number> {
    const base = ctx.absolutePath;
    const scannedFiles = ctx.currentFiles.map((f) => (f.startsWith(base) ? f.slice(base.length + 1) : f));
    const workSet = selectRechunkWorkSet({
      selector,
      scannedFiles,
      indexedFiles: ctx.synchronizer.getSnapshotPaths(),
    });
    await ctx.synchronizer.invalidateEntries(workSet);
    pipelineLog.reindexPhase("RECHUNK_SCOPED", { files: workSet.length, selector });
    return workSet.length;
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

  /**
   * Open the processing context the changes leg streams into; the leg itself
   * is `executeReindexPipelines`.
   */
  private initChangesProcessing(
    ctx: ReindexContext,
    /**
     * File-progress denominator = the DELTA that will actually stream, not the
     * full scan: currentFiles.length rendered a 4.5k-file incremental as
     * "2458/25531 (10%)" with a whole-repo ETA (tea-rags-mcp-d0aqv).
     */
    changedFileCount: number,
    quarantineStore: QuarantineStore,
    deferredChunkHandoff: DeferredChunkRecoveryHandoff,
    chunkSizeOverride?: number,
  ): ProcessingContext {
    const pCtx = this.initProcessing(
      ctx.targetCollection,
      ctx.absolutePath,
      ctx.scanner,
      chunkSizeOverride,
      changedFileCount,
    );
    // `initProcessing` just ran `beginRun`. Seed the recovery handoff into that
    // run before any batch or its completion reads the deferred chunk map; the
    // repair pass has already walked these files (bd tea-rags-mcp-fxio5).
    this.enrichment.seedDeferredChunks(pCtx.enrichmentRun, deferredChunkHandoff);
    // Embed-phase poison-pill isolation (shares the read/parse quarantine store).
    pCtx.chunkPipeline.setQuarantineStore(quarantineStore);
    return pCtx;
  }

  // ── Finalization ─────────────────────────────────────────

  private async finalizeReindex(
    ctx: ReindexContext,
    processingCtx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    stats: ChangeStats,
    startTime: number,
    unreconciled: ReadonlySet<string>,
  ): Promise<void> {
    const enrichmentResult = await this.completePipeline(
      processingCtx,
      chunkMap,
      this.reindexSealSpec(ctx, { snapshot: true, retainPrevious: unreconciled }),
    );
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

  /**
   * How every reindex return seals its run, whatever work it did — the order
   * (marker → snapshot/checkpoint → registry) is `BaseIndexingPipeline#sealRun`'s:
   * mark the collection complete, optionally re-stamp the snapshot, drop the
   * checkpoint, record the registry entry. No promote step: an incremental run
   * writes into the collection the alias already serves.
   *
   * The registry entry is part of closing a run, not of the changes path
   * (bd tea-rags-mcp-zf3x0). It says which commit, when, and how many points
   * the index represents, and `CommitDriftMonitor` reads that git block back.
   * While only the changes path wrote it, the commit axis stayed pinned to
   * whichever run last had a file to chunk: a repository that went quiet — or
   * one whose run only deleted files, which moves the point count and the
   * commit just as much as adding does — reported drift forever, and the
   * reindex that would have cleared it was precisely the run taking an early
   * return. Address it by the ALIAS (`collectionName`), matching the force
   * path; the marker addresses the versioned target.
   *
   * `snapshot: false` belongs to the zero-change return alone — there the
   * stored file list already matches disk, so rewriting it is pure cost.
   *
   * `retainPrevious` names paths this run left out of line with disk; their
   * snapshot entries stay as the previous run saved them, so the next run
   * retries them (bd tea-rags-mcp-ti1oa).
   */
  private reindexSealSpec(
    ctx: ReindexContext,
    { snapshot, retainPrevious }: { snapshot: boolean; retainPrevious?: ReadonlySet<string> },
  ): IndexingRunSealSpec {
    return {
      targetCollection: ctx.targetCollection,
      collectionAlias: ctx.collectionName,
      absolutePath: ctx.absolutePath,
      persist: async () => {
        if (snapshot) {
          const options = retainPrevious && retainPrevious.size > 0 ? { retainPrevious } : undefined;
          await ctx.synchronizer.updateSnapshot(ctx.currentFiles, undefined, options);
        }
        await ctx.synchronizer.deleteCheckpoint();
      },
    };
  }

  /**
   * Close a run whose only work was the repair (bd tea-rags-mcp-gvw8h).
   *
   * A repair writes base rows and leaves every provider it touched mid-run. The
   * finalize is what turns those rows back into the derived tables
   * (`cg_symbols_cycles`, `cg_symbols_metrics`), writes the terminal markers, and
   * releases the per-run state — the reason the repair could not simply be moved
   * above the early returns on its own.
   *
   * Nothing repaired means nothing drifted, so the untouched-repository path —
   * the one that runs on every no-op reindex — returns here before paying for a
   * completion pass it has no use for.
   *
   * A failure is reported the way every other enrichment failure is: through the
   * terminal markers and the log, not by failing a reindex that otherwise
   * succeeded (mirrors `startEnrichment`'s background catch).
   *
   * Returns whether a finalize ran to completion — and with it every
   * provider's whole-collection work (`completeCollectionUnlessFinalized`).
   */
  private async finalizeRepairedRun(
    ctx: ReindexContext,
    stats: ChangeStats,
    repaired: number,
    /** The narrowed recovery handoff whose files this repair walked (bd tea-rags-mcp-fxio5). */
    deferredChunkHandoff: DeferredChunkRecoveryHandoff,
    /**
     * A provider's derived tables were pruned by an earlier deletion and not yet
     * recomputed (bd tea-rags-mcp-dy852): finalize even though nothing was
     * repaired. Only the no-change branch passes it — the deletion-only fast
     * path is the run that pruned, and stays closed.
     */
    staleDerived = false,
  ): Promise<boolean> {
    if (repaired === 0 && !staleDerived) return false;
    pipelineLog.reindexPhase("REPAIR_FINALIZE_START", {
      repaired,
      ...(staleDerived ? { staleDerived: true } : {}),
      collection: ctx.targetCollection,
    });
    try {
      stats.enrichmentMetrics = await this.enrichment.runFinalizeOnly(
        ctx.absolutePath,
        ctx.targetCollection,
        deferredChunkHandoff,
      );
      stats.enrichmentStatus = "completed";
      return true;
    } catch (error) {
      console.error("[Reindex] Repair finalize failed:", error);
      stats.enrichmentStatus = "failed";
      return false;
    }
  }

  /**
   * The whole-collection work a finalize ends with, owed by the early returns
   * that ran none (bd tea-rags-mcp-l1ot.2). Codegraph's co-change sub-graph is
   * a function of HEAD and the working tree's deletions — both of which a
   * deletion-only run, or a run whose HEAD moved with no indexed file changed,
   * can move — yet only a finalize rebuilt it, so a committed `git rm` left the
   * deleted file's pairs standing. A finalize that completed already ran it —
   * `EnrichmentCoordinator#completeRun` asks the same seam on the main thread
   * once that run settles (bd tea-rags-mcp-vtuu4) — so asking again would only
   * pay a second skip check; a finalize that threw never reached it, and this
   * ask is the run's only one.
   */
  private async completeCollectionUnlessFinalized(ctx: ReindexContext, finalized: boolean): Promise<void> {
    if (finalized) return;
    await this.enrichment.runCollectionCompletion(ctx.absolutePath, ctx.targetCollection);
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

    await this.qdrant.pauseOptimizer(ctx.targetCollection);

    let outcome: DeletionOutcome;
    try {
      outcome = await performDeletion(
        this.qdrant,
        ctx.targetCollection,
        filesToDelete,
        this.deleteConfig,
        progressCallback,
        // Same provider-notification hook as the parallel path — the
        // deletion-only branch must not skip it.
        async (paths) => this.enrichment.notifyDeletions(paths, ctx.targetCollection),
      );
    } finally {
      await this.qdrant.resumeOptimizer(ctx.targetCollection).catch((err) => {
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

  /**
   * The part of a recovery handoff this run can settle (bd tea-rags-mcp-fxio5).
   *
   * Files this run re-chunks go first: their stored points are replaced, so the
   * handed-off chunk ids no longer exist, and mixing their stale line ranges
   * into the file's fresh entries would let the deferred pass join a symbol to
   * a deleted chunk. The coordinator then keeps only what its repair walks.
   */
  private narrowDeferredChunkHandoff(
    handoff: DeferredChunkRecoveryHandoff | undefined,
    scanned: ReadonlyMap<string, string>,
    rechunkedPaths: readonly string[],
  ): DeferredChunkRecoveryHandoff {
    if (!handoff || handoff.size === 0) return new Map();
    const rechunked = new Set(rechunkedPaths);
    const untouched = new Map<string, ReadonlyMap<string, ChunkLookupEntry[]>>();
    for (const [providerKey, entriesByPath] of handoff) {
      const kept = new Map([...entriesByPath].filter(([relPath]) => !rechunked.has(relPath)));
      if (kept.size > 0) untouched.set(providerKey, kept);
    }
    return this.enrichment.narrowDeferredChunkHandoff(untouched, scanned);
  }
}

/** A handoff's relPaths per provider — the forced paths `runRepairPass` walks. */
function deferredChunkHandoffPaths(handoff: DeferredChunkRecoveryHandoff): Map<string, ReadonlySet<string>> {
  return new Map(
    [...handoff].map(([providerKey, entriesByPath]): [string, ReadonlySet<string>] => [
      providerKey,
      new Set(entriesByPath.keys()),
    ]),
  );
}
