/**
 * EnrichmentRecovery — detects chunks missing enrichedAt timestamps and re-enriches them.
 *
 * Scrolls Qdrant for chunks where `{providerKey}.{level}.enrichedAt` is empty/missing,
 * groups them by file, and calls the provider to re-enrich.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import { InlineEnrichmentExecutor } from "./executor/index.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import { enrichmentScope } from "./policy.js";
import type { EnrichmentProvider, ProviderContext } from "./types.js";

export interface RecoveryResult {
  recoveredFiles: number;
  recoveredChunks: number;
  remainingUnenriched: number;
}

interface UnenrichedPoint {
  id: string | number;
  relativePath: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Runaway backstop for the unenriched scroll — NOT a working cap. The former
 * 10k cap silently truncated recovery on real damage: a crashed codegraph
 * finalize left 29 461 points unenriched on taxdome, the first scroll page
 * saturated with policy-ignored points, and repeated recovery passes healed
 * nothing beyond page one while reporting a capped remaining count (405).
 * Recovery must see the WHOLE unenriched set; the payload include-selector
 * below keeps the traversal cheap (three scalar keys, no content).
 */
const RECOVERY_SCROLL_HARD_CAP = 1_000_000;

/** Payload keys recovery actually reads — everything else stays server-side. */
const RECOVERY_PAYLOAD_KEYS = ["relativePath", "startLine", "endLine"];

/**
 * Max unique file paths per provider dispatch. Bounds worker-side memory and
 * IPC message size on large recoveries (a whole-repo codegraph walk), and makes
 * healing incremental: each batch's payload writes land before the next batch
 * runs, so a mid-recovery crash keeps the progress made so far.
 */
export const RECOVERY_FILE_BATCH_SIZE = 500;

export interface RecoveryOptions {
  scrollPageSize?: number;
  /**
   * Dispatch seam to the providers; defaults to InlineEnrichmentExecutor.
   * Lets a Phase-2 caller swap in a ThreadPool-backed executor without
   * changing recovery's logic.
   */
  executor?: EnrichmentExecutor;
}

