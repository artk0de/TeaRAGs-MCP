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
import { enrichmentSkipReason, type EnrichmentSkipReason } from "./policy.js";
import type { EnrichmentProvider, ProviderContext } from "./types.js";

export interface RecoveryResult {
  recoveredFiles: number;
  recoveredChunks: number;
  remainingUnenriched: number;
}

/**
 * Which points a pass considers candidates.
 *
 * - `unenriched` — the healing default: points settled by neither terminal
 *   marker, i.e. genuine damage.
 * - `all` — a deliberate recompute: every enrichable point, including ones
 *   already carrying a fresh `enrichedAt`. Used when the provider's OUTPUT
 *   changed (new signal, new resolver) and the existing payload is stale even
 *   though it is present.
 *
 * The two differ only in the candidate filter; everything downstream — policy
 * skips, batching, the failed-batch floor — is shared, so a recompute cannot
 * quietly diverge from recovery's behaviour.
 */
export type RecoveryScope = "unenriched" | "all";

interface UnenrichedPoint {
  id: string | number;
  relativePath: string;
  startLine?: number;
  endLine?: number;
}

/** A point the policy declined, carrying the reason to stamp onto it. */
interface DeclinedPoint {
  id: string | number;
  skippedAs: EnrichmentSkipReason;
}

/**
 * One pass over the unenriched set, split by what the policy says about each
 * point: `owed` is genuine damage recovery must heal, `declined` is deliberate
 * policy skips that must be stamped so they never come back.
 *
 * Kept as a pure query so `countUnenriched` can reuse it without stamping —
 * counting must not mutate.
 */
interface UnenrichedScan {
  owed: UnenrichedPoint[];
  declined: DeclinedPoint[];
}

/**
 * One bounded dispatch slice of the owed set. Carries both views a level needs:
 * the unique paths (what the provider is asked for) and the flat point list
 * (what the applier writes to, and the failed-batch floor when healing throws).
 */
interface RecoveryBatch {
  readonly paths: readonly string[];
  readonly points: readonly UnenrichedPoint[];
  readonly pointsByPath: ReadonlyMap<string, UnenrichedPoint[]>;
}

