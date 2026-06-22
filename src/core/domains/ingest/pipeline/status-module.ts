/**
 * StatusModule - Index status and cleanup operations.
 *
 * Extracted from CodeIndexer to isolate status queries and index clearing.
 *
 * Always reports the latest versioned collection status:
 * - If a newer _v(N+1) is being indexed while alias points to _vN, reports "indexing"
 * - If alias doesn't exist yet (first index in progress), finds _v1 and reports from it
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { ResolveRunStatsRow } from "../../../contracts/types/codegraph.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import { StatsCache } from "../../../infra/stats-cache.js";
import type {
  CodegraphResolveKindRow,
  CodegraphResolveLanguageRow,
  CodegraphResolveSummary,
  IndexStatus,
} from "../../../types.js";
import { INDEXING_METADATA_ID } from "../constants.js";
import { MIN_LANGUAGE_SHARE } from "../infra/index.js";
import { QuarantineStore } from "../sync/index.js";
import { ParallelFileSynchronizer } from "../sync/parallel-synchronizer.js";
import { mapMarkerToHealth } from "./enrichment/health-mapper.js";
import { parseMarkerPayload } from "./indexing-marker-codec.js";

/** If indexing marker says "in progress" for longer than this, report as stale */
const STALE_INDEXING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** `callsResolved / max(1, callsAttempted − callsExternalSkipped)`; 0 when nothing attempted. */
function resolveRate(attempted: number, resolved: number, externalSkipped: number): number {
  return attempted === 0 ? 0 : resolved / Math.max(1, attempted - externalSkipped);
}

/** Running tally aggregated from `cg_run_stats` rows (per language or per kind). */
interface ResolveTally {
  attempted: number;
  resolved: number;
  externalSkipped: number;
}

/**
 * Build the per-receiver-kind breakdown for one language (bd tea-rags-mcp-7m5xz).
 * Includes a kind only when it was actually attempted (`attempted > 0`) — NO
 * min-share filter, since small buckets (e.g. `selfMember`) are the target.
 * Sorted by `attempted` DESC; per-kind `resolveSuccessRate` reuses the shared
 * {@link resolveRate} helper so the external-skip exclusion stays consistent.
 */
function buildByReceiverKind(kinds: Map<string, ResolveTally>): CodegraphResolveKindRow[] {
  return [...kinds.entries()]
    .filter(([, t]) => t.attempted > 0)
    .map(([receiverKind, t]) => ({
      receiverKind,
      attempted: t.attempted,
      resolved: t.resolved,
      externalSkipped: t.externalSkipped,
      resolveSuccessRate: resolveRate(t.attempted, t.resolved, t.externalSkipped),
    }))
    .sort((a, b) => b.attempted - a.attempted);
}

/**
 * Fold the persisted per-(language, receiverKind) `cg_run_stats` rows into the
 * status DTO (bd tea-rags-mcp-cnqrg). The aggregate sums every row; the
 * per-language breakdown sums per language, then applies the SAME display rule
 * as `get_index_metrics` — drop a language whose call-site share is below
 * {@link MIN_LANGUAGE_SHARE} (noise) — and omits the breakdown entirely when ≤1
 * language survives (the aggregate already conveys it). "Officially supported"
 * needs no extra filter: only resolver-backed code languages reach the tally,
 * and unlabeled rows (`language: ""`, direct-mode) are excluded from the
 * per-language view. Returns `undefined` when there are no rows.
 *
 * tea-rags-mcp-7m5xz — the same rows ALSO fold into a per-receiver-kind
 * breakdown, placed by MIRRORING the byLanguage suppression: when >1 language
 * survives, `byReceiverKind` is attached to EACH byLanguage row (precise
 * lang×kind) and the top-level stays absent; when exactly 1 language survives
 * (byLanguage suppressed), the top-level `byReceiverKind` carries that single
 * language's kinds.
 */