export class EnrichmentRecovery {
  private readonly scrollPageSize: number | undefined;
  private readonly executor: EnrichmentExecutor;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly applier: EnrichmentApplier,
    options?: RecoveryOptions,
  ) {
    this.scrollPageSize = options?.scrollPageSize;
    this.executor = options?.executor ?? new InlineEnrichmentExecutor();
  }

  /**
   * Re-enrich file-level signals for chunks missing `{providerKey}.file.enrichedAt`.
   *
   * Dispatches in bounded file batches (RECOVERY_FILE_BATCH_SIZE): one failed
   * batch is logged and counted as remaining while the rest keep healing — a
   * single provider hiccup must not zero out a whole-collection recovery.
   */
  async recoverFileLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
  ): Promise<RecoveryResult> {
    // scrollUnenriched already drops policy-skipped points (generated files are
    // unenriched by design), so recovery only sees genuinely-missed files.
    const unenriched = await this.scrollUnenriched(collectionName, provider, "file");

    if (unenriched.length === 0) {
      return { recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 };
    }

    const root = provider.resolveRoot(absolutePath);
    const pointsByPath = groupByRelativePath(unenriched);
    const uniquePaths = [...pointsByPath.keys()];

    let recoveredFiles = 0;
    let recoveredChunks = 0;
    let failedPoints = 0;

    for (let i = 0; i < uniquePaths.length; i += RECOVERY_FILE_BATCH_SIZE) {
      const batchPaths = uniquePaths.slice(i, i + RECOVERY_FILE_BATCH_SIZE);
      const batchPoints = batchPaths.flatMap((p) => pointsByPath.get(p) ?? []);
      try {
        // Batched recovery — must NOT route through streamFileBatch; the
        // streaming extraction side-effects belong to the live file phase, not
        // to post-hoc recovery.
        const signals = await this.executor.runFileSignals(provider, root, batchPaths, { collectionName });

        // Build ChunkItem-like objects for applyFileSignals
        const items = batchPoints.map((point) => ({
          chunkId: String(point.id),
          chunk: {
            metadata: {
              filePath: root.endsWith("/") ? `${root}${point.relativePath}` : `${root}/${point.relativePath}`,
            },
            startLine: point.startLine ?? 0,
            endLine: point.endLine ?? 0,
            content: "",
          },
        }));

        await this.applier.applyFileSignals(
          collectionName,
          provider.key,
          signals,
          root,
          items as unknown as ChunkItem[],
          provider.fileSignalTransform,
          enrichedAt,
        );

        recoveredFiles += batchPaths.length;
        recoveredChunks += batchPoints.length;
      } catch (error) {
        failedPoints += batchPoints.length;
        // Unconditional: a debug-gated log already cost a full debugging
        // session on live damage — a recovery failure must always surface.
        console.error(
          `[EnrichmentRecovery:${provider.key}] recoverFileLevel batch failed ` +
            `(${batchPaths.length} files, ${batchPoints.length} chunks):`,
          error,
        );
      }
    }

    const remaining = await this.countRemaining(collectionName, provider, "file", failedPoints);

    return { recoveredFiles, recoveredChunks, remainingUnenriched: remaining };
  }

  /**
   * Re-enrich chunk-level signals for chunks missing `{providerKey}.chunk.enrichedAt`.
   */
  async recoverChunkLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
  ): Promise<RecoveryResult> {
    // scrollUnenriched already keeps only "full"-scope points (generated +
    // documentation chunks are unenriched by design), so recovery never
    // resurrects skipped chunk signals.
    const unenriched = await this.scrollUnenriched(collectionName, provider, "chunk");

    if (unenriched.length === 0) {
      return { recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 };
    }

    const root = provider.resolveRoot(absolutePath);
    const pointsByPath = groupByRelativePath(unenriched);
    const uniquePaths = [...pointsByPath.keys()];

    let recoveredFiles = 0;
    let recoveredChunks = 0;
    let failedPoints = 0;

    for (let i = 0; i < uniquePaths.length; i += RECOVERY_FILE_BATCH_SIZE) {
      const batchPaths = uniquePaths.slice(i, i + RECOVERY_FILE_BATCH_SIZE);

      // Build chunkMap for this batch: Map<relativePath, ChunkLookupEntry[]>
      const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
      const batchChunkIds = new Set<string>();
      let batchPointCount = 0;
      for (const relPath of batchPaths) {
        const entries = (pointsByPath.get(relPath) ?? []).map((point) => ({
          chunkId: String(point.id),
          startLine: point.startLine ?? 0,
          endLine: point.endLine ?? 0,
        }));
        chunkMap.set(relPath, entries);
        for (const entry of entries) batchChunkIds.add(entry.chunkId);
        batchPointCount += entries.length;
      }

      try {
        const chunkSignals = await this.executor.runChunkBatch(
          provider,
          root,
          chunkMap as unknown as Map<string, ChunkLookupEntry[]>,
          { collectionName },
        );
        const applied = await this.applier.applyChunkSignals(
          collectionName,
          provider.key,
          chunkSignals,
          enrichedAt,
          batchChunkIds,
        );

        recoveredFiles += chunkMap.size;
        recoveredChunks += applied;
      } catch (error) {
        failedPoints += batchPointCount;
        // Unconditional — see recoverFileLevel: silent recovery failures are
        // exactly how a 29k-point damage went unnoticed.
        console.error(
          `[EnrichmentRecovery:${provider.key}] recoverChunkLevel batch failed ` +
            `(${chunkMap.size} files, ${batchPointCount} chunks):`,
          error,
        );
      }
    }

    const remaining = await this.countRemaining(collectionName, provider, "chunk", failedPoints);

    return { recoveredFiles, recoveredChunks, remainingUnenriched: remaining };
  }

  /**
   * Post-recovery remaining count. The live count is authoritative, but points
   * sitting in failed batches are KNOWN un-healed — when the live count lags
   * (or the count itself fails), the failed-batch floor keeps the marker
   * honest instead of reporting a clean state after a broken pass.
   */
  private async countRemaining(
    collectionName: string,
    provider: EnrichmentProvider,
    level: "file" | "chunk",
    failedPoints: number,
  ): Promise<number> {
    const live = await this.countUnenriched(collectionName, provider, level).catch(() => 0);
    return Math.max(live, failedPoints);
  }

  /**
   * Count chunks missing enrichedAt for the given provider key and level.
   * Uses Qdrant count API — lightweight, no payload transfer.
   */
  async countUnenriched(
    collectionName: string,
    provider: EnrichmentProvider,
    level: "file" | "chunk",
  ): Promise<number> {
    // Fast path: a provider with no per-file policy can't intentionally skip
    // anything, so the server-side count is exact — no payload transfer.
    if (!provider.shouldEnrich) {
      const filter = this.buildUnenrichedFilter(provider.key, level);
      return this.qdrant.countPoints(collectionName, filter);
    }
    // Policy path: server-side count can't express path-glob skips, so count
    // via the policy-filtered scroll. This keeps countUnenriched and the
    // recovery scroll on the SAME set (the invariant buildUnenrichedFilter's
    // relativePath exclusion already maintains) — a generated/doc file the
    // policy skips must not keep the marker degraded forever.
    return (await this.scrollUnenriched(collectionName, provider, level)).length;
  }

  /**
   * High-level recovery entry. Snapshots runId, runs both levels, re-checks
   * runId; only writes the recovery marker when no concurrent run has
   * stamped a fresher runId.
   */
  async recoverAll(
    coll: string,
    absolutePath: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    markerStore: EnrichmentMarkerStore,
  ): Promise<void> {
    const enrichedAt = new Date().toISOString();
    for (const ctx of contexts.values()) {
      const baselineRunId = await markerStore.getRunId(coll, ctx.key);

      const fileResult = await this.recoverFileLevel(coll, absolutePath, ctx.provider, enrichedAt);
      const chunkResult = await this.recoverChunkLevel(coll, absolutePath, ctx.provider, enrichedAt);

      const currentRunId = await markerStore.getRunId(coll, ctx.key);
      if (baselineRunId !== currentRunId) {
        // A concurrent run has rewritten the marker; our counts are stale.
        // Skip the marker write to avoid clobbering the fresher state.
        continue;
      }

      // Stamp the recovery marker with the ACTIVE run pointer, not the
      // per-provider runId. A provider that crashed before any terminal write
      // has no per-provider runId (`baselineRunId` is undefined), so a "" stamp
      // would never match `_run.runId` and the health mapper would re-derive
      // "crashed" forever. `_run.runId` is the identity the mapper compares
      // against, so stamping it makes the recovered terminal status render.
      const activeRunId = await markerStore.getActiveRunId(coll);

      await markerStore.markRecoveryResult(coll, ctx.key, {
        runId: activeRunId ?? baselineRunId ?? "",
        fileStatus: fileResult.remainingUnenriched === 0 ? "completed" : "failed",
        fileUnenriched: fileResult.remainingUnenriched,
        chunkStatus: chunkResult.remainingUnenriched === 0 ? "completed" : "degraded",
        chunkUnenriched: chunkResult.remainingUnenriched,
      });
    }
  }

  /**
   * Build the Qdrant filter for chunks missing `{providerKey}.{level}.enrichedAt`.
   */
  private buildUnenrichedFilter(providerKey: string, level: "file" | "chunk"): Record<string, unknown> {
    const enrichedAtField = `${providerKey}.${level}.enrichedAt`;
    return {
      must: [{ is_empty: { key: enrichedAtField } }],
      must_not: [
        { key: "_type", match: { value: "indexing_metadata" } },
        { key: "_type", match: { value: "schema_metadata" } },
        // Points without a relativePath cannot be re-enriched (scrollUnenriched
        // skips them). Exclude them from the count too, so countUnenriched and
        // the recovery scroll see the same set — otherwise a no-relativePath
        // point with empty enrichedAt keeps the count > 0 and degraded sticks
        // forever with nothing the recovery pass can act on.
        { is_empty: { key: "relativePath" } },
      ],
    };
  }

  /**
   * Scroll Qdrant for chunks missing `{providerKey}.{level}.enrichedAt`.
   * Excludes the metadata point (INDEXING_METADATA_ID).
   */
  private async scrollUnenriched(
    collectionName: string,
    provider: EnrichmentProvider,
    level: "file" | "chunk",
  ): Promise<UnenrichedPoint[]> {
    const filter = this.buildUnenrichedFilter(provider.key, level);
    const points = await this.qdrant.scrollFiltered(
      collectionName,
      filter,
      RECOVERY_SCROLL_HARD_CAP,
      this.scrollPageSize,
      RECOVERY_PAYLOAD_KEYS,
    );

    const result: UnenrichedPoint[] = [];
    for (const point of points) {
      const relativePath = typeof point.payload?.relativePath === "string" ? point.payload.relativePath : null;
      if (!relativePath) continue;
      // Per-file enrichment policy: a file the provider declined is unenriched
      // BY DESIGN — exclude it so neither the recovery pass nor the unenriched
      // count treats an intentional skip as a degraded miss. file level drops
      // scope "none"; chunk level keeps only "full" (drops "none" + "file-only").
      const scope = enrichmentScope(provider, relativePath);
      if (level === "file" ? scope === "none" : scope !== "full") continue;
      result.push({
        id: point.id,
        relativePath,
        startLine: typeof point.payload?.startLine === "number" ? point.payload.startLine : undefined,
        endLine: typeof point.payload?.endLine === "number" ? point.payload.endLine : undefined,
      });
    }
    return result;
  }
}

/** Group unenriched points by relativePath, preserving scroll order. */
function groupByRelativePath(points: UnenrichedPoint[]): Map<string, UnenrichedPoint[]> {
  const byPath = new Map<string, UnenrichedPoint[]>();
  for (const point of points) {
    const existing = byPath.get(point.relativePath) ?? [];
    existing.push(point);
    byPath.set(point.relativePath, existing);
  }
  return byPath;
}
