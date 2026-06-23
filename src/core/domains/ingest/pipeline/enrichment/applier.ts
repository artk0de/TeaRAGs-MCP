/**
 * EnrichmentApplier — provider-agnostic payload writer for Qdrant.
 *
 * Writes enrichment data under nested structure:
 * - File-level: { [providerKey]: { file: data } }
 * - Chunk-level: { [providerKey]: { chunk: overlay } }
 *
 * Replaces git-specific MetadataApplier + chunk-churn write logic.
 */

import { relative } from "node:path";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type {
  ChunkSignalOverlay,
  FileSignalOverlay,
  FileSignalTransform,
} from "../../../../contracts/types/provider.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { batchSetPayloadWithRetry, type BatchWriteRetryOptions } from "./batch-write.js";
import { MissedFileTracker } from "./missed-file-tracker.js";
import type { MissedFileChunk } from "./types.js";

const BATCH_SIZE = 100;
const MISSED_PATH_SAMPLE_LIMIT = 10;

/**
 * Emitted once per apply batch. `applied` is the CUMULATIVE per-(provider,level)
 * value as of this batch:
 * - file level: cumulative count of distinct files processed by this provider
 *   across all batches so far (Set-deduped, so the same relPath in two batches
 *   counts as 1).
 * - chunk level: cumulative count of chunk overlays applied by this provider
 *   across all batches so far (running sum, not a delta).
 */
export interface EnrichmentApplyEvent {
  providerKey: string;
  level: "file" | "chunk";
  applied: number;
}

export class EnrichmentApplier {
  private readonly matchedPaths = new Set<string>();
  private readonly missedTracker = new MissedFileTracker({
    sampleLimit: MISSED_PATH_SAMPLE_LIMIT,
  });

  /**
   * Per-provider tracking for cumulative file-level progress. Keyed by
   * providerKey; Set holds relPaths seen so far (deduped across batches).
   * Populated by applyFileSignals and applyFinalizeFile; emitted as the
   * `applied` value in EnrichmentApplyEvent for level="file".
   */
  private readonly filesByProvider = new Map<string, Set<string>>();

  /**
   * Per-provider tracking for cumulative chunk-level progress. Keyed by
   * providerKey; value is the running sum of chunk overlays applied.
   * Populated by applyChunkSignals; emitted as the `applied` value in
   * EnrichmentApplyEvent for level="chunk".
   */
  private readonly chunksByProvider = new Map<string, number>();