export function summarizeCodegraphResolve(rows: readonly ResolveRunStatsRow[]): CodegraphResolveSummary | undefined {
  if (rows.length === 0) return undefined;
  let attempted = 0;
  let resolved = 0;
  let externalSkipped = 0;
  const byLang = new Map<string, ResolveTally>();
  // Per-language receiver-kind tally (bd tea-rags-mcp-7m5xz). Unlabeled rows are
  // excluded here exactly as they are for byLanguage.
  const byLangKind = new Map<string, Map<string, ResolveTally>>();
  for (const r of rows) {
    attempted += r.attempted;
    resolved += r.resolved;
    externalSkipped += r.externalSkipped;
    if (!r.language) continue; // unlabeled (pre-cnqrg / direct-mode) — aggregate only
    const e = byLang.get(r.language) ?? { attempted: 0, resolved: 0, externalSkipped: 0 };
    e.attempted += r.attempted;
    e.resolved += r.resolved;
    e.externalSkipped += r.externalSkipped;
    byLang.set(r.language, e);
    const kinds = byLangKind.get(r.language) ?? new Map<string, ResolveTally>();
    const k = kinds.get(r.receiverKind) ?? { attempted: 0, resolved: 0, externalSkipped: 0 };
    k.attempted += r.attempted;
    k.resolved += r.resolved;
    k.externalSkipped += r.externalSkipped;
    kinds.set(r.receiverKind, k);
    byLangKind.set(r.language, kinds);
  }
  const summary: CodegraphResolveSummary = {
    resolveSuccessRate: resolveRate(attempted, resolved, externalSkipped),
    callsAttempted: attempted,
    callsResolved: resolved,
    callsExternalSkipped: externalSkipped,
  };
  const byLanguage: CodegraphResolveLanguageRow[] = [...byLang.entries()]
    .filter(([, t]) => attempted > 0 && t.attempted / attempted >= MIN_LANGUAGE_SHARE)
    .map(([language, t]) => ({
      language,
      resolveSuccessRate: resolveRate(t.attempted, t.resolved, t.externalSkipped),
      callsAttempted: t.attempted,
      callsResolved: t.resolved,
      callsExternalSkipped: t.externalSkipped,
      byReceiverKind: buildByReceiverKind(byLangKind.get(language) ?? new Map<string, ResolveTally>()),
    }))
    .sort((a, b) => b.callsAttempted - a.callsAttempted);
  if (byLanguage.length > 1) {
    summary.byLanguage = byLanguage;
  } else if (byLanguage.length === 1) {
    // Single surviving language: byLanguage is suppressed (aggregate conveys it),
    // so surface that language's kind breakdown at the top level instead.
    summary.byReceiverKind = byLanguage[0].byReceiverKind;
  }
  return summary;
}