/** What healing one batch actually recovered, as the level counts it. */
interface RecoveredCounts {
  readonly files: number;
  readonly chunks: number;
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
   * The scan splits policy-skipped points out (generated files are unenriched
   * by design), so recovery only heals genuinely-missed files — and stamps the
   * skipped ones so they leave the candidate set for good. See `recoverLevel`
   * for the traversal this shares with the chunk level.
   */
  async recoverFileLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
    scope: RecoveryScope = "unenriched",
  ): Promise<RecoveryResult> {
    return this.recoverLevel(collectionName, absolutePath, provider, "file", scope, async (batch, root) => {
      // Batched recovery — must NOT route through streamFileBatch; the
      // streaming extraction side-effects belong to the live file phase, not
      // to post-hoc recovery.
      const signals = await this.executor.runFileSignals(provider, root, [...batch.paths], { collectionName });

      // Build ChunkItem-like objects for applyFileSignals
      const items = batch.points.map((point) => ({
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

      return { files: batch.paths.length, chunks: batch.points.length };
    });
  }

  /**
   * Re-enrich chunk-level signals for chunks missing `{providerKey}.chunk.enrichedAt`.
   *
   * The scan keeps only "full"-scope points (generated + documentation chunks
   * are unenriched by design), so recovery never resurrects skipped chunk
   * signals — it stamps them instead.
   */
  async recoverChunkLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
    scope: RecoveryScope = "unenriched",
  ): Promise<RecoveryResult> {
    return this.recoverLevel(collectionName, absolutePath, provider, "chunk", scope, async (batch, root) => {
      // Build chunkMap for this batch: Map<relativePath, ChunkLookupEntry[]>
      const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
      const batchChunkIds = new Set<string>();
      for (const relPath of batch.paths) {
        const entries = (batch.pointsByPath.get(relPath) ?? []).map((point) => ({
          chunkId: String(point.id),
          startLine: point.startLine ?? 0,
          endLine: point.endLine ?? 0,
        }));
        chunkMap.set(relPath, entries);
        for (const entry of entries) batchChunkIds.add(entry.chunkId);
      }

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

      return { files: chunkMap.size, chunks: applied };
    });
  }

  /**
   * The traversal both levels share: scan, settle the declined half, then walk
   * the owed half in bounded file batches, healing each through `healBatch`.
   *
   * One failed batch is logged and counted as remaining while the rest keep
   * healing — a single provider hiccup must not zero out a whole-collection
   * recovery.
   *
   * The two levels differ ONLY in how a batch is healed, so that is the only
   * thing they supply. Holding the traversal once is not cosmetic: file and
   * chunk recovery drifting apart is the same failure mode the unenriched
   * predicate has (one definition moves, the other does not), one layer up.
   * When this was two copies, the batching cap, the failed-batch floor and the
   * declined-stamping step each had to be fixed twice.
   */
  private async recoverLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    level: "file" | "chunk",
    scope: RecoveryScope,
    healBatch: (batch: RecoveryBatch, root: string) => Promise<RecoveredCounts>,
  ): Promise<RecoveryResult> {
    const scan = await this.scanUnenriched(collectionName, provider, level, scope);
    await this.stampDeclined(collectionName, provider.key, level, scan.declined);

    if (scan.owed.length === 0) {
      return { recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 };
    }

    const root = provider.resolveRoot(absolutePath);
    const pointsByPath = groupByRelativePath(scan.owed);
    const uniquePaths = [...pointsByPath.keys()];
    const method = level === "file" ? "recoverFileLevel" : "recoverChunkLevel";

    let recoveredFiles = 0;
    let recoveredChunks = 0;
    let failedPoints = 0;

    for (let i = 0; i < uniquePaths.length; i += RECOVERY_FILE_BATCH_SIZE) {
      const batch = sliceRecoveryBatch(uniquePaths, i, pointsByPath);
      try {
        const healed = await healBatch(batch, root);
        recoveredFiles += healed.files;
        recoveredChunks += healed.chunks;
      } catch (error) {
        failedPoints += batch.points.length;
        // Unconditional: a debug-gated log already cost a full debugging
        // session on live damage — silent recovery failures are exactly how a
        // 29k-point damage went unnoticed.
        console.error(
          `[EnrichmentRecovery:${provider.key}] ${method} batch failed ` +
            `(${batch.paths.length} files, ${batch.points.length} chunks):`,
          error,
        );
      }
    }

    const remaining = await this.countRemaining(collectionName, provider, level, failedPoints);

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
    // Policy path: the server-side count still can't express path-glob skips
    // for points not yet stamped, so count via the policy-split scan. This keeps
    // countUnenriched and the recovery scan on the SAME set (the invariant
    // buildUnenrichedFilter's relativePath exclusion already maintains) — a
    // generated/doc file the policy skips must not keep the marker degraded
    // forever. Counting deliberately does NOT stamp: a query must not mutate.
    return (await this.scanUnenriched(collectionName, provider, level)).owed.length;
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
    scope: RecoveryScope = "unenriched",
  ): Promise<void> {
    const enrichedAt = new Date().toISOString();
    for (const ctx of contexts.values()) {
      const baselineRunId = await markerStore.getRunId(coll, ctx.key);

      const fileResult = await this.recoverFileLevel(coll, absolutePath, ctx.provider, enrichedAt, scope);
      const chunkResult = await this.recoverChunkLevel(coll, absolutePath, ctx.provider, enrichedAt, scope);

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
  private buildUnenrichedFilter(
    providerKey: string,
    level: "file" | "chunk",
    scope: RecoveryScope = "unenriched",
  ): Record<string, unknown> {
    const enrichedAtField = `${providerKey}.${level}.enrichedAt`;
    const skippedAsField = `${providerKey}.${level}.skippedAs`;
    // A forced recompute drops BOTH terminal-state conditions: the payload it
    // rewrites is present and stamped, so filtering on "not yet settled" would
    // select nothing. The must_not exclusions stay — those points cannot be
    // enriched at any scope.
    const settled =
      scope === "all" ? [] : [{ is_empty: { key: enrichedAtField } }, { is_empty: { key: skippedAsField } }];
    return {
      // Two terminal states, both of which settle a point: it was enriched, or
      // policy declined it. A candidate carries neither. Without the second
      // condition the filter cannot express the policy server-side, so the whole
      // declined population is shipped to the client and discarded there on
      // every run — see the skip-stamp design spec.
      must: settled,
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
   * Scroll Qdrant for points settled by neither terminal marker, and split them
   * by what the policy says.
   *
   * Pure query — it never writes. Stamping the declined half is the caller's
   * job, which keeps `countUnenriched` side-effect free.
   */
  private async scanUnenriched(
    collectionName: string,
    provider: EnrichmentProvider,
    level: "file" | "chunk",
    scope: RecoveryScope = "unenriched",
  ): Promise<UnenrichedScan> {
    const filter = this.buildUnenrichedFilter(provider.key, level, scope);
    const points = await this.qdrant.scrollFiltered(
      collectionName,
      filter,
      RECOVERY_SCROLL_HARD_CAP,
      this.scrollPageSize,
      RECOVERY_PAYLOAD_KEYS,
    );

    const owed: UnenrichedPoint[] = [];
    const declined: DeclinedPoint[] = [];
    for (const point of points) {
      const relativePath = typeof point.payload?.relativePath === "string" ? point.payload.relativePath : null;
      if (!relativePath) continue;
      // Per-file enrichment policy: a file the provider declined is unenriched
      // BY DESIGN. It is not a degraded miss and must not be healed — but it
      // does get stamped, so the next run's filter settles it server-side.
      const skippedAs = enrichmentSkipReason(provider, relativePath, level);
      if (skippedAs !== null) {
        declined.push({ id: point.id, skippedAs });
        continue;
      }
      owed.push({
        id: point.id,
        relativePath,
        startLine: typeof point.payload?.startLine === "number" ? point.payload.startLine : undefined,
        endLine: typeof point.payload?.endLine === "number" ? point.payload.endLine : undefined,
      });
    }
    return { owed, declined };
  }

  /**
   * Persist the policy's decline so it stops costing a scan. Best-effort: a
   * failed stamp leaves those points in the next run's scan, which is exactly
   * the pre-fix behaviour, so it degrades rather than breaks.
   */
  private async stampDeclined(
    collectionName: string,
    providerKey: string,
    level: "file" | "chunk",
    declined: readonly DeclinedPoint[],
  ): Promise<void> {
    if (declined.length === 0) return;
    try {
      await this.applier.applySkipStamps(collectionName, providerKey, level, declined);
    } catch (error) {
      console.error(
        `[EnrichmentRecovery:${providerKey}] skip-stamp write failed (${declined.length} ${level} points):`,
        error,
      );
    }
  }
}

/** Take the batch of unique paths starting at `offset`, with their points. */
function sliceRecoveryBatch(
  uniquePaths: readonly string[],
  offset: number,
  pointsByPath: ReadonlyMap<string, UnenrichedPoint[]>,
): RecoveryBatch {
  const paths = uniquePaths.slice(offset, offset + RECOVERY_FILE_BATCH_SIZE);
  return { paths, points: paths.flatMap((p) => pointsByPath.get(p) ?? []), pointsByPath };
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