  /**
   * Optional callback invoked once per apply batch across ALL apply methods
   * (applyFileSignals, applyChunkSignals, applyFinalizeFile).
   * Wired by the coordinator to `maybeHeartbeat` (throttled) AND to the per-run
   * enrichment-progress sink — fires at the single chokepoint all enrichment
   * writes flow through, covering streaming, post-flush enrichRemaining, deferred
   * codegraph, and backfill paths uniformly. The event carries which provider /
   * level was applied and how many point-ops this batch wrote, so the coordinator
   * can accumulate a cumulative per-(provider, level) numerator for CLI progress.
   * The coordinator owns the 30s heartbeat throttle; this callback is
   * unconditional (DRY).
   */
  onApply?: (event: EnrichmentApplyEvent) => void;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly retryOptions?: BatchWriteRetryOptions,
  ) {}

  /** Count of unique files that received enrichment across all apply passes. */
  get matchedFiles(): number {
    return this.matchedPaths.size;
  }

  /** Count of files whose chunks landed without matching file metadata. */
  get missedFiles(): number {
    return this.missedTracker.missedCount;
  }

  /** Bounded sample of missed paths (capped at MISSED_PATH_SAMPLE_LIMIT). */
  get missedPathSamples(): readonly string[] {
    return this.missedTracker.samples;
  }

  /**
   * Files INTENTIONALLY left unenriched by per-file enrichment policy (a
   * provider's `shouldEnrich` returned "none" — e.g. generated db/schema.rb,
   * vendored code). Tracked SEPARATELY from `missedFiles` so health reporting
   * never confuses an intentional skip with an enrichment failure. Deduped.
   */
  private readonly ignoredPaths = new Set<string>();

  /** Count of unique files intentionally skipped by enrichment policy. */
  get ignoredFiles(): number {
    return this.ignoredPaths.size;
  }

  /**
   * Apply file-level signals to a batch of chunks.
   * Payload written as { [providerKey]: { file: data } }.
   *
   * @param transform Optional per-file transform called with (rawData, maxEndLine).
   *   Git uses this for computeFileSignals(churnData, maxEndLine).
   */
  async applyFileSignals(
    collectionName: string,
    providerKey: string,
    fileMetadata: Map<string, FileSignalOverlay>,
    pathBase: string,
    items: ChunkItem[],
    transform?: FileSignalTransform,
    enrichedAt?: string,
    /**
     * Predicate (injected by the caller, which knows the provider's policy):
     * true ⇒ this file was intentionally skipped by `shouldEnrich === "none"`.
     * Such a file has no overlay BY DESIGN — count it as ignored (not missed)
     * and write NO stamp, so it carries no git payload at all. Keeps the
     * applier provider-agnostic (it never imports the policy itself).
     */
    isIgnored?: (relativePath: string) => boolean,
  ): Promise<void> {
    const applyStart = Date.now();

    // Group items by filePath
    const byFile = new Map<string, ChunkItem[]>();
    for (const item of items) {
      const fp = item.chunk.metadata.filePath;
      const existing = byFile.get(fp) || [];
      existing.push(item);
      byFile.set(fp, existing);
    }

    const operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key?: string;
    }[] = [];
    // Parallel to `operations`: for a MATCHED-file op, the (relativePath, chunk)
    // it carries; `null` for missed-file stamp ops (already in missedTracker).
    // Used to route a failed-batch's matched files into the backfill loop so a
    // dropped file-apply write doesn't strand chunks without git.file.enrichedAt.
    const opResidual: ({ relativePath: string; chunk: MissedFileChunk } | null)[] = [];

    for (const [filePath, fileItems] of byFile) {
      const relativePath = relative(pathBase, filePath);
      const data = fileMetadata.get(relativePath);
      if (!data) {
        // Intentional policy skip — record as ignored, NOT missed, and write no
        // stamp (the file stays free of any git payload). Recovery's
        // scrollUnenriched also filters these, so they never go degraded.
        if (isIgnored?.(relativePath)) {
          this.ignoredPaths.add(relativePath);
          continue;
        }
        this.missedTracker.track(
          relativePath,
          fileItems.map((item) => ({
            chunkId: item.chunkId,
            startLine: item.chunk.startLine,
            endLine: item.chunk.endLine,
          })),
        );
        if (enrichedAt) {
          for (const item of fileItems) {
            // File-level stamp: marks "we tried, no git history".
            operations.push({
              payload: { enrichedAt },
              points: [item.chunkId],
              key: `${providerKey}.file`,
            });
            opResidual.push(null);
            // Chunk-level stamp: same semantics. Without this, recovery keeps
            // counting these chunks forever and forces chunk.status=degraded
            // even though there is nothing retriable.
            operations.push({
              payload: { enrichedAt },
              points: [item.chunkId],
              key: `${providerKey}.chunk`,
            });
            opResidual.push(null);
          }
        }
        continue;
      }
      this.matchedPaths.add(relativePath);

      const maxEndLine = fileItems.reduce((max, item) => Math.max(max, item.chunk.endLine), 0);
      const finalData = transform ? transform(data, maxEndLine) : data;
      const payload = enrichedAt
        ? { ...(finalData as Record<string, unknown>), enrichedAt }
        : (finalData as Record<string, unknown>);

      for (const item of fileItems) {
        operations.push({
          payload,
          points: [item.chunkId],
          key: `${providerKey}.file`,
        });
        opResidual.push({
          relativePath,
          chunk: { chunkId: item.chunkId, startLine: item.chunk.startLine, endLine: item.chunk.endLine },
        });
      }
    }

    // Track every file that was processed in this batch (including missed/ignored
    // paths that produced no overlay — they were still seen). Do this BEFORE the
    // early-return so the file count advances even for stamp-only batches.
    let providerFileSet = this.filesByProvider.get(providerKey);
    if (providerFileSet === undefined) {
      providerFileSet = new Set<string>();
      this.filesByProvider.set(providerKey, providerFileSet);
    }
    const prevSize = providerFileSet.size;
    for (const filePath of byFile.keys()) {
      providerFileSet.add(relative(pathBase, filePath));
    }
    const seenNewFiles = providerFileSet.size > prevSize || byFile.size > 0;

    if (operations.length === 0) {
      // Still emit a file event if any new files were seen (e.g. all-ignored batch)
      if (seenNewFiles) {
        this.onApply?.({ providerKey, level: "file", applied: providerFileSet.size });
      }
      pipelineLog.addStageTime("enrichApply", Date.now() - applyStart);
      return;
    }

    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      const ok = await batchSetPayloadWithRetry(this.qdrant, collectionName, batch, this.retryOptions);
      if (!ok) this.trackResidualBatch(opResidual.slice(i, i + BATCH_SIZE));
    }

    this.onApply?.({ providerKey, level: "file", applied: providerFileSet.size });
    pipelineLog.addStageTime("enrichApply", Date.now() - applyStart);
  }

  /**
   * Apply file-level overlays keyed by an accumulated chunkMap
   * (relPath → ChunkLookupEntry[]) rather than a ChunkItem[] batch. Used by the
   * codegraph finalize file-apply path: the deferred chunkMap that ChunkPhase
   * assembled gives us relPath → chunkId mapping, but no ChunkItem objects.
   *
   * Mirrors EnrichmentBackfiller.runFor's file-apply loop: per file, resolve the
   * overlay, compute maxEndLine across its entries, transform, stamp enrichedAt,
   * and write one `${providerKey}.file` op per chunkId.
   *
   * @returns number of files applied (overlay present + at least one entry).
   */
  async applyFinalizeFile(
    collectionName: string,
    providerKey: string,
    fileOverlays: Map<string, FileSignalOverlay>,
    chunkMap: ReadonlyMap<string, readonly { chunkId: string; startLine: number; endLine: number }[]>,
    transform?: FileSignalTransform,
    enrichedAt?: string,
    /**
     * Policy predicate (injected by the caller, which knows the provider's
     * policy): true ⇒ this file was intentionally skipped by
     * `shouldEnrich === "none"`. bd tea-rags-mcp-yl9tv — classification of a
     * MISSING overlay must be a POLICY decision, NOT overlay-presence: a file
     * absent from `fileOverlays` because policy declined it is `ignored` (no
     * stamp); a genuine source-file gap (declined by NO policy yet still no
     * overlay — e.g. dropped under concurrency) is a real `missed` tracked for
     * backfill. Without this, a missing overlay was silently bare-stamped and
     * counted neither way, so ignoredFiles swung run-to-run with file timing.
     * Mirrors `applyFileSignals`. Optional so existing callers stay valid;
     * absent ⇒ legacy bare-stamp (no provider policy available).
     */
    isIgnored?: (relativePath: string) => boolean,
  ): Promise<number> {
    const fileKey = `${providerKey}.file`;
    const ops: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key: string;
    }[] = [];
    let appliedFiles = 0;

    for (const [relPath, entries] of chunkMap) {
      const overlay = fileOverlays.get(relPath);
      if (!overlay) {
        // No overlay for this file. Classify by POLICY (bd tea-rags-mcp-yl9tv),
        // not by overlay presence:
        //   - policy "none" (e.g. generated / vendored, OR a language the
        //     provider doesn't graph) ⇒ ignored, NO stamp (carries no payload).
        //   - otherwise a genuine miss ⇒ track for backfill AND bare-stamp so
        //     recovery doesn't count it unenriched forever.
        if (isIgnored?.(relPath)) {
          this.ignoredPaths.add(relPath);
          continue;
        }
        this.missedTracker.track(
          relPath,
          entries.map((e) => ({ chunkId: e.chunkId, startLine: e.startLine, endLine: e.endLine })),
        );
        if (enrichedAt) {
          for (const entry of entries) {
            ops.push({ payload: { enrichedAt }, points: [entry.chunkId], key: fileKey });
          }
        }
        continue;
      }
      const maxEndLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
      const final = transform ? transform(overlay, maxEndLine) : overlay;
      const payload = enrichedAt
        ? { ...(final as Record<string, unknown>), enrichedAt }
        : (final as Record<string, unknown>);
      for (const entry of entries) {
        ops.push({ payload, points: [entry.chunkId], key: fileKey });
      }
      appliedFiles++;
      this.matchedPaths.add(relPath);
    }

    // Track every relPath in the chunkMap as a processed file for this provider.
    let finalizeFileSet = this.filesByProvider.get(providerKey);
    if (finalizeFileSet === undefined) {
      finalizeFileSet = new Set<string>();
      this.filesByProvider.set(providerKey, finalizeFileSet);
    }
    for (const relPath of chunkMap.keys()) {
      finalizeFileSet.add(relPath);
    }

    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      await batchSetPayloadWithRetry(this.qdrant, collectionName, ops.slice(i, i + BATCH_SIZE), this.retryOptions);
    }

    if (chunkMap.size > 0) this.onApply?.({ providerKey, level: "file", applied: finalizeFileSet.size });
    return appliedFiles;
  }

  /**
   * Apply chunk-level signal overlays.
   * Payload written as { [providerKey]: { chunk: overlay } }.
   */
  async applyChunkSignals(
    collectionName: string,
    providerKey: string,
    chunkMetadata: Map<string, Map<string, ChunkSignalOverlay>>,
    enrichedAt?: string,
    /** All chunk IDs that were requested for enrichment. Used to stamp enrichedAt
     *  on chunks that buildChunkSignals found no commits for — so they don't
     *  remain "unenriched" forever and trigger infinite recovery loops. */
    allRequestedChunkIds?: Set<string>,
  ): Promise<number> {
    const enrichedChunkIds = new Set<string>();
    let batch: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key?: string;
    }[] = [];
    let applied = 0;

    for (const [, overlayMap] of chunkMetadata) {
      for (const [chunkId, overlay] of overlayMap) {
        enrichedChunkIds.add(chunkId);
        const payload = enrichedAt
          ? { ...(overlay as Record<string, unknown>), enrichedAt }
          : (overlay as Record<string, unknown>);
        batch.push({
          payload,
          points: [chunkId],
          key: `${providerKey}.chunk`,
        });

        if (batch.length >= BATCH_SIZE) {
          if (await batchSetPayloadWithRetry(this.qdrant, collectionName, batch, this.retryOptions)) {
            applied += batch.length;
          }
          batch = [];
        }
      }
    }

    if (batch.length > 0) {
      if (await batchSetPayloadWithRetry(this.qdrant, collectionName, batch, this.retryOptions)) {
        applied += batch.length;
      }
    }

    // Stamp enrichedAt on chunks that had no commits (not in chunkMetadata).
    // Without this, these chunks stay "unenriched" and recovery retries forever.
    if (enrichedAt && allRequestedChunkIds) {
      const missed: string[] = [];
      for (const id of allRequestedChunkIds) {
        if (!enrichedChunkIds.has(id)) missed.push(id);
      }

      if (missed.length > 0) {
        for (let i = 0; i < missed.length; i += BATCH_SIZE) {
          const stampBatch = missed.slice(i, i + BATCH_SIZE).map((id) => ({
            payload: { enrichedAt } as Record<string, unknown>,
            points: [id] as (string | number)[],
            key: `${providerKey}.chunk`,
          }));
          if (await batchSetPayloadWithRetry(this.qdrant, collectionName, stampBatch, this.retryOptions)) {
            applied += stampBatch.length;
          }
        }
      }
    }

    if (applied > 0) {
      const cumulative = (this.chunksByProvider.get(providerKey) ?? 0) + applied;
      this.chunksByProvider.set(providerKey, cumulative);
      this.onApply?.({ providerKey, level: "chunk", applied: cumulative });
    }
    return applied;
  }

  /** Read-only snapshot of files whose chunks landed without matching file metadata. */
  getMissedFileChunks(): ReadonlyMap<string, readonly MissedFileChunk[]> {
    return this.missedTracker.chunkMap;
  }

  /** Adjust matched/missed counters after a successful backfill. */
  markBackfilled(paths: readonly string[]): void {
    for (const p of paths) {
      this.matchedPaths.add(p);
    }
    this.missedTracker.decrementMissed(paths.length);
  }

  /**
   * Route the matched files of a write batch that exhausted its retry budget
   * into the missed-file tracker, so the backfill pass re-fetches and re-applies
   * their signals. Without this, a dropped file-apply batch would leave those
   * chunks with git.chunk signals but no git.file.enrichedAt — a permanent
   * degraded that no in-run pass corrects.
   */
  private trackResidualBatch(metas: ({ relativePath: string; chunk: MissedFileChunk } | null)[]): void {
    const byPath = new Map<string, MissedFileChunk[]>();
    for (const m of metas) {
      if (!m) continue;
      const arr = byPath.get(m.relativePath) ?? [];
      arr.push(m.chunk);
      byPath.set(m.relativePath, arr);
    }
    for (const [rp, chunks] of byPath) this.missedTracker.track(rp, chunks);
  }
}