export class StatusModule {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly snapshotDir?: string,
    private readonly codegraphPool?: GraphDbClientPool,
  ) {}

  /**
   * tea-rags-mcp-ykj7 — post-hoc codegraph resolve-quality for an indexed
   * collection, aggregated from the persisted `cg_run_stats` table. Returns
   * `undefined` (non-fatal) when codegraph is disabled, the collection has no
   * codegraph DB on disk, the table is empty, or any read fails — get_index_status
   * must never break because codegraph state is absent. The existence guard
   * (`listCollectionDbNames`, a dir read) prevents a status call from creating a
   * phantom codegraph DB for non-codegraph collections.
   */
  private async readCodegraphResolve(collection: string): Promise<CodegraphResolveSummary | undefined> {
    if (!this.codegraphPool) return undefined;
    // The codegraph DB is keyed by the VERSIONED collection (`code_…_vN`), but
    // the status path usually passes the base/alias name. Resolve to the on-disk
    // DB name WITHOUT creating one — `listCollectionDbNames` is a dir read, so a
    // status call never spins up a phantom codegraph DB for a Qdrant-only
    // collection. Prefer the exact name, then the Qdrant alias target, then the
    // sole version; bail (undefined) on ambiguity rather than guessing.
    const base = collection.replace(/_v\d+$/, "");
    const dbNames = this.codegraphPool.listCollectionDbNames(base);
    if (dbNames.length === 0) return undefined;
    let target: string | undefined;
    if (dbNames.includes(collection)) {
      target = collection;
    } else {
      const aliasTarget = await this.getAliasTarget(base).catch(() => undefined);
      target =
        aliasTarget && dbNames.includes(aliasTarget) ? aliasTarget : dbNames.length === 1 ? dbNames[0] : undefined;
    }
    if (!target) return undefined;
    try {
      const handle = await this.codegraphPool.acquireReader(target);
      try {
        return summarizeCodegraphResolve(await handle.graphDb.getRunStats());
      } finally {
        await handle.graphDb.close();
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Get indexing status for a codebase.
   *
   * Always shows the latest version — if a newer versioned collection
   * is being indexed (no alias yet, or alias still on old version),
   * reports that indexing is in progress.
   */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);

    // Find the latest versioned collection (highest _vN)
    const latestVersioned = await this.findLatestVersionedCollection(collectionName);

    // Check if alias/real collection exists
    const exists = await this.qdrant.collectionExists(collectionName);

    if (!exists && !latestVersioned) {
      return { isIndexed: false, status: "not_indexed" };
    }

    // If a versioned collection exists that is newer than what alias points to,
    // report status from it only when it's actually in-progress or crashed
    // mid-index. A complete-but-unaliased _vN is an orphan from a prior
    // rotation (force-reindex deleted the old alias target and left _vN
    // behind), and must not shadow the real alias target.
    if (latestVersioned) {
      const aliasTarget = exists ? await this.getAliasTarget(collectionName) : undefined;
      if (aliasTarget !== latestVersioned) {
        if (!exists) {
          // No alias/real collection at all — latestVersioned is the only source
          // (first index in progress, or first index that completed but alias was
          // never created).
          return this.getStatusFromCollection(latestVersioned, collectionName);
        }
        const rawPoint = await this.qdrant.getPoint(latestVersioned, INDEXING_METADATA_ID).catch(() => null);
        const marker = rawPoint ? parseMarkerPayload(rawPoint.payload as Record<string, unknown>) : undefined;
        if (!marker?.indexingComplete) {
          // In-progress or crashed mid-index — report from this collection
          return this.getStatusFromCollection(latestVersioned, collectionName);
        }
        // Otherwise it's a completed orphan; fall through to read from alias.
      }
    }

    // Alias points to latest version (or legacy real collection) — read from alias
    return this.getStatusFromCollection(collectionName, collectionName);
  }

  /**
   * Clear all indexed data for a codebase.
   * Handles both legacy (real collection) and alias-based setups.
   */
  async clearIndex(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);

    if (exists) {
      const isAlias = await this.qdrant.aliases.isAlias(collectionName);
      if (isAlias) {
        // Alias-based: find underlying collection, delete alias + collection + orphans
        const aliases = await this.qdrant.aliases.listAliases();
        const activeCollection = aliases.find((a) => a.aliasName === collectionName)?.collectionName;
        await this.qdrant.aliases.deleteAlias(collectionName);
        if (activeCollection) {
          await this.qdrant.deleteCollection(activeCollection);
        }
        // Clean up any orphaned versioned collections
        const allCollections = await this.qdrant.listCollections();
        for (const c of allCollections) {
          if (c.startsWith(`${collectionName}_v`)) {
            await this.qdrant.deleteCollection(c);
          }
        }
      } else {
        // Legacy: real collection, just delete it
        await this.qdrant.deleteCollection(collectionName);
      }
    }

    // Also delete snapshot
    try {
      /* v8 ignore next -- fallback for backward compat */
      const dir = this.snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");
      const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, dir);
      await synchronizer.deleteSnapshot();
      // The quarantine and stats caches live as siblings of the snapshot dir, so
      // the snapshot delete above does not reach them — drop them explicitly.
      await new QuarantineStore(dir, collectionName).clearAll();
      new StatsCache(dir).invalidate(collectionName);
    } catch (_error) {
      // Ignore snapshot deletion errors
    }
  }

  // ── Private helpers ──────────────────────────────────────

  /**
   * Read the poison-pill quarantine count for a collection from its snapshot
   * directory. Returns undefined when no snapshot dir is wired or nothing is
   * quarantined, keeping the status surface narrow.
   */
  private async loadQuarantineSummary(reportedName: string): Promise<{ count: number } | undefined> {
    if (!this.snapshotDir) return undefined;
    const count = await new QuarantineStore(this.snapshotDir, reportedName).count();
    return count > 0 ? { count } : undefined;
  }

  /**
   * Find the latest versioned collection (highest _vN suffix).
   * Returns undefined if no versioned collections exist.
   */
  private async findLatestVersionedCollection(collectionName: string): Promise<string | undefined> {
    const allCollections = await this.qdrant.listCollections();
    const versionedPattern = new RegExp(`^${collectionName}_v(\\d+)$`);
    let maxVersion = 0;
    let latest: string | undefined;

    for (const c of allCollections) {
      const match = c.match(versionedPattern);
      if (match) {
        const version = parseInt(match[1], 10);
        if (version > maxVersion) {
          maxVersion = version;
          latest = c;
        }
      }
    }

    return latest;
  }

  /**
   * Get the collection name that an alias points to.
   * Returns undefined if the name is not an alias (real collection or not found).
   */
  private async getAliasTarget(aliasName: string): Promise<string | undefined> {
    const aliases = await this.qdrant.aliases.listAliases();
    return aliases.find((a) => a.aliasName === aliasName)?.collectionName;
  }

  /**
   * Read full index status from a specific collection.
   * @param sourceCollection - collection to read markers from (e.g. "code_abc_v1")
   * @param reportedName - collection name to report in the response (always the base alias name)
   */
  private async getStatusFromCollection(sourceCollection: string, reportedName: string): Promise<IndexStatus> {
    const rawPoint = await this.qdrant.getPoint(sourceCollection, INDEXING_METADATA_ID);
    const info = await this.qdrant.getCollectionInfo(sourceCollection);
    const marker = rawPoint ? parseMarkerPayload(rawPoint.payload as Record<string, unknown>) : undefined;

    const actualChunksCount = marker ? Math.max(0, info.pointsCount - 1) : info.pointsCount;
    const enrichment = marker?.enrichment ? mapMarkerToHealth(marker.enrichment) : undefined;

    const schemaMetadata = await this.qdrant.getPoint(sourceCollection, "__schema_metadata__").catch(() => null);
    const sparseVersion =
      typeof schemaMetadata?.payload?.sparseVersion === "number" ? schemaMetadata.payload.sparseVersion : undefined;

    if (marker && !marker.indexingComplete) {
      // Detect stale indexing: prefer lastHeartbeat (updated periodically by live pipeline),
      // fall back to startedAt for markers written before heartbeat was introduced.
      const referenceTime = marker.lastHeartbeat ?? marker.startedAt;
      const isStale =
        referenceTime !== undefined && Date.now() - new Date(referenceTime).getTime() > STALE_INDEXING_THRESHOLD_MS;

      if (isStale && sourceCollection !== reportedName) {
        const resolved = await this.resolveStaleCollection(sourceCollection, reportedName, actualChunksCount);
        if ("notIndexed" in resolved) {
          return { isIndexed: false, status: "not_indexed", collectionName: reportedName };
        }
        if (resolved.collection !== sourceCollection) {
          // Bounded: resolved collection is always base name or alias target (never versioned),
          // so the stale check `sourceCollection !== reportedName` won't match on the second call.
          return this.getStatusFromCollection(resolved.collection, reportedName);
        }
        // No fallback found but collection has data — fall through to report stale_indexing.
      }

      return {
        isIndexed: false,
        status: isStale ? "stale_indexing" : "indexing",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        embeddingModel: marker.embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        enrichment,
      };
    }

    if (marker?.indexingComplete) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        embeddingModel: marker.embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        lastUpdated: marker.completedAt ? new Date(marker.completedAt) : undefined,
        enrichment,
        codegraphResolve: await this.readCodegraphResolve(sourceCollection),
        quarantine: await this.loadQuarantineSummary(reportedName),
      };
    }

    // Legacy collection (no marker) - check if it has content
    if (actualChunksCount > 0) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        codegraphResolve: await this.readCodegraphResolve(sourceCollection),
      };
    }

    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName: reportedName,
      chunksCount: 0,
      qdrantUrl: this.qdrant.url,
      sparseVersion,
    };
  }

  /**
   * Resolve a stale versioned collection by finding a working fallback.
   * Deletes the stale collection and returns either a fallback collection name
   * or a notIndexed sentinel if no fallback exists.
   */
  private async resolveStaleCollection(
    staleCollection: string,
    reportedName: string,
    chunksCount: number,
  ): Promise<{ collection: string } | { notIndexed: true }> {
    // Versioned _vN with stale marker — check if a working version exists.
    const aliasTarget = await this.getAliasTarget(reportedName);
    if (aliasTarget) {
      // Alias points to a completed version — safe to delete stale _vN.
      await this.qdrant.deleteCollection(staleCollection);
      return { collection: aliasTarget };
    }
    // Legacy: no alias, but real collection may exist (pre-alias migration).
    const realExists = await this.qdrant.collectionExists(reportedName);
    if (realExists) {
      await this.qdrant.deleteCollection(staleCollection);
      return { collection: reportedName };
    }
    // No alias, no real collection (first index crashed). Delete only if empty.
    if (chunksCount === 0) {
      await this.qdrant.deleteCollection(staleCollection);
      return { notIndexed: true };
    }
    // Stale but has chunks and no fallback — keep it, caller reports stale_indexing.
    return { collection: staleCollection };
  }
}
